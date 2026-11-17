import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.AWS_REGION = 'ap-southeast-1';
process.env.ALARM_NOTIFICATION_TOPIC_ARN = 'arn:aws:sns:ap-southeast-1:123456789012:ops-dashboard-alarm-notifications';

const cloudwatchSendMock = vi.fn();
const ec2SendMock = vi.fn();
const rdsSendMock = vi.fn();
const elbSendMock = vi.fn();
const ecsSendMock = vi.fn();

vi.mock('@aws-sdk/client-cloudwatch', () => ({
  CloudWatchClient: vi.fn().mockImplementation(() => ({ send: cloudwatchSendMock })),
  DescribeAlarmsCommand: vi.fn().mockImplementation((input: unknown) => ({ __cmd: 'DescribeAlarms', input })),
  PutMetricAlarmCommand: vi.fn().mockImplementation((input: unknown) => ({ __cmd: 'PutMetricAlarm', input })),
  DeleteAlarmsCommand: vi.fn().mockImplementation((input: unknown) => ({ __cmd: 'DeleteAlarms', input })),
  // Used by discoverPublishedHostMetrics to find which CWAgent series actually exist. The existing
  // handler tests fall through to `Promise.resolve({})` for any command they do not care about,
  // which destructures to zero published metrics, i.e. no host alarms — so they keep asserting the
  // same EC2/RDS/ALB/ECS counts as before.
  ListMetricsCommand: vi.fn().mockImplementation((input: unknown) => ({ __cmd: 'ListMetrics', input })),
}));

vi.mock('@aws-sdk/client-ec2', () => ({
  EC2Client: vi.fn().mockImplementation(() => ({ send: ec2SendMock })),
  DescribeInstancesCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
}));

vi.mock('@aws-sdk/client-rds', () => ({
  RDSClient: vi.fn().mockImplementation(() => ({ send: rdsSendMock })),
  DescribeDBInstancesCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
}));

vi.mock('@aws-sdk/client-elastic-load-balancing-v2', () => ({
  ElasticLoadBalancingV2Client: vi.fn().mockImplementation(() => ({ send: elbSendMock })),
  DescribeLoadBalancersCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
  DescribeTargetGroupsCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
}));

vi.mock('@aws-sdk/client-ecs', () => ({
  ECSClient: vi.fn().mockImplementation(() => ({ send: ecsSendMock })),
  ListClustersCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
  ListServicesCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
  DescribeServicesCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
}));

const postDiscordEmbedsMock = vi.fn().mockResolvedValue(undefined);
vi.mock('./discordWebhook.js', () => ({
  postDiscordEmbeds: (...args: unknown[]) => postDiscordEmbedsMock(...args),
}));

const {
  handler,
  buildDesiredAlarmSpecs,
  buildHostAlarmSpecs,
  ALARM_NAME_PREFIX,
  isEc2WithinWarmup,
  EC2_ALARM_WARMUP_MINUTES,
} = await import('./alarm-baseline-manager.js');

const {
  RDS_SQLSERVER_FREEABLE_MEMORY_CRITICAL_BYTES,
  EC2_CWAGENT_CRITICAL_PERCENT,
  HOST_DISK_FREE_CRITICAL_PERCENT,
} = await import('../monitoring/monitoringThresholds.js');

beforeEach(() => {
  cloudwatchSendMock.mockReset();
  ec2SendMock.mockReset();
  rdsSendMock.mockReset();
  elbSendMock.mockReset();
  postDiscordEmbedsMock.mockClear();
  ecsSendMock.mockReset();
});

describe('buildDesiredAlarmSpecs — pure function, generates AlarmSpec[] per resource type', () => {
  it('EC2 online -> generates exactly 2 alarms (cpu-high, status-check-failed), names carry the standard prefix', () => {
    const specs = buildDesiredAlarmSpecs({ ec2: [{ instanceId: 'i-abc123', launchTime: undefined }], rds: [], alb: [], ecs: [] });

    expect(specs).toHaveLength(2);
    expect(specs.map((s) => s.alarmName)).toEqual(
      expect.arrayContaining([
        `${ALARM_NAME_PREFIX}ec2-cpu-high_i-abc123`,
        `${ALARM_NAME_PREFIX}ec2-status-check-failed_i-abc123`,
      ]),
    );
    const cpuSpec = specs.find((s) => s.metricName === 'CPUUtilization')!;
    expect(cpuSpec.namespace).toBe('AWS/EC2');
    expect(cpuSpec.dimensions).toEqual([{ Name: 'InstanceId', Value: 'i-abc123' }]);
    expect(cpuSpec.comparisonOperator).toBe('GreaterThanOrEqualToThreshold');
  });

  it('RDS with a DBInstanceClass PRESENT in RDS_INSTANCE_RAM_GIB -> generates all 5 alarms (cpu/storage/memory/read+write latency)', () => {
    const specs = buildDesiredAlarmSpecs({
      ec2: [],
      rds: [{ dbInstanceIdentifier: 'db-1', dbInstanceClass: 'db.m8i.large', engine: 'postgres', allocatedStorageGb: 100 }],
      alb: [],
      ecs: [],
    });

    expect(specs).toHaveLength(5);
    expect(specs.map((s) => s.metricName).sort()).toEqual(['CPUUtilization', 'FreeStorageSpace', 'FreeableMemory', 'ReadLatency', 'WriteLatency'].sort());
    const memSpec = specs.find((s) => s.metricName === 'FreeableMemory')!;
    expect(memSpec.comparisonOperator).toBe('LessThanOrEqualToThreshold');
    expect(memSpec.threshold).toBeGreaterThan(0);
  });

  it('RDS with a DBInstanceClass NOT in RDS_INSTANCE_RAM_GIB -> SKIPS the FreeableMemory alarm (fail-safe), still has cpu/storage', () => {
    const specs = buildDesiredAlarmSpecs({
      ec2: [],
      rds: [{ dbInstanceIdentifier: 'db-unknown-class', dbInstanceClass: 'db.unknown.class', engine: 'postgres', allocatedStorageGb: 50 }],
      alb: [],
      ecs: [],
    });

    expect(specs.map((s) => s.metricName).sort()).toEqual(['CPUUtilization', 'FreeStorageSpace', 'ReadLatency', 'WriteLatency'].sort());
  });

  it('RDS with allocatedStorageGb=0 -> skips the FreeStorageSpace alarm (avoids a meaningless threshold=0)', () => {
    const specs = buildDesiredAlarmSpecs({
      ec2: [],
      rds: [{ dbInstanceIdentifier: 'db-no-storage', dbInstanceClass: 'db.m8i.large', engine: 'postgres', allocatedStorageGb: 0 }],
      alb: [],
      ecs: [],
    });

    expect(specs.map((s) => s.metricName)).not.toContain('FreeStorageSpace');
  });

  it('RDS SQL Server -> the FreeableMemory alarm uses an ABSOLUTE BYTE floor, NOT a % of RAM', () => {
    const specs = buildDesiredAlarmSpecs({
      ec2: [],
      rds: [{ dbInstanceIdentifier: 'db-mssql', dbInstanceClass: 'db.r8i.large', engine: 'sqlserver-se', allocatedStorageGb: 60 }],
      alb: [],
      ecs: [],
    });

    const memSpec = specs.find((s) => s.metricName === 'FreeableMemory')!;
    expect(memSpec.comparisonOperator).toBe('LessThanOrEqualToThreshold');
    // Absolute floor, NOT dependent on the class's RAM.
    expect(memSpec.threshold).toBe(RDS_SQLSERVER_FREEABLE_MEMORY_CRITICAL_BYTES);
    // The old %-based threshold on a 16 GiB box was 1,717 GB — must be MUCH lower so it doesn't
    // false-alarm at a normal operating point (~1.77 GiB measured on abc-prod-rds-mssql).
    expect(memSpec.threshold).toBeLessThan(16 * 1024 ** 3 * 0.1);
  });

  it('RDS SQL Server with a class NOT in RDS_INSTANCE_RAM_GIB -> STILL generates the FreeableMemory alarm (the byte floor doesn\'t need a RAM lookup)', () => {
    const specs = buildDesiredAlarmSpecs({
      ec2: [],
      rds: [{ dbInstanceIdentifier: 'db-mssql-new', dbInstanceClass: 'db.future.class', engine: 'sqlserver-ee', allocatedStorageGb: 60 }],
      alb: [],
      ecs: [],
    });

    expect(specs.map((s) => s.metricName)).toContain('FreeableMemory');
  });

  it('ALB with 2 target groups -> generates 1 TargetResponseTime alarm (1 dimension) + 2 UnHealthyHostCount alarms (2 dimensions each, one per target group)', () => {
    const specs = buildDesiredAlarmSpecs({
      ec2: [],
      rds: [],
      alb: [
        {
          albName: 'my-alb',
          loadBalancerArnSuffix: 'app/my-alb/abc123',
          targetGroups: [
            { targetGroupName: 'tg-1', targetGroupArnSuffix: 'targetgroup/tg-1/aaa' },
            { targetGroupName: 'tg-2', targetGroupArnSuffix: 'targetgroup/tg-2/bbb' },
          ],
        },
      ],
      ecs: [],
    });

    expect(specs).toHaveLength(3);
    const responseTimeSpec = specs.find((s) => s.metricName === 'TargetResponseTime')!;
    expect(responseTimeSpec.dimensions).toEqual([{ Name: 'LoadBalancer', Value: 'app/my-alb/abc123' }]);

    const unhealthySpecs = specs.filter((s) => s.metricName === 'UnHealthyHostCount');
    expect(unhealthySpecs).toHaveLength(2);
    for (const spec of unhealthySpecs) {
      // Original bug fix: UnHealthyHostCount MUST have BOTH the TargetGroup and LoadBalancer
      // dimensions — a dimension set with only LoadBalancer (like the old abc-prod-alb-unhealthy-hosts
      // alarm) stays stuck in INSUFFICIENT_DATA forever because AWS never publishes a datapoint for
      // that combination.
      expect(spec.dimensions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ Name: 'TargetGroup' }),
          expect.objectContaining({ Name: 'LoadBalancer', Value: 'app/my-alb/abc123' }),
        ]),
      );
      expect(spec.dimensions).toHaveLength(2);
    }
  });

  it('NLB with 1 target group -> generates 1 UnHealthyHostCount alarm on AWS/NetworkELB, NEVER a TargetResponseTime alarm', () => {
    const specs = buildDesiredAlarmSpecs({
      ec2: [],
      rds: [],
      alb: [],
      nlb: [
        {
          nlbName: 'my-nlb',
          loadBalancerArnSuffix: 'net/my-nlb/xyz789',
          targetGroups: [{ targetGroupName: 'nlb-tg-1', targetGroupArnSuffix: 'targetgroup/nlb-tg-1/ccc' }],
        },
      ],
      ecs: [],
    });

    expect(specs).toHaveLength(1);
    expect(specs.map((s) => s.metricName)).not.toContain('TargetResponseTime');
    const spec = specs[0];
    expect(spec.metricName).toBe('UnHealthyHostCount');
    expect(spec.namespace).toBe('AWS/NetworkELB');
    expect(spec.dimensions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ Name: 'TargetGroup', Value: 'targetgroup/nlb-tg-1/ccc' }),
        expect.objectContaining({ Name: 'LoadBalancer', Value: 'net/my-nlb/xyz789' }),
      ]),
    );
  });

  it('nlb key absent from the inventory (backward compat) -> generates 0 NLB alarms, does not throw', () => {
    const specs = buildDesiredAlarmSpecs({ ec2: [], rds: [], alb: [], ecs: [] });
    expect(specs.map((s) => s.namespace)).not.toContain('AWS/NetworkELB');
  });

  it('ECS service -> generates 2 alarms (cpu/memory) with both ClusterName+ServiceName dimensions', () => {
    const specs = buildDesiredAlarmSpecs({
      ec2: [],
      rds: [],
      alb: [],
      ecs: [{ clusterName: 'my-cluster', serviceName: 'my-service' }],
    });

    expect(specs).toHaveLength(2);
    for (const spec of specs) {
      expect(spec.namespace).toBe('AWS/ECS');
      expect(spec.dimensions).toEqual(
        expect.arrayContaining([
          { Name: 'ClusterName', Value: 'my-cluster' },
          { Name: 'ServiceName', Value: 'my-service' },
        ]),
      );
    }
  });

  it('a fully empty inventory -> returns an empty array, does not throw', () => {
    expect(buildDesiredAlarmSpecs({ ec2: [], rds: [], alb: [], ecs: [] })).toEqual([]);
  });
});

describe('EC2 warm-up window — does not create cpu-high/status-check-failed alarms right after an instance just started (avoids false alarms when a resource follows an on/off schedule)', () => {
  const now = new Date('2026-08-12T10:00:00.000Z');

  it('isEc2WithinWarmup: launchTime is less than EC2_ALARM_WARMUP_MINUTES before now -> true', () => {
    const launchTime = new Date(now.getTime() - (EC2_ALARM_WARMUP_MINUTES - 1) * 60 * 1000);
    expect(isEc2WithinWarmup(launchTime, now)).toBe(true);
  });

  it('isEc2WithinWarmup: launchTime is at least EC2_ALARM_WARMUP_MINUTES before now -> false', () => {
    const launchTime = new Date(now.getTime() - EC2_ALARM_WARMUP_MINUTES * 60 * 1000);
    expect(isEc2WithinWarmup(launchTime, now)).toBe(false);
  });

  it('isEc2WithinWarmup: launchTime undefined (AWS did not return the field) -> false (fail-safe, no guessing)', () => {
    expect(isEc2WithinWarmup(undefined, now)).toBe(false);
  });

  it('buildDesiredAlarmSpecs: an instance that just started (launchTime = now) -> NO ec2-cpu-high/ec2-status-check-failed alarms', () => {
    const specs = buildDesiredAlarmSpecs({ ec2: [{ instanceId: 'i-just-started', launchTime: now }], rds: [], alb: [], ecs: [] }, now);
    expect(specs).toEqual([]);
  });

  it('buildDesiredAlarmSpecs: an instance running past the warm-up window -> has both alarms as usual', () => {
    const launchTime = new Date(now.getTime() - (EC2_ALARM_WARMUP_MINUTES + 5) * 60 * 1000);
    const specs = buildDesiredAlarmSpecs({ ec2: [{ instanceId: 'i-stable', launchTime }], rds: [], alb: [], ecs: [] }, now);
    expect(specs).toHaveLength(2);
  });

  it('buildDesiredAlarmSpecs: 2 instances, 1 just started + 1 already stable -> only the stable instance gets alarms', () => {
    const stableLaunchTime = new Date(now.getTime() - 30 * 60 * 1000);
    const specs = buildDesiredAlarmSpecs(
      {
        ec2: [
          { instanceId: 'i-warming', launchTime: now },
          { instanceId: 'i-stable', launchTime: stableLaunchTime },
        ],
        rds: [],
        alb: [],
        ecs: [],
      },
      now,
    );
    expect(specs.every((s) => s.alarmName.includes('i-stable'))).toBe(true);
    expect(specs.some((s) => s.alarmName.includes('i-warming'))).toBe(false);
  });
});

describe('discoverOnlineAlb (via handler) — extracts the EXACT dimension value CloudWatch requires from a real ARN', () => {
  // Real bug found through direct AWS verification (ListMetrics): the `LoadBalancer` dimension
  // DROPS the resource-type prefix ("app/<name>/<id>"), but the `TargetGroup` dimension KEEPS
  // that prefix ("targetgroup/<name>/<id>") — 2 DIFFERENT conventions for 2 dimensions of the
  // SAME API. This test uses the account's ACTUAL real ARNs (abc-prod-alb/abc-prod-api-tg) to
  // make sure the bug never recurs.
  it('the LoadBalancer dimension value has NO "loadbalancer/" prefix, the TargetGroup dimension value HAS the "targetgroup/" prefix', async () => {
    ec2SendMock.mockResolvedValue({ Reservations: [] });
    rdsSendMock.mockResolvedValue({ DBInstances: [] });
    ecsSendMock.mockResolvedValue({ clusterArns: [] });
    elbSendMock.mockImplementation((command: { input?: { LoadBalancerArn?: string } }) => {
      if (command.input?.LoadBalancerArn) {
        return Promise.resolve({
          TargetGroups: [
            {
              TargetGroupName: 'abc-prod-api-tg',
              TargetGroupArn: 'arn:aws:elasticloadbalancing:ap-southeast-1:123456789012:targetgroup/abc-prod-api-tg/aaaabbbbccccdddd',
            },
          ],
        });
      }
      return Promise.resolve({
        LoadBalancers: [
          {
            LoadBalancerName: 'abc-prod-alb',
            Type: 'application',
            LoadBalancerArn: 'arn:aws:elasticloadbalancing:ap-southeast-1:123456789012:loadbalancer/app/abc-prod-alb/0123456789abcdef',
          },
        ],
      });
    });
    cloudwatchSendMock.mockImplementation((command: { __cmd: string }) => {
      if (command.__cmd === 'DescribeAlarms') return Promise.resolve({ MetricAlarms: [] });
      return Promise.resolve({});
    });

    await handler();

    const putCalls = cloudwatchSendMock.mock.calls.filter((c) => c[0].__cmd === 'PutMetricAlarm');
    const unhealthyCall = putCalls.find((c) => c[0].input.MetricName === 'UnHealthyHostCount')!;
    const dims = unhealthyCall[0].input.Dimensions as { Name: string; Value: string }[];

    expect(dims.find((d) => d.Name === 'LoadBalancer')?.Value).toBe('app/abc-prod-alb/0123456789abcdef');
    expect(dims.find((d) => d.Name === 'TargetGroup')?.Value).toBe('targetgroup/abc-prod-api-tg/aaaabbbbccccdddd');

    const responseTimeCall = putCalls.find((c) => c[0].input.MetricName === 'TargetResponseTime')!;
    const rtDims = responseTimeCall[0].input.Dimensions as { Name: string; Value: string }[];
    expect(rtDims).toEqual([{ Name: 'LoadBalancer', Value: 'app/abc-prod-alb/0123456789abcdef' }]);
  });

  // Another real bug found: DescribeLoadBalancers returns BOTH ALBs (Type='application') AND NLBs
  // (Type='network', e.g. abc-prod-nlb-kafka in the real account) — NLBs use the entirely
  // different AWS/NetworkELB namespace and have NO TargetResponseTime (Layer 4). Creating an ALB
  // alarm for an NLB would stay stuck in INSUFFICIENT_DATA forever — exactly reproducing the
  // original bug that was investigated. NLB does NOT get an ALB-shaped alarm (no TargetResponseTime
  // at all), but it DOES get its own AWS/NetworkELB UnHealthyHostCount alarm per target group.
  it('a Network Load Balancer (Type=network) with a target group -> gets an AWS/NetworkELB UnHealthyHostCount alarm, never an ALB-shaped one', async () => {
    ec2SendMock.mockResolvedValue({ Reservations: [] });
    rdsSendMock.mockResolvedValue({ DBInstances: [] });
    ecsSendMock.mockResolvedValue({ clusterArns: [] });
    elbSendMock.mockImplementation((command: { input?: { LoadBalancerArn?: string } }) => {
      if (command.input?.LoadBalancerArn?.includes('nlb-kafka')) {
        return Promise.resolve({
          TargetGroups: [
            {
              TargetGroupName: 'kafka-tg',
              TargetGroupArn: 'arn:aws:elasticloadbalancing:ap-southeast-1:123456789012:targetgroup/kafka-tg/9988776655443322',
            },
          ],
        });
      }
      if (command.input?.LoadBalancerArn) return Promise.resolve({ TargetGroups: [] });
      return Promise.resolve({
        LoadBalancers: [
          {
            LoadBalancerName: 'abc-prod-nlb-kafka',
            Type: 'network',
            LoadBalancerArn: 'arn:aws:elasticloadbalancing:ap-southeast-1:123456789012:loadbalancer/net/abc-prod-nlb-kafka/5555666677778888',
          },
          {
            LoadBalancerName: 'abc-prod-alb',
            Type: 'application',
            LoadBalancerArn: 'arn:aws:elasticloadbalancing:ap-southeast-1:123456789012:loadbalancer/app/abc-prod-alb/0123456789abcdef',
          },
        ],
      });
    });
    cloudwatchSendMock.mockImplementation((command: { __cmd: string }) => {
      if (command.__cmd === 'DescribeAlarms') return Promise.resolve({ MetricAlarms: [] });
      return Promise.resolve({});
    });

    await handler();

    const putCalls = cloudwatchSendMock.mock.calls.filter((c) => c[0].__cmd === 'PutMetricAlarm');
    // ALB's TargetResponseTime (0 target groups -> no UnHealthyHostCount for the ALB) + the NLB's
    // own UnHealthyHostCount alarm for its 1 target group.
    expect(putCalls).toHaveLength(2);

    const albCall = putCalls.find((c) => (c[0].input.AlarmName as string).includes('abc-prod-alb'))!;
    expect(albCall[0].input.MetricName).toBe('TargetResponseTime');
    expect(albCall[0].input.Namespace).toBe('AWS/ApplicationELB');

    const nlbCall = putCalls.find((c) => (c[0].input.AlarmName as string).includes('nlb-kafka'))!;
    expect(nlbCall[0].input.MetricName).toBe('UnHealthyHostCount');
    expect(nlbCall[0].input.Namespace).toBe('AWS/NetworkELB');
    const nlbDims = nlbCall[0].input.Dimensions as { Name: string; Value: string }[];
    expect(nlbDims.find((d) => d.Name === 'LoadBalancer')?.Value).toBe('net/abc-prod-nlb-kafka/5555666677778888');
    expect(nlbDims.find((d) => d.Name === 'TargetGroup')?.Value).toBe('targetgroup/kafka-tg/9988776655443322');
  });
});

describe('handler — reconcile loop (discover -> PutMetricAlarm -> DeleteAlarms orphans)', () => {
  function mockDiscoveryEmpty(): void {
    ec2SendMock.mockResolvedValue({ Reservations: [] });
    rdsSendMock.mockResolvedValue({ DBInstances: [] });
    elbSendMock.mockResolvedValue({ LoadBalancers: [] });
    ecsSendMock.mockResolvedValue({ clusterArns: [] });
  }

  it('an inventory with 1 online EC2 -> PutMetricAlarm is called exactly twice with AlarmActions/OKActions = the SNS topic, InsufficientDataActions NOT set', async () => {
    ec2SendMock.mockResolvedValue({
      Reservations: [
        { Instances: [{ InstanceId: 'i-test1', State: { Name: 'running' }, LaunchTime: new Date('2020-01-01T00:00:00.000Z') }] },
      ],
    });
    rdsSendMock.mockResolvedValue({ DBInstances: [] });
    elbSendMock.mockResolvedValue({ LoadBalancers: [] });
    ecsSendMock.mockResolvedValue({ clusterArns: [] });
    cloudwatchSendMock.mockImplementation((command: { __cmd: string }) => {
      if (command.__cmd === 'DescribeAlarms') return Promise.resolve({ MetricAlarms: [] });
      return Promise.resolve({});
    });

    const result = await handler();

    expect(result.ok).toBe(true);
    expect(result.created).toBe(2);
    expect(result.deleted).toBe(0);

    const putCalls = cloudwatchSendMock.mock.calls.filter((c) => c[0].__cmd === 'PutMetricAlarm');
    expect(putCalls).toHaveLength(2);
    for (const call of putCalls) {
      expect(call[0].input.AlarmActions).toEqual(['arn:aws:sns:ap-southeast-1:123456789012:ops-dashboard-alarm-notifications']);
      expect(call[0].input.OKActions).toEqual(['arn:aws:sns:ap-southeast-1:123456789012:ops-dashboard-alarm-notifications']);
      expect(call[0].input.InsufficientDataActions).toBeUndefined();
    }
  });

  it('merges paginated online-EC2 results when DescribeInstances returns a NextToken, creating alarms for both pages', async () => {
    ec2SendMock
      .mockResolvedValueOnce({
        Reservations: [
          { Instances: [{ InstanceId: 'i-page1', State: { Name: 'running' }, LaunchTime: new Date('2020-01-01T00:00:00Z') }] },
        ],
        NextToken: 'token-page-2',
      })
      .mockResolvedValueOnce({
        Reservations: [
          { Instances: [{ InstanceId: 'i-page2', State: { Name: 'running' }, LaunchTime: new Date('2020-01-01T00:00:00Z') }] },
        ],
      });
    rdsSendMock.mockResolvedValue({ DBInstances: [] });
    elbSendMock.mockResolvedValue({ LoadBalancers: [] });
    ecsSendMock.mockResolvedValue({ clusterArns: [] });
    cloudwatchSendMock.mockImplementation((command: { __cmd: string }) => {
      if (command.__cmd === 'DescribeAlarms') return Promise.resolve({ MetricAlarms: [] });
      return Promise.resolve({});
    });

    await handler();

    const putCalls = cloudwatchSendMock.mock.calls.filter((c) => c[0].__cmd === 'PutMetricAlarm');
    const alarmedNames = putCalls.map((c) => c[0].input.AlarmName as string).filter((name) => name.includes('ec2-cpu-high'));
    expect(alarmedNames.some((name) => name.includes('i-page1'))).toBe(true);
    expect(alarmedNames.some((name) => name.includes('i-page2'))).toBe(true);
  });

  it('a standard alarm exists but the resource has been deleted (no longer in inventory) -> DeleteAlarms is called for that exact orphaned alarm', async () => {
    mockDiscoveryEmpty();
    cloudwatchSendMock.mockImplementation((command: { __cmd: string }) => {
      if (command.__cmd === 'DescribeAlarms') {
        return Promise.resolve({
          MetricAlarms: [
            { AlarmName: `${ALARM_NAME_PREFIX}ec2-cpu-high_i-deleted` },
            { AlarmName: `${ALARM_NAME_PREFIX}ec2-status-check-failed_i-deleted` },
          ],
        });
      }
      return Promise.resolve({});
    });

    const result = await handler();

    expect(result.created).toBe(0);
    expect(result.deleted).toBe(2);
    const deleteCall = cloudwatchSendMock.mock.calls.find((c) => c[0].__cmd === 'DeleteAlarms')!;
    expect(deleteCall[0].input.AlarmNames).toEqual(
      expect.arrayContaining([`${ALARM_NAME_PREFIX}ec2-cpu-high_i-deleted`, `${ALARM_NAME_PREFIX}ec2-status-check-failed_i-deleted`]),
    );
  });

  it('DescribeAlarms uses the correct ALARM_NAME_PREFIX -> NEVER lists/deletes an out-of-scope alarm (e.g. CIS-*/TargetTracking-*)', async () => {
    mockDiscoveryEmpty();
    cloudwatchSendMock.mockImplementation((command: { __cmd: string }) => {
      if (command.__cmd === 'DescribeAlarms') return Promise.resolve({ MetricAlarms: [] });
      return Promise.resolve({});
    });

    await handler();

    const describeCall = cloudwatchSendMock.mock.calls.find((c) => c[0].__cmd === 'DescribeAlarms')!;
    expect(describeCall[0].input.AlarmNamePrefix).toBe(ALARM_NAME_PREFIX);
  });

  it('one PutMetricAlarm throws a non-throttling error for one spec -> does not throw out of the handler, other specs are still applied (records the error, continues)', async () => {
    ec2SendMock.mockResolvedValue({
      Reservations: [
        { Instances: [{ InstanceId: 'i-test1', State: { Name: 'running' }, LaunchTime: new Date('2020-01-01T00:00:00.000Z') }] },
      ],
    });
    rdsSendMock.mockResolvedValue({ DBInstances: [] });
    elbSendMock.mockResolvedValue({ LoadBalancers: [] });
    ecsSendMock.mockResolvedValue({ clusterArns: [] });

    let putCallCount = 0;
    cloudwatchSendMock.mockImplementation((command: { __cmd: string }) => {
      if (command.__cmd === 'DescribeAlarms') return Promise.resolve({ MetricAlarms: [] });
      if (command.__cmd === 'PutMetricAlarm') {
        putCallCount += 1;
        if (putCallCount === 1) return Promise.reject(new Error('ValidationException'));
        return Promise.resolve({});
      }
      return Promise.resolve({});
    });

    await expect(handler()).resolves.toEqual({ ok: true, created: 1, deleted: 0 });
  });

  it('PutMetricAlarm throttling (err.name === "Throttling") -> retries with backoff, succeeds after a few attempts', async () => {
    ec2SendMock.mockResolvedValue({
      Reservations: [
        { Instances: [{ InstanceId: 'i-test1', State: { Name: 'running' }, LaunchTime: new Date('2020-01-01T00:00:00.000Z') }] },
      ],
    });
    rdsSendMock.mockResolvedValue({ DBInstances: [] });
    elbSendMock.mockResolvedValue({ LoadBalancers: [] });
    ecsSendMock.mockResolvedValue({ clusterArns: [] });

    const throttlingError = Object.assign(new Error('Rate exceeded'), { name: 'Throttling' });
    let putCallCount = 0;
    cloudwatchSendMock.mockImplementation((command: { __cmd: string }) => {
      if (command.__cmd === 'DescribeAlarms') return Promise.resolve({ MetricAlarms: [] });
      if (command.__cmd === 'PutMetricAlarm') {
        putCallCount += 1;
        if (putCallCount <= 2) return Promise.reject(throttlingError);
        return Promise.resolve({});
      }
      return Promise.resolve({});
    });

    await expect(handler()).resolves.toEqual({ ok: true, created: 2, deleted: 0 });
    // 2 alarm specs (ec2-cpu-high + ec2-status-check-failed) — the first spec retries twice before
    // succeeding on the 3rd attempt, the second spec succeeds right away -> 4 PutMetricAlarm calls total.
    const putCalls = cloudwatchSendMock.mock.calls.filter((c) => c[0].__cmd === 'PutMetricAlarm');
    expect(putCalls.length).toBe(4);
  });

  it('PutMetricAlarm throttling repeatedly exceeds the max retry count -> still throws so the handler records the failure (no infinite retry)', async () => {
    // 2 specs x max backoff (500+1000+1500ms=3000ms per spec) -> needs a timeout above the default 5000ms.
    ec2SendMock.mockResolvedValue({
      Reservations: [{ Instances: [{ InstanceId: 'i-test1', State: { Name: 'running' }, LaunchTime: new Date('2020-01-01T00:00:00.000Z') }] }],
    });
    rdsSendMock.mockResolvedValue({ DBInstances: [] });
    elbSendMock.mockResolvedValue({ LoadBalancers: [] });
    ecsSendMock.mockResolvedValue({ clusterArns: [] });

    const throttlingError = Object.assign(new Error('Rate exceeded'), { name: 'Throttling' });
    cloudwatchSendMock.mockImplementation((command: { __cmd: string }) => {
      if (command.__cmd === 'DescribeAlarms') return Promise.resolve({ MetricAlarms: [] });
      if (command.__cmd === 'PutMetricAlarm') return Promise.reject(throttlingError);
      return Promise.resolve({});
    });

    const result = await handler();
    expect(result.created).toBe(0);
  }, 10000);

  it('DeleteAlarms throws an error -> does not throw out of the handler (logs the error, treated as a retry on the next reconcile pass)', async () => {
    mockDiscoveryEmpty();
    cloudwatchSendMock.mockImplementation((command: { __cmd: string }) => {
      if (command.__cmd === 'DescribeAlarms') {
        return Promise.resolve({ MetricAlarms: [{ AlarmName: `${ALARM_NAME_PREFIX}ec2-cpu-high_i-deleted` }] });
      }
      if (command.__cmd === 'DeleteAlarms') return Promise.reject(new Error('AccessDenied'));
      return Promise.resolve({});
    });

    await expect(handler()).resolves.toMatchObject({ ok: true, deleted: 0 });
  });

  it('calls postDiscordEmbeds when PutMetricAlarm fails for at least 1 spec', async () => {
    ec2SendMock.mockResolvedValue({ Reservations: [{ Instances: [{ InstanceId: 'i-x', State: { Name: 'running' }, LaunchTime: new Date(0) }] }] });
    rdsSendMock.mockResolvedValue({ DBInstances: [] });
    elbSendMock.mockResolvedValue({ LoadBalancers: [] });
    ecsSendMock.mockResolvedValue({ clusterArns: [] });
    cloudwatchSendMock.mockImplementation((command: { __cmd?: string }) => {
      if (command.__cmd === 'DescribeAlarms') return Promise.resolve({ MetricAlarms: [] });
      if (command.__cmd === 'PutMetricAlarm') return Promise.reject(new Error('Throttling'));
      return Promise.resolve({});
    });

    await handler();

    expect(postDiscordEmbedsMock).toHaveBeenCalledTimes(1);
    const embeds = postDiscordEmbedsMock.mock.calls[0][0];
    expect(embeds[0].title).toContain('alarm-baseline-manager');
    // Requirement: name WHICH alarms failed and WHY, not just a bare count — an operator should
    // be able to act from the notification alone, without opening CloudWatch Logs.
    const failedField = embeds[0].fields.find((f: { name: string }) => f.name === 'Failed alarms');
    expect(failedField).toBeDefined();
    expect(failedField.value).toContain('ec2-cpu-high_i-x');
    expect(failedField.value).toContain('Throttling');
  });

  it('does NOT call postDiscordEmbeds when every PutMetricAlarm/DeleteAlarms call succeeds', async () => {
    ec2SendMock.mockResolvedValue({ Reservations: [] });
    rdsSendMock.mockResolvedValue({ DBInstances: [] });
    elbSendMock.mockResolvedValue({ LoadBalancers: [] });
    ecsSendMock.mockResolvedValue({ clusterArns: [] });
    cloudwatchSendMock.mockResolvedValue({ MetricAlarms: [] });

    await handler();

    expect(postDiscordEmbedsMock).not.toHaveBeenCalled();
  });
});

describe('buildHostAlarmSpecs — CloudWatch Agent disk/memory alarms', () => {
  const INSTANCE = 'i-0a1b2c3d4e5f60007';

  /** The dimension set the agent really publishes for a Windows LogicalDisk counter — confirmed
   *  against the live account with GetMetricStatistics, which returned datapoints only for this
   *  exact three-dimension combination. */
  const windowsDisk = (drive: string) => ({
    metricName: 'LogicalDisk % Free Space',
    dimensions: [
      { Name: 'InstanceId', Value: INSTANCE },
      { Name: 'objectname', Value: 'LogicalDisk' },
      { Name: 'instance', Value: drive },
    ],
  });

  // ---- The one thing most worth pinning ----
  it('Windows "% Free Space" alarms on the LOW side — the opposite polarity to Linux', () => {
    const [spec] = buildHostAlarmSpecs([windowsDisk('C:')]);

    // If this ever flips to GreaterThanOrEqual, the alarm goes quiet EXACTLY when the disk fills up,
    // while still appearing in the alarm list as coverage. That is worse than having no alarm.
    expect(spec.comparisonOperator).toBe('LessThanOrEqualToThreshold');
    expect(spec.threshold).toBe(HOST_DISK_FREE_CRITICAL_PERCENT);
    expect(spec.threshold).toBeLessThan(50); // a % FREE floor, never a % USED ceiling
  });

  it('Linux disk/memory alarm on the HIGH side, at the shared CWAgent critical threshold', () => {
    const specs = buildHostAlarmSpecs([
      { metricName: 'disk_used_percent', dimensions: [{ Name: 'InstanceId', Value: 'i-linux' }] },
      { metricName: 'mem_used_percent', dimensions: [{ Name: 'InstanceId', Value: 'i-linux' }] },
    ]);

    expect(specs).toHaveLength(2);
    for (const spec of specs) {
      expect(spec.comparisonOperator).toBe('GreaterThanOrEqualToThreshold');
      expect(spec.threshold).toBe(EC2_CWAGENT_CRITICAL_PERCENT);
    }
  });

  it('the two polarities are genuinely complementary, not the same number twice', () => {
    expect(HOST_DISK_FREE_CRITICAL_PERCENT).toBe(100 - EC2_CWAGENT_CRITICAL_PERCENT);
  });

  // ---- Per-drive, because averaging drives hides a full one ----
  it('creates ONE alarm PER DRIVE, each carrying its own drive dimension', () => {
    const specs = buildHostAlarmSpecs([windowsDisk('C:'), windowsDisk('D:'), windowsDisk('E:')]);

    expect(specs).toHaveLength(3);
    const drives = specs.map((s) => s.dimensions.find((d) => d.Name === 'instance')?.Value);
    expect(drives).toEqual(['C:', 'D:', 'E:']);
    // Distinct alarm names, otherwise the three PutMetricAlarm calls would overwrite each other and
    // only the last drive would end up monitored.
    expect(new Set(specs.map((s) => s.alarmName)).size).toBe(3);
    expect(specs[0].alarmName).toContain('C_'); // ':' is not allowed in an alarm name
  });

  it('carries the dimension set through VERBATIM, so the alarm can actually match a datapoint', () => {
    const published = windowsDisk('D:');
    const [spec] = buildHostAlarmSpecs([published]);

    expect(spec.namespace).toBe('CWAgent');
    expect(spec.dimensions).toEqual(published.dimensions);
  });

  // ---- Never invent an alarm for a host that publishes nothing ----
  it('publishes nothing -> creates nothing (no permanently INSUFFICIENT_DATA alarm)', () => {
    expect(buildHostAlarmSpecs([])).toEqual([]);
  });

  it('ignores metrics outside the rule set and series with no InstanceId', () => {
    const specs = buildHostAlarmSpecs([
      { metricName: 'swap_used_percent', dimensions: [{ Name: 'InstanceId', Value: 'i-linux' }] },
      { metricName: 'disk_used_percent', dimensions: [{ Name: 'path', Value: '/' }] },
    ]);

    expect(specs).toEqual([]);
  });

  it('skips a LogicalDisk series that has no drive dimension instead of guessing one', () => {
    const specs = buildHostAlarmSpecs([
      { metricName: 'LogicalDisk % Free Space', dimensions: [{ Name: 'InstanceId', Value: INSTANCE }] },
    ]);

    expect(specs).toEqual([]);
  });

  // ---- Duplicate granularities must not multiply notifications ----
  it('given both an aggregated and a per-filesystem series, alarms once on the aggregated one', () => {
    const specs = buildHostAlarmSpecs([
      {
        metricName: 'disk_used_percent',
        dimensions: [
          { Name: 'InstanceId', Value: 'i-linux' },
          { Name: 'path', Value: '/' },
          { Name: 'fstype', Value: 'ext4' },
        ],
      },
      { metricName: 'disk_used_percent', dimensions: [{ Name: 'InstanceId', Value: 'i-linux' }] },
    ]);

    expect(specs).toHaveLength(1);
    expect(specs[0].dimensions).toEqual([{ Name: 'InstanceId', Value: 'i-linux' }]);
  });

  // ---- Evaluation settings must match how often the agent actually reports ----
  it('period matches the 300s agent collection interval and misses do not page', () => {
    const [spec] = buildHostAlarmSpecs([windowsDisk('C:')]);

    expect(spec.period).toBe(300);
    expect(spec.evaluationPeriods).toBe(2);
    // A host stopped by the on/off schedule publishes nothing; that is not an incident.
    expect(spec.treatMissingData).toBe('notBreaching');
  });

  it('host alarms join the same managed prefix, so orphan cleanup covers them too', () => {
    const specs = buildHostAlarmSpecs([windowsDisk('C:')]);
    expect(specs[0].alarmName.startsWith(ALARM_NAME_PREFIX)).toBe(true);
  });

  it('reaches the desired set through buildDesiredAlarmSpecs', () => {
    const specs = buildDesiredAlarmSpecs({
      ec2: [],
      rds: [],
      alb: [],
      ecs: [],
      hostMetrics: [windowsDisk('C:')],
    });

    expect(specs).toHaveLength(1);
    expect(specs[0].metricName).toBe('LogicalDisk % Free Space');
  });

  it('an inventory with no hostMetrics field still works (older callers)', () => {
    expect(buildDesiredAlarmSpecs({ ec2: [], rds: [], alb: [], ecs: [] })).toEqual([]);
  });
});
