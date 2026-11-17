import { DescribeAlarmsCommand, type MetricAlarm } from '@aws-sdk/client-cloudwatch';
import type { AlarmSummary, ThresholdLevel } from '@ops-dashboard/shared';
// Lean_Lambda_Exception (Requirement 6.4a): direct import, not `../monitoring/index.js`.
// `alert-service.ts` is used by `health-report-fn` (a lean standalone Lambda), and the monitoring
// barrel also re-exports `get-monitoring.ts`/`get-monitoring-history.ts`, which import
// `shared-kernel/response.ts` -> `config.ts` at module scope, throwing immediately when
// `ENTRA_TENANT_ID`/etc. are missing — going through the barrel would make this Lambda depend on
// env vars it is never granted (see `lambda-boot.test.ts`).
import { buildConsoleLink } from '../monitoring/monitoring-service.js';
import { getCloudWatchClient } from '../../core/aws-clients.js';

/**
 * `alert-service.ts` runs inside the `router` Lambda, on the handling path of every `GET
 * /monitoring` request (spec `realtime-monitoring-dashboard`) — same pattern as
 * `monitoring-service.ts`: reads the region directly from `process.env.AWS_REGION` (the Lambda
 * runtime always sets this variable itself), does NOT import `config.ts`.
 */
const AWS_REGION = process.env.AWS_REGION as string;

const cloudwatch = getCloudWatchClient();

/** Maps a CloudWatch Alarm `StateValue` to `Threshold_Level` (Requirement 8.3): ALARM→critical,
 * INSUFFICIENT_DATA→warn, OK→ok. */
function mapAlarmStateToLevel(state: MetricAlarm['StateValue']): ThresholdLevel {
  switch (state) {
    case 'ALARM':
      return 'critical';
    case 'INSUFFICIENT_DATA':
      return 'warn';
    default:
      return 'ok';
  }
}

/**
 * Simplifies CloudWatch's `ComparisonOperator` (7 real values) down to 2 directions — see the full
 * comment on `AlarmSummary.comparisonOperator` (`shared/src/index.ts`) for WHY this is needed
 * (distinguishing "AlarmHigh" from "AlarmLow" for the same target-tracking autoscaling metric,
 * e.g. ECS CPUUtilization). `LessThanLowerOrGreaterThanUpperThreshold` (a two-sided band, used for
 * anomaly detection) has no single direction — returns `undefined`.
 */
function mapComparisonOperatorToDirection(
  operator: MetricAlarm['ComparisonOperator'],
): 'above' | 'below' | undefined {
  switch (operator) {
    case 'GreaterThanThreshold':
    case 'GreaterThanOrEqualToThreshold':
    case 'GreaterThanUpperThreshold':
      return 'above';
    case 'LessThanThreshold':
    case 'LessThanOrEqualToThreshold':
    case 'LessThanLowerThreshold':
      return 'below';
    default:
      return undefined;
  }
}

/** Known CloudWatch dimension names that identify a resource — used to infer `relatedResourceId`
 * from an alarm's `Dimensions` (Requirement 9.3), matching the resource types `Monitoring_Page`
 * supports (EC2/RDS/ALB/EBS_Volume). Order doesn't matter — 1 alarm matches at most 1 of these
 * names (each alarm is usually tied to a single resource type). Does NOT include
 * `ServiceName`/`ClusterName` (ECS_Service) — those 2 dimensions must be handled TOGETHER (see
 * `inferEcsRelatedResourceId`), which can't go through the "1 name matches, done" loop like other
 * resource types. Does NOT include `LoadBalancer` (ALB) — that dimension needs separate handling
 * (see `inferAlbRelatedResourceId`) because CloudWatch returns it as an ARN suffix
 * `app/<name>/<id>`, NOT the bare name that `MonitoringResource.resourceId` uses for ALB (BUG FIX:
 * this used to use the dimension value directly as `relatedResourceId`, which never matched
 * `albSummary.name` — causing ALB alarms to always fall into "Other Alerts" and the ALB to never
 * be considered "having a problem", with no place to show the target group breakdown). */
const RESOURCE_IDENTIFYING_DIMENSION_NAMES = ['InstanceId', 'DBInstanceIdentifier', 'VolumeId'];

/**
 * ALB needs separate handling: the CloudWatch `LoadBalancer` dimension returns an ARN suffix in
 * the form `app/<name>/<id>` (see `extractAlbArnSuffix` in `infra-service.ts` — this EXACT value
 * is what's used as the dimension value when querying `GetMetricData`/creating an alarm for the
 * ALB), but ALB's `MonitoringResource.resourceId` (`monitoring-service.ts`) is the BARE NAME
 * (`albSummary.name`, e.g. `abc-prod-alb`) — these 2 values have completely different formats and
 * never match directly. Extracts exactly the `<name>` part between the 2 `/` separators to match
 * back to the ALB's real `resourceId`. Returns `undefined` if the value doesn't match the expected
 * `app/<name>/<id>` structure (doesn't throw/doesn't guess).
 */
function inferAlbRelatedResourceId(dimensions: MetricAlarm['Dimensions']): string | undefined {
  const loadBalancerDimensionValue = dimensions?.find((d) => d.Name === 'LoadBalancer')?.Value;
  if (!loadBalancerDimensionValue) return undefined;
  const parts = loadBalancerDimensionValue.split('/');
  // Expected structure: "app/<name>/<id>" (exactly 3 parts) — a Network Load Balancer or Gateway
  // Load Balancer uses a different prefix ("net"/"gwy") but the same 3-part structure, so the
  // <name> extraction is still correct even though `Monitoring_Page` currently only supports ALB
  // (`AWS/ApplicationELB`).
  if (parts.length !== 3) return undefined;
  return parts[1];
}

/**
 * ECS_Service needs BOTH dimensions (`ClusterName` + `ServiceName`) AT ONCE to identify exactly 1
 * service — `ServiceName` alone isn't enough (2 different clusters can have services with the
 * same name). Joins them into the EXACT format `ecsResourceId()` in `monitoring-service.ts` uses
 * (`<clusterName>/<serviceName>`) so `relatedResourceId` matches the corresponding ECS_Service's
 * `MonitoringResource.resourceId` exactly — if it didn't match this format, `Monitoring_Page`
 * wouldn't be able to map the alarm to its online resource (it would incorrectly fall into
 * `standaloneAlerts`, even though that resource is online).
 */
function inferEcsRelatedResourceId(dimensions: MetricAlarm['Dimensions']): string | undefined {
  const serviceName = dimensions?.find((d) => d.Name === 'ServiceName')?.Value;
  const clusterName = dimensions?.find((d) => d.Name === 'ClusterName')?.Value;
  if (!serviceName || !clusterName) return undefined;
  return `${clusterName}/${serviceName}`;
}

/** Infers `relatedResourceId` from an alarm's `Dimensions` — tries ECS (2 dimensions) first since
 * it's more specific, then tries the remaining single dimension names. Returns `undefined` if no
 * dimension matches (e.g. a composite alarm with no `Dimensions`, or an alarm on some other
 * dimension that doesn't identify a specific resource). */
function inferRelatedResourceId(dimensions: MetricAlarm['Dimensions']): string | undefined {
  const ecsResourceId = inferEcsRelatedResourceId(dimensions);
  if (ecsResourceId) return ecsResourceId;

  const albResourceId = inferAlbRelatedResourceId(dimensions);
  if (albResourceId) return albResourceId;

  for (const dimensionName of RESOURCE_IDENTIFYING_DIMENSION_NAMES) {
    const match = dimensions?.find((d) => d.Name === dimensionName);
    if (match?.Value) return match.Value;
  }
  return undefined;
}

/**
 * Builds the `consoleLink` for 1 `MetricAlarm` using `buildConsoleLink()` (reused from
 * `monitoring-service.ts`, Task 3.4), using the alarm's `Namespace`/`MetricName` and its first
 * dimension (if any) as `dimensionName`/`dimensionValue`. An alarm with no `MetricName`/
 * `Dimensions` (e.g. a composite alarm, or one using metric math with multiple `Metrics[]` instead
 * of a single metric) has no clear "primary" dimension to point at — the sensible fallback is an
 * empty string for dimensionName/dimensionValue, which still produces a CloudWatch Console link
 * that opens the right namespace/metric (if any), rather than skipping consoleLink entirely
 * (Requirement 12.2 applies to every Realtime_Metric/alarm, with no "no link" exception in the
 * design).
 */
function buildAlarmConsoleLink(alarm: MetricAlarm): string {
  const firstDimension = alarm.Dimensions?.[0];
  return buildConsoleLink({
    region: AWS_REGION,
    namespace: alarm.Namespace ?? '',
    metricName: alarm.MetricName ?? '',
    dimensionName: firstDimension?.Name ?? '',
    dimensionValue: firstDimension?.Value ?? '',
  });
}

function toAlarmSummary(alarm: MetricAlarm): AlarmSummary | undefined {
  const alarmName = alarm.AlarmName;
  const state = alarm.StateValue;
  if (!alarmName || !state) return undefined; // Missing a core identifier/state — skip, don't guess.

  const level = mapAlarmStateToLevel(state);
  return {
    alarmName,
    state,
    threshold: { level, reason: state },
    namespace: alarm.Namespace ?? '',
    region: AWS_REGION,
    consoleLink: buildAlarmConsoleLink(alarm),
    relatedResourceId: inferRelatedResourceId(alarm.Dimensions),
    metricName: alarm.MetricName,
    comparisonOperator: mapComparisonOperatorToDirection(alarm.ComparisonOperator),
  };
}

/**
 * Application Auto Scaling creates a PAIR of alarms for every target-tracking policy: an
 * `...-AlarmHigh` and an `...-AlarmLow`, on the SAME metric, with OPPOSITE comparison operators.
 * The `AlarmLow` half sits in `ALARM` state whenever utilisation is BELOW target — which is the
 * normal, healthy condition for a service that simply is not under load. It is how scale-IN gets
 * triggered, not a fault.
 *
 * Measured on this account: **4 of the 6** alarms in ALARM state were `TargetTracking-...-AlarmLow`
 * (ECS CPU/Memory). A list where two thirds of the entries are not incidents trains people to
 * ignore it — and that is the direct reason `health-report-fn` and `time-of-day-trigger-fn` were
 * able to fail on 100% of invocations for 10 and 7 days with their alarms firing the whole time.
 *
 * These alarms are AWS-MANAGED: the scaling policy owns them and recreates them if deleted, which
 * is exactly why `alarm-baseline-manager` restricts itself to its own `ALARM_NAME_PREFIX`. So the
 * correct place to handle them is here — leave them untouched in CloudWatch, keep them out of the
 * operator's alert list.
 *
 * Deliberately NARROW. Only the `below` half is suppressed; the matching `AlarmHigh` genuinely means
 * "utilisation is above target" and stays visible. Both halves share the same name prefix, so
 * filtering on the prefix alone would hide real signal — the direction is what separates them, which
 * is precisely why `AlarmSummary.comparisonOperator` exists (see `shared/src/index.ts`).
 */
const TARGET_TRACKING_ALARM_NAME_PREFIX = 'TargetTracking-';

export function isAutoscalingScaleInNoise(summary: AlarmSummary): boolean {
  return (
    summary.alarmName.startsWith(TARGET_TRACKING_ALARM_NAME_PREFIX) &&
    summary.comparisonOperator === 'below'
  );
}

/** The group rank used to sort `critical` to the top (Requirement 9.2) — `warn`/`ok` don't need a
 * distinct relative order between them, they just need to come after `critical`. */
const LEVEL_SORT_RANK: Record<ThresholdLevel, number> = { critical: 0, warn: 1, ok: 1 };

/**
 * `getAlerts()` — reads the state of every `CloudWatch_Alarm` already configured in
 * `AWS_Account` (Requirement 8.1), without recomputing thresholds/state itself. Paginates through
 * `NextToken` to fetch the complete alarm list (matching the pattern other collectors in this
 * codebase use when they need every page of results). Uses a stable sort (`Array.prototype.sort`
 * is stable in modern V8/Node) to group `critical` to the top while preserving relative order
 * within each group (Requirement 9.2, Property 8).
 */
export async function getAlerts(): Promise<AlarmSummary[]> {
  const summaries: AlarmSummary[] = [];
  let nextToken: string | undefined;

  do {
    const { MetricAlarms = [], NextToken } = await cloudwatch.send(
      new DescribeAlarmsCommand({ NextToken: nextToken }),
    );

    for (const alarm of MetricAlarms) {
      const summary = toAlarmSummary(alarm);
      if (!summary) continue;
      // Autoscaling scale-in alarms are permanently in ALARM by design — see
      // isAutoscalingScaleInNoise. Excluded from the list, never deleted from CloudWatch.
      if (isAutoscalingScaleInNoise(summary)) continue;
      summaries.push(summary);
    }

    nextToken = NextToken;
  } while (nextToken);

  return summaries.sort((a, b) => LEVEL_SORT_RANK[a.threshold.level] - LEVEL_SORT_RANK[b.threshold.level]);
}
