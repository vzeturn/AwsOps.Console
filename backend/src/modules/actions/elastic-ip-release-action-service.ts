import { DescribeAddressesCommand, ReleaseAddressCommand } from '@aws-sdk/client-ec2';
import type { ActionExecutionResult } from '@ops-dashboard/shared';
import { getEc2Client } from '../../core/aws-clients.js';

/**
 * `elastic-ip-release-action-service.ts` runs inside `action-execution-fn` (a dedicated mutate
 * Lambda, `ActionExecutionRole`). Executes the `ElasticIp_Release` Resource_Action — releases an
 * Elastic IP that isn't attached to any resource (findingType `elasticIpUnused` in
 * `infra-review-collector.ts`). `ec2:ReleaseAddress` is a TRULY ONE-WAY action — AWS does not
 * guarantee you get that same IP address back (see `ACTION_CATALOG`,
 * `reversibilityClass: 'irreversible'`).
 */
const ec2 = getEc2Client();

/**
 * Executes `ElasticIp_Release`: re-reads the current `AssociationId` state AT EXECUTION TIME
 * (don't trust preview data, which may be stale), only proceeds if the EIP is STILL unattached.
 *
 * - `allocationId` doesn't exist -> `'rejected'`.
 * - The EIP HAS been attached to a resource (someone attached it between opening
 *   Confirmation_Dialog and execution) -> `'rejected'` (never release an IP that's in use — it
 *   would disconnect that resource).
 * - `ReleaseAddress` fails -> `'failure'`.
 */
export async function executeElasticIpRelease(allocationId: string): Promise<ActionExecutionResult> {
  let associated: boolean;
  let publicIp: string | undefined;
  try {
    const { Addresses = [] } = await ec2.send(new DescribeAddressesCommand({ AllocationIds: [allocationId] }));
    const address = Addresses[0];
    if (!address) {
      return { outcome: 'rejected', reason: `Elastic IP with allocationId ${allocationId} not found at execution time.` };
    }
    associated = !!address.AssociationId;
    publicIp = address.PublicIp;
  } catch (err) {
    return { outcome: 'failure', reason: `Failed to read the current state of Elastic IP ${allocationId}: ${(err as Error).message}` };
  }

  if (associated) {
    return {
      outcome: 'rejected',
      reason: `Elastic IP ${allocationId} has already been attached to a resource at execution time — not releasing it, to avoid disconnecting that resource.`,
    };
  }

  try {
    await ec2.send(new ReleaseAddressCommand({ AllocationId: allocationId }));
  } catch (err) {
    return { outcome: 'failure', reason: `ReleaseAddress failed for ${allocationId}: ${(err as Error).message}` };
  }

  return { outcome: 'success', releasedPublicIp: publicIp };
}
