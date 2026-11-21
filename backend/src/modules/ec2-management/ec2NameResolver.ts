import { DescribeInstancesCommand, DescribeNatGatewaysCommand, type EC2Client } from '@aws-sdk/client-ec2';
import { logger } from '../../shared-kernel/logger.js';

/**
 * `ec2NameResolver.ts` — a SHARED "resolve an AWS resource id to its human Name tag" helper.
 * Extracted out of `alarm-notifier.ts` (where this started as 2 private functions) so
 * `health-report.ts` can show the SAME resolved name for the SAME `InstanceId` an operator would
 * already recognize from a CloudWatch Alarm notification — a notification that shows a bare
 * `i-0a1b2c3d4e5f60001` in one channel and a friendly name in another (for the exact same
 * instance) is confusing in a way that undermines the whole point of resolving names at all.
 *
 * Every lookup here is a "best effort, never fail the caller" lookup: a deleted resource, a
 * missing IAM permission, or a transient API error all resolve to `undefined` rather than
 * throwing — the caller's fallback is always the raw id, which is strictly better than losing the
 * notification entirely over a name lookup that doesn't matter as much as the notification itself.
 */

/**
 * Looks up the `Name` tag of an EC2 instance by `instanceId` — lets an operator recognize which
 * service is affected without opening the AWS Console/CLI for every alarm/report. Returns
 * `undefined` when the instance no longer exists, the tag is absent, or the API call fails for
 * any reason (never throws).
 */
export async function fetchEc2NameTag(ec2: EC2Client, instanceId: string): Promise<string | undefined> {
  try {
    const result = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
    const tags = result.Reservations?.[0]?.Instances?.[0]?.Tags ?? [];
    return tags.find((t) => t.Key === 'Name')?.Value || undefined;
  } catch (err) {
    logger.error(`ec2NameResolver: failed to look up Name tag for EC2 instance ${instanceId} (ignoring)`, err);
    return undefined;
  }
}

/** Same lookup for a NAT Gateway (`nat-xxx`) — same "unreadable id, look up the Name tag" reason,
 * same never-throw contract as `fetchEc2NameTag`. */
export async function fetchNatGatewayNameTag(ec2: EC2Client, natGatewayId: string): Promise<string | undefined> {
  try {
    const result = await ec2.send(new DescribeNatGatewaysCommand({ NatGatewayIds: [natGatewayId] }));
    const tags = result.NatGateways?.[0]?.Tags ?? [];
    return tags.find((t) => t.Key === 'Name')?.Value || undefined;
  } catch (err) {
    logger.error(`ec2NameResolver: failed to look up Name tag for NAT Gateway ${natGatewayId} (ignoring)`, err);
    return undefined;
  }
}

/**
 * Convenience wrapper for the common display pattern used across every notification composer in
 * this project: show the Name tag when one was found, otherwise fall back to the raw id (never
 * show both, per the requirement "should only use names, not ids, since they're hard to read" —
 * the id is only a fallback clue for manual lookup when the name genuinely isn't available).
 */
export async function resolveEc2DisplayName(ec2: EC2Client, instanceId: string): Promise<string> {
  const name = await fetchEc2NameTag(ec2, instanceId);
  return name ?? instanceId;
}
