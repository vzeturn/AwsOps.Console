import type { Dimension, MetricDataQuery } from '@aws-sdk/client-cloudwatch';
import type { MonitoringResourceType } from '@ops-dashboard/shared';
import type { OnlineResources } from './online-resources.js';

// ---- METRIC_DEFINITIONS (Requirement 1.1, 3.1, 3.2, 4.1, 5.1) ----

export interface MetricDefinition {
  name: string;
  namespace: string;
  stat: 'Average' | 'Sum' | 'Maximum' | 'Minimum';
  /** The display unit for `RealtimeMetric.unit` (Data Models) — `GetMetricData` doesn't return
   * `Unit` in `MetricDataResult` (unlike `GetMetricStatistics`), so it's hardcoded to the official
   * CloudWatch unit for each metric (AWS RDS/EC2/EBS/ALB CloudWatch metric reference). */
  unit: string;
}

/**
 * The fixed metric table per resource type — the source of truth for Property 2 ("Per-resource-kind
 * metric set completeness"). CWAgent (`mem_used_percent`/`disk_used_percent`) is NOT yet in this
 * table — added dynamically in `detectCwAgentInstances()` (Task 3.1), because that set depends on
 * the agent-detection state at the current refresh time, not a fixed set per resource type.
 */
export const METRIC_DEFINITIONS = {
  /** 4 base EC2 metrics (Requirement 1.1). */
  ec2: [
    { name: 'CPUUtilization', namespace: 'AWS/EC2', stat: 'Average', unit: 'Percent' },
    { name: 'NetworkIn', namespace: 'AWS/EC2', stat: 'Sum', unit: 'Bytes' },
    { name: 'NetworkOut', namespace: 'AWS/EC2', stat: 'Sum', unit: 'Bytes' },
    { name: 'StatusCheckFailed', namespace: 'AWS/EC2', stat: 'Maximum', unit: 'Count' },
  ] as MetricDefinition[],
  /** The full 14 RDS metrics per the RDS Best Practices Guide (Requirement 4.1). */
  rds: [
    { name: 'CPUUtilization', namespace: 'AWS/RDS', stat: 'Average', unit: 'Percent' },
    { name: 'FreeableMemory', namespace: 'AWS/RDS', stat: 'Average', unit: 'Bytes' },
    { name: 'SwapUsage', namespace: 'AWS/RDS', stat: 'Average', unit: 'Bytes' },
    { name: 'FreeStorageSpace', namespace: 'AWS/RDS', stat: 'Average', unit: 'Bytes' },
    { name: 'ReadIOPS', namespace: 'AWS/RDS', stat: 'Average', unit: 'Count/Second' },
    { name: 'WriteIOPS', namespace: 'AWS/RDS', stat: 'Average', unit: 'Count/Second' },
    { name: 'ReadLatency', namespace: 'AWS/RDS', stat: 'Average', unit: 'Seconds' },
    { name: 'WriteLatency', namespace: 'AWS/RDS', stat: 'Average', unit: 'Seconds' },
    { name: 'ReadThroughput', namespace: 'AWS/RDS', stat: 'Average', unit: 'Bytes/Second' },
    { name: 'WriteThroughput', namespace: 'AWS/RDS', stat: 'Average', unit: 'Bytes/Second' },
    { name: 'DiskQueueDepth', namespace: 'AWS/RDS', stat: 'Average', unit: 'Count' },
    { name: 'NetworkReceiveThroughput', namespace: 'AWS/RDS', stat: 'Average', unit: 'Bytes/Second' },
    { name: 'NetworkTransmitThroughput', namespace: 'AWS/RDS', stat: 'Average', unit: 'Bytes/Second' },
    { name: 'DatabaseConnections', namespace: 'AWS/RDS', stat: 'Average', unit: 'Count' },
  ] as MetricDefinition[],
  /** 2 ALB metrics (Requirement 5.1). */
  alb: [
    { name: 'UnHealthyHostCount', namespace: 'AWS/ApplicationELB', stat: 'Average', unit: 'Count' },
    { name: 'TargetResponseTime', namespace: 'AWS/ApplicationELB', stat: 'Average', unit: 'Seconds' },
  ] as MetricDefinition[],
  /** 2 service-level ECS_Service metrics (namespace AWS/ECS, dimension ClusterName+ServiceName) —
   * ECS only emits these 2 metrics at the service level, enough to detect a service under
   * CPU/memory pressure (matching the target-tracking autoscaling already configured on
   * abc-prod-ecs-cluster's services). */
  ecs: [
    { name: 'CPUUtilization', namespace: 'AWS/ECS', stat: 'Average', unit: 'Percent' },
    { name: 'MemoryUtilization', namespace: 'AWS/ECS', stat: 'Average', unit: 'Percent' },
  ] as MetricDefinition[],
  /** 5 base EBS metrics — every online EBS_Volume has these (Requirement 3.1). */
  ebsBase: [
    { name: 'VolumeReadOps', namespace: 'AWS/EBS', stat: 'Sum', unit: 'Count' },
    { name: 'VolumeWriteOps', namespace: 'AWS/EBS', stat: 'Sum', unit: 'Count' },
    { name: 'VolumeReadBytes', namespace: 'AWS/EBS', stat: 'Sum', unit: 'Bytes' },
    { name: 'VolumeWriteBytes', namespace: 'AWS/EBS', stat: 'Sum', unit: 'Bytes' },
    { name: 'VolumeQueueLength', namespace: 'AWS/EBS', stat: 'Average', unit: 'Count' },
  ] as MetricDefinition[],
  /** +1 extra metric ONLY when the volume type is `io1`/`io2` (Requirement 3.2). */
  ebsIoThroughput: [
    { name: 'VolumeThroughputPercentage', namespace: 'AWS/EBS', stat: 'Average', unit: 'Percent' },
  ] as MetricDefinition[],
  /**
   * 2 CloudWatch_Agent metrics (Requirement 2.1) — added ONLY for an EC2 instance that is both
   * `Online_Resource` AND present in the set returned by `detectCwAgentInstances()` for the SAME
   * current refresh cycle (Task 3.1). Not part of `METRIC_DEFINITIONS.ec2` (a fixed set per
   * resource type, Property 2) because this set depends on dynamic agent-detection results, not a
   * fixed set per resource type.
   */
  cwAgent: [
    { name: 'mem_used_percent', namespace: 'CWAgent', stat: 'Average', unit: 'Percent' },
    { name: 'disk_used_percent', namespace: 'CWAgent', stat: 'Average', unit: 'Percent' },
  ] as MetricDefinition[],
};

/** WHERE an EBS_Volume has type `io1`/`io2` (Requirement 3.2). */
export function isIoOptimizedVolumeType(volumeType: string): boolean {
  return volumeType === 'io1' || volumeType === 'io2';
}

/** The fixed set of metric names that applies to 1 EBS_Volume, based on its volume type. */
export function ebsMetricDefinitionsFor(volumeType: string): MetricDefinition[] {
  return isIoOptimizedVolumeType(volumeType)
    ? [...METRIC_DEFINITIONS.ebsBase, ...METRIC_DEFINITIONS.ebsIoThroughput]
    : METRIC_DEFINITIONS.ebsBase;
}

// ---- buildMetricQueries (Requirement 1.1, 3.1, 3.2, 4.1, 5.1) ----

/** The CloudWatch dimension name identifying a resource, per type (matching namespace in METRIC_DEFINITIONS). */
export const DIMENSION_NAME_BY_RESOURCE_TYPE: Record<MonitoringResourceType, string> = {
  ec2: 'InstanceId',
  ebs: 'VolumeId',
  rds: 'DBInstanceIdentifier',
  alb: 'LoadBalancer',
  // ECS_Service needs 2 dimensions simultaneously (ClusterName+ServiceName) — there's no single
  // "primary" dimension like the other types. This value exists ONLY to satisfy the
  // `Record<MonitoringResourceType, string>` type — it must NOT be used directly for ECS anywhere
  // (buildMetricDataQuery/buildConsoleLink for ECS both take a separate path, see
  // `singleDimension`/`buildRealtimeMetric` callers).
  ecs: 'ServiceName',
};

/** The default CloudWatch granularity for the namespaces used here when Enhanced_Monitoring isn't
 * enabled (Requirement 4.8) — also a sensible period for EC2/EBS/ALB (which have no Enhanced
 * Monitoring concept). */
const METRIC_PERIOD_SECONDS = 60;

/** `MetricDataQuery.Id` only accepts `[a-z][a-zA-Z0-9_]*` — replace invalid characters with `_`,
 * matching the `sanitizeQueryId` pattern already used in `ec2-collector.ts`/`rds-collector.ts`. */
function sanitizeQueryId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_]/g, '_');
}

/** A unique id for 1 (resourceType, resourceId, metric) — resourceType is always lowercase so it
 * matches CloudWatch's `[a-z]` first-character requirement. Reused so `getMonitoringData()` (Task
 * 3.10) can map `GetMetricData` results back to the right resource/metric. */
export function buildMetricQueryId(resourceType: MonitoringResourceType, resourceId: string, metricName: string): string {
  return `${resourceType}_${sanitizeQueryId(resourceId)}_${sanitizeQueryId(metricName)}`;
}

/**
 * `buildMetricDataQuery` takes `dimensions` DIRECTLY (instead of inferring a single dimension from
 * `DIMENSION_NAME_BY_RESOURCE_TYPE[resourceType]`) — necessary because ECS_Service requires 2
 * dimensions AT ONCE (`ClusterName` + `ServiceName`, see AWS/ECS CloudWatch metric reference),
 * unlike every other resource type before it (only 1 dimension). `resourceId` is still used
 * separately for `buildMetricQueryId` (an internal unique identifier for mapping `GetMetricData`
 * results), independent of the actual `dimensions` sent to CloudWatch.
 */
export function buildMetricDataQuery(
  resourceType: MonitoringResourceType,
  resourceId: string,
  metric: MetricDefinition,
  dimensions: Dimension[],
): MetricDataQuery {
  return {
    Id: buildMetricQueryId(resourceType, resourceId, metric.name),
    MetricStat: {
      Metric: {
        Namespace: metric.namespace,
        MetricName: metric.name,
        Dimensions: dimensions,
      },
      Period: METRIC_PERIOD_SECONDS,
      Stat: metric.stat,
    },
    ReturnData: true,
  };
}

/** A single dimension — for EC2/EBS/RDS/ALB (each type has exactly 1 identifying dimension). */
export function singleDimension(resourceType: Exclude<MonitoringResourceType, 'ecs'>, resourceId: string): Dimension[] {
  return [{ Name: DIMENSION_NAME_BY_RESOURCE_TYPE[resourceType], Value: resourceId }];
}

/** A unique internal `resourceId` for 1 ECS_Service — used as the key to map `GetMetricData`
 * results AND as `MonitoringResource.resourceId` (the full-identifier requirement, similar to how
 * EBS uses volumeId as resourceName when it has no separate name). */
export function ecsResourceId(clusterName: string, serviceName: string): string {
  return `${clusterName}/${serviceName}`;
}

/**
 * Builds the `MetricDataQuery` list for `GetMetricData` from `METRIC_DEFINITIONS`, for every
 * `Online_Resource` already loaded in the current refresh cycle. CWAgent (`mem_used_percent`/
 * `disk_used_percent`) is NOT yet added at this step — added in Task 3.1
 * (`detectCwAgentInstances()`).
 *
 * ALB: skips any ALB missing a valid `arnSuffix` (no dimension value CloudWatch would accept —
 * see `extractAlbArnSuffix` in infra-service.ts) — does NOT send a query with a bad dimension
 * value (it would always silently return 0 datapoints, wasting `GetMetricData` quota for nothing).
 */
export function buildMetricQueries(resources: OnlineResources): MetricDataQuery[] {
  const queries: MetricDataQuery[] = [];

  for (const instance of resources.ec2) {
    for (const metric of METRIC_DEFINITIONS.ec2) {
      queries.push(buildMetricDataQuery('ec2', instance.instanceId, metric, singleDimension('ec2', instance.instanceId)));
    }
  }

  for (const volume of resources.ebs) {
    for (const metric of ebsMetricDefinitionsFor(volume.volumeType)) {
      queries.push(buildMetricDataQuery('ebs', volume.volumeId, metric, singleDimension('ebs', volume.volumeId)));
    }
  }

  for (const db of resources.rds) {
    for (const metric of METRIC_DEFINITIONS.rds) {
      queries.push(
        buildMetricDataQuery('rds', db.dbInstanceIdentifier, metric, singleDimension('rds', db.dbInstanceIdentifier)),
      );
    }
  }

  for (const alb of resources.alb) {
    if (!alb.arnSuffix) continue;
    for (const metric of METRIC_DEFINITIONS.alb) {
      queries.push(buildMetricDataQuery('alb', alb.name, metric, singleDimension('alb', alb.arnSuffix)));
    }
  }

  for (const service of resources.ecs) {
    const resourceId = ecsResourceId(service.clusterName, service.serviceName);
    const dimensions: Dimension[] = [
      { Name: 'ClusterName', Value: service.clusterName },
      { Name: 'ServiceName', Value: service.serviceName },
    ];
    for (const metric of METRIC_DEFINITIONS.ecs) {
      queries.push(buildMetricDataQuery('ecs', resourceId, metric, dimensions));
    }
  }

  return queries;
}
