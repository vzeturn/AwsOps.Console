/**
 * RDS Nightly Schedule: tag-driven fixed stop/start schedule for an RDS instance, independent of
 * ALB traffic (unlike Idle-to-Zero, see `idleScheduler.ts`). Built for `abc-stg-rds-postgres`,
 * whose traffic is sparse and bursty enough that traffic-based idle detection caused frequent
 * stop/wake flapping (each cycle = a full RDS restart, see `rds-nightly-scheduler.ts` for the
 * incident this replaces). Discovers every RDS instance carrying
 * `RDS_NIGHTLY_SCHEDULER_MANAGED_TAG_KEY=true` at runtime, same tag-driven philosophy as
 * idle-scheduler, so enrolling another instance needs zero code change/redeploy.
 */

// RENAMED to PascalCase 2026-10-08 (tag-standard rollout) — was 'rds-nightly-scheduler:managed'.
// No IAM Condition references this key (RdsNightlySchedulerRole is scoped by ARN pattern only,
// not by tag), so the only follow-up outside code is re-tagging any RDS instance that currently
// carries the old key by hand (e.g. abc-stg-rds-postgres) — this Lambda never writes the tag
// itself, only reads it.
export const RDS_NIGHTLY_SCHEDULER_MANAGED_TAG_KEY = 'RdsNightlyScheduler:Managed';
