import { describe, it, expect, vi, beforeEach } from 'vitest';

// alert-service imports buildConsoleLink from monitoring-service, which reads ASSESSMENT_BUCKET_NAME
// at module scope — same setup the sibling alert-service tests use.
process.env.AWS_REGION = 'ap-southeast-1';
process.env.ASSESSMENT_BUCKET_NAME = 'test-assessment-bucket';

const cloudwatchSendMock = vi.fn();

vi.mock('@aws-sdk/client-cloudwatch', () => ({
  CloudWatchClient: vi.fn().mockImplementation(() => ({ send: cloudwatchSendMock })),
  DescribeAlarmsCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
}));

const { getAlerts, isAutoscalingScaleInNoise } = await import('./alert-service.js');

beforeEach(() => {
  cloudwatchSendMock.mockReset();
});

/** The real shape Application Auto Scaling produces: a PAIR on the same metric, opposite operators. */
const ecsScaleInAlarm = {
  AlarmName: 'TargetTracking-service/abc-prod/api-AlarmLow-8f2c1e3a-1111-2222-3333-444455556666',
  StateValue: 'ALARM',
  Namespace: 'AWS/ECS',
  MetricName: 'CPUUtilization',
  ComparisonOperator: 'LessThanThreshold',
  Dimensions: [
    { Name: 'ClusterName', Value: 'abc-prod' },
    { Name: 'ServiceName', Value: 'api' },
  ],
};

const ecsScaleOutAlarm = {
  ...ecsScaleInAlarm,
  AlarmName: 'TargetTracking-service/abc-prod/api-AlarmHigh-8f2c1e3a-1111-2222-3333-444455556666',
  ComparisonOperator: 'GreaterThanThreshold',
};

const realIncident = {
  AlarmName: 'ops-dashboard-baseline-host-disk-low-free_i-0a1b2c3d4e5f60007-C_',
  StateValue: 'ALARM',
  Namespace: 'CWAgent',
  MetricName: 'LogicalDisk % Free Space',
  ComparisonOperator: 'LessThanOrEqualToThreshold',
  Dimensions: [{ Name: 'InstanceId', Value: 'i-0a1b2c3d4e5f60007' }],
};

describe('autoscaling scale-in alarms are noise, not incidents', () => {
  it('hides the AlarmLow half but KEEPS the AlarmHigh half', async () => {
    cloudwatchSendMock.mockResolvedValue({ MetricAlarms: [ecsScaleInAlarm, ecsScaleOutAlarm] });

    const alerts = await getAlerts();

    expect(alerts).toHaveLength(1);
    expect(alerts[0].alarmName).toContain('AlarmHigh');
  });

  it('a real disk incident with the SAME "below" direction is NOT filtered', async () => {
    // The filter must key on the name prefix AND the direction together. Host disk alarms are also
    // 'below' (Windows % Free Space), so filtering on direction alone would suppress a full disk.
    cloudwatchSendMock.mockResolvedValue({ MetricAlarms: [realIncident] });

    const alerts = await getAlerts();

    expect(alerts).toHaveLength(1);
    expect(alerts[0].alarmName).toBe(realIncident.AlarmName);
    expect(alerts[0].comparisonOperator).toBe('below');
  });

  it('the 4-in-6 noise ratio measured on the account collapses to the 2 real alerts', async () => {
    cloudwatchSendMock.mockResolvedValue({
      MetricAlarms: [
        { ...ecsScaleInAlarm, AlarmName: 'TargetTracking-a-AlarmLow-1' },
        { ...ecsScaleInAlarm, AlarmName: 'TargetTracking-b-AlarmLow-2' },
        { ...ecsScaleInAlarm, AlarmName: 'TargetTracking-c-AlarmLow-3' },
        { ...ecsScaleInAlarm, AlarmName: 'TargetTracking-d-AlarmLow-4' },
        realIncident,
        { ...realIncident, AlarmName: 'abc-prod-alb-unhealthy-hosts' },
      ],
    });

    const alerts = await getAlerts();

    expect(alerts).toHaveLength(2);
    expect(alerts.every((a) => !a.alarmName.startsWith('TargetTracking-'))).toBe(true);
  });

  it('predicate: needs BOTH the prefix and the below direction', () => {
    const base = {
      alarmName: 'TargetTracking-x-AlarmLow-1',
      state: 'ALARM' as const,
      threshold: { level: 'critical' as const, reason: 'ALARM' },
      namespace: 'AWS/ECS',
      region: 'ap-southeast-1',
      consoleLink: '',
    };

    expect(isAutoscalingScaleInNoise({ ...base, comparisonOperator: 'below' })).toBe(true);
    expect(isAutoscalingScaleInNoise({ ...base, comparisonOperator: 'above' })).toBe(false);
    // An anomaly-detection band has no single direction -> not this pattern, keep it visible.
    expect(isAutoscalingScaleInNoise({ ...base, comparisonOperator: undefined })).toBe(false);
    expect(
      isAutoscalingScaleInNoise({ ...base, alarmName: 'CIS-something', comparisonOperator: 'below' }),
    ).toBe(false);
  });
});
