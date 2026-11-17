import { ListMetricsCommand, type MetricDataQuery } from '@aws-sdk/client-cloudwatch';
import { cloudwatch } from './clients.js';
import { METRIC_DEFINITIONS, buildMetricDataQuery, singleDimension } from './metric-definitions.js';
import type { OnlineEc2Instance } from './online-resources.js';

// ---- CloudWatch_Agent dynamic detection (Requirement 2.1, 2.2, 2.3, 2.4) ----

/**
 * Detects the set of EC2 instances sending `CWAgent` data (`mem_used_percent`/`disk_used_percent`)
 * with EXACTLY 1 `ListMetrics({ Namespace: 'CWAgent' })` call — no per-instance filtering, fetches
 * every CWAgent metric AWS knows about, then extracts `InstanceId` from each metric's `Dimensions`
 * (1 metric can have other dimensions besides `InstanceId`, e.g. `ImageId`/`InstanceType` — looked
 * up by `Name`, not assumed by array position).
 *
 * Doesn't read/store state across cycles — every call to this function recomputes entirely from
 * that call's own `ListMetrics` result (Requirement 2.3, Property 3).
 */
export async function detectCwAgentInstances(): Promise<Set<string>> {
  const { Metrics = [] } = await cloudwatch.send(new ListMetricsCommand({ Namespace: 'CWAgent' }));
  const instanceIds = new Set<string>();

  for (const metric of Metrics) {
    const instanceId = metric.Dimensions?.find((d) => d.Name === 'InstanceId')?.Value;
    if (instanceId) instanceIds.add(instanceId);
  }

  return instanceIds;
}

/**
 * Builds `MetricDataQuery[]` for `mem_used_percent`/`disk_used_percent` (namespace `CWAgent`) ONLY
 * for EC2 instances satisfying BOTH conditions: `Online_Resource` (present in `onlineEc2`) AND
 * present in `cwAgentInstanceIds` (the `detectCwAgentInstances()` result from the SAME current
 * cycle). The caller (Task 3.10, `getMonitoringData()`) merges this result with
 * `buildMetricQueries()` into a single `MetricDataQuery` list for 1 batched `GetMetricData` call
 * (Requirement 2.1).
 */
export function buildCwAgentMetricQueries(
  onlineEc2: OnlineEc2Instance[],
  cwAgentInstanceIds: ReadonlySet<string>,
): MetricDataQuery[] {
  const queries: MetricDataQuery[] = [];

  for (const instance of onlineEc2) {
    if (!cwAgentInstanceIds.has(instance.instanceId)) continue;
    for (const metric of METRIC_DEFINITIONS.cwAgent) {
      queries.push(buildMetricDataQuery('ec2', instance.instanceId, metric, singleDimension('ec2', instance.instanceId)));
    }
  }

  return queries;
}

/**
 * Second gate (Requirement 2.2/2.3): `ListMetrics` can return a metric it "knows about" even
 * though the agent has stopped sending data — a CWAgent metric is only considered available if
 * its latest datapoint (from the `GetMetricData` result, Task 3.10) has a timestamp within 5
 * minutes of the current refresh time `now`. A pure function, reads no state — reusable for both
 * CWAgent metrics.
 */
export function isCwAgentDatapointFresh(timestamp: Date, now: Date): boolean {
  const CW_AGENT_FRESHNESS_WINDOW_MS = 5 * 60 * 1000;
  return now.getTime() - timestamp.getTime() <= CW_AGENT_FRESHNESS_WINDOW_MS;
}
