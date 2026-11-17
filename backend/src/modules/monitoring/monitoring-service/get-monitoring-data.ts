import { GetMetricDataCommand, type MetricDataQuery, type MetricDataResult } from '@aws-sdk/client-cloudwatch';
import type { MonitoringData, MonitoringResource, MonitoringResourceType, RealtimeMetric } from '@ops-dashboard/shared';
import { cloudwatch, AWS_REGION } from './clients.js';
import { logger } from '../../../shared-kernel/logger.js';
import { recordIfChanged } from '../threshold-history-service.js';
import {
  loadOnlineEc2,
  loadOnlineEbs,
  loadOnlineRds,
  loadAlbTargets,
  loadOnlineEcsServices,
  type OnlineResources,
  type OnlineEcsService,
} from './online-resources.js';
import {
  METRIC_DEFINITIONS,
  DIMENSION_NAME_BY_RESOURCE_TYPE,
  buildMetricQueries,
  buildMetricQueryId,
  ecsResourceId,
  ebsMetricDefinitionsFor,
  type MetricDefinition,
} from './metric-definitions.js';
import { detectCwAgentInstances, buildCwAgentMetricQueries, isCwAgentDatapointFresh } from './cwagent-detection.js';
import { evalMonitoringThreshold, type MonitoringThresholdContext } from './threshold-eval.js';
import { buildConsoleLink } from './console-link.js';
import { buildMetricTrend, METRIC_TREND_WINDOW_MS } from './metric-trend.js';
// Lean_Lambda_Exception (Requirement 6.4a): direct import, not `../../ec2-management/index.js`
// — see the exception comment in `threshold-eval.ts` (same directory, same reason).
import { applyMonitoringExemption } from '../../ec2-management/thresholds.js';

// ---- getMonitoringData(): final wiring (Task 3.10, Requirement 6.1, 6.2, 6.3, 6.4, 7.1, 7.2) ----

/**
 * `GetMetricData` limit — max 500 metrics/call (see design.md "Cost Analysis" — AWS
 * `GetMetricData` API Reference). At the current real resource scale of `AWS_Account` (~82
 * metrics/refresh cycle per design.md's calculation), 500 is a wide safety margin.
 *
 * KNOWN LIMITATION: pagination is not implemented for exceeding 500 metrics/cycle — if
 * `AWS_Account` grows past that threshold in the future, `getMonitoringData()` will need to batch
 * multiple `GetMetricData` calls, similar to the `INSTANCES_PER_BATCH` pattern already used in
 * `ec2-collector.ts`/`rds-collector.ts`. Not implemented upfront since it's unnecessary at the
 * current scale.
 */
const MAX_METRICS_PER_GET_METRIC_DATA_CALL = 500;

interface RawDatapoint {
  timestamp: Date;
  value: number;
}

/** Extracts a valid `{ timestamp, value }[]` from 1 `MetricDataResult` — skips any pair missing a
 * timestamp or whose value isn't a number (CloudWatch can return `Values`/`Timestamps` of
 * mismatched length in some partial-failure cases, e.g. `StatusCode !== 'Complete'`). */
function toRawDatapoints(result: MetricDataResult | undefined): RawDatapoint[] {
  const timestamps = result?.Timestamps ?? [];
  const values = result?.Values ?? [];
  const points: RawDatapoint[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const timestamp = timestamps[i];
    const value = values[i];
    if (timestamp && typeof value === 'number') points.push({ timestamp, value });
  }
  return points;
}

/** The datapoint with the latest timestamp — used as the "current value" of 1 `RealtimeMetric`. */
function latestRawDatapoint(datapoints: RawDatapoint[]): RawDatapoint | undefined {
  return datapoints.reduce<RawDatapoint | undefined>((latest, point) => {
    if (!latest || point.timestamp.getTime() > latest.timestamp.getTime()) return point;
    return latest;
  }, undefined);
}

/**
 * A single batched `GetMetricData` call covering all `queries` of the current refresh cycle
 * (Requirement 7.1/7.2). `StartTime` looks back by `METRIC_TREND_WINDOW_MS` (60 minutes) to have
 * enough datapoints for `buildMetricTrend()` — matching the "up to 60 minutes" mark in
 * Requirement 13.1.
 *
 * NOT wrapped in try/catch — a `GetMetricData` error (throttle/permission/network) MUST propagate
 * so `getMonitoringData()` fails the whole `/monitoring` response, per Design Error Handling (no
 * `Promise.allSettled`, no fallback/cache).
 */
async function fetchMetricDataResults(
  queries: MetricDataQuery[],
  now: Date,
): Promise<Map<string, MetricDataResult>> {
  const resultsById = new Map<string, MetricDataResult>();
  if (queries.length === 0) return resultsById;

  if (queries.length > MAX_METRICS_PER_GET_METRIC_DATA_CALL) {
    logger.warn(
      `getMonitoringData: ${queries.length} metric queries exceed the ${MAX_METRICS_PER_GET_METRIC_DATA_CALL}/call GetMetricData limit (known limitation, no pagination) — CloudWatch may return an error.`,
    );
  }

  const startTime = new Date(now.getTime() - METRIC_TREND_WINDOW_MS);
  const { MetricDataResults = [] } = await cloudwatch.send(
    new GetMetricDataCommand({ MetricDataQueries: queries, StartTime: startTime, EndTime: now }),
  );

  for (const result of MetricDataResults) {
    if (result.Id) resultsById.set(result.Id, result);
  }
  return resultsById;
}

/** The "primary" dimension used to build `CloudWatch_Console_Link` — ONLY 1 dimension even though
 * a metric may have several real dimensions (ECS needs both ClusterName+ServiceName for
 * `GetMetricData`, but the current console URL scheme — see `buildConsoleLink` — supports only 1
 * dimension/link). For ALB, the value MUST be `arnSuffix` (not the bare `name`) — the same bug
 * already fixed in `buildMetricDataQuery`. */
interface ConsoleLinkDimension {
  name: string;
  value: string;
}

/** Builds 1 "regular" `RealtimeMetric` (not CWAgent — no freshness gate) from the `GetMetricData`
 * result mapped by `Id`. The current value defaults to `0` when CloudWatch has no datapoint yet
 * (e.g. the resource just came online, not enough of a period elapsed) — doesn't throw, doesn't
 * hide the metric (unlike CWAgent; base metrics ALWAYS show while the resource is
 * `Online_Resource`, Requirement 1.1/3.1/4.1/5.1). */
function buildRealtimeMetric(
  resourceType: MonitoringResourceType,
  resourceId: string,
  metric: MetricDefinition,
  resultsById: ReadonlyMap<string, MetricDataResult>,
  now: Date,
  context: MonitoringThresholdContext,
  consoleLinkDimension: ConsoleLinkDimension,
): RealtimeMetric {
  const datapoints = toRawDatapoints(resultsById.get(buildMetricQueryId(resourceType, resourceId, metric.name)));
  const value = latestRawDatapoint(datapoints)?.value ?? 0;

  return {
    name: metric.name,
    value,
    unit: metric.unit,
    threshold: evalMonitoringThreshold(resourceType, metric.name, value, context),
    trend: buildMetricTrend(datapoints, now),
    consoleLink: buildConsoleLink({
      region: AWS_REGION,
      namespace: metric.namespace,
      metricName: metric.name,
      dimensionName: consoleLinkDimension.name,
      dimensionValue: consoleLinkDimension.value,
    }),
  };
}

/** `ConsoleLinkDimension` for EC2/EBS/RDS — the one dimension matches the `GetMetricData` dimension. */
function singleConsoleLinkDimension(resourceType: Exclude<MonitoringResourceType, 'ecs' | 'alb'>, resourceId: string): ConsoleLinkDimension {
  return { name: DIMENSION_NAME_BY_RESOURCE_TYPE[resourceType], value: resourceId };
}

/**
 * Builds 1 CWAgent `RealtimeMetric` (`mem_used_percent`/`disk_used_percent`) for 1 EC2 instance,
 * APPLYING a second gate (Requirement 2.2/2.3, Property 3): returns `undefined` (fully hidden, NOT
 * a placeholder) if there's no datapoint at all, or the latest datapoint is no longer "fresh"
 * (older than 5 minutes) — `isCwAgentDatapointFresh()`. Only called for an instance already present
 * in `cwAgentInstanceIds` of the SAME cycle (the `getMonitoringData()` caller already filtered;
 * freshness here is an independent second filtering layer).
 */
function buildCwAgentRealtimeMetricIfFresh(
  instanceId: string,
  metric: MetricDefinition,
  resultsById: ReadonlyMap<string, MetricDataResult>,
  now: Date,
): RealtimeMetric | undefined {
  const datapoints = toRawDatapoints(resultsById.get(buildMetricQueryId('ec2', instanceId, metric.name)));
  const latest = latestRawDatapoint(datapoints);
  if (!latest || !isCwAgentDatapointFresh(latest.timestamp, now)) return undefined;

  return {
    name: metric.name,
    value: latest.value,
    unit: metric.unit,
    threshold: evalMonitoringThreshold('ec2', metric.name, latest.value),
    trend: buildMetricTrend(datapoints, now),
    consoleLink: buildConsoleLink({
      region: AWS_REGION,
      namespace: metric.namespace,
      metricName: metric.name,
      dimensionName: DIMENSION_NAME_BY_RESOURCE_TYPE.ec2,
      dimensionValue: instanceId,
    }),
  };
}

/** ECS: uses `ServiceName` as the "primary" dimension shown in the console link (drops
 * `ClusterName` from the link — the current URL scheme supports only 1 dimension, see
 * `ConsoleLinkDimension`). A user opening the link still sees the right metric/namespace/region,
 * and just has to pick the right cluster themselves if the console asks — acceptable since this
 * is only a "see more" link, not the primary data source. */
function ecsConsoleLinkDimension(service: OnlineEcsService): ConsoleLinkDimension {
  return { name: 'ServiceName', value: service.serviceName };
}

/**
 * Records `Threshold_History` for 1 `RealtimeMetric` only if it HAS a threshold (measured-only —
 * `threshold === undefined` — has no meaningful "level" to record history for, per the Task 3.10
 * description). A history-write error (S3 PutObject failure) MUST NEVER propagate out —
 * `threshold-history-service.ts` (Task 6.1) already wraps its own S3 read/write errors internally
 * and doesn't throw, but wrapping again here is a second defensive layer, per the explicit
 * requirement in Design Error Handling: history writing is a supporting feature (Group D) that
 * must never block the primary Realtime_Metric display (Group A/B) of the `/monitoring` response
 * if the history write temporarily fails for any reason.
 */
async function recordThresholdHistorySafely(
  resourceType: MonitoringResourceType,
  resourceId: string,
  metric: RealtimeMetric,
): Promise<void> {
  if (metric.threshold === undefined) return;

  try {
    await recordIfChanged(resourceType, resourceId, metric.name, metric.value, metric.threshold.level);
  } catch (err) {
    logger.error(
      `getMonitoringData: recordIfChanged failed for ${resourceType}-${resourceId}/${metric.name} (ignored, not failing the /monitoring response)`,
      err,
    );
  }
}

/**
 * Handles 1 metric end-to-end: build the `RealtimeMetric` + record `Threshold_History` (if it has
 * a threshold), then push it onto `metrics`. Factored out to avoid repeating the same code across
 * the resource-kind loops below.
 */
async function processRealtimeMetric(
  metrics: RealtimeMetric[],
  resourceType: MonitoringResourceType,
  resourceId: string,
  metric: MetricDefinition,
  resultsById: ReadonlyMap<string, MetricDataResult>,
  now: Date,
  context: MonitoringThresholdContext,
  consoleLinkDimension: ConsoleLinkDimension,
): Promise<void> {
  const realtimeMetric = buildRealtimeMetric(resourceType, resourceId, metric, resultsById, now, context, consoleLinkDimension);
  metrics.push(realtimeMetric);
  // This `await` is load-bearing and must NOT be removed: `recordIfChanged()`
  // (threshold-history-service.ts) reads the ENTIRE JSON object for 1 resourceId then PUTs the whole
  // thing back. Two calls for the SAME resourceId (2 different metrics) running concurrently would
  // both read the same old state and overwrite each other — a lost update. Awaiting here guarantees
  // the next call for that resource reads the state the previous one just wrote.
  //
  // Callers therefore keep their per-metric loop sequential, and get their speed from running
  // DIFFERENT resources concurrently instead — see the comment in `getMonitoringData()`, which
  // explains why that is safe (one S3 object per resource).
  await recordThresholdHistorySafely(resourceType, resourceId, realtimeMetric);
}

/**
 * `getMonitoringData()` — final wiring of `monitoring-service.ts` (Task 3.10). Returns
 * `{ resources, generatedAt }` (does NOT include `alerts` — that comes from `alert-service.ts`,
 * Task 5.1, joined in by the `get-monitoring.ts` handler, Task 7.1, into the complete
 * `MonitoringData`).
 *
 * Error Handling (design.md): any error from `loadOnlineEc2/Ebs/Rds`, `loadAlbTargets`,
 * `detectCwAgentInstances`, or `GetMetricData` MUST propagate (throw) out — NO
 * `Promise.allSettled`, NO fallback/cache. Only the `Threshold_History` write error (Group D, a
 * supporting feature) is wrapped separately in `recordThresholdHistorySafely()`, so it doesn't
 * fail this response.
 */
export async function getMonitoringData(): Promise<Omit<MonitoringData, 'alerts'>> {
  const now = new Date();

  // loadOnlineEbs() needs the loadOnlineEc2() result from the SAME cycle (Task 2.1) -> call it
  // first, sequentially. loadOnlineRds/loadAlbTargets/detectCwAgentInstances don't depend on
  // onlineEc2 -> run them in parallel.
  const onlineEc2 = await loadOnlineEc2();
  const [onlineEbs, onlineRds, albTargets, cwAgentInstanceIds, onlineEcs] = await Promise.all([
    loadOnlineEbs(onlineEc2),
    loadOnlineRds(),
    loadAlbTargets(),
    detectCwAgentInstances(),
    loadOnlineEcsServices(),
  ]);

  const resources: OnlineResources = { ec2: onlineEc2, ebs: onlineEbs, rds: onlineRds, alb: albTargets, ecs: onlineEcs };

  const baseQueries = buildMetricQueries(resources);
  const cwAgentQueries = buildCwAgentMetricQueries(onlineEc2, cwAgentInstanceIds);
  const allQueries = [...baseQueries, ...cwAgentQueries];

  // A single batched GetMetricData call covering every query of this cycle (Requirement 7.1/7.2)
  // — an error here propagates straight out, uncaught (Design Error Handling).
  const resultsById = await fetchMetricDataResults(allQueries, now);

  const noThresholdContext: MonitoringThresholdContext = {};

  // ---- PARALLEL ACROSS RESOURCES, STILL STRICTLY SEQUENTIAL WITHIN ONE RESOURCE ----
  //
  // Measured before this change: `router-fn` averaged 1876 ms and peaked at 9756 ms, while
  // `static-server-fn` averaged 6 ms — asset delivery was never the bottleneck, so no amount of CDN
  // work could have fixed it. The time is spent here: ~82 metrics per cycle, each one awaiting its
  // own full read-modify-write of an S3 object, one after another.
  //
  // The per-metric `await` could NOT just be deleted. `recordIfChanged()` reads the ENTIRE JSON for
  // one resourceId and PUTs the whole thing back, so two metrics of the SAME resource running
  // concurrently would both read the same old state and one would silently overwrite the other — a
  // lost update, and the reason the original code documented its sequencing as deliberate.
  //
  // What makes parallelism safe is the KEY SHAPE: the store is
  // `threshold-history/{resourceType}-{resourceId}.json`, i.e. ONE OBJECT PER RESOURCE. Two
  // different resources touch two different objects and cannot conflict — and the resourceType
  // prefix means even an ec2 and an ebs sharing an id would not collide. So each resource keeps its
  // sequential metric loop (invariant intact) and the resources themselves run concurrently. ~82
  // sequential round-trips collapse to ~4, the largest metric count any single resource has.
  //
  // Response shape is unchanged: `Promise.all` preserves input order, and the five groups are
  // concatenated in the same ec2 -> ebs -> rds -> alb -> ecs order as before.
  const [ec2Resources, ebsResources, rdsResources, albResources, ecsResources] = await Promise.all([
    Promise.all(
      onlineEc2.map(async (instance): Promise<MonitoringResource> => {
        const metrics: RealtimeMetric[] = [];

        for (const metric of METRIC_DEFINITIONS.ec2) {
          await processRealtimeMetric(
            metrics,
            'ec2',
            instance.instanceId,
            metric,
            resultsById,
            now,
            noThresholdContext,
            singleConsoleLinkDimension('ec2', instance.instanceId),
          );
        }

        // Same resourceId as the loop above, so this MUST stay after it, sequentially — both write
        // the same `ec2-<instanceId>.json` object.
        if (cwAgentInstanceIds.has(instance.instanceId)) {
          for (const metric of METRIC_DEFINITIONS.cwAgent) {
            const cwAgentMetric = buildCwAgentRealtimeMetricIfFresh(instance.instanceId, metric, resultsById, now);
            if (!cwAgentMetric) continue; // Fully hidden — not fresh (Requirement 2.2/2.3).
            metrics.push(cwAgentMetric);
            await recordThresholdHistorySafely('ec2', instance.instanceId, cwAgentMetric);
          }
        }

        return {
          resourceType: 'ec2',
          resourceId: instance.instanceId,
          resourceName: instance.name,
          region: instance.region,
          metrics,
        };
      }),
    ),

    Promise.all(
      onlineEbs.map(async (volume): Promise<MonitoringResource> => {
        const metrics: RealtimeMetric[] = [];
        for (const metric of ebsMetricDefinitionsFor(volume.volumeType)) {
          await processRealtimeMetric(
            metrics,
            'ebs',
            volume.volumeId,
            metric,
            resultsById,
            now,
            noThresholdContext,
            singleConsoleLinkDimension('ebs', volume.volumeId),
          );
        }
        return {
          resourceType: 'ebs',
          // No separate Name tag for EBS_Volume (OnlineEbsVolume doesn't collect one) — use volumeId
          // as resourceName, satisfying Requirement 12.1 (only requires a complete identifier, not a
          // separate "friendly" name for EBS_Volume).
          resourceName: volume.volumeId,
          resourceId: volume.volumeId,
          region: volume.region,
          metrics,
        };
      }),
    ),

    Promise.all(
      onlineRds.map(async (db): Promise<MonitoringResource> => {
        const metrics: RealtimeMetric[] = [];
        const rdsContext: MonitoringThresholdContext = {
          dbInstanceClass: db.dbInstanceClass,
          // `engine` is needed for FreeableMemory: SQL Server uses a completely different threshold
          // model (a free-byte floor) because its buffer pool is capped by `max server memory` and
          // then held onto, which would make the % used model produce permanent false alarms.
          engine: db.engine,
          allocatedStorageGb: db.allocatedStorageGb,
        };
        for (const metric of METRIC_DEFINITIONS.rds) {
          await processRealtimeMetric(
            metrics,
            'rds',
            db.dbInstanceIdentifier,
            metric,
            resultsById,
            now,
            rdsContext,
            singleConsoleLinkDimension('rds', db.dbInstanceIdentifier),
          );
        }
        return {
          resourceType: 'rds',
          resourceId: db.dbInstanceIdentifier,
          resourceName: db.dbInstanceIdentifier,
          region: db.region,
          metrics,
        };
      }),
    ),

    Promise.all(
      albTargets.map(async (albSummary): Promise<MonitoringResource> => {
        const metrics: RealtimeMetric[] = [];
        const albContext: MonitoringThresholdContext = { totalTargets: albSummary.totalTargets };
        // ALB missing a valid arnSuffix -> NO dimension value CloudWatch would accept -> the resource
        // still appears in the response (Requirement 5.1: every ALB is listed), but WITH NO metrics
        // (metrics: []) instead of showing a misleading 0/measured-only — consistent with
        // buildMetricQueries already excluding this ALB from GetMetricData.
        if (albSummary.arnSuffix) {
          for (const metric of METRIC_DEFINITIONS.alb) {
            await processRealtimeMetric(
              metrics,
              'alb',
              albSummary.name,
              metric,
              resultsById,
              now,
              albContext,
              { name: 'LoadBalancer', value: albSummary.arnSuffix },
            );
          }
        }
        // `ops-dashboard:monitoring-exempt` (modules/ec2-management/thresholds.ts) — same tag `infra-service.ts`
        // already honors for `AlbSummary.threshold` on the Infra tab. Applied here too, to the
        // specific metric (`UnHealthyHostCount`) that can otherwise show `critical`, so Infra Map
        // (which takes the WORST metric threshold per resource, see `useHealthLookup` in
        // `infra-map.tsx`) doesn't flip an exempted ALB back to critical the moment this
        // independently-computed CloudWatch-based threshold disagrees with the Infra tab's.
        for (const metric of metrics) {
          if (metric.name === 'UnHealthyHostCount' && metric.threshold) {
            metric.threshold = applyMonitoringExemption(metric.threshold, albSummary.tags);
          }
        }
        return {
          resourceType: 'alb',
          resourceId: albSummary.name,
          resourceName: albSummary.name,
          region: albSummary.region,
          metrics,
          targetGroupHealth: albSummary.targetGroups,
        };
      }),
    ),

    Promise.all(
      onlineEcs.map(async (service): Promise<MonitoringResource> => {
        const metrics: RealtimeMetric[] = [];
        const resourceId = ecsResourceId(service.clusterName, service.serviceName);
        for (const metric of METRIC_DEFINITIONS.ecs) {
          await processRealtimeMetric(
            metrics,
            'ecs',
            resourceId,
            metric,
            resultsById,
            now,
            noThresholdContext,
            ecsConsoleLinkDimension(service),
          );
        }
        return {
          resourceType: 'ecs',
          resourceId,
          resourceName: `${service.clusterName}/${service.serviceName}`,
          region: service.region,
          metrics,
        };
      }),
    ),
  ]);

  const monitoringResources: MonitoringResource[] = [
    ...ec2Resources,
    ...ebsResources,
    ...rdsResources,
    ...albResources,
    ...ecsResources,
  ];

  return { resources: monitoringResources, generatedAt: now.toISOString() };
}
