/**
 * `alerting` Domain_Module — public export surface for anything outside this module that needs to
 * reference the alerting stack's own symbols. External importers confirmed via grep
 * (backend-core-foundation Task 15): `cost-collector.ts`, `downsize-scheduler.ts`,
 * `ec2-rightsize-applier.ts`, `governance-exemption-auditor.ts`, `patch-scheduler.ts`,
 * `security-endpoint-drift-detector.ts`, `security-guardduty-triage.ts`,
 * `security-public-bucket-guardian.ts`, `time-of-day-trigger.ts`,
 * `infra-review-collector/assessment-report-builder.ts`, `infra-review-collector/discord-embeds.ts`,
 * and `modules/agent/ai-ops-agent.ts` all import `postDiscordEmbeds`/`DiscordEmbed`/
 * `DiscordEmbedField` from `discordWebhook.ts` and `buildOpsNotificationEmbed`/
 * `OpsNotificationSeverity` from `opsNotification.ts`. `modules/monitoring/monitoring-snapshot.ts` imports
 * `getAlerts` from `alert-service.ts`. Every one of those importers references the individual
 * files directly (not this barrel) since they were already wired that way before this module
 * existed; this barrel exists for consistency with every other Domain_Module (Requirement 6.2)
 * and is available for future callers. The 4 Lambda entrypoints in this module
 * (`discord-alarm-notifier.ts`, `alarm-baseline-manager.ts`, `health-report.ts`,
 * `alerting-topic-guardian.ts`) are NOT exported here — nothing imports their `handler` directly,
 * they are only bundled individually by `infra/scripts/build-artifacts.mjs`.
 */
export { postDiscordEmbeds, type DiscordEmbed, type DiscordEmbedField } from './discordWebhook.js';
export { buildOpsNotificationEmbed, type OpsNotificationSeverity, type OpsNotificationInput } from './opsNotification.js';
export { getAlerts, isAutoscalingScaleInNoise } from './alert-service.js';
export { formatRunbookField } from './runbookNotificationText.js';
