import { ListFunctionsCommand } from '@aws-sdk/client-lambda';
import {
  GetMetricDataCommand,
  type MetricDataQuery,
  type MetricDataResult,
} from '@aws-sdk/client-cloudwatch';
import { logger } from '../../shared-kernel/logger.js';
import { getLambdaClient, getCloudWatchClient } from '../../core/aws-clients.js';

/** The Lambda runtime always sets this variable itself — no need for CloudFormation to declare it or to validate it. */
const AWS_REGION = process.env.AWS_REGION as string;

/** Usage survey period — the last 30 days (Requirement 1.2, following the same pattern as ec2-collector.ts). */
const SURVEY_PERIOD_DAYS = 30;
const SURVEY_PERIOD_SECONDS = SURVEY_PERIOD_DAYS * 24 * 60 * 60;

/** GetMetricData caps at 500 metric queries/call — 3 queries/function, so batch by function. */
const FUNCTIONS_PER_BATCH = 150;

/**
 * Raw data for one Lambda function — the collector ONLY fetches measured data, it does NOT
 * decide recommendations itself. The orchestrator (`infra-review-collector.ts`, task 7.1) uses
 * `classifyByThreshold` in `lib/recommendations.ts` to generate `RecommendationItem`s from this
 * data (e.g.: low `invocationsInPeriod` -> candidate for a memory/rightsizing review).
 *
 * Does NOT use `LambdaSummary` from `@ops-dashboard/shared` directly because that type requires
 * a `threshold: ThresholdMeta` field — assigning the threshold is the orchestrator's job, not the collector's.
 */
export interface RawLambdaMetrics {
  functionName: string;
  region: string;
  memoryMb: number;
  /** Average duration (ms) over the survey period; null if CloudWatch returns no data. */
  avgDurationMs: number | null;
  /** Total invocation count over the survey period; null if there's no data. */
  invocationsInPeriod: number | null;
  /** Total error count over the survey period; null if there's no data. */
  errorsInPeriod: number | null;
}

interface LambdaFunctionDescriptor {
  functionName: string;
  memoryMb: number;
}

interface FunctionMetrics {
  avgDurationMs: number | null;
  invocationsInPeriod: number | null;
  errorsInPeriod: number | null;
}

/** MetricDataQuery.Id only accepts [a-z][a-zA-Z0-9_]* — replace invalid characters (e.g. '-' in the function name) with '_'. */
function sanitizeQueryId(functionName: string): string {
  return functionName.replace(/[^a-zA-Z0-9_]/g, '_');
}

function buildMetricQuery(
  queryId: string,
  metricName: string,
  functionName: string,
  stat: 'Average' | 'Sum',
): MetricDataQuery {
  return {
    Id: queryId,
    MetricStat: {
      Metric: {
        Namespace: 'AWS/Lambda',
        MetricName: metricName,
        Dimensions: [{ Name: 'FunctionName', Value: functionName }],
      },
      // Period equals the exact length of the survey period -> CloudWatch returns exactly 1
      // datapoint (average for Duration, sum for Invocations/Errors).
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

async function loadLambdaFunctions(): Promise<LambdaFunctionDescriptor[]> {
  const result: LambdaFunctionDescriptor[] = [];
  let marker: string | undefined;

  do {
    const { Functions = [], NextMarker } = await getLambdaClient().send(
      new ListFunctionsCommand({ Marker: marker, MaxItems: 50 }),
    );
    for (const fn of Functions) {
      const functionName = fn.FunctionName;
      if (!functionName) continue;
      result.push({ functionName, memoryMb: fn.MemorySize ?? 0 });
    }
    marker = NextMarker;
  } while (marker);

  return result;
}

/**
 * Fetches Invocations (sum)/Duration (average)/Errors (sum) over the survey period for each
 * function. Wraps errors separately (following the same pattern as `ec2-collector.ts`) — a
 * CloudWatch failure doesn't break the `ListFunctions` data already fetched, it just treats the
 * affected functions' metrics as null.
 */
async function loadFunctionMetrics(
  functionNames: string[],
  endTime: Date,
): Promise<Map<string, FunctionMetrics>> {
  const result = new Map<string, FunctionMetrics>();
  if (functionNames.length === 0) return result;

  const startTime = new Date(endTime.getTime() - SURVEY_PERIOD_SECONDS * 1000);

  for (let i = 0; i < functionNames.length; i += FUNCTIONS_PER_BATCH) {
    const batchNames = functionNames.slice(i, i + FUNCTIONS_PER_BATCH);
    const batchQueries: MetricDataQuery[] = [];
    for (const functionName of batchNames) {
      const suffix = sanitizeQueryId(functionName);
      batchQueries.push(buildMetricQuery(`inv_${suffix}`, 'Invocations', functionName, 'Sum'));
      batchQueries.push(buildMetricQuery(`dur_${suffix}`, 'Duration', functionName, 'Average'));
      batchQueries.push(buildMetricQuery(`err_${suffix}`, 'Errors', functionName, 'Sum'));
    }

    try {
      const { MetricDataResults = [] } = await getCloudWatchClient().send(
        new GetMetricDataCommand({
          MetricDataQueries: batchQueries,
          StartTime: startTime,
          EndTime: endTime,
        }),
      );

      for (const functionName of batchNames) {
        const suffix = sanitizeQueryId(functionName);
        result.set(functionName, {
          invocationsInPeriod: firstValue(MetricDataResults, `inv_${suffix}`),
          avgDurationMs: firstValue(MetricDataResults, `dur_${suffix}`),
          errorsInPeriod: firstValue(MetricDataResults, `err_${suffix}`),
        });
      }
    } catch (err) {
      // Following the same pattern as GetCostForecast in cost-collector.ts: one failing
      // CloudWatch batch doesn't break the ListFunctions data or other batches — treat this batch's metrics as null.
      logger.error('serverless-collector: GetMetricData failed for one batch (skipping, metrics=null)', err);
      for (const functionName of batchNames) {
        result.set(functionName, { avgDurationMs: null, invocationsInPeriod: null, errorsInPeriod: null });
      }
    }
  }

  return result;
}

/**
 * Surveys every Lambda function in the AWS_Account: configured memory, and average
 * invocations/duration/errors usage over the survey period (Requirement 1.2). Only returns raw
 * data — classification (rightsizing, candidates to review...) is decided by the orchestrator
 * via `classifyByThreshold` in `lib/recommendations.ts`.
 *
 * Wraps errors separately: if `ListFunctions` fails (missing permissions, throttling...), log
 * and return empty — don't let this collector's failure break the other collectors in `infra-review-collector.ts`.
 */
export async function collectServerless(): Promise<RawLambdaMetrics[]> {
  let functions: LambdaFunctionDescriptor[];
  try {
    functions = await loadLambdaFunctions();
  } catch (err) {
    logger.error('serverless-collector: ListFunctions failed (skipping, returning empty)', err);
    return [];
  }

  if (functions.length === 0) return [];

  const metricsByFunctionName = await loadFunctionMetrics(
    functions.map((f) => f.functionName),
    new Date(),
  );

  return functions.map((fn) => {
    const metrics = metricsByFunctionName.get(fn.functionName) ?? {
      avgDurationMs: null,
      invocationsInPeriod: null,
      errorsInPeriod: null,
    };
    return {
      functionName: fn.functionName,
      region: AWS_REGION,
      memoryMb: fn.memoryMb,
      avgDurationMs: metrics.avgDurationMs,
      invocationsInPeriod: metrics.invocationsInPeriod,
      errorsInPeriod: metrics.errorsInPeriod,
    };
  });
}
