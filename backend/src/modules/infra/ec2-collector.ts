import { DescribeInstancesCommand, type Tag } from '@aws-sdk/client-ec2';
import {
  GetMetricDataCommand,
  type MetricDataQuery,
  type MetricDataResult,
} from '@aws-sdk/client-cloudwatch';
// Lean_Lambda_Exception (Requirement 6.4a): direct imports, not `../governance/index.js`.
// `ec2-collector.ts` is used by `infra-collector-fn`/`infra-review-collector-fn` (lean standalone
// Lambdas), and the governance barrel re-exports `s3PolicyStore.ts`, which imports
// `../assessment/index.js`, which pulls in `config.ts` at module scope — going through the
// barrel would make these Lambdas depend on env vars they are never granted (see
// `lambda-boot.test.ts`).
import { SCHEDULE_TAG_KEY } from '../governance/patchScheduling.js';
import {
  NO_AUTO_RIGHTSIZE_TAG_KEY,
  NO_AUTO_SIZING_TAG_KEY,
  PENDING_AUTO_RIGHTSIZE_TAG_KEY,
  LAST_AUTO_RIGHTSIZE_DATE_TAG_KEY,
} from '../governance/ec2AutoRightsizing.js';
import { logger } from '../../shared-kernel/logger.js';
import { mapWithConcurrency } from '../../core/concurrency.js';
import { getEc2Client, getCloudWatchClient } from '../../core/aws-clients.js';

/** The Lambda runtime always sets this variable itself — no need for CloudFormation to declare it, no need to validate it. */
const AWS_REGION = process.env.AWS_REGION as string;

/** Usage survey window — the last 30 days (Requirement 1.1, 1.3). */
const SURVEY_PERIOD_DAYS = 30;
const SURVEY_PERIOD_SECONDS = SURVEY_PERIOD_DAYS * 24 * 60 * 60;

/** GetMetricData caps out at 500 metric queries per call — with 4 queries per instance (CPU
 * avg/max, network in/out), we need to batch by instance. */
const INSTANCES_PER_BATCH = 120;

/**
 * Raw data for a single EC2 instance — the collector ONLY gathers measured data, it does NOT
 * decide on a recommendation itself. The orchestrator (`infra-review-collector.ts`, task 7.1) uses
 * `classifyByThreshold`/`classifyByState` in `lib/recommendations.ts` to produce a
 * `RecommendationItem` from this data (e.g. `avgCpuPercent` below the threshold -> rightsizing;
 * `state === 'stopped'` -> terminate/snapshot candidate).
 */
export interface Ec2CollectorItem {
  instanceId: string;
  name: string;
  region: string;
  state: string;
  instanceType: string;
  /** Average CPUUtilization (%) over the survey window; null if CloudWatch returns no data. */
  avgCpuPercent: number | null;
  /**
   * MAXIMUM CPUUtilization (%) over the survey window — used as a SECOND safety check layer for
   * the `ec2LowCpu` rule (a fallback for when Compute Optimizer has no data for this instance, see
   * `infra-review-collector.ts`): an instance with a low AVERAGE CPU but a high PEAK (a bursty
   * workload — batch job, DMS, cron) should NOT be recommended for downsizing based on the average
   * alone, since the peak load is what actually determines whether the instance has enough
   * resources. `null` if CloudWatch returns no data.
   */
  maxCpuPercent: number | null;
  /** Average NetworkIn (bytes) over the survey window; null if no data. */
  avgNetworkInBytes: number | null;
  /** Average NetworkOut (bytes) over the survey window; null if no data. */
  avgNetworkOutBytes: number | null;
  /**
   * Raw `Platform` from DescribeInstances — ONLY has the value `'windows'` for Windows instances,
   * and is `undefined` (NOT an empty string) for EVERY Linux/UNIX instance (this is OFFICIAL AWS
   * API behavior — the `Platform` field only exists for Windows, it is not a way to distinguish
   * Linux distros). Used as a SAFE indicator of "this is Windows" for the `EC2_Rightsize`
   * Resource_Action (which requires "carefully checking OS ... Windows won't work if the target
   * type's chip doesn't support it").
   */
  platform: string | undefined;
  /** `PlatformDetails` — a more detailed OS description than `platform` (e.g. "Linux/UNIX",
   * "Windows", "Red Hat Enterprise Linux") — shown for reference only, NOT used to decide
   * architecture compatibility (that decision is based on `architecture` + a real
   * `DescribeInstanceTypes` call, see `ec2Rightsizing.ts`). */
  platformDetails: string;
  /** The instance's CPU architecture AT SURVEY TIME — 'x86_64' | 'arm64' | 'i386' (raw value from
   * `DescribeImages`, not transformed). `undefined` if the AMI/architecture can't be determined
   * (the AMI was deleted, or DescribeImages errored for that AMI) — the `EC2_Rightsize`
   * Resource_Action MUST refuse to rightsize when the current architecture can't be determined
   * (fail-safe, never assume). */
  architecture: string | undefined;
  /** `true` when the instance has the `SCHEDULE_TAG_KEY` tag (participates in the automated on/off
   * schedule, the same population as `patch-scheduler.ts`) — used by the `EC2_AutoRightsize`
   * evaluator (`ec2AutoRightsizing.ts`) to determine scope (only instances with a natural daily
   * stop cycle). */
  hasScheduleTag: boolean;
  /** `true` when the instance has the OLD `NO_AUTO_RIGHTSIZE_TAG_KEY` tag OR the NEW, unified
   * `NO_AUTO_SIZING_TAG_KEY` tag (covering both EC2_AutoRightsize and time-of-day sizing) — manually
   * excludes it from the automated mechanism; this is a dual-read during the transition period. */
  autoRightsizeExempt: boolean;
  /** Current value of the `PENDING_AUTO_RIGHTSIZE_TAG_KEY` tag on the instance ('up'/'down'),
   * `undefined` if not set yet (or an unrecognized value other than these two strings — treated as
   * not set, fail-safe). */
  pendingAutoRightsizeDirection: 'up' | 'down' | undefined;
  /** Current value of the `LAST_AUTO_RIGHTSIZE_DATE_TAG_KEY` tag ("YYYY-MM-DD"), `undefined` if the
   * instance has never had `EC2_AutoRightsize` applied to it. */
  lastAutoRightsizeDate: string | undefined;
  /** Raw tags from DescribeInstances — used by PolicyStore.getTeamOverride() to read
   * min/max-instance-type/scale-margin-percent overrides without calling DescribeInstances again. */
  tagsRaw: Tag[];
}

interface Ec2InstanceDescriptor {
  instanceId: string;
  name: string;
  state: string;
  instanceType: string;
  platform: string | undefined;
  platformDetails: string;
  architecture: string | undefined;
  hasScheduleTag: boolean;
  autoRightsizeExempt: boolean;
  pendingAutoRightsizeDirection: 'up' | 'down' | undefined;
  lastAutoRightsizeDate: string | undefined;
  tagsRaw: Tag[];
}

interface InstanceMetrics {
  avgCpuPercent: number | null;
  maxCpuPercent: number | null;
  avgNetworkInBytes: number | null;
  avgNetworkOutBytes: number | null;
}

/** MetricDataQuery.Id only accepts [a-z][a-zA-Z0-9_]* — replace invalid characters (e.g. '-' in an instance id) with '_'. */
function sanitizeQueryId(instanceId: string): string {
  return instanceId.replace(/[^a-zA-Z0-9_]/g, '_');
}

function buildMetricQuery(
  queryId: string,
  metricName: string,
  instanceId: string,
  stat: 'Average' | 'Maximum' = 'Average',
): MetricDataQuery {
  return {
    Id: queryId,
    MetricStat: {
      Metric: {
        Namespace: 'AWS/EC2',
        MetricName: metricName,
        Dimensions: [{ Name: 'InstanceId', Value: instanceId }],
      },
      // Period equals the exact length of the survey window -> CloudWatch returns a single
      // datapoint (average or maximum depending on `stat` — see the `maxCpuPercent` field in `Ec2CollectorItem`).
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

async function loadEc2Instances(): Promise<Ec2InstanceDescriptor[]> {
  const result: Ec2InstanceDescriptor[] = [];
  let nextToken: string | undefined;
  do {
    const { Reservations = [], NextToken } = await getEc2Client().send(new DescribeInstancesCommand({ NextToken: nextToken }));
    for (const reservation of Reservations) {
      for (const instance of reservation.Instances ?? []) {
        const instanceId = instance.InstanceId;
        if (!instanceId) continue;
        const tags = instance.Tags ?? [];
        const nameTag = tags.find((t) => t.Key === 'Name')?.Value ?? '(no Name tag)';
        const pendingRaw = tags.find((t) => t.Key === PENDING_AUTO_RIGHTSIZE_TAG_KEY)?.Value;
        result.push({
          instanceId,
          name: nameTag,
          state: instance.State?.Name ?? 'unknown',
          instanceType: instance.InstanceType ?? '',
          // `Platform`/`PlatformDetails`/`Architecture` are all available DIRECTLY on the `Instance`
          // returned from DescribeInstances — NO need to call DescribeImages separately (confirmed
          // by the AWS SDK client-ec2 Instance type). `Platform` only has the value 'windows' for
          // Windows, undefined for every Linux/UNIX (OFFICIAL AWS behavior, not missing data).
          platform: instance.Platform,
          platformDetails: instance.PlatformDetails ?? 'unknown',
          architecture: instance.Architecture,
          hasScheduleTag: tags.some((t) => t.Key === SCHEDULE_TAG_KEY),
          // Dual-read during the transition period (spec section 2.4): exempt if it has the OLD tag
          // (no-auto-rightsize) OR the NEW unified tag (no-auto-sizing) — don't break exemptions set manually before.
          autoRightsizeExempt: tags.some((t) => t.Key === NO_AUTO_RIGHTSIZE_TAG_KEY || t.Key === NO_AUTO_SIZING_TAG_KEY),
          pendingAutoRightsizeDirection: pendingRaw === 'up' || pendingRaw === 'down' ? pendingRaw : undefined,
          lastAutoRightsizeDate: tags.find((t) => t.Key === LAST_AUTO_RIGHTSIZE_DATE_TAG_KEY)?.Value,
          tagsRaw: tags,
        });
      }
    }
    nextToken = NextToken;
  } while (nextToken);
  return result;
}

/**
 * Fetches average CPUUtilization/NetworkIn/NetworkOut over the survey window for each instance.
 * Errors are caught separately (following the same pattern as `GetCostForecast` in
 * `cost-collector.ts`) — a CloudWatch error doesn't spoil the Describe* data already fetched, it
 * just treats the affected instances' metrics as null.
 */
/** Maximum number of GetMetricData batches allowed in flight at the same time — see
 * core/concurrency.ts. An account with many instances (and therefore many batches) no longer pays
 * for total collection time proportional to batch count; it's bounded by the slowest single
 * batch instead, up to this concurrency cap. */
const METRICS_BATCH_CONCURRENCY = 4;

async function loadInstanceMetrics(
  instanceIds: string[],
  endTime: Date,
): Promise<Map<string, InstanceMetrics>> {
  const result = new Map<string, InstanceMetrics>();
  if (instanceIds.length === 0) return result;

  const startTime = new Date(endTime.getTime() - SURVEY_PERIOD_SECONDS * 1000);

  const batches: string[][] = [];
  for (let i = 0; i < instanceIds.length; i += INSTANCES_PER_BATCH) {
    batches.push(instanceIds.slice(i, i + INSTANCES_PER_BATCH));
  }

  // Each batch's own try/catch stays exactly as it was — only the outer loop's EXECUTION
  // STRATEGY changed (concurrent instead of strictly sequential). mapWithConcurrency's own
  // rejection path is never exercised here since this mapped function always catches its own
  // errors and writes null metrics instead of throwing.
  await mapWithConcurrency(batches, METRICS_BATCH_CONCURRENCY, async (batchIds) => {
    const batchQueries: MetricDataQuery[] = [];
    for (const instanceId of batchIds) {
      const suffix = sanitizeQueryId(instanceId);
      batchQueries.push(buildMetricQuery(`cpu_${suffix}`, 'CPUUtilization', instanceId, 'Average'));
      batchQueries.push(buildMetricQuery(`cpumax_${suffix}`, 'CPUUtilization', instanceId, 'Maximum'));
      batchQueries.push(buildMetricQuery(`netin_${suffix}`, 'NetworkIn', instanceId));
      batchQueries.push(buildMetricQuery(`netout_${suffix}`, 'NetworkOut', instanceId));
    }

    try {
      const { MetricDataResults = [] } = await getCloudWatchClient().send(
        new GetMetricDataCommand({
          MetricDataQueries: batchQueries,
          StartTime: startTime,
          EndTime: endTime,
        }),
      );

      for (const instanceId of batchIds) {
        const suffix = sanitizeQueryId(instanceId);
        result.set(instanceId, {
          avgCpuPercent: firstValue(MetricDataResults, `cpu_${suffix}`),
          maxCpuPercent: firstValue(MetricDataResults, `cpumax_${suffix}`),
          avgNetworkInBytes: firstValue(MetricDataResults, `netin_${suffix}`),
          avgNetworkOutBytes: firstValue(MetricDataResults, `netout_${suffix}`),
        });
      }
    } catch (err) {
      // Following the same pattern as GetCostForecast in cost-collector.ts: one CloudWatch batch
      // erroring doesn't spoil the Describe* data or other batches — treat this batch's metrics as null.
      logger.error('ec2-collector: GetMetricData failed for one batch (skipping, metrics=null)', err);
      for (const instanceId of batchIds) {
        result.set(instanceId, { avgCpuPercent: null, maxCpuPercent: null, avgNetworkInBytes: null, avgNetworkOutBytes: null });
      }
    }
  });

  return result;
}

/**
 * Surveys every EC2 instance in the AWS_Account: instance type, state, and average CPU/network
 * usage over the survey window (Requirement 1.1). Returns raw data only — classifying rightsizing
 * candidates (1.3) / terminate candidates (1.4) is decided by the orchestrator via
 * `classifyByThreshold`/`classifyByState`.
 *
 * Errors are caught separately: if `DescribeInstances` fails (missing permissions, throttling...),
 * log it and return empty — don't let this collector's error break the other collectors in
 * `infra-review-collector.ts`.
 */
export async function collectEc2(): Promise<Ec2CollectorItem[]> {
  let instances: Ec2InstanceDescriptor[];
  try {
    instances = await loadEc2Instances();
  } catch (err) {
    logger.error('ec2-collector: DescribeInstances failed (skipping, returning empty)', err);
    return [];
  }

  if (instances.length === 0) return [];

  const metricsByInstanceId = await loadInstanceMetrics(
    instances.map((i) => i.instanceId),
    new Date(),
  );

  return instances.map((instance) => {
    const metrics = metricsByInstanceId.get(instance.instanceId) ?? {
      avgCpuPercent: null,
      maxCpuPercent: null,
      avgNetworkInBytes: null,
      avgNetworkOutBytes: null,
    };
    return {
      instanceId: instance.instanceId,
      name: instance.name,
      region: AWS_REGION,
      state: instance.state,
      instanceType: instance.instanceType,
      avgCpuPercent: metrics.avgCpuPercent,
      maxCpuPercent: metrics.maxCpuPercent,
      avgNetworkInBytes: metrics.avgNetworkInBytes,
      avgNetworkOutBytes: metrics.avgNetworkOutBytes,
      platform: instance.platform,
      platformDetails: instance.platformDetails,
      architecture: instance.architecture,
      hasScheduleTag: instance.hasScheduleTag,
      autoRightsizeExempt: instance.autoRightsizeExempt,
      pendingAutoRightsizeDirection: instance.pendingAutoRightsizeDirection,
      lastAutoRightsizeDate: instance.lastAutoRightsizeDate,
      tagsRaw: instance.tagsRaw,
    };
  });
}
