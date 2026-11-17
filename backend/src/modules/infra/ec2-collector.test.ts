import { describe, it, expect, vi, beforeEach } from 'vitest';

// Task 6.2: unit tests for ec2-collector.ts
// The collector reads the region directly from process.env.AWS_REGION (the Lambda runtime always
// sets this itself) — set it before importing the module; no longer mocking config.ts (the collector doesn't import config.ts).
process.env.AWS_REGION = 'ap-southeast-1';

const ec2SendMock = vi.fn();
const cloudwatchSendMock = vi.fn();

vi.mock('@aws-sdk/client-ec2', () => ({
  EC2Client: vi.fn().mockImplementation(() => ({ send: ec2SendMock })),
  DescribeInstancesCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
}));

vi.mock('@aws-sdk/client-cloudwatch', () => ({
  CloudWatchClient: vi.fn().mockImplementation(() => ({ send: cloudwatchSendMock })),
  GetMetricDataCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
}));

// Import after the mocks are declared (vi.mock is hoisted to the top by vitest).
const { collectEc2 } = await import('./ec2-collector.js');

beforeEach(() => {
  ec2SendMock.mockReset();
  cloudwatchSendMock.mockReset();
});

describe('collectEc2', () => {
  it('returns the correct Ec2CollectorItem for a running instance with normal CPU/network', async () => {
    ec2SendMock.mockResolvedValue({
      Reservations: [
        {
          Instances: [
            {
              InstanceId: 'i-running1',
              InstanceType: 't3.medium',
              State: { Name: 'running' },
              Tags: [{ Key: 'Name', Value: 'web-1' }],
            },
          ],
        },
      ],
    });
    cloudwatchSendMock.mockResolvedValue({
      MetricDataResults: [
        { Id: 'cpu_i_running1', Values: [55.5] },
        { Id: 'cpumax_i_running1', Values: [92.3] },
        { Id: 'netin_i_running1', Values: [1_000_000] },
        { Id: 'netout_i_running1', Values: [2_000_000] },
      ],
    });

    const result = await collectEc2();

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      instanceId: 'i-running1',
      name: 'web-1',
      region: 'ap-southeast-1',
      state: 'running',
      instanceType: 't3.medium',
      avgCpuPercent: 55.5,
      maxCpuPercent: 92.3,
      avgNetworkInBytes: 1_000_000,
      avgNetworkOutBytes: 2_000_000,
    });
  });

  it('returns avgCpuPercent matching the mocked low CPU value from CloudWatch', async () => {
    ec2SendMock.mockResolvedValue({
      Reservations: [
        {
          Instances: [
            {
              InstanceId: 'i-lowcpu2',
              InstanceType: 't3.large',
              State: { Name: 'running' },
              Tags: [],
            },
          ],
        },
      ],
    });
    cloudwatchSendMock.mockResolvedValue({
      MetricDataResults: [
        { Id: 'cpu_i_lowcpu2', Values: [1.2] },
        { Id: 'cpumax_i_lowcpu2', Values: [3.8] },
        { Id: 'netin_i_lowcpu2', Values: [500] },
        { Id: 'netout_i_lowcpu2', Values: [300] },
      ],
    });

    const result = await collectEc2();

    expect(result).toHaveLength(1);
    expect(result[0].avgCpuPercent).toBe(1.2);
    expect(result[0].maxCpuPercent).toBe(3.8);
    expect(result[0].name).toBe('(no Name tag)');
  });

  it('correctly maps state=stopped, metrics=null when CloudWatch returns no data', async () => {
    ec2SendMock.mockResolvedValue({
      Reservations: [
        {
          Instances: [
            {
              InstanceId: 'i-stopped3',
              InstanceType: 't3.small',
              State: { Name: 'stopped' },
              Tags: [{ Key: 'Name', Value: 'batch-worker' }],
            },
          ],
        },
      ],
    });
    cloudwatchSendMock.mockResolvedValue({ MetricDataResults: [] });

    const result = await collectEc2();

    expect(result).toHaveLength(1);
    expect(result[0].state).toBe('stopped');
    expect(result[0].avgCpuPercent).toBeNull();
    expect(result[0].maxCpuPercent).toBeNull();
    expect(result[0].avgNetworkInBytes).toBeNull();
    expect(result[0].avgNetworkOutBytes).toBeNull();
  });

  it('returns [] (does not throw) when DescribeInstances fails', async () => {
    ec2SendMock.mockRejectedValue(new Error('AccessDenied'));

    const result = await collectEc2();

    expect(result).toEqual([]);
    expect(cloudwatchSendMock).not.toHaveBeenCalled();
  });

  it('correctly maps platform/platformDetails/architecture for a Windows instance', async () => {
    ec2SendMock.mockResolvedValue({
      Reservations: [
        {
          Instances: [
            {
              InstanceId: 'i-windows1',
              InstanceType: 'm5.large',
              State: { Name: 'running' },
              Tags: [{ Key: 'Name', Value: 'windows-app' }],
              Platform: 'windows',
              PlatformDetails: 'Windows',
              Architecture: 'x86_64',
            },
          ],
        },
      ],
    });
    cloudwatchSendMock.mockResolvedValue({ MetricDataResults: [] });

    const result = await collectEc2();

    expect(result).toHaveLength(1);
    expect(result[0].platform).toBe('windows');
    expect(result[0].platformDetails).toBe('Windows');
    expect(result[0].architecture).toBe('x86_64');
  });

  it('correctly maps platform=undefined/architecture=arm64 for a Linux Graviton instance', async () => {
    ec2SendMock.mockResolvedValue({
      Reservations: [
        {
          Instances: [
            {
              InstanceId: 'i-graviton1',
              InstanceType: 'm6g.large',
              State: { Name: 'running' },
              Tags: [],
              // Platform does not exist on the response for Linux instances (OFFICIAL AWS behavior).
              PlatformDetails: 'Linux/UNIX',
              Architecture: 'arm64',
            },
          ],
        },
      ],
    });
    cloudwatchSendMock.mockResolvedValue({ MetricDataResults: [] });

    const result = await collectEc2();

    expect(result).toHaveLength(1);
    expect(result[0].platform).toBeUndefined();
    expect(result[0].platformDetails).toBe('Linux/UNIX');
    expect(result[0].architecture).toBe('arm64');
  });

  it('maps platformDetails="unknown" when AWS returns no PlatformDetails, architecture=undefined when Architecture is not returned', async () => {
    ec2SendMock.mockResolvedValue({
      Reservations: [
        {
          Instances: [
            {
              InstanceId: 'i-noplatforminfo',
              InstanceType: 't3.micro',
              State: { Name: 'running' },
              Tags: [],
            },
          ],
        },
      ],
    });
    cloudwatchSendMock.mockResolvedValue({ MetricDataResults: [] });

    const result = await collectEc2();

    expect(result).toHaveLength(1);
    expect(result[0].platform).toBeUndefined();
    expect(result[0].platformDetails).toBe('unknown');
    expect(result[0].architecture).toBeUndefined();
  });

  it('DescribeInstances returns multiple pages (NextToken) -> loadEc2Instances/collectEc2 merges instances from ALL pages, not just the first', async () => {
    ec2SendMock.mockImplementation((command: { __cmd?: string; constructor?: { name?: string }; input?: { NextToken?: string } }) => {
      // Page 1: 1 instance + NextToken. Page 2: a different instance, no more NextToken.
      if (!command.input?.NextToken) {
        return Promise.resolve({
          Reservations: [{ Instances: [{ InstanceId: 'i-page1', State: { Name: 'running' }, InstanceType: 't3.micro', Tags: [] }] }],
          NextToken: 'token-page-2',
        });
      }
      return Promise.resolve({
        Reservations: [{ Instances: [{ InstanceId: 'i-page2', State: { Name: 'running' }, InstanceType: 't3.micro', Tags: [] }] }],
      });
    });
    cloudwatchSendMock.mockResolvedValue({ MetricDataResults: [] });

    const items = await collectEc2();

    expect(items.map((i) => i.instanceId).sort()).toEqual(['i-page1', 'i-page2']);
  });

  it('correctly maps hasScheduleTag/autoRightsizeExempt/pendingAutoRightsizeDirection/lastAutoRightsizeDate from tags (EC2_AutoRightsize)', async () => {
    ec2SendMock.mockResolvedValue({
      Reservations: [
        {
          Instances: [
            {
              InstanceId: 'i-scheduled1',
              InstanceType: 't3.large',
              State: { Name: 'running' },
              Tags: [
                { Key: 'Schedule:Start', Value: '08:00' },
                { Key: 'OpsDashboard:PendingAutoRightsize', Value: 'up' },
                { Key: 'OpsDashboard:LastAutoRightsizeDate', Value: '2026-08-01' },
              ],
            },
          ],
        },
      ],
    });
    cloudwatchSendMock.mockResolvedValue({ MetricDataResults: [] });

    const result = await collectEc2();

    expect(result).toHaveLength(1);
    expect(result[0].hasScheduleTag).toBe(true);
    expect(result[0].autoRightsizeExempt).toBe(false);
    expect(result[0].pendingAutoRightsizeDirection).toBe('up');
    expect(result[0].lastAutoRightsizeDate).toBe('2026-08-01');
  });

  it('correctly maps autoRightsizeExempt=true when the no-auto-rightsize tag is present, pendingAutoRightsizeDirection=undefined when missing/an unrecognized value', async () => {
    ec2SendMock.mockResolvedValue({
      Reservations: [
        {
          Instances: [
            {
              InstanceId: 'i-exempt1',
              InstanceType: 't3.large',
              State: { Name: 'running' },
              Tags: [
                { Key: 'OpsDashboard:NoAutoRightsize', Value: 'true' },
                { Key: 'OpsDashboard:PendingAutoRightsize', Value: 'sideways' },
              ],
            },
          ],
        },
      ],
    });
    cloudwatchSendMock.mockResolvedValue({ MetricDataResults: [] });

    const result = await collectEc2();

    expect(result).toHaveLength(1);
    expect(result[0].hasScheduleTag).toBe(false);
    expect(result[0].autoRightsizeExempt).toBe(true);
    expect(result[0].pendingAutoRightsizeDirection).toBeUndefined();
    expect(result[0].lastAutoRightsizeDate).toBeUndefined();
  });

  it('autoRightsizeExempt = true when the instance has the no-auto-sizing tag (NEW), even without the no-auto-rightsize tag (OLD)', async () => {
    ec2SendMock.mockResolvedValueOnce({
      Reservations: [
        {
          Instances: [
            {
              InstanceId: 'i-1',
              State: { Name: 'running' },
              InstanceType: 't3.large',
              Tags: [{ Key: 'OpsDashboard:NoAutoSizing', Value: '' }],
            },
          ],
        },
      ],
    });
    cloudwatchSendMock.mockResolvedValueOnce({ MetricDataResults: [] });

    const result = await collectEc2();

    expect(result[0]?.autoRightsizeExempt).toBe(true);
  });

  it('runs GetMetricData batches concurrently rather than strictly sequentially', async () => {
    // 3 batches worth of instances (INSTANCES_PER_BATCH = 120) -> 361 instances triggers 4 batches.
    // If batches ran sequentially, 4 batches x ~40ms delay each would take >= 160ms; run
    // concurrently, elapsed time should stay much closer to a single batch's delay.
    const instanceCount = 361;
    ec2SendMock.mockResolvedValue({
      Reservations: [
        {
          Instances: Array.from({ length: instanceCount }, (_, i) => ({
            InstanceId: `i-conc${i}`,
            InstanceType: 't3.micro',
            State: { Name: 'running' },
            Tags: [],
          })),
        },
      ],
    });
    const BATCH_DELAY_MS = 40;
    cloudwatchSendMock.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ MetricDataResults: [] }), BATCH_DELAY_MS)),
    );

    const start = Date.now();
    const result = await collectEc2();
    const elapsedMs = Date.now() - start;

    expect(result).toHaveLength(instanceCount);
    // 4 batches sequential would be >= 160ms; concurrent should stay well under 2x a single batch.
    expect(elapsedMs).toBeLessThan(BATCH_DELAY_MS * 2.5);
  });

  it('returns tagsRaw = the raw Tags array from DescribeInstances', async () => {
    ec2SendMock.mockResolvedValue({
      Reservations: [
        {
          Instances: [
            {
              InstanceId: 'i-tagsraw1',
              State: { Name: 'running' },
              InstanceType: 't3.large',
              Tags: [{ Key: 'OpsDashboard:MinInstanceType', Value: 't3.small' }],
            },
          ],
        },
      ],
    });
    cloudwatchSendMock.mockResolvedValue({ MetricDataResults: [] });

    const result = await collectEc2();

    expect(result[0]?.tagsRaw).toEqual([{ Key: 'OpsDashboard:MinInstanceType', Value: 't3.small' }]);
  });
});
