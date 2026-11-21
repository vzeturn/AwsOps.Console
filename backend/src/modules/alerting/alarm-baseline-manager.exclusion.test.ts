import { describe, it, expect, vi } from 'vitest';

// The exclusion list is read at MODULE SCOPE, so it has to be set before the import — hence a separate
// test file rather than adding cases to alarm-baseline-manager.test.ts.
//
// What is being pinned: excluding a resource must remove ONLY that resource's alarms, must match
// EXACTLY (so `abc-prod-alb` is never caught by an entry aimed at a differently-named ALB), and must
// leave every other resource's alarms untouched. Getting this wrong silently disables production
// monitoring, which is a worse outcome than the alarm noise it exists to suppress.
process.env.AWS_REGION = 'ap-southeast-1';
process.env.ALARM_NOTIFICATION_TOPIC_ARN = 'arn:aws:sns:ap-southeast-1:123456789012:t';
process.env.ALARM_BASELINE_EXCLUDED_RESOURCES =
  ' abc-smoketest-alb , abc-stg-alb ,i-0excluded, db-excluded ,cluster-x/service-y,';

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
vi.mock('./alertHook.js', () => ({ postAlertEmbeds: vi.fn() }));

const { buildDesiredAlarmSpecs, buildHostAlarmSpecs, isExcludedResource } = await import(
  './alarm-baseline-manager.js'
);

const alb = (name: string, tgs: string[]) => ({
  albName: name,
  loadBalancerArnSuffix: `app/${name}/abc123`,
  targetGroups: tgs.map((t) => ({ targetGroupName: t, targetGroupArnSuffix: `targetgroup/${t}/def` })),
});

describe('ALARM_BASELINE_EXCLUDED_RESOURCES', () => {
  it('parses a CSV with stray whitespace and a trailing comma', () => {
    expect(isExcludedResource('abc-smoketest-alb')).toBe(true);
    expect(isExcludedResource('abc-stg-alb')).toBe(true);
    expect(isExcludedResource('i-0excluded')).toBe(true);
    expect(isExcludedResource('db-excluded')).toBe(true);
    expect(isExcludedResource('cluster-x/service-y')).toBe(true);
    expect(isExcludedResource('')).toBe(false);
  });

  it('matches EXACTLY — never by prefix or substring', () => {
    // The whole point: an entry for one ALB must not silently take out a similarly-named production one.
    expect(isExcludedResource('abc-prod-alb')).toBe(false);
    expect(isExcludedResource('abc-stg-alb-2')).toBe(false);
    expect(isExcludedResource('stg-alb')).toBe(false);
    expect(isExcludedResource('ABC-STG-ALB')).toBe(false); // case-sensitive, like the AWS identifiers
  });

  it('drops the excluded ALBs and their target-group alarms, keeps production intact', () => {
    const specs = buildDesiredAlarmSpecs({
      ec2: [],
      rds: [],
      alb: [
        alb('abc-prod-alb', ['abc-prod-api-tg', 'abc-prod-grafana-tg']),
        alb('abc-smoketest-alb', ['partners-smoketest-tg', 'pgadmin-smoketest-tg']),
        alb('abc-stg-alb', ['partners-stg-tg']),
      ],
      ecs: [],
    });

    const names = specs.map((s) => s.alarmName);
    expect(names.some((n) => n.includes('abc-smoketest-alb'))).toBe(false);
    expect(names.some((n) => n.includes('abc-stg-alb'))).toBe(false);

    // Production keeps 1 response-time alarm + 1 unhealthy-hosts alarm per target group.
    expect(names.filter((n) => n.includes('abc-prod-alb'))).toHaveLength(3);
    expect(specs).toHaveLength(3);
  });

  it('applies to EC2, RDS and ECS too, not just ALB', () => {
    const specs = buildDesiredAlarmSpecs({
      ec2: [
        { instanceId: 'i-0excluded', launchTime: undefined },
        { instanceId: 'i-0kept', launchTime: undefined },
      ],
      rds: [
        { dbInstanceIdentifier: 'db-excluded', dbInstanceClass: 'db.m8i.large', engine: 'postgres', allocatedStorageGb: 100 },
        { dbInstanceIdentifier: 'db-kept', dbInstanceClass: 'db.m8i.large', engine: 'postgres', allocatedStorageGb: 100 },
      ],
      alb: [],
      ecs: [
        { clusterName: 'cluster-x', serviceName: 'service-y' },
        { clusterName: 'cluster-x', serviceName: 'service-kept' },
      ],
    });

    const names = specs.map((s) => s.alarmName).join('\n');
    expect(names).not.toContain('i-0excluded');
    expect(names).not.toContain('db-excluded');
    expect(names).not.toContain('service-y');

    expect(names).toContain('i-0kept');
    expect(names).toContain('db-kept');
    expect(names).toContain('service-kept');
  });

  it('applies to host-level disk/memory alarms as well', () => {
    const disk = (iid: string) => ({
      metricName: 'LogicalDisk % Free Space',
      dimensions: [
        { Name: 'InstanceId', Value: iid },
        { Name: 'objectname', Value: 'LogicalDisk' },
        { Name: 'instance', Value: 'C:' },
      ],
    });

    const specs = buildHostAlarmSpecs([disk('i-0excluded'), disk('i-0kept')]);

    expect(specs).toHaveLength(1);
    expect(specs[0].alarmName).toContain('i-0kept');
  });

  it('an excluded resource leaves the desired set, so orphan cleanup deletes its existing alarms', async () => {
    // This is how the switch actually takes effect in production: nothing deletes alarms explicitly,
    // the existing orphan path does it because the alarms are no longer desired.
    ec2SendMock.mockResolvedValue({ Reservations: [] });
    rdsSendMock.mockResolvedValue({ DBInstances: [] });
    elbSendMock.mockImplementation(async (cmd: { input?: { LoadBalancerArn?: string } }) => {
      if (cmd.input?.LoadBalancerArn) {
        return { TargetGroups: [{ TargetGroupName: 'partners-stg-tg', TargetGroupArn: 'arn:aws:elasticloadbalancing:ap-southeast-1:1:targetgroup/partners-stg-tg/x' }] };
      }
      return {
        LoadBalancers: [
          {
            LoadBalancerName: 'abc-stg-alb',
            Type: 'application',
            LoadBalancerArn: 'arn:aws:elasticloadbalancing:ap-southeast-1:1:loadbalancer/app/abc-stg-alb/x',
          },
        ],
      };
    });
    ecsSendMock.mockResolvedValue({ clusterArns: [] });

    const existing = 'ops-dashboard-baseline-alb-unhealthy-hosts_abc-stg-alb-partners-stg-tg';
    const deleted: string[][] = [];
    cloudwatchSendMock.mockImplementation((command: { __cmd: string; input?: { AlarmNames?: string[] } }) => {
      if (command.__cmd === 'DescribeAlarms') return Promise.resolve({ MetricAlarms: [{ AlarmName: existing }] });
      if (command.__cmd === 'DeleteAlarms') {
        deleted.push(command.input?.AlarmNames ?? []);
        return Promise.resolve({});
      }
      return Promise.resolve({});
    });

    const { handler } = await import('./alarm-baseline-manager.js');
    const result = await handler();

    expect(result.created).toBe(0); // the only ALB present is excluded
    expect(deleted.flat()).toContain(existing);
  });
});
