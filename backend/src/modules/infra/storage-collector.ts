import { ListBucketsCommand, GetBucketLifecycleConfigurationCommand } from '@aws-sdk/client-s3';
import { DescribeVolumesCommand } from '@aws-sdk/client-ec2';
import { GetMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { logger } from '../../shared-kernel/logger.js';
import { getS3Client, getEc2Client, getCloudWatchClient } from '../../core/aws-clients.js';

/**
 * Raw data for one S3 bucket. Has NO `threshold` field — unlike `S3BucketSummary` in
 * `@ops-dashboard/shared` (that field is a recommendation/threshold computed by
 * `lib/recommendations.ts` and `infra-review-collector.ts`, not the collector's job). The
 * remaining fields match `S3BucketSummary` exactly.
 */
export interface S3BucketRaw {
  bucketName: string;
  region: string;
  sizeByStorageClassGb: Record<string, number>;
  hasLifecyclePolicy: boolean;
}

/** Raw data for one EBS volume — same reason for no `threshold` field, see `S3BucketRaw`. */
export interface EbsVolumeRaw {
  volumeId: string;
  region: string;
  volumeType: string;
  sizeGb: number;
  attached: boolean;
}

export interface StorageData {
  s3Buckets: S3BucketRaw[];
  ebsVolumes: EbsVolumeRaw[];
}

/**
 * Collector that ONLY fetches raw data (doesn't decide recommendations) — called from
 * `infra-review-collector.ts` on a schedule (see design.md, "Backend — data collection" section).
 * The `acme` account operates primarily in `ap-southeast-1`; following the same simplification
 * used in `infra-service.ts` (EC2/RDS), assign `region: config.awsRegion` to every resource
 * instead of calling `GetBucketLocationCommand` per bucket.
 */
/** The Lambda runtime always sets this variable itself — no need for CloudFormation to declare it or to validate it. */
const AWS_REGION = process.env.AWS_REGION as string;

/** The main storage classes that can appear in the CloudWatch `AWS/S3` `BucketSizeBytes` metric. */
const STORAGE_TYPES = [
  'StandardStorage',
  'StandardIAStorage',
  'OneZoneIAStorage',
  'IntelligentTieringFAStorage',
  'GlacierInstantRetrievalStorage',
  'GlacierStorage',
  'DeepArchiveStorage',
  'ReducedRedundancyStorage',
] as const;

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * Fetches size per storage class for each bucket via CloudWatch `GetMetricData`
 * (namespace `AWS/S3`, metric `BucketSizeBytes`, dimension `BucketName` + `StorageType`).
 * This metric only publishes 1 datapoint/day, so a 3-day window is used with a `Period` of 1
 * day, taking the most recent point. `GetMetricData` caps at 500 queries/call — batched at 100
 * for safety.
 */
async function loadSizeByStorageClass(bucketNames: string[]): Promise<Map<string, Record<string, number>>> {
  const result = new Map<string, Record<string, number>>(bucketNames.map((name) => [name, {}]));
  if (bucketNames.length === 0) return result;

  const endTime = new Date();
  const startTime = new Date(endTime.getTime() - 3 * 24 * 60 * 60 * 1000);

  type QueryMeta = { id: string; bucketName: string; storageType: string };
  const queries: QueryMeta[] = [];
  bucketNames.forEach((bucketName, bIdx) => {
    STORAGE_TYPES.forEach((storageType, sIdx) => {
      queries.push({ id: `b${bIdx}s${sIdx}`, bucketName, storageType });
    });
  });

  for (const batch of chunk(queries, 100)) {
    const { MetricDataResults = [] } = await getCloudWatchClient().send(
      new GetMetricDataCommand({
        StartTime: startTime,
        EndTime: endTime,
        MetricDataQueries: batch.map((q) => ({
          Id: q.id,
          MetricStat: {
            Metric: {
              Namespace: 'AWS/S3',
              MetricName: 'BucketSizeBytes',
              Dimensions: [
                { Name: 'BucketName', Value: q.bucketName },
                { Name: 'StorageType', Value: q.storageType },
              ],
            },
            Period: 86400,
            Stat: 'Average',
          },
          ReturnData: true,
        })),
      }),
    );

    for (const metricResult of MetricDataResults) {
      const meta = batch.find((q) => q.id === metricResult.Id);
      if (!meta) continue;
      const latestValue = metricResult.Values?.[metricResult.Values.length - 1];
      if (latestValue === undefined || latestValue <= 0) continue;
      const sizesForBucket = result.get(meta.bucketName) ?? {};
      sizesForBucket[meta.storageType] = latestValue / 1024 ** 3; // bytes -> GB
      result.set(meta.bucketName, sizesForBucket);
    }
  }

  return result;
}

async function loadS3Buckets(): Promise<S3BucketRaw[]> {
  const { Buckets = [] } = await getS3Client().send(new ListBucketsCommand({}));
  const bucketNames = Buckets.map((b) => b.Name).filter((name): name is string => !!name);

  const sizeByBucket = await loadSizeByStorageClass(bucketNames).catch((err) => {
    // CloudWatch is a secondary source for size per storage class — a failure (throttling,
    // missing permissions) must not break the entire bucket list, just leave sizeByStorageClassGb empty.
    logger.error('storage-collector: CloudWatch BucketSizeBytes failed (skipping, sizeByStorageClassGb empty)', err);
    return new Map<string, Record<string, number>>();
  });

  const result: S3BucketRaw[] = [];
  for (const bucketName of bucketNames) {
    let hasLifecyclePolicy = false;
    try {
      const { Rules = [] } = await getS3Client().send(new GetBucketLifecycleConfigurationCommand({ Bucket: bucketName }));
      hasLifecyclePolicy = Rules.length > 0;
    } catch (err) {
      const errorName = (err as { name?: string }).name;
      // NoSuchLifecycleConfiguration is a normal outcome (bucket has no lifecycle policy yet),
      // not an error worth logging. Other errors (throttling, missing permissions...) are
      // wrapped per bucket — don't let one bucket's failure break the entire list.
      if (errorName !== 'NoSuchLifecycleConfiguration') {
        logger.error(
          'storage-collector: GetBucketLifecycleConfiguration failed (skipping, treating as no lifecycle policy)',
          { bucketName, error: err },
        );
      }
      hasLifecyclePolicy = false;
    }

    result.push({
      bucketName,
      region: AWS_REGION,
      sizeByStorageClassGb: sizeByBucket.get(bucketName) ?? {},
      hasLifecyclePolicy,
    });
  }
  return result;
}

async function loadEbsVolumes(): Promise<EbsVolumeRaw[]> {
  const volumes: EbsVolumeRaw[] = [];
  let nextToken: string | undefined;

  do {
    const { Volumes = [], NextToken } = await getEc2Client().send(new DescribeVolumesCommand({ NextToken: nextToken }));
    for (const volume of Volumes) {
      volumes.push({
        volumeId: volume.VolumeId ?? '',
        region: AWS_REGION,
        volumeType: volume.VolumeType ?? 'unknown',
        sizeGb: volume.Size ?? 0,
        attached: (volume.Attachments?.length ?? 0) > 0 || volume.State === 'in-use',
      });
    }
    nextToken = NextToken;
  } while (nextToken);

  return volumes;
}

/**
 * Collects raw S3 + EBS data for `infra-review-collector`. Wraps errors separately per source
 * (S3 / EBS) — one source failing returns empty for that part, WITHOUT breaking the whole
 * result (Requirements 4.1, 4.2, 4.3, 4.4). This function ONLY collects raw data, it does not
 * decide recommendations itself — that's `lib/recommendations.ts`'s job.
 */
export async function getStorageData(): Promise<StorageData> {
  const [s3Buckets, ebsVolumes] = await Promise.all([
    loadS3Buckets().catch((err) => {
      logger.error('storage-collector: collecting S3 buckets failed (skipping, s3Buckets=[])', err);
      return [] as S3BucketRaw[];
    }),
    loadEbsVolumes().catch((err) => {
      logger.error('storage-collector: collecting EBS volumes failed (skipping, ebsVolumes=[])', err);
      return [] as EbsVolumeRaw[];
    }),
  ]);

  return { s3Buckets, ebsVolumes };
}
