import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ec2-rightsize-action-service.ts imports from `../governance/index.js`, whose barrel also
// evaluates `s3PolicyStore.ts` -> `assessment/infra-review-collector/clients.ts`, which reads
// ASSESSMENT_BUCKET_NAME/AWS_ACCOUNT_ID directly from process.env at module scope (independent of
// the `config.js` mock below) and throws if missing.
process.env.ASSESSMENT_BUCKET_NAME = 'test-assessment-bucket';
process.env.AWS_ACCOUNT_ID = '123456789012';

vi.mock('../../config.js', () => ({
  config: {
    allowedOrigins: [],
    entraTenantId: 'test-tenant',
    entraClientId: 'test-client',
    allowedGroupIds: [],
    awsRegion: 'ap-southeast-1',
    costCacheParamName: 'test-cost-cache-param',
    assessmentBucketName: 'test-assessment-bucket',
    ec2StateManagerServiceTokenParamName: 'test-service-token-param',
    ec2StateManagerFunctionUrl: 'https://example.invalid/',
    actionExecutionFunctionName: 'test-action-execution-fn',
  },
  corsHeaders: () => ({}),
}));

const ec2SendMock = vi.fn();
const callEc2StateManagerMock = vi.fn();

vi.mock('@aws-sdk/client-ec2', () => ({
  EC2Client: vi.fn().mockImplementation(() => ({ send: ec2SendMock })),
  DescribeInstancesCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'DescribeInstances', input })),
  DescribeInstanceTypesCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'DescribeInstanceTypes', input })),
  ModifyInstanceAttributeCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'ModifyInstanceAttribute', input })),
}));

vi.mock('./ec2-state-manager-client.js', () => ({
  callEc2StateManager: callEc2StateManagerMock,
}));

const { executeEc2Rightsize } = await import('./ec2-rightsize-action-service.js');

const INSTANCE_ID = 'i-0123456789abcdef0';

function describeInstancesResult(instanceType: string, state: string) {
  return { Reservations: [{ Instances: [{ InstanceType: instanceType, State: { Name: state } }] }] };
}

/**
 * `DescribeInstanceTypes`, when called via `fetchFamilySizes`, uses `Filters: [{Name:
 * 'instance-type', Values: ['<family>.*']}]`, NOT `InstanceTypes: [...]` — it returns ALL sizes
 * in the family (current type + the next smaller size, enough for `pickSmallerFamilySize` to
 * choose correctly). `t3.large` -> `t3.medium` are 2 consecutive sizes in the real `SIZE_LADDER`
 * of family "t3" (nano/micro/small/medium/large/xlarge/2xlarge...).
 */
function describeInstanceTypesFamilyResult(
  familySizes: { instanceType: string; vcpus: number; memoryMiB: number; architectures: string[] }[],
) {
  return {
    InstanceTypes: familySizes.map((s) => ({
      InstanceType: s.instanceType,
      VCpuInfo: { DefaultVCpus: s.vcpus },
      MemoryInfo: { SizeInMiB: s.memoryMiB },
      ProcessorInfo: { SupportedArchitectures: s.architectures },
    })),
  };
}

/**
 * Default used by most test cases: family "t3" with current=t3.large (2 vCPU/8192MiB) and
 * target=t3.medium (2 vCPU/4096MiB) — same vCPU, only memory differs, matching how
 * `pickSmallerFamilySize` ranks sizes when vCPU is equal.
 */
function defaultT3FamilyResult(currentArch: string[], targetArch: string[]) {
  return describeInstanceTypesFamilyResult([
    { instanceType: 't3.medium', vcpus: 2, memoryMiB: 4096, architectures: targetArch },
    { instanceType: 't3.large', vcpus: 2, memoryMiB: 8192, architectures: currentArch },
  ]);
}

/** Shared dispatcher for `ec2SendMock` — routes by `__type` attached to the input by the command mock. */
function setupEc2Mock(opts: {
  instanceType: string;
  state: string;
  currentArch: string[];
  targetArch: string[];
  modifyThrows?: Error;
  describeInstancesAfterModifyState?: string;
}) {
  let modifyCalled = false;
  ec2SendMock.mockImplementation(async (command: { __type?: string }) => {
    if (command.__type === 'DescribeInstances') {
      const state = modifyCalled && opts.describeInstancesAfterModifyState ? opts.describeInstancesAfterModifyState : opts.state;
      return describeInstancesResult(opts.instanceType, state);
    }
    if (command.__type === 'DescribeInstanceTypes') {
      return defaultT3FamilyResult(opts.currentArch, opts.targetArch);
    }
    if (command.__type === 'ModifyInstanceAttribute') {
      modifyCalled = true;
      if (opts.modifyThrows) throw opts.modifyThrows;
      return {};
    }
    throw new Error(`Unexpected EC2 command in mock: ${command.__type}`);
  });
}

beforeEach(() => {
  ec2SendMock.mockReset();
  callEc2StateManagerMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('executeEc2Rightsize', () => {
  it('success: instance running, same architecture — stop via StateManager, ModifyInstanceAttribute, restart, poll running', async () => {
    let describeCallCount = 0;
    ec2SendMock.mockImplementation(async (command: { __type?: string }) => {
      if (command.__type === 'DescribeInstances') {
        describeCallCount++;
        if (describeCallCount === 1) return describeInstancesResult('t3.large', 'running');
        if (describeCallCount === 2) return describeInstancesResult('t3.large', 'stopped'); // poll after stop
        return describeInstancesResult('t3.medium', 'running'); // poll after start
      }
      if (command.__type === 'DescribeInstanceTypes') {
        return defaultT3FamilyResult(['x86_64'], ['x86_64']);
      }
      if (command.__type === 'ModifyInstanceAttribute') return {};
      throw new Error(`Unexpected EC2 command: ${command.__type}`);
    });
    callEc2StateManagerMock.mockResolvedValue({ success: true, state: 'stopped' });

    const result = await executeEc2Rightsize(INSTANCE_ID);

    expect(result).toEqual({ outcome: 'success', newInstanceType: 't3.medium' });
    expect(callEc2StateManagerMock).toHaveBeenCalledWith(INSTANCE_ID, 'ap-southeast-1', 'stop');
    expect(callEc2StateManagerMock).toHaveBeenCalledWith(INSTANCE_ID, 'ap-southeast-1', 'start');
  });

  it('rejected: instance does not exist — does not call StateManager/ModifyInstanceAttribute', async () => {
    ec2SendMock.mockResolvedValue({ Reservations: [] });

    const result = await executeEc2Rightsize(INSTANCE_ID);

    expect(result.outcome).toBe('rejected');
    expect(callEc2StateManagerMock).not.toHaveBeenCalled();
  });

  it('rejected: instance is already at the smallest size (nano) — cannot determine a target', async () => {
    ec2SendMock.mockResolvedValue(describeInstancesResult('t4g.nano', 'running'));

    const result = await executeEc2Rightsize(INSTANCE_ID);

    expect(result.outcome).toBe('rejected');
    expect(callEc2StateManagerMock).not.toHaveBeenCalled();
  });

  it('rejected: CPU architecture incompatible between current and target — does NOT stop/modify/start', async () => {
    setupEc2Mock({
      instanceType: 't3.large',
      state: 'running',
      currentArch: ['x86_64'],
      targetArch: ['arm64'], // simulates an incompatibility (doesn't actually happen within the same family, but verifies the 2nd safety layer still works correctly)
    });

    const result = await executeEc2Rightsize(INSTANCE_ID);

    expect(result.outcome).toBe('rejected');
    expect(result.reason).toContain('is not CPU-architecture compatible with');
    expect(callEc2StateManagerMock).not.toHaveBeenCalled();
    const calledTypes = ec2SendMock.mock.calls.map((c: unknown[]) => (c[0] as { __type?: string }).__type);
    expect(calledTypes).not.toContain('ModifyInstanceAttribute');
  });

  it('failure: stop via StateManager fails — does NOT call ModifyInstanceAttribute', async () => {
    setupEc2Mock({ instanceType: 't3.large', state: 'running', currentArch: ['x86_64'], targetArch: ['x86_64'] });
    callEc2StateManagerMock.mockResolvedValue({ success: false, error: 'StateManager timeout' });

    const result = await executeEc2Rightsize(INSTANCE_ID);

    expect(result.outcome).toBe('failure');
    expect(result.reason).toContain('StateManager timeout');
    const calledTypes = ec2SendMock.mock.calls.map((c: unknown[]) => (c[0] as { __type?: string }).__type);
    expect(calledTypes).not.toContain('ModifyInstanceAttribute');
  });

  it('failure: ModifyInstanceAttribute throws after stop succeeds — does NOT call start', async () => {
    let describeCallCount = 0;
    ec2SendMock.mockImplementation(async (command: { __type?: string }) => {
      if (command.__type === 'DescribeInstances') {
        describeCallCount++;
        if (describeCallCount === 1) return describeInstancesResult('t3.large', 'running');
        return describeInstancesResult('t3.large', 'stopped');
      }
      if (command.__type === 'DescribeInstanceTypes') return defaultT3FamilyResult(['x86_64'], ['x86_64']);
      if (command.__type === 'ModifyInstanceAttribute') throw new Error('InvalidInstanceType');
      throw new Error(`Unexpected EC2 command: ${command.__type}`);
    });
    callEc2StateManagerMock.mockResolvedValue({ success: true, state: 'stopped' });

    const result = await executeEc2Rightsize(INSTANCE_ID);

    expect(result.outcome).toBe('failure');
    expect(result.reason).toContain('InvalidInstanceType');
    expect(callEc2StateManagerMock).toHaveBeenCalledTimes(1); // stop only, no start
    expect(callEc2StateManagerMock).toHaveBeenCalledWith(INSTANCE_ID, 'ap-southeast-1', 'stop');
  });

  it('failure: start via StateManager fails after the type change succeeds — still returns newInstanceType', async () => {
    let describeCallCount = 0;
    ec2SendMock.mockImplementation(async (command: { __type?: string }) => {
      if (command.__type === 'DescribeInstances') {
        describeCallCount++;
        if (describeCallCount === 1) return describeInstancesResult('t3.large', 'running');
        return describeInstancesResult('t3.large', 'stopped');
      }
      if (command.__type === 'DescribeInstanceTypes') return defaultT3FamilyResult(['x86_64'], ['x86_64']);
      if (command.__type === 'ModifyInstanceAttribute') return {};
      throw new Error(`Unexpected EC2 command: ${command.__type}`);
    });
    callEc2StateManagerMock.mockImplementation(async (_id: string, _region: string, action: string) => {
      if (action === 'stop') return { success: true, state: 'stopped' };
      return { success: false, error: 'start failed' };
    });

    const result = await executeEc2Rightsize(INSTANCE_ID);

    expect(result.outcome).toBe('failure');
    expect(result.newInstanceType).toBe('t3.medium');
    expect(result.reason).toContain('start failed');
  });

  it('success, no state change: instance was already stopped — only changes type, does NOT call start (preserves the user\'s "leave it stopped" intent)', async () => {
    ec2SendMock.mockImplementation(async (command: { __type?: string }) => {
      if (command.__type === 'DescribeInstances') return describeInstancesResult('t3.large', 'stopped');
      if (command.__type === 'DescribeInstanceTypes') return defaultT3FamilyResult(['x86_64'], ['x86_64']);
      if (command.__type === 'ModifyInstanceAttribute') return {};
      throw new Error('unexpected');
    });

    const result = await executeEc2Rightsize(INSTANCE_ID);

    expect(result).toEqual({ outcome: 'success', newInstanceType: 't3.medium' });
    expect(callEc2StateManagerMock).not.toHaveBeenCalled();
  });

  it('failure: running instance does not reach "stopped" within the wait time — timeout, does NOT call ModifyInstanceAttribute', async () => {
    vi.useFakeTimers();
    let describeCallCount = 0;
    ec2SendMock.mockImplementation(async (command: { __type?: string }) => {
      if (command.__type === 'DescribeInstances') {
        describeCallCount++;
        // The FIRST read (before deciding to stop) must be 'running' to trigger the stop flow;
        // subsequent polls (waiting for 'stopped') always return 'stopping' — never reaching
        // 'stopped', forcing the poll loop to run until the deadline.
        return describeInstancesResult('t3.large', describeCallCount === 1 ? 'running' : 'stopping');
      }
      if (command.__type === 'DescribeInstanceTypes') return defaultT3FamilyResult(['x86_64'], ['x86_64']);
      throw new Error(`Unexpected EC2 command: ${command.__type}`);
    });
    callEc2StateManagerMock.mockResolvedValue({ success: true, state: 'stopping' });

    const resultPromise = executeEc2Rightsize(INSTANCE_ID);
    await vi.advanceTimersByTimeAsync(305_000);
    const result = await resultPromise;

    expect(result.outcome).toBe('failure');
    expect(result.reason).toMatch(/stopped/);
    const calledTypes = ec2SendMock.mock.calls.map((c: unknown[]) => (c[0] as { __type?: string }).__type);
    expect(calledTypes).not.toContain('ModifyInstanceAttribute');

    vi.useRealTimers();
  });

  it('failure: DescribeInstances (the initial state read) throws -> outcome failure', async () => {
    ec2SendMock.mockRejectedValue(new Error('network error'));

    const result = await executeEc2Rightsize(INSTANCE_ID);

    expect(result.outcome).toBe('failure');
  });
});
