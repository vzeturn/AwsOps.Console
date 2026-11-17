import { DescribeDBInstancesCommand, type DBInstance } from '@aws-sdk/client-rds';
import {
  GetMetricDataCommand,
  type MetricDataQuery,
  type MetricDataResult,
} from '@aws-sdk/client-cloudwatch';
import { logger } from '../../shared-kernel/logger.js';
import { fetchAllPages } from '../../core/pagination.js';
import { mapWithConcurrency } from '../../core/concurrency.js';
import { getRdsClient, getCloudWatchClient } from '../../core/aws-clients.js';

/** The Lambda runtime always sets this variable itself — no CloudFormation declaration or
 * validation needed. */
const AWS_REGION = process.env.AWS_REGION as string;

/** Usage survey window — the last 30 days (Requirement 2.1, 2.2), same as ec2-collector.ts. */
const SURVEY_PERIOD_DAYS = 30;
const SURVEY_PERIOD_SECONDS = SURVEY_PERIOD_DAYS * 24 * 60 * 60;

/** GetMetricData caps out at 500 metric queries per call — 3 queries/instance (CPU avg/max,
 * connections), so batch by instance. */
const INSTANCES_PER_BATCH = 150;

/** Tag names used to identify the production environment (case-insensitive). */
const ENVIRONMENT_TAG_KEYS = ['environment', 'env'];
/** Tag values considered production (case-insensitive). */
const PRODUCTION_TAG_VALUES = ['production', 'prod'];

/**
 * Raw data for one RDS instance — the collector ONLY gathers measured data, it does NOT decide
 * recommendations/protection gaps itself. The orchestrator (`infra-review-collector.ts`, task 7.1)
 * uses `classifyByThreshold` (rightsizing based on `avgCpuPercent`/`avgConnections`, Requirement
 * 2.2) and `buildProtectionGapFinding` (availability risk when `multiAz === false` and
 * `isProduction`, Requirement 2.3) in `lib/recommendations.ts` to generate
 * `RecommendationItem`/`ProtectionGap` from this data.
 */
export interface RdsCollectorItem {
  dbInstanceIdentifier: string;
  region: string;
  engine: string;
  dbInstanceClass: string;
  multiAz: boolean;
  allocatedStorageGb: number;
  /** Average CPUUtilization (%) over the survey window; null if CloudWatch returns no data. */
  avgCpuPercent: number | null;
  /**
   * MAXIMUM CPUUtilization (%) over the survey window — plays the same role as `maxCpuPercent` on
   * `Ec2CollectorItem` (see the comment there): a SECOND safety check layer for the `rdsLowCpu`
   * rule (a fallback for when Compute Optimizer has no data for this instance). `null` if
   * CloudWatch returns no data.
   */
  maxCpuPercent: number | null;
  /** Average DatabaseConnections over the survey window; null if no data is available. */
  avgConnections: number | null;
  /**
   * Flags a resource as production based on the `Environment`/`Env` tag = 'production'/'prod'
   * (case-insensitive, see `ENVIRONMENT_TAG_KEYS`/`PRODUCTION_TAG_VALUES`).
   * ASSUMPTION: if the instance has no matching environment tag, it is treated as NOT production
   * (`false`) — this avoids a false-positive protection gap being recorded for a non-prod/dev/test
   * resource just because it's missing a tag. This is a reasonable convention but it can miss a
   * real production instance that hasn't been tagged per convention; the orchestrator/operator
   * should add the tag if higher accuracy is needed.
   */
  isProduction: boolean;
}

interface RdsInstanceDescriptor {
  dbInstanceIdentifier: string;
  engine: string;
  dbInstanceClass: string;
  multiAz: boolean;
  allocatedStorageGb: number;
  isProduction: boolean;
}

interface InstanceMetrics {
  avgCpuPercent: number | null;
  maxCpuPercent: number | null;
  avgConnections: number | null;
}

/** MetricDataQuery.Id only accepts [a-z][a-zA-Z0-9_]* — replace invalid characters (e.g. '-' in a db identifier) with '_'. */
function sanitizeQueryId(dbInstanceIdentifier: string): string {
  return dbInstanceIdentifier.replace(/[^a-zA-Z0-9_]/g, '_');
}

function buildMetricQuery(
  queryId: string,
  metricName: string,
  dbInstanceIdentifier: string,
  stat: 'Average' | 'Maximum' = 'Average',
): MetricDataQuery {
  return {
    Id: queryId,
    MetricStat: {
      Metric: {
        Namespace: 'AWS/RDS',
        MetricName: metricName,
        Dimensions: [{ Name: 'DBInstanceIdentifier', Value: dbInstanceIdentifier }],
      },
      // Period equals the exact length of the survey window -> CloudWatch returns exactly one
      // datapoint (average or maximum depending on `stat` — see the `maxCpuPercent` field on
      // `RdsCollectorItem`).
      Period: SURVEY_PERIOD_SECONDS,
      Stat: stat,
    },
    ReturnData: true,
  };
}

function firstValue(results: MetricDataResult[], queryId: string): number | null {
  const match = results.find((r) => r.Id === queryId);
  const value = match?.Values?.[0];
  return typeof value === 'number' ? value : null;
}

/**
 * Determines whether a resource is production based on the `Environment`/`Env` tag =
 * 'production'/'prod' (case-insensitive on both the tag name and value). See the full assumption
 * in the comment on the `isProduction` field of `RdsCollectorItem`.
 */
function resolveIsProduction(tags: { Key?: string; Value?: string }[] | undefined): boolean {
  if (!tags) return false;
  return tags.some((tag) => {
    const key = tag.Key?.toLowerCase() ?? '';
    const value = tag.Value?.toLowerCase() ?? '';
    return ENVIRONMENT_TAG_KEYS.includes(key) && PRODUCTION_TAG_VALUES.includes(value);
  });
}

async function loadRdsInstances(): Promise<RdsInstanceDescriptor[]> {
  // DescribeDBInstances returns a bounded page (Marker in/out) — RDS::DescribeDBInstancesMessage
  // documents a max of 100 records/call. Paginated via fetchAllPages (core/pagination.ts) so an
  // account with more than one page of RDS instances is not silently truncated.
  const dbInstances = await fetchAllPages<DBInstance, string>(async (marker) => {
    const { DBInstances = [], Marker } = await getRdsClient().send(new DescribeDBInstancesCommand({ Marker: marker }));
    return { items: DBInstances, nextToken: Marker };
  });

  const result: RdsInstanceDescriptor[] = [];
  for (const db of dbInstances) {
    const dbInstanceIdentifier = db.DBInstanceIdentifier;
    if (!dbInstanceIdentifier) continue;
    result.push({
      dbInstanceIdentifier,
      engine: db.Engine ?? '',
      dbInstanceClass: db.DBInstanceClass ?? '',
      multiAz: db.MultiAZ ?? false,
      allocatedStorageGb: db.AllocatedStorage ?? 0,
      isProduction: resolveIsProduction(db.TagList),
    });
  }
  return result;
}

/**
 * Fetches the average CPUUtilization/DatabaseConnections over the survey window for each instance.
 * Errors are isolated per batch (following the same pattern as `GetCostForecast` in
 * `cost-collector.ts`/`ec2-collector.ts`) — a CloudWatch error does not corrupt the Describe* data
 * already fetched, it just treats the metrics for the affected instances as null.
 */
/** Maximum number of GetMetricData batches allowed in flight at the same time — see
 * core/concurrency.ts. Bounds total collection time by the slowest single batch (up to this cap)
 * instead of growing linearly with batch count on an account with many RDS instances. */
const METRICS_BATCH_CONCURRENCY = 4;

async function loadInstanceMetrics(
  dbInstanceIdentifiers: string[],
  endTime: Date,
): Promise<Map<string, InstanceMetrics>> {
  const result = new Map<string, InstanceMetrics>();
  if (dbInstanceIdentifiers.length === 0) return result;

  const startTime = new Date(endTime.getTime() - SURVEY_PERIOD_SECONDS * 1000);

  const batches: string[][] = [];
  for (let i = 0; i < dbInstanceIdentifiers.length; i += INSTANCES_PER_BATCH) {
    batches.push(dbInstanceIdentifiers.slice(i, i + INSTANCES_PER_BATCH));
  }

  // Each batch's own try/catch stays exactly as it was — only the outer loop's EXECUTION
  // STRATEGY changed (concurrent instead of strictly sequential).
  await mapWithConcurrency(batches, METRICS_BATCH_CONCURRENCY, async (batchIds) => {
    const batchQueries: MetricDataQuery[] = [];
    for (const dbInstanceIdentifier of batchIds) {
      const suffix = sanitizeQueryId(dbInstanceIdentifier);
      batchQueries.push(buildMetricQuery(`cpu_${suffix}`, 'CPUUtilization', dbInstanceIdentifier, 'Average'));
      batchQueries.push(buildMetricQuery(`cpumax_${suffix}`, 'CPUUtilization', dbInstanceIdentifier, 'Maximum'));
      batchQueries.push(buildMetricQuery(`conn_${suffix}`, 'DatabaseConnections', dbInstanceIdentifier));
    }

    try {
      const { MetricDataResults = [] } = await getCloudWatchClient().send(
        new GetMetricDataCommand({
          MetricDataQueries: batchQueries,
          StartTime: startTime,
          EndTime: endTime,
        }),
      );

      for (const dbInstanceIdentifier of batchIds) {
        const suffix = sanitizeQueryId(dbInstanceIdentifier);
        result.set(dbInstanceIdentifier, {
          avgCpuPercent: firstValue(MetricDataResults, `cpu_${suffix}`),
          maxCpuPercent: firstValue(MetricDataResults, `cpumax_${suffix}`),
          avgConnections: firstValue(MetricDataResults, `conn_${suffix}`),
        });
      }
    } catch (err) {
      // Following the same pattern as GetCostForecast/ec2-collector.ts: a CloudWatch error on one
      // batch does not corrupt the Describe* data or the other batches — treat this batch's
      // metrics as null.
      logger.error('rds-collector: GetMetricData failed for a batch (skipping, metrics=null)', err);
      for (const dbInstanceIdentifier of batchIds) {
        result.set(dbInstanceIdentifier, { avgCpuPercent: null, maxCpuPercent: null, avgConnections: null });
      }
    }
  });

  return result;
}

/**
 * Surveys every RDS instance in AWS_Account: engine, instance class, Multi-AZ configuration,
 * allocated storage capacity, and average CPU/connections usage over the survey window
 * (Requirement 2.1). Returns only raw data — rightsizing classification (2.2) / availability risk
 * when Multi-AZ is missing on production (2.3) is decided by the orchestrator via
 * `classifyByThreshold`/`buildProtectionGapFinding`.
 *
 * Errors are isolated: if `DescribeDBInstances` fails (missing permissions, throttling...), log it
 * and return empty — don't let an error in this collector break the other collectors in
 * `infra-review-collector.ts`.
 */
export async function collectRds(): Promise<RdsCollectorItem[]> {
  let instances: RdsInstanceDescriptor[];
  try {
    instances = await loadRdsInstances();
  } catch (err) {
    logger.error('rds-collector: DescribeDBInstances failed (skipping, returning empty)', err);
    return [];
  }

  if (instances.length === 0) return [];

  const metricsByDbInstanceId = await loadInstanceMetrics(
    instances.map((i) => i.dbInstanceIdentifier),
    new Date(),
  );

  return instances.map((instance) => {
    const metrics = metricsByDbInstanceId.get(instance.dbInstanceIdentifier) ?? {
      avgCpuPercent: null,
      maxCpuPercent: null,
      avgConnections: null,
    };
    return {
      dbInstanceIdentifier: instance.dbInstanceIdentifier,
      region: AWS_REGION,
      engine: instance.engine,
      dbInstanceClass: instance.dbInstanceClass,
      multiAz: instance.multiAz,
      allocatedStorageGb: instance.allocatedStorageGb,
      avgCpuPercent: metrics.avgCpuPercent,
      maxCpuPercent: metrics.maxCpuPercent,
      avgConnections: metrics.avgConnections,
      isProduction: instance.isProduction,
    };
  });
}
