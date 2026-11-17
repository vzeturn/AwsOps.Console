import { describe, it, expect, vi, beforeEach } from 'vitest';

// ecs-scale-action-service.ts runs inside action-execution-fn and reads config.awsRegion — mock
// config.js before importing, following the same pattern as the other tests in this directory.
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

const ecsSendMock = vi.fn();
const autoscalingSendMock = vi.fn();

vi.mock('@aws-sdk/client-ecs', () => ({
  ECSClient: vi.fn().mockImplementation(() => ({ send: ecsSendMock })),
  DescribeServicesCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'DescribeServices', input })),
  UpdateServiceCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'UpdateService', input })),
}));

vi.mock('@aws-sdk/client-application-auto-scaling', () => ({
  ApplicationAutoScalingClient: vi.fn().mockImplementation(() => ({ send: autoscalingSendMock })),
  DescribeScalableTargetsCommand: vi
    .fn()
    .mockImplementation((input: unknown) => ({ __type: 'DescribeScalableTargets', input })),
}));

const { executeEcsScaleOut } = await import('./ecs-scale-action-service.js');

beforeEach(() => {
  ecsSendMock.mockReset();
  autoscalingSendMock.mockReset();
});

describe('executeEcsScaleOut', () => {
  it('success: re-reads the current desiredCount + maxCapacity, calls UpdateService with the new target, returns outcome success', async () => {
    ecsSendMock.mockImplementation(async (command: { __type?: string }) => {
      if (command.__type === 'DescribeServices') return { services: [{ status: 'ACTIVE', desiredCount: 4 }] };
      if (command.__type === 'UpdateService') return {};
      throw new Error('unexpected');
    });
    autoscalingSendMock.mockResolvedValue({ ScalableTargets: [{ MaxCapacity: 10 }] });

    const result = await executeEcsScaleOut('abc-prod-ecs-cluster/abc-prod-ecs-service-api');

    expect(result).toEqual({ outcome: 'success', newDesiredCount: 6 }); // 4 + ceil(4*0.5) = 6
    expect(ecsSendMock).toHaveBeenCalledTimes(2); // DescribeServices + UpdateService
  });

  it('rejected: resourceId is not in the "<cluster>/<service>" format — NO ECS API is called', async () => {
    const result = await executeEcsScaleOut('no-slash-here');

    expect(result.outcome).toBe('rejected');
    expect(ecsSendMock).not.toHaveBeenCalled();
  });

  it('rejected: service is not ACTIVE at execution time — UpdateService is NOT called', async () => {
    ecsSendMock.mockResolvedValue({ services: [{ status: 'DRAINING', desiredCount: 2 }] });

    const result = await executeEcsScaleOut('cluster-x/service-y');

    expect(result.outcome).toBe('rejected');
    expect(ecsSendMock).toHaveBeenCalledTimes(1); // only DescribeServices, not UpdateService
  });

  it('rejected: already at maxCapacity — UpdateService is NOT called (avoid a no-op mutate)', async () => {
    ecsSendMock.mockResolvedValue({ services: [{ status: 'ACTIVE', desiredCount: 10 }] });
    autoscalingSendMock.mockResolvedValue({ ScalableTargets: [{ MaxCapacity: 10 }] });

    const result = await executeEcsScaleOut('cluster-x/service-y');

    expect(result.outcome).toBe('rejected');
    expect(ecsSendMock).toHaveBeenCalledTimes(1);
  });

  it('failure: UpdateService throws → outcome failure, does NOT throw outward', async () => {
    ecsSendMock.mockImplementation(async (command: { __type?: string }) => {
      if (command.__type === 'DescribeServices') return { services: [{ status: 'ACTIVE', desiredCount: 2 }] };
      if (command.__type === 'UpdateService') throw new Error('AWS throttled');
      throw new Error('unexpected');
    });
    autoscalingSendMock.mockResolvedValue({ ScalableTargets: [] });

    const result = await executeEcsScaleOut('cluster-x/service-y');

    expect(result.outcome).toBe('failure');
    expect(result.reason).toContain('AWS throttled');
  });

  it('failure: DescribeServices throw → outcome failure', async () => {
    ecsSendMock.mockRejectedValue(new Error('network error'));

    const result = await executeEcsScaleOut('cluster-x/service-y');

    expect(result.outcome).toBe('failure');
  });

  it('does not throw when DescribeScalableTargets fails — scale-out still succeeds with no maxCapacity limit', async () => {
    ecsSendMock.mockImplementation(async (command: { __type?: string }) => {
      if (command.__type === 'DescribeServices') return { services: [{ status: 'ACTIVE', desiredCount: 2 }] };
      if (command.__type === 'UpdateService') return {};
      throw new Error('unexpected');
    });
    autoscalingSendMock.mockRejectedValue(new Error('boom'));

    const result = await executeEcsScaleOut('cluster-x/service-y');

    expect(result.outcome).toBe('success');
  });
});
