import { DescribeAddressesCommand } from '@aws-sdk/client-ec2';
import { logger } from '../../shared-kernel/logger.js';
import { getEc2Client } from '../../core/aws-clients.js';

/** The Lambda runtime always sets this variable itself — no need to declare it in CloudFormation
 * or validate it. */
const AWS_REGION = process.env.AWS_REGION as string;

/**
 * Raw data for one Elastic IP (public IPv4 address) — the collector ONLY gathers measured data,
 * it does NOT decide the recommendation itself. The orchestrator (`infra-review-collector.ts`)
 * uses `associated === false` to generate a `RecommendationItem` (findingType
 * `elasticIpUnused`) — AWS charges for an Elastic IP that ISN'T attached to a running resource
 * the same as an IP in use ($0.005/hour in every region, confirmed via the official AWS VPC
 * Pricing page — no made-up numbers).
 */
export interface ElasticIpRaw {
  allocationId: string;
  publicIp: string;
  region: string;
  /** `true` when the EIP is attached to a network interface (`AssociationId` has a value) —
   * `false` means the EIP is "orphaned," still billed hourly even though it's not used by any
   * resource. */
  associated: boolean;
}

/**
 * Surveys every Elastic IP in the AWS_Account — returns only raw data (attached or not), does not
 * decide the recommendation itself. Errors are isolated: if `DescribeAddresses` fails, log it and
 * return empty — don't break the other collectors (same pattern as
 * `getStorageData()`/`collectRds()`).
 */
export async function collectElasticIps(): Promise<ElasticIpRaw[]> {
  try {
    const { Addresses = [] } = await getEc2Client().send(new DescribeAddressesCommand({}));
    return Addresses.filter((addr) => addr.AllocationId && addr.PublicIp).map((addr) => ({
      allocationId: addr.AllocationId as string,
      publicIp: addr.PublicIp as string,
      region: AWS_REGION,
      associated: !!addr.AssociationId,
    }));
  } catch (err) {
    logger.error('elastic-ip-collector: DescribeAddresses failed (ignored, returning empty)', err);
    return [];
  }
}
