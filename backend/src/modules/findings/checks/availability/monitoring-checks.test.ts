import { describe, it, expect } from 'vitest';
import type { AlarmSummary, MonitoringData } from '@ops-dashboard/shared';
import { ALARM_IN_ALARM, METRIC_THRESHOLD } from './monitoring-checks.js';
import { buildSnapshot, NOW, VPC } from '../__fixtures__/snapshot.js';

function alarm(overrides: Partial<AlarmSummary>): AlarmSummary {
  return {
    alarmName: 'web-1-cpu-high',
    state: 'ALARM',
    threshold: { level: 'critical', reason: 'ALARM' },
    namespace: 'AWS/EC2',
    region: 'ap-southeast-1',
    consoleLink: 'https://console.aws.amazon.com/cloudwatch',
    relatedResourceId: 'i-0web1',
    metricName: 'CPUUtilization',
    ...overrides,
  };
}

function monitoring(level: 'ok' | 'warn' | 'critical'): MonitoringData {
  return {
    generatedAt: NOW,
    alerts: [],
    resources: [
      {
        resourceType: 'ec2',
        resourceId: 'i-0web1',
        resourceName: 'web-1',
        region: 'ap-southeast-1',
        metrics: [{ name: 'CPUUtilization', value: 97, unit: 'Percent', threshold: { level, reason: 'cpu' } }],
      },
    ],
  } as unknown as MonitoringData;
}

describe('avail.alarm-in-alarm', () => {
  it('fail: an ALARM-state alarm becomes a high availability finding placed on its related resource', () => {
    const [d] = ALARM_IN_ALARM.run(buildSnapshot({ alarms: [alarm({})] }));
    expect(d).toMatchObject({ checkId: 'avail.alarm-in-alarm', kpi: 'availability', severity: 'high', vpcId: VPC, subnetId: 'subnet-0prv1a', resourceId: 'web-1-cpu-high' });
    expect(d.resourceArn).toBe('arn:aws:cloudwatch:ap-southeast-1:123456789012:alarm:web-1-cpu-high');
  });

  it('pass: OK and INSUFFICIENT_DATA alarms produce nothing', () => {
    expect(ALARM_IN_ALARM.run(buildSnapshot({ alarms: [alarm({ state: 'OK' }), alarm({ state: 'INSUFFICIENT_DATA' })] }))).toEqual([]);
  });
});

describe('avail.metric-threshold', () => {
  it('fail: critical metric -> one high finding per resource', () => {
    const drafts = METRIC_THRESHOLD.run(buildSnapshot({ monitoring: monitoring('critical') }));
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ severity: 'high', resourceId: 'i-0web1', vpcId: VPC });
    expect(drafts[0].evidence.data).toMatchObject({ metrics: [{ name: 'CPUUtilization', value: 97, level: 'critical' }] });
  });

  it('fail: warn metric -> medium', () => {
    expect(METRIC_THRESHOLD.run(buildSnapshot({ monitoring: monitoring('warn') }))[0].severity).toBe('medium');
  });

  it('pass: ok metrics produce nothing', () => {
    expect(METRIC_THRESHOLD.run(buildSnapshot({ monitoring: monitoring('ok') }))).toEqual([]);
  });
});
