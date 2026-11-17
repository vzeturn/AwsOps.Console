import { ListBucketsCommand, GetBucketPolicyStatusCommand, GetBucketTaggingCommand } from '@aws-sdk/client-s3';
import { getS3Client } from '../../core/aws-clients.js';
import { logger } from '../../shared-kernel/logger.js';

/**
 * Public-exposure status of every bucket. Extracted from security-public-bucket-guardian.ts so the
 * findings-aggregator can reuse it WITHOUT pulling in Discord/opsNotification. See the guardian's
 * header for why `IsPublic` + the `DataClass=public` tag convention is the rule.
 */

const DATA_CLASS_TAG_KEY = 'DataClass';
const DATA_CLASS_PUBLIC_VALUE = 'public';

export interface BucketPublicStatus {
  bucketName: string;
  isPublic: boolean;
  dataClassTagValue: string | undefined;
}

async function listAllBucketNames(): Promise<string[]> {
  const { Buckets = [] } = await getS3Client().send(new ListBucketsCommand({}));
  return Buckets.map((b) => b.Name).filter((name): name is string => Boolean(name));
}

/** NoSuchBucketPolicy -> false (not public via policy); any other error -> undefined (unknown). */
async function checkIsPublic(bucketName: string): Promise<boolean | undefined> {
  try {
    const { PolicyStatus } = await getS3Client().send(new GetBucketPolicyStatusCommand({ Bucket: bucketName }));
    return PolicyStatus?.IsPublic ?? false;
  } catch (err) {
    if (err instanceof Error && err.name === 'NoSuchBucketPolicy') return false;
    logger.error(`security-public-bucket-status: failed to read policy status for bucket ${bucketName} (treating as unknown)`, err);
    return undefined;
  }
}

async function readDataClassTag(bucketName: string): Promise<string | undefined> {
  try {
    const { TagSet = [] } = await getS3Client().send(new GetBucketTaggingCommand({ Bucket: bucketName }));
    return TagSet.find((t) => t.Key === DATA_CLASS_TAG_KEY)?.Value;
  } catch (err) {
    if (err instanceof Error && err.name === 'NoSuchTagSet') return undefined;
    logger.error(`security-public-bucket-status: failed to read tags for bucket ${bucketName} (treating as no tag)`, err);
    return undefined;
  }
}

/** `undetermined` = buckets whose public status could not be read. Callers that auto-resolve
 * findings MUST treat a non-empty list as "source not healthy" (fail-safe, no false all-clear). */
export async function collectBucketPublicStatuses(): Promise<{ statuses: BucketPublicStatus[]; undetermined: string[] }> {
  const bucketNames = await listAllBucketNames();
  const results = await Promise.all(
    bucketNames.map(async (bucketName) => {
      const isPublic = await checkIsPublic(bucketName);
      if (isPublic === undefined) return { bucketName, status: undefined };
      const dataClassTagValue = await readDataClassTag(bucketName);
      return { bucketName, status: { bucketName, isPublic, dataClassTagValue } };
    }),
  );
  return {
    statuses: results.flatMap((r) => (r.status ? [r.status] : [])),
    undetermined: results.filter((r) => !r.status).map((r) => r.bucketName),
  };
}

/** Public AND not tagged exactly DataClass=public. */
export function findUnexplainedPublicBuckets(statuses: BucketPublicStatus[]): BucketPublicStatus[] {
  return statuses.filter((s) => s.isPublic && s.dataClassTagValue !== DATA_CLASS_PUBLIC_VALUE);
}
