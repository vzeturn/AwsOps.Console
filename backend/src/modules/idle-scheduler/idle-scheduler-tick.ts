/**
 * `idle-scheduler-tick.ts` — standalone Lambda (EventBridge Scheduler `rate(5 minutes)`, see
 * `infra/ops-dashboard.yaml`). Every 5 minutes: discovers EVERY ALB tagged
 * `idle-scheduler:managed=true` in the account/region, and for each one, stops its associated
 * EC2 instance + RDS instance once `idleMinutes` (default `DEFAULT_IDLE_MINUTES`) have passed with
 * ZERO requests summed across every one of the ALB's target groups.
 *
 * Replaces the retired `abc-stg-idle-stop` Lambda (formerly `infra/stg-idle-scheduler.yaml`,
 * deployed as its own `abc-stg-idle-scheduler` CloudFormation stack — deleted 2026-09-22, once
 * this module was confirmed working against the exact same live instance/ALB): that version
 * hardcoded exactly one EC2/RDS/ALB triple via CloudFormation Parameters. This version discovers
 * EVERY opted-in group by tag, so enrolling a second STG/dev environment later needs zero code
 * change and zero redeploy — only tagging the new ALB (see `idleScheduler.ts` for the full tagging
 * convention).
 *
 * Lean_Lambda_Exception (Requirement 6.4a — same reasoning as `governance-exemption-auditor.ts`):
 * imports `discordWebhook.ts`/`opsNotification.ts` directly, not via `../alerting/index.js`.
 */
import { DescribeLoadBalancersCommand, DescribeTagsCommand, DescribeTargetGroupsCommand } from '@aws-sdk/client-elastic-load-balancing-v2';
import { DescribeInstancesCommand, StopInstancesCommand } from '@aws-sdk/client-ec2';
import { DescribeDBInstancesCommand, StopDBInstanceCommand } from '@aws-sdk/client-rds';
import { GetMetricStatisticsCommand } from '@aws-sdk/client-cloudwatch';
import { getElasticLoadBalancingV2Client, getEc2Client, getRdsClient, getCloudWatchClient } from '../../core/aws-clients.js';
import { tagsToMap } from '../../core/awsTags.js';
import { fetchAllPages } from '../../core/pagination.js';
import { IDLE_SCHEDULER_HOLD_TAG_KEY } from '@ops-dashboard/shared';
import { parseManagedGroupTags, decideIdleStop, type IdleStopSkipReason } from './idle-scheduler-logic.js';
// Reuses the exact ALB-ARN-suffix extraction infra-service.ts already has (the value CloudWatch's
// `LoadBalancer` dimension requires) instead of re-deriving it with a second, slightly different
// implementation.
import { extractAlbArnSuffix } from '../infra/infra-service.js';
import { postDiscordEmbeds } from '../alerting/discordWebhook.js';
import { buildOpsNotificationEmbed } from '../alerting/opsNotification.js';
import { logger } from '../../shared-kernel/logger.js';

const elb = getElasticLoadBalancingV2Client();
const ec2 = getEc2Client();
const rds = getRdsClient();
const cw = getCloudWatchClient();

interface ManagedAlb {
  albArn: string;
  albName: string;
  /** `app/<name>/<id>` form — the value CloudWatch's `LoadBalancer` dimension requires. */
  albArnSuffix: string;
  ec2InstanceId: string;
  /** `undefined` when the group opted RDS out of idle-to-zero (e.g. `abc-stg-alb`, which stops
   * `abc-stg-rds-postgres` on a fixed midnight schedule instead — see `rds-nightly-scheduler.ts` —
   * to avoid the stop/wake flapping traffic-based idle detection caused for a DB with sparse,
   * bursty traffic). EC2 idle-to-zero still applies normally for these groups. */
  rdsInstanceId: string | undefined;
  idleMinutes: number;
}

async function discoverManagedAlbs(): Promise<{ managed: ManagedAlb[]; misconfigured: string[] }> {
  const allLoadBalancers = await fetchAllPages(async (marker) => {
    const { LoadBalancers = [], NextMarker } = await elb.send(new DescribeLoadBalancersCommand({ Marker: marker }));
    return { items: LoadBalancers, nextToken: NextMarker };
  });

  const managed: ManagedAlb[] = [];
  const misconfigured: string[] = [];
  const albsWithArn = allLoadBalancers.filter((lb) => lb.LoadBalancerArn && lb.LoadBalancerName);

  // DescribeTags accepts up to 20 ARNs per call — batch rather than one call per ALB.
  for (let i = 0; i < albsWithArn.length; i += 20) {
    const batch = albsWithArn.slice(i, i + 20);
    const arns = batch.map((lb) => lb.LoadBalancerArn!);
    const { TagDescriptions = [] } = await elb.send(new DescribeTagsCommand({ ResourceArns: arns }));
    for (const lb of batch) {
      const tagsList = TagDescriptions.find((td) => td.ResourceArn === lb.LoadBalancerArn)?.Tags ?? [];
      const tags = tagsToMap(tagsList);
      const parsed = parseManagedGroupTags(tags);
      if (!parsed) continue;
      // Only `ec2-instance-id` is required — `rds-instance-id` is optional, since a group may opt
      // RDS out of idle-to-zero entirely (see the `ManagedAlb.rdsInstanceId` comment above).
      if (!parsed.ec2InstanceId) {
        misconfigured.push(lb.LoadBalancerName!);
        continue;
      }
      const albArnSuffix = extractAlbArnSuffix(lb.LoadBalancerArn) ?? lb.LoadBalancerName!;
      managed.push({
        albArn: lb.LoadBalancerArn!,
        albName: lb.LoadBalancerName!,
        albArnSuffix,
        ec2InstanceId: parsed.ec2InstanceId,
        rdsInstanceId: parsed.rdsInstanceId,
        idleMinutes: parsed.idleMinutes,
      });
    }
  }

  return { managed, misconfigured };
}

async function targetGroupArnSuffixesFor(albArn: string): Promise<string[]> {
  const { TargetGroups = [] } = await elb.send(new DescribeTargetGroupsCommand({ LoadBalancerArn: albArn }));
  return TargetGroups.map((tg) => tg.TargetGroupArn?.split(':targetgroup/')[1]).filter((v): v is string => Boolean(v));
}

// ALB `RequestCount` (Standard resolution, `AWS/ApplicationELB`) can lag several minutes before a
// datapoint is fully ingested. Querying straight up to `now()` risks landing on a period CloudWatch
// hasn't finished aggregating yet, which returns an EMPTY datapoint (not a low one) for the most
// recent minutes — `sumRequestsInWindow` then reports 0 requests even though real traffic just
// happened, and `processGroup` stops the group. Minutes later the same still-warm traffic (or the
// next poll from whatever's generating it) hits the now-stopped target and 5xx's, firing the wake
// alarm — a stop/wake flap. Bug found in the wild (2026-09-24): `abc-stg-alb` flapped stopped/woken
// roughly every 20 minutes for hours because of this. Shifting the query window's end back by a
// fixed ingestion buffer keeps it entirely inside data CloudWatch has already finished aggregating.
const METRIC_INGESTION_BUFFER_MINUTES = 5;

async function sumRequestsInWindow(albArnSuffix: string, targetGroupArnSuffixes: string[], minutes: number): Promise<number> {
  const end = new Date(Date.now() - METRIC_INGESTION_BUFFER_MINUTES * 60_000);
  const start = new Date(end.getTime() - minutes * 60_000);
  let total = 0;
  for (const tgSuffix of targetGroupArnSuffixes) {
    const { Datapoints = [] } = await cw.send(
      new GetMetricStatisticsCommand({
        Namespace: 'AWS/ApplicationELB',
        MetricName: 'RequestCount',
        Dimensions: [
          // `albArnSuffix` (from `extractAlbArnSuffix`) is ALREADY in the `app/<name>/<id>` form
          // CloudWatch's `LoadBalancer` dimension requires — do NOT prepend another `app/` here.
          // Bug found in the wild (2026-09-22): prepending `app/` produced `app/app/<name>/<id>`,
          // which matches no real ALB, so GetMetricStatistics silently returned 0 datapoints —
          // no error, just an empty result — making every group look permanently idle
          // regardless of real traffic. Same class of bug the comment on
          // `extractAlbArnSuffix` in infra-service.ts already warns about.
          { Name: 'LoadBalancer', Value: albArnSuffix },
          { Name: 'TargetGroup', Value: `targetgroup/${tgSuffix}` },
        ],
        StartTime: start,
        EndTime: end,
        Period: minutes * 60,
        Statistics: ['Sum'],
      }),
    );
    total += Datapoints.reduce((sum, dp) => sum + (dp.Sum ?? 0), 0);
  }
  return total;
}

interface GroupOutcome {
  albName: string;
  action: 'stopped' | 'skip';
  reason?: IdleStopSkipReason;
  error?: string;
}

async function processGroup(group: ManagedAlb, now: Date): Promise<GroupOutcome> {
  let instance;
  try {
    const { Reservations = [] } = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [group.ec2InstanceId] }));
    instance = Reservations[0]?.Instances?.[0];
  } catch (err) {
    return { albName: group.albName, action: 'skip', error: `DescribeInstances failed: ${(err as Error).message}` };
  }
  if (!instance) {
    return { albName: group.albName, action: 'skip', error: `EC2 instance ${group.ec2InstanceId} not found` };
  }

  const tags = tagsToMap(instance.Tags);
  const held = tags[IDLE_SCHEDULER_HOLD_TAG_KEY] === 'true';
  const ec2State = instance.State?.Name ?? 'unknown';

  // Compute request count only when it can actually change the decision (avoids extra
  // GetMetricStatistics calls — held/not-running/grace-period all skip regardless of traffic).
  const preliminary = decideIdleStop({
    ec2State,
    ec2LaunchTime: instance.LaunchTime,
    held,
    idleMinutes: group.idleMinutes,
    requestsInIdleWindow: 0,
    now,
  });
  if (preliminary.action === 'skip' && preliminary.reason !== 'active') {
    return { albName: group.albName, action: 'skip', reason: preliminary.reason };
  }

  let requests: number;
  try {
    const tgSuffixes = await targetGroupArnSuffixesFor(group.albArn);
    requests = await sumRequestsInWindow(group.albArnSuffix, tgSuffixes, group.idleMinutes);
  } catch (err) {
    return { albName: group.albName, action: 'skip', error: `RequestCount lookup failed: ${(err as Error).message}` };
  }

  const decision = decideIdleStop({
    ec2State,
    ec2LaunchTime: instance.LaunchTime,
    held,
    idleMinutes: group.idleMinutes,
    requestsInIdleWindow: requests,
    now,
  });
  if (decision.action === 'skip') {
    return { albName: group.albName, action: 'skip', reason: decision.reason };
  }

  try {
    await ec2.send(new StopInstancesCommand({ InstanceIds: [group.ec2InstanceId] }));
  } catch (err) {
    return { albName: group.albName, action: 'skip', error: `StopInstances failed: ${(err as Error).message}` };
  }

  if (group.rdsInstanceId) {
    try {
      const { DBInstances = [] } = await rds.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: group.rdsInstanceId }));
      if (DBInstances[0]?.DBInstanceStatus === 'available') {
        await rds.send(new StopDBInstanceCommand({ DBInstanceIdentifier: group.rdsInstanceId }));
      }
    } catch (err) {
      logger.error(`idle-scheduler-tick: failed to stop RDS ${group.rdsInstanceId} for ALB ${group.albName} (EC2 already stopped)`, err);
    }
  }

  logger.info(`idle-scheduler-tick: stopped ${group.ec2InstanceId}${group.rdsInstanceId ? `/${group.rdsInstanceId}` : ''} for ALB ${group.albName} (0 requests in ${group.idleMinutes}m)`);
  return { albName: group.albName, action: 'stopped' };
}

export interface IdleSchedulerTickResult {
  ok: true;
  groupsChecked: number;
  stopped: number;
  misconfigured: string[];
  errors: number;
}

export async function handler(): Promise<IdleSchedulerTickResult> {
  const now = new Date();
  const { managed, misconfigured } = await discoverManagedAlbs();

  if (misconfigured.length > 0) {
    logger.error(`idle-scheduler-tick: ${misconfigured.length} ALB(s) tagged managed=true but missing a required companion tag: ${misconfigured.join(', ')}`);
  }

  const outcomes = await Promise.all(managed.map((group) => processGroup(group, now)));
  const stopped = outcomes.filter((o) => o.action === 'stopped');
  const errored = outcomes.filter((o) => o.error);

  logger.info(`idle-scheduler-tick: groupsChecked=${managed.length} stopped=${stopped.length} errors=${errored.length} misconfigured=${misconfigured.length}`);

  if (errored.length > 0 || misconfigured.length > 0) {
    const lines = [
      ...errored.map((o) => `**${o.albName}**: ${o.error}`),
      ...misconfigured.map((name) => `**${name}**: missing ec2-instance-id tag`),
    ];
    const embed = buildOpsNotificationEmbed({
      what: 'idle-scheduler-tick: errors while checking managed resource-groups',
      severity: 'warning',
      who: 'system:idle-scheduler-tick',
      impact: 'The affected resource-group(s) were NOT evaluated for idle-stop this cycle — they will be retried next run, but if this persists, cost savings for that group is not happening.',
      how: 'Fix the tag/permissions issue on the affected ALB, or check CloudWatch Logs for /aws/lambda/*-idle-scheduler-tick-fn for the full error.',
      extra: [{ name: 'Affected groups', value: lines.join('\n').slice(0, 1024), inline: false }],
      timestampOverride: now.toISOString(),
    });
    await postDiscordEmbeds([embed]);
  }

  return { ok: true, groupsChecked: managed.length, stopped: stopped.length, misconfigured, errors: errored.length };
}
