/**
 * `idle-scheduler-wake.ts` — standalone Lambda, subscribed to `IdleSchedulerWakeTopic` (SNS). Each
 * managed resource-group has its OWN CloudWatch Alarm (`Alb5xxCount > 0` for
 * `WAKE_DEBOUNCE_DATAPOINTS` consecutive 1-minute periods, created by
 * `idle-scheduler-mutate-handler.ts` when the group is registered) whose `AlarmActions` all point
 * at this ONE shared topic/Lambda — mirrors the retired `abc-stg-wake` Lambda's behavior (start
 * EC2+RDS in parallel to minimize combined wake latency), generalized to any group instead of one
 * hardcoded instance pair.
 *
 * The alarm's `AlarmName` follows the fixed convention `idle-scheduler-wake-<albName>` (see
 * `buildWakeAlarmName` in `idle-scheduler-mutate-handler.ts`) — this Lambda parses the ALB name
 * back out of the incoming SNS message's `AlarmName` field, then re-reads that ALB's OWN tags to
 * find which EC2/RDS instance to start (rather than embedding instance ids in the alarm/SNS
 * payload) — the ALB's tags are the single source of truth for a group's membership (see
 * `idleScheduler.ts`), so re-reading them here means a tag update takes effect on the very next
 * wake with no redeploy, exactly like the tick Lambda.
 *
 * Lean_Lambda_Exception (Requirement 6.4a): imports `alertHook.ts`/`opsNotification.ts`
 * directly, not via `../alerting/index.js`.
 */
import type { SNSEvent } from 'aws-lambda';
import { DescribeLoadBalancersCommand, DescribeTagsCommand } from '@aws-sdk/client-elastic-load-balancing-v2';
import { DescribeInstancesCommand, StartInstancesCommand } from '@aws-sdk/client-ec2';
import { DescribeDBInstancesCommand, StartDBInstanceCommand } from '@aws-sdk/client-rds';
import { getElasticLoadBalancingV2Client, getEc2Client, getRdsClient } from '../../core/aws-clients.js';
import { tagsToMap } from '../../core/awsTags.js';
import { parseManagedGroupTags } from './idle-scheduler-logic.js';
import { WAKE_ALARM_NAME_PREFIX, albNameFromWakeAlarmName } from './idle-scheduler-naming.js';
import { postAlertEmbeds } from '../alerting/alertHook.js';
import { buildOpsNotificationEmbed } from '../alerting/opsNotification.js';
import { logger } from '../../shared-kernel/logger.js';

const elb = getElasticLoadBalancingV2Client();
const ec2 = getEc2Client();
const rds = getRdsClient();

interface AlarmMessage {
  AlarmName?: string;
  NewStateValue?: string;
}

async function findGroupAlbArn(albName: string): Promise<string | undefined> {
  // DescribeLoadBalancers by Names is the cheapest way to resolve name -> ARN + re-read tags,
  // avoiding a full account-wide scan (unlike idle-scheduler-tick.ts, which legitimately needs to
  // scan every ALB since it doesn't yet know which ones are managed).
  try {
    const { LoadBalancers = [] } = await elb.send(new DescribeLoadBalancersCommand({ Names: [albName] }));
    return LoadBalancers[0]?.LoadBalancerArn;
  } catch (err) {
    logger.error(`idle-scheduler-wake: DescribeLoadBalancers failed for ${albName}`, err);
    return undefined;
  }
}

async function startEc2(instanceId: string): Promise<string> {
  const { Reservations = [] } = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
  const state = Reservations[0]?.Instances?.[0]?.State?.Name ?? 'unknown';
  if (state !== 'stopped') return `ec2 skipped (state=${state})`;
  await ec2.send(new StartInstancesCommand({ InstanceIds: [instanceId] }));
  return `ec2 start requested (was ${state})`;
}

async function startRds(instanceId: string): Promise<string> {
  const { DBInstances = [] } = await rds.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: instanceId }));
  const status = DBInstances[0]?.DBInstanceStatus ?? 'unknown';
  if (status !== 'stopped') return `rds skipped (status=${status})`;
  await rds.send(new StartDBInstanceCommand({ DBInstanceIdentifier: instanceId }));
  return `rds start requested (was ${status})`;
}

async function wakeGroup(albName: string): Promise<{ ec2: string; rds: string } | { error: string }> {
  const albArn = await findGroupAlbArn(albName);
  if (!albArn) return { error: `ALB ${albName} not found` };

  let tags: Record<string, string>;
  try {
    const { TagDescriptions = [] } = await elb.send(new DescribeTagsCommand({ ResourceArns: [albArn] }));
    tags = tagsToMap(TagDescriptions[0]?.Tags);
  } catch (err) {
    return { error: `DescribeTags failed for ${albName}: ${(err as Error).message}` };
  }

  const parsed = parseManagedGroupTags(tags);
  if (!parsed || !parsed.ec2InstanceId) {
    return { error: `ALB ${albName} is no longer a valid managed group (tags missing/changed)` };
  }

  // `rdsInstanceId` is optional — a group may opt RDS out of idle-to-zero (fixed midnight schedule
  // instead, see `rds-nightly-scheduler.ts`); only EC2 is woken for those groups.
  const [ec2Result, rdsResult] = await Promise.all([
    startEc2(parsed.ec2InstanceId).catch((err) => `error: ${(err as Error).message}`),
    parsed.rdsInstanceId ? startRds(parsed.rdsInstanceId).catch((err) => `error: ${(err as Error).message}`) : Promise.resolve('rds not managed by idle-scheduler'),
  ]);
  return { ec2: ec2Result, rds: rdsResult };
}

export async function handler(event: SNSEvent): Promise<{ ok: true; processed: number }> {
  let processed = 0;

  for (const record of event.Records) {
    let message: AlarmMessage;
    try {
      message = JSON.parse(record.Sns.Message) as AlarmMessage;
    } catch {
      logger.error('idle-scheduler-wake: could not parse SNS message as JSON, skipping record');
      continue;
    }

    if (message.NewStateValue !== 'ALARM') continue; // Only act on the transition INTO alarm, not OK/INSUFFICIENT_DATA.

    const albName = albNameFromWakeAlarmName(message.AlarmName ?? '');
    if (!albName) {
      logger.error(`idle-scheduler-wake: alarm name '${message.AlarmName}' does not match the '${WAKE_ALARM_NAME_PREFIX}<albName>' convention, skipping`);
      continue;
    }

    const result = await wakeGroup(albName);
    processed += 1;

    if ('error' in result) {
      logger.error(`idle-scheduler-wake: failed to wake group for ALB ${albName}: ${result.error}`);
      const embed = buildOpsNotificationEmbed({
        what: `idle-scheduler-wake: failed to wake resource-group ${albName}`,
        severity: 'critical',
        who: 'system:idle-scheduler-wake',
        impact: 'A real request arrived for this stopped environment but the automatic wake failed — it will stay unreachable until manually started or the alarm re-fires successfully.',
        why: result.error,
        how: `Manually start the EC2 instance + RDS instance behind ALB ${albName}, then investigate why the automatic wake failed.`,
      });
      await postAlertEmbeds([embed]);
    } else {
      logger.info(`idle-scheduler-wake: woke group for ALB ${albName}: ec2=${result.ec2} rds=${result.rds}`);
    }
  }

  return { ok: true, processed };
}
