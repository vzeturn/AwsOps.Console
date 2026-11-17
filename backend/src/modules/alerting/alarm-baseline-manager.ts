import {
  DescribeAlarmsCommand,
  PutMetricAlarmCommand,
  DeleteAlarmsCommand,
  ListMetricsCommand,
} from '@aws-sdk/client-cloudwatch';
import { DescribeInstancesCommand } from '@aws-sdk/client-ec2';
import { DescribeDBInstancesCommand } from '@aws-sdk/client-rds';
import {
  DescribeLoadBalancersCommand,
  DescribeTargetGroupsCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import { ListClustersCommand, ListServicesCommand, DescribeServicesCommand } from '@aws-sdk/client-ecs';
import {
  getCloudWatchClient,
  getEc2Client,
  getRdsClient,
  getElasticLoadBalancingV2Client,
  getEcsClient,
} from '../../core/aws-clients.js';
// Lean_Lambda_Exception (Requirement 6.4a): imports the specific files directly rather than via
// `../monitoring/index.js`/`../ec2-management/index.js` (the default Requirement 6.4 barrel
// convention). `alarm-baseline-manager-fn` is a lean, standalone Lambda (CloudFormation grants it
// only a narrow env var set, see `infra/ops-dashboard.yaml` + `lambda-boot.test.ts`) — both
// barrels also re-export handler files (`get-monitoring.ts`, `actions-ec2-management.ts`,
// `instanceInInfraCache.ts`) that import the `config.ts` singleton at module scope, which throws
// immediately when `ENTRA_TENANT_ID`/etc. are missing. Since ES modules evaluate every export of
// a barrel file when ANY symbol is imported from it, going through either barrel would make this
// Lambda depend on env vars it is never granted, exactly the class of bug `lambda-boot.test.ts`
// exists to catch (see that file's header comment for the real prior outage this caused). Revisit
// this exception if `AlarmBaselineManagerFunction`'s CloudFormation grant is ever widened to
// include the full `AppConfig` set (Requirement 6.4a's condition (iii) would then no longer hold).
import {
  EC2_CPU_CRITICAL_PERCENT,
  EC2_CWAGENT_CRITICAL_PERCENT,
  HOST_DISK_FREE_CRITICAL_PERCENT,
  RDS_CPU_CRITICAL_PERCENT,
  RDS_IO_LATENCY_CRITICAL_SECONDS,
  RDS_FREE_STORAGE_CRITICAL_PERCENT,
  RDS_FREEABLE_MEMORY_USED_CRITICAL_PERCENT,
  RDS_SQLSERVER_FREEABLE_MEMORY_CRITICAL_BYTES,
  RDS_INSTANCE_RAM_GIB,
  isSqlServerEngine,
  ALB_RESPONSE_TIME_CRITICAL_SECONDS,
  ALB_UNHEALTHY_HOST_WARN_COUNT,
  NLB_UNHEALTHY_HOST_WARN_COUNT,
  ECS_CPU_CRITICAL_PERCENT,
  ECS_MEMORY_CRITICAL_PERCENT,
} from '../monitoring/monitoringThresholds.js';
import { computeUptimeMinutes } from '../ec2-management/ec2Uptime.js';
import { postDiscordEmbeds } from './discordWebhook.js';
import { buildOpsNotificationEmbed } from './opsNotification.js';
import { logger } from '../../shared-kernel/logger.js';

/**
 * `alarm-baseline-manager.ts` — a NEW Lambda, running on a schedule (EventBridge Scheduler, see
 * `infra/ops-dashboard.yaml`), that implements a "standard alarm set per resource type" using a
 * RECONCILE LOOP model (like how a Kubernetes controller/`kubectl apply` works — declarative,
 * idempotent): on every run, it re-surveys ALL currently "online" resources (EC2 running/RDS
 * available/ALB+TargetGroup/ECS_Service active), computes the DESIRED alarm set (`AlarmSpec[]`)
 * using the SAME THRESHOLDS shared with Monitoring_Page (`modules/monitoring/monitoringThresholds.ts` — the
 * single source of truth, never out of sync with the dashboard), then `PutMetricAlarm`s
 * (create/update, idempotent) each desired alarm and `DeleteAlarms` any "standard" alarm (prefixed
 * with `ALARM_NAME_PREFIX`) no longer in the desired set (its resource was deleted/stopped —
 * avoiding an exact repeat of the original bug investigated earlier:
 * `abc-prod-alb-unhealthy-hosts` stuck permanently in `INSUFFICIENT_DATA` because of a wrong
 * dimension + nobody deleting the alarm when the resource changed).
 *
 * Touches ONLY alarms whose name starts with `ALARM_NAME_PREFIX` — NEVER creates/modifies/deletes
 * any other alarm (CIS Security Hub benchmark alarms, Application Auto Scaling TargetTracking
 * alarms, or any manual alarm outside this scope) — absolutely safe for infrastructure outside
 * this "standard alarm set" scope.
 *
 * ALL standard alarms SHARE 1 SNS topic (`ALARM_NOTIFICATION_TOPIC_ARN`) for both `AlarmActions`
 * AND `OKActions` — that topic has EXACTLY 1 subscriber, `discord-alarm-notifier` (requirement:
 * "SNS should stop sending email and switch to a Discord webhook"). Does NOT set
 * `InsufficientDataActions` — an `INSUFFICIENT_DATA` state (e.g. from CloudWatch being 1 data
 * period behind) will NOT send a Discord notification (avoiding meaningless noise), but still
 * displays correctly on the CloudWatch Console if someone needs to look it up.
 */

const ALARM_NOTIFICATION_TOPIC_ARN = process.env.ALARM_NOTIFICATION_TOPIC_ARN as string;

/**
 * CSV of resource identifiers to keep OUT of the standard alarm set — a deliberate, reversible
 * "temporarily stop alarming on this thing" switch.
 *
 * WHY THIS HAS TO EXIST RATHER THAN JUST DELETING THE ALARMS
 *
 * This Lambda is a reconcile loop on a 1-hour schedule. Deleting an alarm by hand in the console does
 * nothing lasting: the next reconcile recomputes the desired set from the live resources and calls
 * `PutMetricAlarm` again, so the alarm is back within the hour. Suppressing it via
 * `DisableAlarmActions` fails the same way, because `PutMetricAlarm` resets `ActionsEnabled` to true.
 * The only durable place to express "do not alarm on this" is the desired set itself, which is here.
 *
 * The cleanup is automatic and needs no extra code: once a resource is excluded, its alarms are no
 * longer in the desired set, so the existing orphan-deletion path removes them on the next run —
 * the same path that handles a resource being deleted.
 *
 * Identifiers are matched EXACTLY against the id each builder uses in its alarm name:
 *   EC2 / host metrics -> InstanceId       (i-0123...)
 *   RDS                -> DBInstanceIdentifier
 *   ALB                -> load balancer NAME (e.g. abc-smoketest-alb)
 *   ECS                -> "<cluster>/<service>"
 *
 * Exact matching, not prefix or substring: `abc-prod-alb` must never be caught by an entry meant for
 * `abc-prod-alb-something`, and a typo should fail visibly by excluding nothing rather than silently
 * disabling monitoring on a resource nobody intended.
 */
const EXCLUDED_RESOURCES: ReadonlySet<string> = new Set(
  (process.env.ALARM_BASELINE_EXCLUDED_RESOURCES ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0),
);

/** Exported for testing and so the reconcile log can state what was skipped. */
export function isExcludedResource(resourceId: string, excluded: ReadonlySet<string> = EXCLUDED_RESOURCES): boolean {
  return excluded.has(resourceId);
}

const cloudwatch = getCloudWatchClient();
const ec2 = getEc2Client();
const rds = getRdsClient();
const elb = getElasticLoadBalancingV2Client();
const ecs = getEcsClient();

/** The unique alarm NAME prefix managed by this Lambda — see the file-header comment; this is the
 * "safe zone" for reconciling (list/create/delete) that NEVER touches an alarm outside its scope. */
export const ALARM_NAME_PREFIX = 'ops-dashboard-baseline-';

const GIB_IN_BYTES = 1024 ** 3;

/** The spec for 1 desired CloudWatch Alarm — has enough fields to call `PutMetricAlarmCommand` directly. */
export interface AlarmSpec {
  alarmName: string;
  alarmDescription: string;
  namespace: string;
  metricName: string;
  dimensions: { Name: string; Value: string }[];
  statistic: 'Average' | 'Maximum' | 'Sum';
  period: number;
  evaluationPeriods: number;
  threshold: number;
  comparisonOperator: 'GreaterThanOrEqualToThreshold' | 'LessThanOrEqualToThreshold';
  /**
   * Left `undefined` for every alarm that existed before host-level alarms were added, so those
   * keep CloudWatch's default (`missing`) and their behaviour is unchanged.
   *
   * Host alarms set `notBreaching`: those instances are started/stopped by an external on/off
   * schedule (the `schedule:start` tag), and a stopped instance publishes no CWAgent metric. The
   * default would park its alarm in `INSUFFICIENT_DATA` — harmless for notifications (this Lambda
   * deliberately never sets `InsufficientDataActions`) but it clutters the alarm list, and a
   * cluttered list is exactly why two dead Lambdas went unnoticed for 10 days.
   */
  treatMissingData?: 'notBreaching' | 'missing' | 'breaching' | 'ignore';
}

/** CloudWatch AlarmName allows most UTF-8 characters (up to 255 chars), but to avoid any
 * display/URL-encoding risk when opening a console link, only [A-Za-z0-9._-] is kept, everything
 * else is replaced with '_'. */
function sanitizeAlarmNamePart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_');
}

// ---- Surveys "online" resources — a collector SEPARATE from this Lambda (independent of
// monitoring-service.ts, which runs in the router role, avoiding a cross-dependency between 2
// Lambdas with different IAM roles) — uses the SAME "online" DEFINITION as Monitoring_Page (EC2
// running, RDS available, ALB every target group, ECS active + runningCount > 0) so the standard
// alarm set ALWAYS matches resources that are actually running, never creating a "stillborn"
// alarm for a resource that's stopped/doesn't exist. ----

interface OnlineEc2 {
  instanceId: string;
  /** `LaunchTime` from `DescribeInstances` — updated on every instance start (including
   * restarting after a `stop`, confirmed via the AWS EC2 UserGuide "instance lifecycle": an
   * instance transitions `pending` -> `running` on every start, `LaunchTime` reflects the MOST
   * RECENT start, not the original instance creation time — unlike RDS's `InstanceCreateTime`,
   * which doesn't change on stop/start). `undefined` if AWS doesn't return this field (never
   * observed in practice, but optional per the SDK type) — fail-safe: does NOT warm-up when data
   * is missing (treated as already warm, preserving prior behavior).
   */
  launchTime: Date | undefined;
}

async function discoverOnlineEc2(): Promise<OnlineEc2[]> {
  const result: OnlineEc2[] = [];
  let nextToken: string | undefined;
  do {
    const { Reservations = [], NextToken } = await ec2.send(new DescribeInstancesCommand({ NextToken: nextToken }));
    for (const reservation of Reservations) {
      for (const instance of reservation.Instances ?? []) {
        if (instance.State?.Name !== 'running') continue;
        if (instance.InstanceId) result.push({ instanceId: instance.InstanceId, launchTime: instance.LaunchTime });
      }
    }
    nextToken = NextToken;
  } while (nextToken);
  return result;
}

interface OnlineRds {
  dbInstanceIdentifier: string;
  dbInstanceClass: string;
  /**
   * `DBInstance.Engine` — needed for the FreeableMemory alarm: SQL Server uses a completely
   * different threshold model (an absolute free-byte floor) than engines relying on the OS page
   * cache. Must exactly match the model `threshold-eval.ts` uses, otherwise the dashboard and
   * CloudWatch Alarm will drift out of sync.
   */
  engine: string;
  allocatedStorageGb: number;
}

async function discoverOnlineRds(): Promise<OnlineRds[]> {
  const { DBInstances = [] } = await rds.send(new DescribeDBInstancesCommand({}));
  const result: OnlineRds[] = [];
  for (const db of DBInstances) {
    if (db.DBInstanceStatus !== 'available') continue;
    if (!db.DBInstanceIdentifier) continue;
    result.push({
      dbInstanceIdentifier: db.DBInstanceIdentifier,
      dbInstanceClass: db.DBInstanceClass ?? '',
      engine: db.Engine ?? '',
      allocatedStorageGb: db.AllocatedStorage ?? 0,
    });
  }
  return result;
}

/**
 * An ARN shaped `arn:...:loadbalancer/app/<name>/<id>` -> `app/<name>/<id>` — the REAL value
 * CloudWatch requires for the `LoadBalancer` dimension (namespace `AWS/ApplicationELB`): the part
 * AFTER the `:loadbalancer/` marker, NOT including the word `loadbalancer/` (verified to match
 * `extractAlbArnSuffix` in `infra-service.ts`).
 */
function extractLoadBalancerDimensionValue(arn: string | undefined): string | undefined {
  if (!arn) return undefined;
  const marker = ':loadbalancer/';
  const idx = arn.indexOf(marker);
  return idx === -1 ? undefined : arn.slice(idx + marker.length);
}

/**
 * An ARN shaped `arn:...:targetgroup/<name>/<id>` -> `targetgroup/<name>/<id>` — the REAL value
 * CloudWatch requires for the `TargetGroup` dimension. IMPORTANT: DIFFERENT from `LoadBalancer`
 * above — the `TargetGroup` dimension REQUIRES KEEPING the word `targetgroup/` (verified in
 * practice via `ListMetrics`: the real dimension value returned is
 * `"targetgroup/abc-prod-api-tg/aaaabbbbccccdddd"`, NOT just
 * `"abc-prod-api-tg/aaaabbbbccccdddd"`) — AWS is inconsistent between these 2 dimensions
 * (LoadBalancer drops the resource-type prefix, TargetGroup keeps it), so each dimension must be
 * handled separately, NOT via 1 shared generic marker-based function.
 */
function extractTargetGroupDimensionValue(arn: string | undefined): string | undefined {
  if (!arn) return undefined;
  // Standard ARN format: arn:partition:service:region:account-id:resource — the "resource" part
  // is everything AFTER the 5th ':' (including the word "targetgroup/"), kept as-is without trimming.
  const parts = arn.split(':');
  return parts.length >= 6 ? parts.slice(5).join(':') : undefined;
}

interface OnlineAlb {
  albName: string;
  loadBalancerArnSuffix: string;
  targetGroups: { targetGroupName: string; targetGroupArnSuffix: string }[];
}

interface OnlineNlb {
  nlbName: string;
  loadBalancerArnSuffix: string;
  targetGroups: { targetGroupName: string; targetGroupArnSuffix: string }[];
}

/**
 * `DescribeLoadBalancers` returns BOTH Application Load Balancers (`Type: 'application'`) and
 * Network Load Balancers (`Type: 'network'`, e.g. `abc-prod-nlb-kafka` in the real account) in the
 * same call. They need SEPARATE alarm sets because they live in different CloudWatch namespaces
 * with different metrics: ALB is `AWS/ApplicationELB` (`UnHealthyHostCount`/`TargetResponseTime`,
 * matching `METRIC_DEFINITIONS.alb` in `monitoring-service.ts`), NLB is `AWS/NetworkELB` with NO
 * `TargetResponseTime` (Layer 4 — it doesn't terminate/inspect the application protocol). Treating
 * an NLB as if it were an ALB (or vice versa) creates an alarm guaranteed to get stuck permanently
 * in `INSUFFICIENT_DATA` due to the wrong namespace/metric — EXACTLY the original bug investigated
 * for `abc-prod-alb-unhealthy-hosts`. Both discoverers below share the same
 * `DescribeLoadBalancers`/`DescribeTargetGroups` calls per load balancer (free-tier Describe/List
 * APIs, no extra cost from covering both types) but are kept as two distinct functions/interfaces
 * so neither can accidentally inherit the other's alarm set.
 */
const ALB_LOAD_BALANCER_TYPE = 'application';
const NLB_LOAD_BALANCER_TYPE = 'network';

async function discoverOnlineAlb(): Promise<OnlineAlb[]> {
  const { LoadBalancers = [] } = await elb.send(new DescribeLoadBalancersCommand({}));
  const result: OnlineAlb[] = [];

  for (const lb of LoadBalancers) {
    if (lb.Type !== ALB_LOAD_BALANCER_TYPE) continue;
    const loadBalancerArnSuffix = extractLoadBalancerDimensionValue(lb.LoadBalancerArn);
    if (!lb.LoadBalancerName || !loadBalancerArnSuffix) continue;

    const { TargetGroups = [] } = await elb.send(new DescribeTargetGroupsCommand({ LoadBalancerArn: lb.LoadBalancerArn }));
    const targetGroups: OnlineAlb['targetGroups'] = [];
    for (const tg of TargetGroups) {
      const targetGroupArnSuffix = extractTargetGroupDimensionValue(tg.TargetGroupArn);
      if (!tg.TargetGroupName || !targetGroupArnSuffix) continue;
      targetGroups.push({ targetGroupName: tg.TargetGroupName, targetGroupArnSuffix });
    }

    result.push({ albName: lb.LoadBalancerName, loadBalancerArnSuffix, targetGroups });
  }

  return result;
}

/** Mirrors `discoverOnlineAlb()` exactly, filtered to `Type: 'network'` instead — see the shared
 * comment above both interfaces for why NLB needs its own discoverer rather than reusing ALB's. */
async function discoverOnlineNlb(): Promise<OnlineNlb[]> {
  const { LoadBalancers = [] } = await elb.send(new DescribeLoadBalancersCommand({}));
  const result: OnlineNlb[] = [];

  for (const lb of LoadBalancers) {
    if (lb.Type !== NLB_LOAD_BALANCER_TYPE) continue;
    const loadBalancerArnSuffix = extractLoadBalancerDimensionValue(lb.LoadBalancerArn);
    if (!lb.LoadBalancerName || !loadBalancerArnSuffix) continue;

    const { TargetGroups = [] } = await elb.send(new DescribeTargetGroupsCommand({ LoadBalancerArn: lb.LoadBalancerArn }));
    const targetGroups: OnlineNlb['targetGroups'] = [];
    for (const tg of TargetGroups) {
      const targetGroupArnSuffix = extractTargetGroupDimensionValue(tg.TargetGroupArn);
      if (!tg.TargetGroupName || !targetGroupArnSuffix) continue;
      targetGroups.push({ targetGroupName: tg.TargetGroupName, targetGroupArnSuffix });
    }

    result.push({ nlbName: lb.LoadBalancerName, loadBalancerArnSuffix, targetGroups });
  }

  return result;
}

interface OnlineEcsService {
  clusterName: string;
  serviceName: string;
}

async function discoverOnlineEcsServices(): Promise<OnlineEcsService[]> {
  const { clusterArns = [] } = await ecs.send(new ListClustersCommand({}));
  const result: OnlineEcsService[] = [];

  for (const clusterArn of clusterArns) {
    const { serviceArns = [] } = await ecs.send(new ListServicesCommand({ cluster: clusterArn }));
    if (serviceArns.length === 0) continue;

    const { services = [] } = await ecs.send(new DescribeServicesCommand({ cluster: clusterArn, services: serviceArns }));
    for (const service of services) {
      if (service.status !== 'ACTIVE') continue;
      if ((service.runningCount ?? 0) <= 0) continue;
      const serviceName = service.serviceName;
      const clusterName = clusterArn.split('/').pop();
      if (!serviceName || !clusterName) continue;
      result.push({ clusterName, serviceName });
    }
  }

  return result;
}

// ---- Host-level metrics (CloudWatch Agent, namespace `CWAgent`) ----
//
// These are the metrics that reveal a machine running out of disk or memory — the things that
// actually take a server down, and precisely what the account had NO alarm for: verified against
// all 93 alarms, nothing watched disk_used_percent, mem_used_percent, `LogicalDisk % Free Space` or
// `Memory % Committed Bytes In Use`. Three separate disk incidents (a Linux root filesystem at
// 91%, and a Windows C: at 1% free) were each found by a human happening to look at a dashboard.
//
// WHY THIS IS DRIVEN OFF ListMetrics AND NOT OFF THE INSTANCE LIST
//
// Only a few of the running instances have the CloudWatch Agent installed at all. Creating a disk
// alarm for an instance that publishes no CWAgent metric would produce an alarm permanently stuck
// in INSUFFICIENT_DATA — a blind alarm, the exact failure this whole alarm baseline exists to
// prevent (see the file header on `abc-prod-alb-unhealthy-hosts`). So the desired set is derived
// from what the agents are ACTUALLY publishing. An instance with no agent simply gets no host
// alarm, and one that gains an agent gets alarms on the next reconcile, with no code change.
//
// The dimension sets are copied VERBATIM from ListMetrics for the same reason: a hand-built
// dimension set that does not match what CloudWatch stores gives an alarm that can never fire.

/** One `(metricName, dimensions)` series that a CloudWatch Agent is currently publishing. */
export interface PublishedHostMetric {
  metricName: string;
  dimensions: { Name: string; Value: string }[];
}

interface HostMetricRule {
  metricName: string;
  threshold: number;
  comparisonOperator: 'GreaterThanOrEqualToThreshold' | 'LessThanOrEqualToThreshold';
  /** Distinguishes the alarm name; also the part a human reads first in Discord. */
  slug: string;
  /**
   * When set, the metric is only MEANINGFUL per value of this dimension, so one alarm is created
   * per published value instead of one per instance.
   *
   * Set for Windows `LogicalDisk % Free Space` (`instance` holds the drive letter). Aggregating
   * that metric to a single per-instance number would AVERAGE the drives together: on
   * `abc-prod-ec2-hrms` that is C: 45.5% + D: 16.1% + E: 89.9% -> ~50%, which reads as healthy
   * while D: is nearly full. It is the same defect as the Linux config that averaged `/` with ~22
   * permanently-full squashfs mounts and reported 0.0%.
   */
  perDimension?: string;
  describe: (label: string) => string;
}

const HOST_METRIC_RULES: HostMetricRule[] = [
  // --- Linux (CWAgent `disk`/`mem` plugins) — high value is bad. ---
  {
    metricName: 'disk_used_percent',
    threshold: EC2_CWAGENT_CRITICAL_PERCENT,
    comparisonOperator: 'GreaterThanOrEqualToThreshold',
    slug: 'host-disk-high',
    describe: (label) => `Host ${label} filesystem >= ${EC2_CWAGENT_CRITICAL_PERCENT}% USED (Linux disk_used_percent)`,
  },
  {
    metricName: 'mem_used_percent',
    threshold: EC2_CWAGENT_CRITICAL_PERCENT,
    comparisonOperator: 'GreaterThanOrEqualToThreshold',
    slug: 'host-mem-high',
    describe: (label) => `Host ${label} memory >= ${EC2_CWAGENT_CRITICAL_PERCENT}% used (Linux mem_used_percent)`,
  },
  // --- Windows — NOTE THE OPPOSITE OPERATOR. `% Free Space` counts space REMAINING, so the bad
  // direction is DOWNWARD. See HOST_DISK_FREE_CRITICAL_PERCENT in modules/monitoring/monitoringThresholds.ts. ---
  {
    metricName: 'LogicalDisk % Free Space',
    threshold: HOST_DISK_FREE_CRITICAL_PERCENT,
    comparisonOperator: 'LessThanOrEqualToThreshold',
    slug: 'host-disk-low-free',
    perDimension: 'instance',
    describe: (label) =>
      `Host ${label} <= ${HOST_DISK_FREE_CRITICAL_PERCENT}% disk space FREE (Windows LogicalDisk % Free Space — low is bad)`,
  },
  {
    metricName: 'Memory % Committed Bytes In Use',
    threshold: EC2_CWAGENT_CRITICAL_PERCENT,
    comparisonOperator: 'GreaterThanOrEqualToThreshold',
    slug: 'host-mem-committed-high',
    describe: (label) => `Host ${label} committed memory >= ${EC2_CWAGENT_CRITICAL_PERCENT}% (Windows)`,
  },
];

const CWAGENT_NAMESPACE = 'CWAgent';

async function discoverPublishedHostMetrics(): Promise<PublishedHostMetric[]> {
  const wanted = new Set(HOST_METRIC_RULES.map((r) => r.metricName));
  const result: PublishedHostMetric[] = [];
  let nextToken: string | undefined;
  do {
    const { Metrics = [], NextToken } = await cloudwatch.send(
      new ListMetricsCommand({ Namespace: CWAGENT_NAMESPACE, NextToken: nextToken }),
    );
    for (const metric of Metrics) {
      if (!metric.MetricName || !wanted.has(metric.MetricName)) continue;
      const dimensions = (metric.Dimensions ?? [])
        .filter((d): d is { Name: string; Value: string } => Boolean(d.Name && d.Value))
        .map((d) => ({ Name: d.Name, Value: d.Value }));
      if (!dimensions.some((d) => d.Name === 'InstanceId')) continue;
      result.push({ metricName: metric.MetricName, dimensions });
    }
    nextToken = NextToken;
  } while (nextToken);
  return result;
}

function dimensionValue(metric: PublishedHostMetric, name: string): string | undefined {
  return metric.dimensions.find((d) => d.Name === name)?.Value;
}

/**
 * One alarm per host metric series worth alarming on.
 *
 * A PURE function over what ListMetrics reported, so the whole selection rule is unit-testable
 * without touching AWS.
 *
 * For a rule WITHOUT `perDimension` the agent may publish the same metric several times for one
 * instance at different granularities — an aggregated `{InstanceId}` series plus a per-filesystem
 * `{InstanceId, path, fstype}` one, because `drop_original_metrics` is not honoured consistently.
 * Alarming on all of them would multiply notifications for a single event, so the MOST AGGREGATED
 * series wins (fewest dimensions; ties broken lexicographically for a stable, reproducible choice).
 */
export function buildHostAlarmSpecs(published: PublishedHostMetric[]): AlarmSpec[] {
  const specs: AlarmSpec[] = [];

  for (const rule of HOST_METRIC_RULES) {
    const matching = published.filter((m) => m.metricName === rule.metricName);

    // Group by instance, then by the per-dimension value when the rule asks for one. The key is
    // what "one alarm" means for this rule.
    const groups = new Map<string, PublishedHostMetric[]>();
    for (const metric of matching) {
      const instanceId = dimensionValue(metric, 'InstanceId');
      if (!instanceId) continue;
      if (isExcludedResource(instanceId)) continue;
      let key = instanceId;
      if (rule.perDimension) {
        const sub = dimensionValue(metric, rule.perDimension);
        // No value for the dimension this rule is keyed on -> not the series we want (e.g. the
        // `_Total` roll-up, or an aggregated series). Skip rather than guess.
        if (!sub) continue;
        key = `${instanceId}|${sub}`;
      }
      const bucket = groups.get(key);
      if (bucket) bucket.push(metric);
      else groups.set(key, [metric]);
    }

    // Sorted by group key so the emitted order is deterministic (keeps tests and logs stable).
    const orderedGroups = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, v]) => v);
    for (const candidates of orderedGroups) {
      const chosen = [...candidates].sort((a, b) => {
        if (a.dimensions.length !== b.dimensions.length) return a.dimensions.length - b.dimensions.length;
        const aKey = a.dimensions.map((d) => `${d.Name}=${d.Value}`).sort().join(',');
        const bKey = b.dimensions.map((d) => `${d.Name}=${d.Value}`).sort().join(',');
        return aKey.localeCompare(bKey);
      })[0];

      const instanceId = dimensionValue(chosen, 'InstanceId') as string;
      const sub = rule.perDimension ? dimensionValue(chosen, rule.perDimension) : undefined;
      const label = sub ? `${instanceId} ${sub}` : instanceId;
      const nameSuffix = sub
        ? `${sanitizeAlarmNamePart(instanceId)}-${sanitizeAlarmNamePart(sub)}`
        : sanitizeAlarmNamePart(instanceId);

      specs.push({
        alarmName: `${ALARM_NAME_PREFIX}${rule.slug}_${nameSuffix}`,
        alarmDescription: rule.describe(label),
        namespace: CWAGENT_NAMESPACE,
        metricName: rule.metricName,
        // Verbatim from ListMetrics — see the section comment above.
        dimensions: chosen.dimensions,
        statistic: 'Average',
        // The agents collect every 300s (`infra/cloudwatch-agent/*.json`). A shorter period would
        // evaluate against gaps between datapoints and flap.
        period: 300,
        evaluationPeriods: 2,
        threshold: rule.threshold,
        comparisonOperator: rule.comparisonOperator,
        treatMissingData: 'notBreaching',
      });
    }
  }

  return specs;
}

export interface OnlineResourceInventory {
  ec2: OnlineEc2[];
  rds: OnlineRds[];
  alb: OnlineAlb[];
  ecs: OnlineEcsService[];
  /**
   * Optional so the existing tests that build an inventory literal keep compiling; absent is
   * treated as "no NLBs" (no network-load-balancer alarms) — the same backward-compatible pattern
   * already used for `hostMetrics` below.
   */
  nlb?: OnlineNlb[];
  /**
   * Optional so the existing tests that build an inventory literal keep compiling; absent is
   * treated as "no host metrics published", i.e. no host alarms.
   */
  hostMetrics?: PublishedHostMetric[];
}

async function discoverOnlineResources(): Promise<OnlineResourceInventory> {
  const [ec2Instances, rdsInstances, albs, nlbs, ecsServices, hostMetrics] = await Promise.all([
    discoverOnlineEc2(),
    discoverOnlineRds(),
    discoverOnlineAlb(),
    discoverOnlineNlb(),
    discoverOnlineEcsServices(),
    discoverPublishedHostMetrics(),
  ]);
  return { ec2: ec2Instances, rds: rdsInstances, alb: albs, nlb: nlbs, ecs: ecsServices, hostMetrics };
}

// ---- Build AlarmSpec[] per resource type — THRESHOLDS come from modules/monitoring/monitoringThresholds.ts (the
// single source of truth, shared with Monitoring_Page). Only the CRITICAL tier is used for the
// REAL standard alarms (unlike Monitoring_Page, which shows 2 visual tiers, warn/critical) —
// avoiding Discord getting spammed by "warn"-level alerts while someone is watching the dashboard
// live; standard alarms should only fire when action can't wait (staying true to "always ready
// for operations" while still avoiding alert fatigue). ----

/**
 * Warm-up window (minutes) after an EC2's `LaunchTime` (the MOST RECENT start) — during this
 * window, no CPU/StatusCheckFailed alarm is created for that instance (Requirement: the system
 * applies an on/off schedule via the `schedule:start`/`schedule:stop` tags, and the alarm must
 * follow that schedule to avoid a false alert right after boot — CPU can spike abnormally from
 * service/cache warm-up load, and StatusCheckFailed can be true for the first 1-3 minutes before
 * status checks stabilize, per the AWS EC2 UserGuide "instance lifecycle": the `pending` ->
 * `running` transition doesn't mean status checks have passed yet).
 *
 * A DELIBERATE TRADE-OFF (fail-safe toward reducing noise, not toward absolute safety): for the
 * first 10 minutes after start, the instance has NEITHER of these 2 alarms at all — if the
 * instance genuinely fails right at boot (e.g. a status check permanently failing due to an
 * AMI/network issue), there's at most 1 "blind" reconcile cycle
 * (`AlarmBaselineScheduleExpression`, see infra/ops-dashboard.yaml) before the alarm is created
 * again on the next cycle — this is a short, acceptable gap since a start is a DELIBERATE action
 * (scheduled or manual), unlike an unexpected failure during otherwise stable operation (which has
 * no warm-up).
 */
export const EC2_ALARM_WARMUP_MINUTES = 10;

/** Whether 1 EC2 instance is still within its warm-up window at time `now` — an `undefined`
 * `launchTime` (AWS not returning the field, never observed in practice) is treated as ALREADY
 * warm (fail-safe: no data means no guessing, preserving alarm-creation behavior from before
 * warm-up existed). */
export function isEc2WithinWarmup(launchTime: Date | undefined, now: Date): boolean {
  if (!launchTime) return false;
  return computeUptimeMinutes(launchTime, now) < EC2_ALARM_WARMUP_MINUTES;
}

function buildEc2AlarmSpecs(instances: OnlineEc2[], now: Date): AlarmSpec[] {
  const specs: AlarmSpec[] = [];
  for (const instance of instances) {
    if (isExcludedResource(instance.instanceId)) continue;
    if (isEc2WithinWarmup(instance.launchTime, now)) continue;
    const id = sanitizeAlarmNamePart(instance.instanceId);
    specs.push({
      alarmName: `${ALARM_NAME_PREFIX}ec2-cpu-high_${id}`,
      alarmDescription: `EC2 ${instance.instanceId} CPUUtilization >= ${EC2_CPU_CRITICAL_PERCENT}% (sustained 15 minutes)`,
      namespace: 'AWS/EC2',
      metricName: 'CPUUtilization',
      dimensions: [{ Name: 'InstanceId', Value: instance.instanceId }],
      statistic: 'Average',
      period: 300,
      evaluationPeriods: 3,
      threshold: EC2_CPU_CRITICAL_PERCENT,
      comparisonOperator: 'GreaterThanOrEqualToThreshold',
    });
    specs.push({
      alarmName: `${ALARM_NAME_PREFIX}ec2-status-check-failed_${id}`,
      alarmDescription: `EC2 ${instance.instanceId} StatusCheckFailed != 0 (instance/system check failed)`,
      namespace: 'AWS/EC2',
      metricName: 'StatusCheckFailed',
      dimensions: [{ Name: 'InstanceId', Value: instance.instanceId }],
      statistic: 'Maximum',
      period: 60,
      evaluationPeriods: 2,
      threshold: 1,
      comparisonOperator: 'GreaterThanOrEqualToThreshold',
    });
  }
  return specs;
}

function buildRdsAlarmSpecs(instances: OnlineRds[]): AlarmSpec[] {
  const specs: AlarmSpec[] = [];
  for (const db of instances) {
    if (isExcludedResource(db.dbInstanceIdentifier)) continue;
    const id = sanitizeAlarmNamePart(db.dbInstanceIdentifier);
    specs.push({
      alarmName: `${ALARM_NAME_PREFIX}rds-cpu-high_${id}`,
      alarmDescription: `RDS ${db.dbInstanceIdentifier} CPUUtilization >= ${RDS_CPU_CRITICAL_PERCENT}% (sustained 15 minutes)`,
      namespace: 'AWS/RDS',
      metricName: 'CPUUtilization',
      dimensions: [{ Name: 'DBInstanceIdentifier', Value: db.dbInstanceIdentifier }],
      statistic: 'Average',
      period: 300,
      evaluationPeriods: 3,
      threshold: RDS_CPU_CRITICAL_PERCENT,
      comparisonOperator: 'GreaterThanOrEqualToThreshold',
    });

    for (const [metric, slug] of [['ReadLatency', 'read'], ['WriteLatency', 'write']] as const) {
      specs.push({
        alarmName: `${ALARM_NAME_PREFIX}rds-${slug}-latency-high_${id}`,
        alarmDescription: `RDS ${db.dbInstanceIdentifier} ${metric} >= ${RDS_IO_LATENCY_CRITICAL_SECONDS * 1000} ms (sustained 15 minutes)`,
        namespace: 'AWS/RDS',
        metricName: metric,
        dimensions: [{ Name: 'DBInstanceIdentifier', Value: db.dbInstanceIdentifier }],
        statistic: 'Average',
        period: 300,
        evaluationPeriods: 3,
        threshold: RDS_IO_LATENCY_CRITICAL_SECONDS,
        comparisonOperator: 'GreaterThanOrEqualToThreshold',
      });
    }

    if (db.allocatedStorageGb > 0) {
      const criticalFreeBytes = db.allocatedStorageGb * GIB_IN_BYTES * (RDS_FREE_STORAGE_CRITICAL_PERCENT / 100);
      specs.push({
        alarmName: `${ALARM_NAME_PREFIX}rds-free-storage-low_${id}`,
        alarmDescription: `RDS ${db.dbInstanceIdentifier} FreeStorageSpace <= ${RDS_FREE_STORAGE_CRITICAL_PERCENT}% of allocated storage (${db.allocatedStorageGb} GiB)`,
        namespace: 'AWS/RDS',
        metricName: 'FreeStorageSpace',
        dimensions: [{ Name: 'DBInstanceIdentifier', Value: db.dbInstanceIdentifier }],
        statistic: 'Average',
        period: 300,
        evaluationPeriods: 1,
        threshold: criticalFreeBytes,
        comparisonOperator: 'LessThanOrEqualToThreshold',
      });
    }

    // SQL Server: the threshold is an absolute FREE-BYTE FLOOR, NOT % used. The full rationale
    // with measured data is recorded on `RDS_SQLSERVER_FREEABLE_MEMORY_*_BYTES` in
    // lib/monitoringThresholds. In short: `max server memory` caps the buffer pool, SQL Server
    // fills it and holds on, so the normal operating point always sits around 89% used — the old
    // 90% critical threshold was equivalent to FreeableMemory <= 1.717 GB on a 16 GiB box, only
    // 180 MB away from abc-prod-rds-mssql's HEALTHY value, i.e. a real alarm about to fire with no
    // actual incident.
    // This model doesn't need a RAM_GIB lookup, so it can create the alarm even for a class not yet in the table.
    if (isSqlServerEngine(db.engine)) {
      specs.push({
        alarmName: `${ALARM_NAME_PREFIX}rds-freeable-memory-low_${id}`,
        alarmDescription: `RDS ${db.dbInstanceIdentifier} (SQL Server) FreeableMemory <= ${Math.round(RDS_SQLSERVER_FREEABLE_MEMORY_CRITICAL_BYTES / 1024 / 1024)} MiB free — an absolute byte-floor threshold because the buffer pool is capped by 'max server memory' and then held onto`,
        namespace: 'AWS/RDS',
        metricName: 'FreeableMemory',
        dimensions: [{ Name: 'DBInstanceIdentifier', Value: db.dbInstanceIdentifier }],
        statistic: 'Average',
        period: 300,
        evaluationPeriods: 1,
        threshold: RDS_SQLSERVER_FREEABLE_MEMORY_CRITICAL_BYTES,
        comparisonOperator: 'LessThanOrEqualToThreshold',
      });
      continue;
    }

    // Engines relying on the OS page cache: the FreeableMemory alarm can only be created when
    // there's a RAM_GIB entry for this DBInstanceClass (see RDS_INSTANCE_RAM_GIB in
    // modules/monitoring/monitoringThresholds.ts) — a missing entry -> this alarm is NOT created for that
    // instance (fail-safe, no arbitrary guessing of a byte threshold), but the 2 CPU/FreeStorage
    // alarms above are still created.
    const ramGib = RDS_INSTANCE_RAM_GIB[db.dbInstanceClass];
    if (ramGib !== undefined) {
      const criticalFreeableBytes = ramGib * GIB_IN_BYTES * (1 - RDS_FREEABLE_MEMORY_USED_CRITICAL_PERCENT / 100);
      specs.push({
        alarmName: `${ALARM_NAME_PREFIX}rds-freeable-memory-low_${id}`,
        alarmDescription: `RDS ${db.dbInstanceIdentifier} FreeableMemory <= ${100 - RDS_FREEABLE_MEMORY_USED_CRITICAL_PERCENT}% RAM free (class ${db.dbInstanceClass}, ${ramGib} GiB)`,
        namespace: 'AWS/RDS',
        metricName: 'FreeableMemory',
        dimensions: [{ Name: 'DBInstanceIdentifier', Value: db.dbInstanceIdentifier }],
        statistic: 'Average',
        period: 300,
        evaluationPeriods: 1,
        threshold: criticalFreeableBytes,
        comparisonOperator: 'LessThanOrEqualToThreshold',
      });
    } else {
      logger.warn(
        `alarm-baseline-manager: RDS_INSTANCE_RAM_GIB is missing an entry for DBInstanceClass=${db.dbInstanceClass} (${db.dbInstanceIdentifier}) — skipping the FreeableMemory alarm for this instance (fail-safe, no guessing a threshold).`,
      );
    }
  }
  return specs;
}

function buildAlbAlarmSpecs(albs: OnlineAlb[]): AlarmSpec[] {
  const specs: AlarmSpec[] = [];
  for (const alb of albs) {
    if (isExcludedResource(alb.albName)) continue;
    const albId = sanitizeAlarmNamePart(alb.albName);

    // TargetResponseTime supports a STANDALONE {LoadBalancer} dimension (confirmed in practice —
    // unlike UnHealthyHostCount, see the comment below) -> 1 alarm/ALB is enough, no need for per-target-group.
    specs.push({
      alarmName: `${ALARM_NAME_PREFIX}alb-high-response-time_${albId}`,
      alarmDescription: `ALB ${alb.albName} TargetResponseTime >= ${ALB_RESPONSE_TIME_CRITICAL_SECONDS}s`,
      namespace: 'AWS/ApplicationELB',
      metricName: 'TargetResponseTime',
      dimensions: [{ Name: 'LoadBalancer', Value: alb.loadBalancerArnSuffix }],
      statistic: 'Average',
      period: 300,
      evaluationPeriods: 2,
      threshold: ALB_RESPONSE_TIME_CRITICAL_SECONDS,
      comparisonOperator: 'GreaterThanOrEqualToThreshold',
    });

    // UnHealthyHostCount does NOT support a standalone {LoadBalancer} dimension — it ONLY exists
    // for the combination {TargetGroup, LoadBalancer} or {TargetGroup, AvailabilityZone,
    // LoadBalancer} (verified directly via GetMetricStatistics/AWS docs — this is EXACTLY the root
    // cause behind `abc-prod-alb-unhealthy-hosts` (old dimension had only LoadBalancer) being
    // stuck permanently in INSUFFICIENT_DATA even though the ALB was completely healthy). Must
    // create 1 alarm per target group with BOTH dimensions present.
    for (const tg of alb.targetGroups) {
      const tgId = sanitizeAlarmNamePart(tg.targetGroupName);
      specs.push({
        alarmName: `${ALARM_NAME_PREFIX}alb-unhealthy-hosts_${albId}-${tgId}`,
        alarmDescription: `ALB ${alb.albName} / target group ${tg.targetGroupName} UnHealthyHostCount >= ${ALB_UNHEALTHY_HOST_WARN_COUNT}`,
        namespace: 'AWS/ApplicationELB',
        metricName: 'UnHealthyHostCount',
        dimensions: [
          { Name: 'TargetGroup', Value: tg.targetGroupArnSuffix },
          { Name: 'LoadBalancer', Value: alb.loadBalancerArnSuffix },
        ],
        statistic: 'Average',
        period: 60,
        evaluationPeriods: 2,
        threshold: ALB_UNHEALTHY_HOST_WARN_COUNT,
        comparisonOperator: 'GreaterThanOrEqualToThreshold',
      });
    }
  }
  return specs;
}

/**
 * NLB standard alarm set — Layer 4, no TargetResponseTime (see the discoverer comment above for
 * why). Only target health, using the exact same {TargetGroup, LoadBalancer} dimension pair as
 * ALB's own `UnHealthyHostCount` (namespace differs — `AWS/NetworkELB` — but the dimension
 * requirement is the same: `UnHealthyHostCount` has no standalone {LoadBalancer} dimension either).
 */
function buildNlbAlarmSpecs(nlbs: OnlineNlb[]): AlarmSpec[] {
  const specs: AlarmSpec[] = [];
  for (const nlb of nlbs) {
    if (isExcludedResource(nlb.nlbName)) continue;
    const nlbId = sanitizeAlarmNamePart(nlb.nlbName);

    for (const tg of nlb.targetGroups) {
      const tgId = sanitizeAlarmNamePart(tg.targetGroupName);
      specs.push({
        alarmName: `${ALARM_NAME_PREFIX}nlb-unhealthy-hosts_${nlbId}-${tgId}`,
        alarmDescription: `NLB ${nlb.nlbName} / target group ${tg.targetGroupName} UnHealthyHostCount >= ${NLB_UNHEALTHY_HOST_WARN_COUNT}`,
        namespace: 'AWS/NetworkELB',
        metricName: 'UnHealthyHostCount',
        dimensions: [
          { Name: 'TargetGroup', Value: tg.targetGroupArnSuffix },
          { Name: 'LoadBalancer', Value: nlb.loadBalancerArnSuffix },
        ],
        statistic: 'Average',
        period: 60,
        evaluationPeriods: 2,
        threshold: NLB_UNHEALTHY_HOST_WARN_COUNT,
        comparisonOperator: 'GreaterThanOrEqualToThreshold',
      });
    }
  }
  return specs;
}

function buildEcsAlarmSpecs(services: OnlineEcsService[]): AlarmSpec[] {
  const specs: AlarmSpec[] = [];
  for (const service of services) {
    // Matches the `<cluster>/<service>` form used as the ECS resourceId elsewhere in the project,
    // so one exclusion list works across the dashboard and this Lambda.
    if (isExcludedResource(`${service.clusterName}/${service.serviceName}`)) continue;
    const id = `${sanitizeAlarmNamePart(service.clusterName)}-${sanitizeAlarmNamePart(service.serviceName)}`;
    const dimensions = [
      { Name: 'ClusterName', Value: service.clusterName },
      { Name: 'ServiceName', Value: service.serviceName },
    ];

    specs.push({
      alarmName: `${ALARM_NAME_PREFIX}ecs-cpu-high_${id}`,
      alarmDescription: `ECS ${service.clusterName}/${service.serviceName} CPUUtilization >= ${ECS_CPU_CRITICAL_PERCENT}%`,
      namespace: 'AWS/ECS',
      metricName: 'CPUUtilization',
      dimensions,
      statistic: 'Average',
      period: 300,
      evaluationPeriods: 3,
      threshold: ECS_CPU_CRITICAL_PERCENT,
      comparisonOperator: 'GreaterThanOrEqualToThreshold',
    });
    specs.push({
      alarmName: `${ALARM_NAME_PREFIX}ecs-memory-high_${id}`,
      alarmDescription: `ECS ${service.clusterName}/${service.serviceName} MemoryUtilization >= ${ECS_MEMORY_CRITICAL_PERCENT}%`,
      namespace: 'AWS/ECS',
      metricName: 'MemoryUtilization',
      dimensions,
      statistic: 'Average',
      period: 300,
      evaluationPeriods: 3,
      threshold: ECS_MEMORY_CRITICAL_PERCENT,
      comparisonOperator: 'GreaterThanOrEqualToThreshold',
    });
  }
  return specs;
}

/** Builds the ENTIRE desired `AlarmSpec[]` from 1 `OnlineResourceInventory` — a PURE function,
 * reusable in unit tests without mocking the AWS SDK. `now` defaults to `new Date()` when the
 * caller doesn't pass it (keeps backward compatibility for older tests calling
 * `buildDesiredAlarmSpecs(inventory)` with no 2nd argument) — pass `now` explicitly when you need
 * to control the warm-up evaluation time (EC2 warm-up unit tests). */
export function buildDesiredAlarmSpecs(inventory: OnlineResourceInventory, now: Date = new Date()): AlarmSpec[] {
  return [
    ...buildEc2AlarmSpecs(inventory.ec2, now),
    ...buildRdsAlarmSpecs(inventory.rds),
    ...buildAlbAlarmSpecs(inventory.alb),
    ...buildNlbAlarmSpecs(inventory.nlb ?? []),
    ...buildEcsAlarmSpecs(inventory.ecs),
    ...buildHostAlarmSpecs(inventory.hostMetrics ?? []),
  ];
}

// ---- Reconcile: PutMetricAlarm for each desired spec + DeleteAlarms for orphaned "standard" alarms ----

async function listExistingBaselineAlarmNames(): Promise<Set<string>> {
  const names = new Set<string>();
  let nextToken: string | undefined;
  do {
    const { MetricAlarms = [], NextToken } = await cloudwatch.send(
      new DescribeAlarmsCommand({ AlarmNamePrefix: ALARM_NAME_PREFIX, NextToken: nextToken }),
    );
    for (const alarm of MetricAlarms) {
      if (alarm.AlarmName) names.add(alarm.AlarmName);
    }
    nextToken = NextToken;
  } while (nextToken);
  return names;
}

/** `PutMetricAlarm` has no published TPS SLA, but in practice: firing ~47 commands sequentially
 * in the same reconcile run (no delay) was enough to hit `Throttling: Rate exceeded` on the last
 * few commands — retry with backoff ONLY for throttling errors (other errors — e.g. a wrong
 * Namespace/Dimension — retrying is pointless, so fail fast to log the real root cause clearly). */
const PUT_ALARM_MAX_ATTEMPTS = 4;
const PUT_ALARM_BASE_DELAY_MS = 500;

/** Max number of individual failed-alarm entries listed in the reconcile-error Discord embed —
 * same Discord Embed 1024-char field-size reasoning already applied to `MAX_LISTED_ALARMS` in
 * `health-report.ts`. */
const MAX_LISTED_ALARM_FAILURES = 10;

function isThrottlingError(err: unknown): boolean {
  return err instanceof Error && err.name === 'Throttling';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function putAlarm(spec: AlarmSpec): Promise<void> {
  for (let attempt = 1; attempt <= PUT_ALARM_MAX_ATTEMPTS; attempt += 1) {
    try {
      await cloudwatch.send(
        new PutMetricAlarmCommand({
          AlarmName: spec.alarmName,
          AlarmDescription: spec.alarmDescription,
          Namespace: spec.namespace,
          MetricName: spec.metricName,
          Dimensions: spec.dimensions,
          Statistic: spec.statistic,
          Period: spec.period,
          EvaluationPeriods: spec.evaluationPeriods,
          Threshold: spec.threshold,
          ComparisonOperator: spec.comparisonOperator,
          // Omitted when the spec does not set it, so CloudWatch keeps its default ('missing') and
          // every pre-existing alarm behaves exactly as before.
          TreatMissingData: spec.treatMissingData,
          AlarmActions: [ALARM_NOTIFICATION_TOPIC_ARN],
          OKActions: [ALARM_NOTIFICATION_TOPIC_ARN],
          // Does NOT set InsufficientDataActions — see the file-header comment.
          Tags: [
            { Key: 'ManagedBy', Value: 'ops-dashboard-alarm-baseline-manager' },
            { Key: 'Lifecycle', Value: 'active' },
          ],
        }),
      );
      return;
    } catch (err) {
      if (!isThrottlingError(err) || attempt === PUT_ALARM_MAX_ATTEMPTS) throw err;
      await sleep(PUT_ALARM_BASE_DELAY_MS * 2 ** (attempt - 1));
    }
  }
}

/** DeleteAlarms is limited to a maximum of 100 alarms/call — split into batches if exceeded. */
const DELETE_ALARMS_BATCH_SIZE = 100;

async function deleteAlarms(alarmNames: string[]): Promise<void> {
  for (let i = 0; i < alarmNames.length; i += DELETE_ALARMS_BATCH_SIZE) {
    const batch = alarmNames.slice(i, i + DELETE_ALARMS_BATCH_SIZE);
    await cloudwatch.send(new DeleteAlarmsCommand({ AlarmNames: batch }));
  }
}

export async function handler(): Promise<{ ok: true; created: number; deleted: number }> {
  const inventory = await discoverOnlineResources();
  const desiredSpecs = buildDesiredAlarmSpecs(inventory);
  const desiredNames = new Set(desiredSpecs.map((s) => s.alarmName));

  const existingNames = await listExistingBaselineAlarmNames();

  // Idempotent apply — PutMetricAlarm creates or updates (no distinction, like `kubectl
  // apply`/CloudFormation) for EVERY desired spec, whether it already exists or not. 1 failing
  // alarm shouldn't break reconciling the others — wrap each call individually, log the error, continue.
  let created = 0;
  let putFailed = 0;
  // WHICH alarms failed, not just how many — a bare count tells an operator to go read the logs
  // before they can even tell whether this is worth acting on right now; showing the actual names
  // (and each error's own message) directly in the notification means the common case ("it's
  // always the same 2 host alarms hitting Throttling") doesn't require opening CloudWatch Logs at
  // all. Bounded so 1 mass failure (e.g. a bad IAM change) can't blow out the Discord embed's
  // field size limit.
  const putFailures: { alarmName: string; message: string }[] = [];
  for (const spec of desiredSpecs) {
    try {
      await putAlarm(spec);
      created += 1;
    } catch (err) {
      putFailed += 1;
      putFailures.push({ alarmName: spec.alarmName, message: err instanceof Error ? err.message : String(err) });
      logger.error(`alarm-baseline-manager: PutMetricAlarm failed for "${spec.alarmName}" (skipping, continuing)`, err);
    }
  }

  // Orphan cleanup: a "standard" alarm that still exists but is NO LONGER in the desired set (its
  // resource was deleted/stopped since the previous reconcile) -> delete it, avoiding a repeat of
  // the original bug (an alarm stuck permanently in INSUFFICIENT_DATA because its backing resource
  // no longer exists).
  const orphanedNames = [...existingNames].filter((name) => !desiredNames.has(name));
  let deleted = 0;
  let deleteFailed = false;
  if (orphanedNames.length > 0) {
    try {
      await deleteAlarms(orphanedNames);
      deleted = orphanedNames.length;
    } catch (err) {
      deleteFailed = true;
      logger.error('alarm-baseline-manager: DeleteAlarms failed for orphaned alarms (skipping, will retry on the next reconcile)', err);
    }
  }

  // The exclusion list is stated on EVERY run on purpose. A resource silently missing from the alarm
  // set is indistinguishable from a bug, and "why is nothing alarming on X" is a question that must be
  // answerable from the logs alone.
  const excluded = [...EXCLUDED_RESOURCES];
  logger.info(
    `alarm-baseline-manager: reconcile done — ${desiredSpecs.length} desired alarms (${created} PutMetricAlarm succeeded), ` +
      `${deleted}/${orphanedNames.length} orphaned alarms deleted. ` +
      (excluded.length > 0
        ? `EXCLUDED from alarming by ALARM_BASELINE_EXCLUDED_RESOURCES (${excluded.length}): ${excluded.join(', ')}`
        : 'No resources excluded.'),
  );

  if (putFailed > 0 || deleteFailed) {
    const extra = [
      { name: 'PutMetricAlarm failures', value: String(putFailed), inline: true },
      { name: 'DeleteAlarms failed', value: deleteFailed ? 'yes' : 'no', inline: true },
      { name: 'Total desired alarms', value: String(desiredSpecs.length), inline: true },
    ];
    if (putFailures.length > 0) {
      const shown = putFailures.slice(0, MAX_LISTED_ALARM_FAILURES);
      const lines = shown.map((f) => `**${f.alarmName}**: ${f.message}`);
      const remaining = putFailures.length - shown.length;
      if (remaining > 0) lines.push(`… and ${remaining} more`);
      extra.push({ name: 'Failed alarms', value: lines.join('\n'), inline: false });
    }
    const region = process.env.AWS_REGION;
    const missingAlarmCoverage = putFailed; // every failed PutMetricAlarm leaves that resource with NO standard alarm at all until the next reconcile.
    const embed = buildOpsNotificationEmbed({
      what: 'alarm-baseline-manager: errors occurred during this reconcile',
      severity: 'critical',
      who: 'system:alarm-baseline-manager',
      impact:
        missingAlarmCoverage > 0
          ? `${missingAlarmCoverage} resource(s) are left WITHOUT their standard CloudWatch alarm until the next reconcile — a real problem on those resources will not page anyone.`
          : 'Orphaned alarm cleanup failed — a stale alarm from a deleted resource may still exist, but every resource\'s actual coverage is otherwise unaffected.',
      how: 'Check the failed alarms below for the specific error. Throttling clears on its own on the next hourly reconcile; any other error (e.g. a wrong Namespace/Dimension) needs a code fix.',
      links: region
        ? [{ label: 'CloudWatch Logs (alarm-baseline-manager-fn)', url: `https://${region}.console.aws.amazon.com/cloudwatch/home?region=${region}#logsV2:log-groups/log-group/$252Faws$252Flambda$252Fabc-ops-dashboard-prod-alerting-baseline-manager-fn` }]
        : undefined,
      region,
      extra,
    });
    await postDiscordEmbeds([embed]);
  }

  return { ok: true, created, deleted };
}
