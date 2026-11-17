import { worstSeverity } from '@ops-dashboard/shared';
import type { RealtimeMetric, ThresholdMeta } from '@ops-dashboard/shared';
import { attributeResource } from '../../attribution.js';
import { ALARM_STATE_SEVERITY, MONITORING_THRESHOLD_SEVERITY } from '../../defaults.js';
import { arnFor, arnKindForResourceType } from '../../finding-id.js';
import { arnContext, makeDraft, type CheckDefinition } from '../types.js';

type BreachingMetric = RealtimeMetric & { threshold: ThresholdMeta & { level: 'warn' | 'critical' } };

function isBreaching(metric: RealtimeMetric): metric is BreachingMetric {
  return metric.threshold !== undefined && metric.threshold.level !== 'ok';
}

/** Adapter over the existing alerting source (getAlerts -> DescribeAlarms). */
export const ALARM_IN_ALARM: CheckDefinition = {
  checkId: 'avail.alarm-in-alarm',
  source: 'monitoring',
  kpi: 'availability',
  isoControls: ['A.8.16'],
  requires: ['topology', 'alarms'],
  title: 'CloudWatch alarm is in ALARM state',
  impact: 'A monitored signal is outside its healthy range; the affected service may be degraded or unavailable.',
  remediation: ['Open the alarm in CloudWatch and confirm the breaching metric and its duration.', 'Follow the runbook for the affected resource type, then confirm the alarm returns to OK.'],
  run: (snapshot) =>
    (snapshot.alarms ?? [])
      .filter((a) => a.state === 'ALARM')
      .map((a) =>
        makeDraft(ALARM_IN_ALARM, {
          resourceType: 'cloudwatch-alarm',
          resourceId: a.alarmName,
          resourceName: a.relatedResourceId,
          resourceArn: arnFor('cloudwatch-alarm', a.alarmName, arnContext(snapshot)),
          placement: attributeResource(snapshot.topologyIndex, a.relatedResourceId ?? ''),
          severity: ALARM_STATE_SEVERITY,
          title: `Alarm ${a.alarmName} is in ALARM`,
          description: `${a.namespace}${a.metricName ? ` ${a.metricName}` : ''} breached: ${a.threshold.reason}`,
          observedAt: snapshot.observedAt.alarms ?? snapshot.now,
          data: { alarmName: a.alarmName, state: a.state, namespace: a.namespace, metricName: a.metricName, relatedResourceId: a.relatedResourceId, consoleLink: a.consoleLink },
        }),
      ),
};

/** Adapter over monitoring-cache.json thresholds: ONE finding per resource, worst metric wins. */
export const METRIC_THRESHOLD: CheckDefinition = {
  checkId: 'avail.metric-threshold',
  source: 'monitoring',
  kpi: 'availability',
  isoControls: ['A.8.6', 'A.8.16'],
  requires: ['topology', 'monitoring-metrics'],
  title: 'Resource metrics over threshold',
  impact: 'Sustained resource pressure (CPU, memory, storage, connections) precedes outages and latency.',
  remediation: ['Open the Monitoring page for the resource and review the metric trend.', 'Scale or rightsize the resource, or fix the workload driving the metric.'],
  run: (snapshot) =>
    (snapshot.monitoring?.resources ?? []).flatMap((resource) => {
      const breaching = resource.metrics.filter(isBreaching);
      if (breaching.length === 0) return [];
      const severity = worstSeverity(breaching.map((m) => MONITORING_THRESHOLD_SEVERITY[m.threshold.level])) ?? 'medium';
      return [
        makeDraft(METRIC_THRESHOLD, {
          resourceType: resource.resourceType,
          resourceId: resource.resourceId,
          resourceName: resource.resourceName,
          resourceArn: arnFor(arnKindForResourceType(resource.resourceType), resource.resourceId, arnContext(snapshot)),
          placement: attributeResource(snapshot.topologyIndex, resource.resourceId),
          severity,
          title: `${breaching.length} metric(s) over threshold on ${resource.resourceName}`,
          description: breaching.map((m) => `${m.name}=${m.value}${m.unit ? ` ${m.unit}` : ''} (${m.threshold.level})`).join('; '),
          observedAt: snapshot.observedAt['monitoring-metrics'] ?? snapshot.now,
          data: { metrics: breaching.map((m) => ({ name: m.name, value: m.value, unit: m.unit, level: m.threshold.level, reason: m.threshold.reason })) },
        }),
      ];
    }),
};
