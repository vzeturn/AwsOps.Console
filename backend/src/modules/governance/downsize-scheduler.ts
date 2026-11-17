import { ModifyDBInstanceCommand } from '@aws-sdk/client-rds';
import { StopInstancesCommand, StartInstancesCommand, ModifyInstanceAttributeCommand, DescribeInstancesCommand, waitUntilInstanceStopped } from '@aws-sdk/client-ec2';
import { getRdsClient, getEc2Client } from '../../core/aws-clients.js';
// Lean_Lambda_Exception (Requirement 6.4a): direct imports, not `../alerting/index.js` — see the
// exception comment in `agent/ai-ops-agent.ts` (same reason): `downsize-scheduler-fn` is a lean
// standalone Lambda.
import { postDiscordEmbeds, type DiscordEmbed } from '../alerting/discordWebhook.js';
import { buildOpsNotificationEmbed } from '../alerting/opsNotification.js';
import { logger } from '../../shared-kernel/logger.js';

/**
 * `downsize-scheduler-fn` — a Lambda reused for one-time manual RDS/EC2 downsize runs (confirmed
 * via chat, not the automatic Compute Optimizer). Receives resource + target class/type from the
 * EVENT PAYLOAD (not environment variables) — each downsize run only needs one one-time
 * EventBridge Scheduler created DIRECTLY VIA THE API (not through CloudFormation, since this is an
 * ad-hoc task that needs to be created/edited/deleted flexibly) pointing at this Lambda with a
 * different Input, with no redeploy needed.
 *
 * Does NOT reuse patch-scheduler-fn (only patches the OS on an on/off schedule, doesn't change
 * instance class/size) or ec2-rightsize-applier-fn (only self-applies when Compute Optimizer
 * CONFIRMS with high confidence, doesn't accept a manual target class) — different domains.
 */

export interface DownsizeSchedulerEvent {
  rds?: { instanceIdentifier: string; targetClass?: string; availabilityZone?: string };
  ec2?: { instanceId: string; targetType: string };
}

const rds = getRdsClient();
const ec2 = getEc2Client();

async function downsizeRds(instanceIdentifier: string, targetClass: string | undefined, availabilityZone: string | undefined): Promise<DiscordEmbed> {
  try {
    const result = await rds.send(
      new ModifyDBInstanceCommand({
        DBInstanceIdentifier: instanceIdentifier,
        ...(targetClass ? { DBInstanceClass: targetClass } : {}),
        ...(availabilityZone ? { AvailabilityZone: availabilityZone } : {}),
        ApplyImmediately: true,
      }),
    );
    // `ModifyDBInstanceCommand`'s response describes the instance's state RIGHT AFTER the API
    // call is accepted, BEFORE the change actually takes effect — `DBInstance.DBInstanceClass`/
    // `AvailabilityZone` are therefore still the ORIGINAL values (the new ones only appear in
    // `PendingModifiedValues` at this point). Free to read here, no extra DescribeDBInstances call
    // needed just to get the rollback value.
    const previousClass = result.DBInstance?.DBInstanceClass;
    const previousAz = result.DBInstance?.AvailabilityZone;
    const whatChanged = [targetClass ? `class -> \`${targetClass}\`` : undefined, availabilityZone ? `AZ -> \`${availabilityZone}\`` : undefined]
      .filter(Boolean)
      .join(', ');
    logger.info(`downsize-scheduler: RDS ${instanceIdentifier} (${whatChanged}) request sent successfully.`);
    const region = process.env.AWS_REGION;
    const rollbackParts: string[] = [];
    if (previousClass && targetClass) rollbackParts.push(`class back to \`${previousClass}\``);
    if (previousAz && availabilityZone) rollbackParts.push(`AZ back to \`${previousAz}\``);
    return buildOpsNotificationEmbed({
      what: `RDS ${instanceIdentifier} downsize succeeded`,
      severity: 'success',
      where: instanceIdentifier,
      who: 'system:downsize-scheduler',
      how: `${whatChanged} (ApplyImmediately). AWS will apply it within a few minutes; check status via describe-db-instances.`,
      links: region ? [{ label: 'Open in RDS', url: `https://${region}.console.aws.amazon.com/rds/home?region=${region}#database:id=${instanceIdentifier}` }] : undefined,
      region,
      extra: rollbackParts.length > 0
        ? [{ name: 'Rollback', value: `ModifyDBInstance \`${instanceIdentifier}\` ${rollbackParts.join(' and ')} (ApplyImmediately) if this doesn't perform as expected.`, inline: false }]
        : undefined,
    });
  } catch (err) {
    logger.error(`downsize-scheduler: ModifyDBInstance failed for ${instanceIdentifier}`, err);
    return buildOpsNotificationEmbed({
      what: `RDS ${instanceIdentifier} downsize failed`,
      severity: 'critical',
      where: instanceIdentifier,
      who: 'system:downsize-scheduler',
      why: (err as Error).message,
    });
  }
}

async function downsizeEc2(instanceId: string, targetType: string): Promise<DiscordEmbed> {
  // The Name tag is read from THIS SAME DescribeInstances call below (already needed to know
  // `State`) — no extra API call is made just to look up the name, avoiding a redundant
  // round-trip (STANDARDS.md §3).
  let displayName = instanceId;
  try {
    const { Reservations = [] } = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
    const instance = Reservations[0]?.Instances?.[0];
    const currentState = instance?.State?.Name;
    const wasRunning = currentState === 'running';
    const previousType = instance?.InstanceType;
    displayName = instance?.Tags?.find((t) => t.Key === 'Name')?.Value || instanceId;

    if (wasRunning) {
      await ec2.send(new StopInstancesCommand({ InstanceIds: [instanceId] }));
      await waitUntilInstanceStopped({ client: ec2, maxWaitTime: 300 }, { InstanceIds: [instanceId] });
    }

    await ec2.send(new ModifyInstanceAttributeCommand({ InstanceId: instanceId, InstanceType: { Value: targetType } }));

    if (wasRunning) {
      await ec2.send(new StartInstancesCommand({ InstanceIds: [instanceId] }));
    }

    logger.info(`downsize-scheduler: EC2 ${instanceId} -> ${targetType} succeeded (wasRunning=${wasRunning}).`);
    const region = process.env.AWS_REGION;
    return buildOpsNotificationEmbed({
      what: `EC2 ${displayName} downsize succeeded`,
      severity: 'success',
      where: displayName,
      who: 'system:downsize-scheduler',
      how: `Instance type: \`${targetType}\`${wasRunning ? ' — stopped, changed type, restarted.' : ' — instance was not running, only the type was changed.'}`,
      links: region ? [{ label: 'Open in EC2', url: `https://${region}.console.aws.amazon.com/ec2/home?region=${region}#InstanceDetails:instanceId=${instanceId}` }] : undefined,
      region,
      extra: previousType
        ? [{
            name: 'Rollback',
            value: `Change \`${displayName}\` back to \`${previousType}\`${wasRunning ? ' (stop, ModifyInstanceAttribute, start)' : ' (ModifyInstanceAttribute)'} if the new type doesn't perform as expected. Only safe within the same CPU architecture — do not cross x86_64 <-> arm64 this way.`,
            inline: false,
          }]
        : undefined,
    });
  } catch (err) {
    logger.error(`downsize-scheduler: type change failed for EC2 ${instanceId}`, err);
    return buildOpsNotificationEmbed({
      what: `EC2 ${displayName} downsize failed`,
      severity: 'critical',
      where: displayName,
      who: 'system:downsize-scheduler',
      why: (err as Error).message,
    });
  }
}

export interface DownsizeSchedulerResult {
  ok: true;
  rdsOutcome: 'success' | 'failure' | 'skipped';
  ec2Outcome: 'success' | 'failure' | 'skipped';
}

export async function handler(event: DownsizeSchedulerEvent): Promise<DownsizeSchedulerResult> {
  const embeds: DiscordEmbed[] = [];
  let rdsOutcome: DownsizeSchedulerResult['rdsOutcome'] = 'skipped';
  let ec2Outcome: DownsizeSchedulerResult['ec2Outcome'] = 'skipped';

  if (event.rds) {
    const embed = await downsizeRds(event.rds.instanceIdentifier, event.rds.targetClass, event.rds.availabilityZone);
    embeds.push(embed);
    rdsOutcome = embed.color === 0x57f287 ? 'success' : 'failure';
  }

  if (event.ec2) {
    const embed = await downsizeEc2(event.ec2.instanceId, event.ec2.targetType);
    embeds.push(embed);
    ec2Outcome = embed.color === 0x57f287 ? 'success' : 'failure';
  }

  if (embeds.length > 0) await postDiscordEmbeds(embeds);
  return { ok: true, rdsOutcome, ec2Outcome };
}
