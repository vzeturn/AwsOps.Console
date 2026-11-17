/**
 * `logs` Domain_Module — public export surface for anything outside this module that needs to
 * reference the CloudWatch Logs viewer's own symbols. External importers confirmed via grep
 * (backend-core-foundation Task 14.1): `router.ts` imports both Lambda-URL handlers directly, and
 * `infra-review-collector/assessment-report-builder.ts` imports `collectCloudWatchLogGroups` from
 * the collector to build the assessment report's `cloudWatchLogGroupNoRetention` finding. Both of
 * those importers reference the individual files directly (not this barrel) since they were
 * already wired that way before this module existed; this barrel exists for consistency with
 * every other Domain_Module (Requirement 6.2) and is available for future callers.
 */
export { handler as getLogGroupsHandler } from './get-log-groups.js';
export { handler as getLogEventsHandler } from './get-log-events.js';
export { listLogGroups, queryLogEvents } from './cloudwatch-logs-viewer-service.js';
export { collectCloudWatchLogGroups, type CloudWatchLogGroupRaw } from './cloudwatch-logs-collector.js';
