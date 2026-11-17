/**
 * Barrel re-export — `monitoring-service.ts` has been split into the dedicated modules under
 * `monitoring-service/` (Online_Resource loading, metric definitions, CWAgent detection, threshold
 * eval, console link, metric trend, final wiring in `getMonitoringData()`). The old export path/
 * names are kept here so existing consumers (`alert-service.ts`, `get-monitoring.ts`, the
 * test suite) don't need to change their import paths.
 */
export {
  type OnlineEc2Instance,
  type OnlineEbsVolume,
  type OnlineRdsInstance,
  type AlbTargetsSummary,
  type OnlineResources,
  type OnlineEcsService,
  loadOnlineEc2,
  loadOnlineEbs,
  loadOnlineRds,
  loadAlbTargets,
  loadOnlineEcsServices,
  loadOnlineResources,
} from './monitoring-service/online-resources.js';

export {
  METRIC_DEFINITIONS,
  isIoOptimizedVolumeType,
  ebsMetricDefinitionsFor,
  DIMENSION_NAME_BY_RESOURCE_TYPE,
  buildMetricQueryId,
  buildMetricDataQuery,
  singleDimension,
  ecsResourceId,
  buildMetricQueries,
} from './monitoring-service/metric-definitions.js';

export {
  detectCwAgentInstances,
  buildCwAgentMetricQueries,
  isCwAgentDatapointFresh,
} from './monitoring-service/cwagent-detection.js';

export {
  RDS_INSTANCE_RAM_GIB,
  type MonitoringThresholdContext,
  evalMonitoringThreshold,
} from './monitoring-service/threshold-eval.js';

export {
  type ConsoleLinkParams,
  buildConsoleLink,
  parseConsoleLink,
} from './monitoring-service/console-link.js';

export { buildMetricTrend } from './monitoring-service/metric-trend.js';

export { getMonitoringData } from './monitoring-service/get-monitoring-data.js';
