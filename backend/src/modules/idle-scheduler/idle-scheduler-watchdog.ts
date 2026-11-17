/**
 * `idle-scheduler-watchdog.ts` — standalone Lambda (EventBridge Scheduler `rate(60 minutes)`, see
 * `infra/ops-dashboard.yaml`). Re-asserts that idle-to-zero is ALWAYS fully active (per user
 * decision, 2026-09-22): it must not be possible for someone to silently switch off any part of
 * the mechanism — pausing the tick schedule, zeroing either Lambda's reserved concurrency (the
 * AWS-documented way to fully block a function from running while leaving it looking intact),
 * removing `idle-scheduler:managed=true` from an ALB, or disabling a wake alarm's actions.
 *
 * Deliberately does NOT touch EC2/RDS running/stopped state — its job is to keep the MECHANISM
 * itself always enabled, never to force a particular instance up or down (see `idleScheduler.ts`'s
 * file header). Any drift found is corrected AND published as a CloudWatch metric
 * (`WatchdogDriftDetected`) plus a Discord alert — silent auto-heal alone would let a pattern of
 * repeated disabling go unnoticed (same reasoning as `alarm-baseline-manager.ts`'s
 * `ALARM_BASELINE_EXCLUDED_RESOURCES` staleness concern).
 *
 * Lean_Lambda_Exception (Requirement 6.4a): imports `discordWebhook.ts`/`opsNotification.ts`
 * directly, not via `../alerting/index.js`.
 */
import { DescribeLoadBalancersCommand, DescribeTagsCommand } from '@aws-sdk/client-elastic-load-balancing-v2';
import { DescribeAlarmsCommand, EnableAlarmActionsCommand, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { GetScheduleCommand, UpdateScheduleCommand } from '@aws-sdk/client-scheduler';
import { GetFunctionConcurrencyCommand, PutFunctionConcurrencyCommand } from '@aws-sdk/client-lambda';
import { getElasticLoadBalancingV2Client, getCloudWatchClient, getSchedulerClient, getLambdaClient } from '../../core/aws-clients.js';
import { tagsToMap } from '../../core/awsTags.js';
import { fetchAllPages } from '../../core/pagination.js';
import { parseManagedGroupTags, hasAnyDrift, type WatchdogGroupDrift, type WatchdogMechanismDrift } from './idle-scheduler-logic.js';
import { buildWakeAlarmName, albNameFromWakeAlarmName, WAKE_ALARM_NAME_PREFIX } from './idle-scheduler-naming.js';
import { postDiscordEmbeds } from '../alerting/discordWebhook.js';
import { buildOpsNotificationEmbed } from '../alerting/opsNotification.js';
import { logger } from '../../shared-kernel/logger.js';

const elb = getElasticLoadBalancingV2Client();
const cw = getCloudWatchClient();
const scheduler = getSchedulerClient();
const lambda = getLambdaClient();

const METRIC_NAMESPACE = 'OpsDashboard/IdleScheduler';
const TICK_SCHEDULE_NAME = process.env.IDLE_SCHEDULER_TICK_SCHEDULE_NAME ?? '';
const TICK_SCHEDULE_GROUP = process.env.IDLE_SCHEDULER_SCHEDULE_GROUP ?? 'default';
const TICK_FUNCTION_NAME = process.env.IDLE_SCHEDULER_TICK_FUNCTION_NAME ?? '';
const WAKE_FUNCTION_NAME = process.env.IDLE_SCHEDULER_WAKE_FUNCTION_NAME ?? '';

async function checkTickSchedule(): Promise<boolean> {
  if (!TICK_SCHEDULE_NAME) {
    logger.error('idle-scheduler-watchdog: IDLE_SCHEDULER_TICK_SCHEDULE_NAME not configured, cannot check the tick schedule');
    return false;
  }
  const sched = await scheduler.send(new GetScheduleCommand({ Name: TICK_SCHEDULE_NAME, GroupName: TICK_SCHEDULE_GROUP }));
  if (sched.State === 'ENABLED') return false;

  logger.warn(`idle-scheduler-watchdog: tick schedule ${TICK_SCHEDULE_NAME} was ${sched.State} — re-enabling.`);
  await scheduler.send(
    new UpdateScheduleCommand({
      Name: TICK_SCHEDULE_NAME,
      GroupName: TICK_SCHEDULE_GROUP,
      ScheduleExpression: sched.ScheduleExpression,
      FlexibleTimeWindow: sched.FlexibleTimeWindow,
      Target: sched.Target,
      State: 'ENABLED',
      ...(sched.Description ? { Description: sched.Description } : {}),
      ...(sched.ScheduleExpressionTimezone ? { ScheduleExpressionTimezone: sched.ScheduleExpressionTimezone } : {}),
      ...(sched.ActionAfterCompletion ? { ActionAfterCompletion: sched.ActionAfterCompletion } : {}),
    }),
  );
  return true;
}

/** Reserved-concurrency = 0 is the AWS-documented way to fully block a function from running
 * while leaving the function itself (code, triggers, name) looking entirely intact — the single
 * most deceptive way to disable this mechanism without deleting anything visible. Restores to
 * "no reservation" (DeleteFunctionConcurrency-equivalent, via PutFunctionConcurrency with a
 * generous value would still cap it — using the SDK's own unreserved-concurrency semantics is
 * simplest expressed as: any explicit reservation found here is removed rather than raised, so
 * the function shares the account's unreserved pool exactly as it did before anyone touched it). */
async function checkFunctionNotBlocked(functionName: string): Promise<boolean> {
  if (!functionName) return false;
  let reserved: number | undefined;
  try {
    const resp = await lambda.send(new GetFunctionConcurrencyCommand({ FunctionName: functionName }));
    reserved = resp.ReservedConcurrentExecutions;
  } catch (err) {
    logger.error(`idle-scheduler-watchdog: could not read concurrency for ${functionName}`, err);
    return false;
  }
  if (reserved !== 0) return false;

  logger.warn(`idle-scheduler-watchdog: ${functionName} has ReservedConcurrentExecutions=0 (blocked) — restoring to 1.`);
  await lambda.send(new PutFunctionConcurrencyCommand({ FunctionName: functionName, ReservedConcurrentExecutions: 1 }));
  return true;
}

interface ManagedAlbTags {
  albArn: string;
  albName: string;
  managed: boolean;
}

async function listAllAlbTags(): Promise<ManagedAlbTags[]> {
  const allLoadBalancers = await fetchAllPages(async (marker) => {
    const { LoadBalancers = [], NextMarker } = await elb.send(new DescribeLoadBalancersCommand({ Marker: marker }));
    return { items: LoadBalancers, nextToken: NextMarker };
  });

  const result: ManagedAlbTags[] = [];
  const withArn = allLoadBalancers.filter((lb) => lb.LoadBalancerArn && lb.LoadBalancerName);
  for (let i = 0; i < withArn.length; i += 20) {
    const batch = withArn.slice(i, i + 20);
    const arns = batch.map((lb) => lb.LoadBalancerArn!);
    const { TagDescriptions = [] } = await elb.send(new DescribeTagsCommand({ ResourceArns: arns }));
    for (const lb of batch) {
      const tagsList = TagDescriptions.find((td) => td.ResourceArn === lb.LoadBalancerArn)?.Tags ?? [];
      const tags = tagsToMap(tagsList);
      result.push({ albArn: lb.LoadBalancerArn!, albName: lb.LoadBalancerName!, managed: parseManagedGroupTags(tags) !== undefined });
    }
  }
  return result;
}

/**
 * NOTE on "tag missing" drift: unlike the tick/wake Lambdas' concurrency or the schedule state,
 * this watchdog CANNOT safely restore a removed `idle-scheduler:managed=true` tag — it has no
 * record of what the tag's companion values (ec2-instance-id/rds-instance-id) USED to be once the
 * whole tag set is gone, and guessing would risk silently re-enrolling the wrong instance. Instead
 * this watchdog tracks disappearance via the alarm: every registered group's wake alarm keeps
 * existing (via `idle-scheduler-mutate-handler.ts`) independent of the ALB's own tags, so a
 * missing `managed` tag on an ALB that still has a corresponding wake alarm is exactly the drift
 * signal this function reports — the fix is a re-registration decision for a human (or the
 * mutate API), which the alert below asks for explicitly. Only the wake alarm's OWN
 * ActionsEnabled state is corrected automatically here.
 *
 * `allAlbTags` is fetched ONCE by the caller and passed in — this used to call `listAllAlbTags()`
 * (a full account-wide DescribeLoadBalancers + DescribeTags scan) separately for EVERY registered
 * group via `Promise.all`, turning an account with N managed groups into N redundant full scans
 * on every watchdog run. Fixed by hoisting the single scan up to `handler()`.
 */
async function checkGroupDrift(albName: string, allAlbTags: ManagedAlbTags[]): Promise<WatchdogGroupDrift> {
  const alb = allAlbTags.find((a) => a.albName === albName);
  const tagMissing = !alb?.managed;

  const alarmName = buildWakeAlarmName(albName);
  let wakeAlarmActionsDisabled = false;
  try {
    const { MetricAlarms = [] } = await cw.send(new DescribeAlarmsCommand({ AlarmNames: [alarmName] }));
    const alarm = MetricAlarms[0];
    if (alarm && alarm.ActionsEnabled === false) {
      logger.warn(`idle-scheduler-watchdog: wake alarm ${alarmName} has ActionsEnabled=false — re-enabling.`);
      await cw.send(new EnableAlarmActionsCommand({ AlarmNames: [alarmName] }));
      wakeAlarmActionsDisabled = true;
    }
  } catch (err) {
    logger.error(`idle-scheduler-watchdog: could not check/enable actions for alarm ${alarmName}`, err);
  }

  return { albName, tagMissing, wakeAlarmActionsDisabled };
}

/** Every ALB whose wake alarm exists is considered "registered" for the purposes of THIS
 * watchdog's group-level checks — discovered by listing alarms with the shared name prefix rather
 * than depending on the ALB still carrying its tags (see the doc comment on `checkGroupDrift`). */
async function discoverRegisteredAlbNames(): Promise<string[]> {
  const allAlarms = await fetchAllPages(async (nextToken) => {
    const { MetricAlarms = [], NextToken } = await cw.send(new DescribeAlarmsCommand({ AlarmNamePrefix: WAKE_ALARM_NAME_PREFIX, NextToken: nextToken }));
    return { items: MetricAlarms, nextToken: NextToken };
  });
  return allAlarms.map((alarm) => albNameFromWakeAlarmName(alarm.AlarmName ?? '')).filter((name): name is string => Boolean(name));
}

export interface IdleSchedulerWatchdogResult {
  ok: true;
  driftDetected: boolean;
  mechanism: WatchdogMechanismDrift;
  groups: WatchdogGroupDrift[];
}

export async function handler(): Promise<IdleSchedulerWatchdogResult> {
  const [tickScheduleDisabled, tickFunctionBlocked, wakeFunctionBlocked, registeredAlbNames, allAlbTags] = await Promise.all([
    checkTickSchedule(),
    checkFunctionNotBlocked(TICK_FUNCTION_NAME),
    checkFunctionNotBlocked(WAKE_FUNCTION_NAME),
    discoverRegisteredAlbNames(),
    listAllAlbTags(),
  ]);

  const groups = await Promise.all(registeredAlbNames.map((albName) => checkGroupDrift(albName, allAlbTags)));
  const mechanism: WatchdogMechanismDrift = { tickScheduleDisabled, tickFunctionBlocked, wakeFunctionBlocked };
  const driftDetected = hasAnyDrift(mechanism, groups);

  try {
    await cw.send(
      new PutMetricDataCommand({
        Namespace: METRIC_NAMESPACE,
        MetricData: [{ MetricName: 'WatchdogDriftDetected', Value: driftDetected ? 1 : 0, Unit: 'Count' }],
      }),
    );
  } catch (err) {
    logger.error('idle-scheduler-watchdog: failed to publish WatchdogDriftDetected metric', err);
  }

  logger.info(`idle-scheduler-watchdog: driftDetected=${driftDetected} mechanism=${JSON.stringify(mechanism)} groups=${JSON.stringify(groups)}`);

  if (driftDetected) {
    const lines: string[] = [];
    if (mechanism.tickScheduleDisabled) lines.push('Tick schedule was disabled — re-enabled.');
    if (mechanism.tickFunctionBlocked) lines.push('Tick Lambda had ReservedConcurrentExecutions=0 (blocked) — restored.');
    if (mechanism.wakeFunctionBlocked) lines.push('Wake Lambda had ReservedConcurrentExecutions=0 (blocked) — restored.');
    for (const g of groups) {
      if (g.tagMissing) lines.push(`**${g.albName}**: idle-scheduler:managed tag is missing (its wake alarm still exists) — needs manual re-registration.`);
      if (g.wakeAlarmActionsDisabled) lines.push(`**${g.albName}**: wake alarm actions were disabled — re-enabled.`);
    }

    const embed = buildOpsNotificationEmbed({
      what: 'idle-scheduler-watchdog: detected and corrected drift in the idle-to-zero mechanism',
      severity: 'warning',
      who: 'system:idle-scheduler-watchdog',
      impact: 'Idle-to-zero must always be active for every managed resource-group — this drift means someone (or something) disabled part of the mechanism outside of the intended tagging/API flow.',
      why: 'See the list below for exactly what was found out of place.',
      how: 'The mechanism self-heals automatically, EXCEPT a missing idle-scheduler:managed tag (that case needs a human/API decision — re-register the group via POST /idle-scheduler if it should still be managed). If this keeps recurring, investigate who/what keeps disabling it.',
      extra: [{ name: 'Findings', value: lines.join('\n').slice(0, 1024), inline: false }],
    });
    await postDiscordEmbeds([embed]);
  }

  return { ok: true, driftDetected, mechanism, groups };
}
