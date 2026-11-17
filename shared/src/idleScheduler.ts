/**
 * `idleScheduler.ts` — data model for the Idle-to-Zero feature: a first-class, tag-driven
 * ops-dashboard capability (NOT a one-off standalone CloudFormation stack — see
 * `backend/src/modules/idle-scheduler/` and `infra/ops-dashboard.yaml` for the implementation,
 * and the retired `infra/stg-idle-scheduler.yaml`/`abc-stg-idle-scheduler` stack this replaces).
 *
 * WHAT IT DOES: for a non-production ALB + EC2 + RDS group opted in via tags, automatically stops
 * EC2+RDS after N idle minutes (zero ALB requests on every target group) and automatically wakes
 * both in parallel on the first real request (an ALB 5xx alarm — no healthy target). A watchdog
 * re-asserts the mechanism's own configuration every hour so it cannot be silently disabled.
 *
 * WHICH RESOURCES ARE ELIGIBLE (deliberately narrow, not "every EC2 instance"):
 *   - Must sit behind an Application Load Balancer — the ALB's `RequestCount` per target group is
 *     the ONLY signal used to detect "idle" safely (a signal like CPU% or NetworkIn can be near-zero
 *     while a service is legitimately waiting on a slow client, an ALB request count cannot lie
 *     about whether anyone actually asked for the service).
 *   - Must be a non-production environment — this trades a 502/503 + several minutes of latency on
 *     the FIRST request after idle-stop for cost savings, a trade-off never acceptable for
 *     production traffic.
 *   - Opt-in per resource-group via the `idle-scheduler:managed=true` tag on the ALB (see
 *     `IDLE_SCHEDULER_MANAGED_TAG_KEY`) — nothing is auto-enrolled.
 *   A bastion host (or any resource with no ALB in front of it) is NOT eligible for THIS
 *   mechanism — it has no request-count signal to key off. `infra/bastion-idle-stop.yaml` already
 *   covers that case with a different signal (NetworkIn) and is intentionally left as-is.
 */

/** Tag key (on the ALB) that opts a resource-group INTO idle-to-zero — presence-based on the ALB
 * itself; the value must be the literal string `"true"`. Absence, or any other value, means the
 * group is not managed. Mirrors the existing `OpsDashboard:MonitoringExempt` presence-based
 * convention (`thresholds.ts`) rather than inventing a new tagging style.
 *
 * RENAMED to PascalCase 2026-10-08 (tag-standard rollout) — was `idle-scheduler:managed`. The
 * `ec2:ResourceTag/...` IAM Conditions in `infra/ops-dashboard.yaml` (`IdleSchedulerTickRole`'s
 * `Ec2StopOnlyManagedInstances` Sid, `IdleSchedulerWakeRole`'s `Ec2StartOnlyManagedInstances` Sid)
 * MUST be updated to the exact same new key in lockstep with this constant and redeployed BEFORE
 * any ALB is re-tagged, or `ec2:StopInstances`/`StartInstances` will start failing with
 * AccessDenied for every managed group. */
export const IDLE_SCHEDULER_MANAGED_TAG_KEY = 'IdleScheduler:Managed';

/** Tag key (on the ALB) holding the EC2 instance id to stop/start for this resource-group.
 * RENAMED to PascalCase 2026-10-08 — was `idle-scheduler:ec2-instance-id`. */
export const IDLE_SCHEDULER_EC2_INSTANCE_ID_TAG_KEY = 'IdleScheduler:Ec2InstanceId';

/** Tag key (on the ALB) holding the RDS instance identifier to stop/start for this resource-group.
 * RENAMED to PascalCase 2026-10-08 — was `idle-scheduler:rds-instance-id`. */
export const IDLE_SCHEDULER_RDS_INSTANCE_ID_TAG_KEY = 'IdleScheduler:RdsInstanceId';

/** Tag key (on the ALB) holding an OPTIONAL override of idle minutes (default:
 * `DEFAULT_IDLE_MINUTES` below) — e.g. `"45"`. Absent or unparseable = use the default.
 * RENAMED to PascalCase 2026-10-08 — was `idle-scheduler:idle-minutes`. */
export const IDLE_SCHEDULER_IDLE_MINUTES_TAG_KEY = 'IdleScheduler:IdleMinutes';

/** Tag key (on the managed EC2 instance, NOT the ALB) that HOLDS an idle-stop tick — set by a
 * deploy/migration pipeline immediately before touching the instance, cleared immediately after,
 * so a tick firing mid-deploy never stops the instance/RDS out from under an in-progress
 * operation. Read-only from this feature's point of view (never written by idle-scheduler itself
 * — see IT-21 precedent this generalizes: `abc-stg-idle-scheduler`'s cb-migrate/cb-deploy hold-tag).
 * RENAMED to PascalCase 2026-10-08 — was `idle-scheduler:hold`. Any external deploy/migration
 * pipeline that sets this tag by hand must be updated to the new key name too. */
export const IDLE_SCHEDULER_HOLD_TAG_KEY = 'IdleScheduler:Hold';

/** Default minutes of zero ALB requests (summed across every target group) before a
 * resource-group is stopped, when `IDLE_SCHEDULER_IDLE_MINUTES_TAG_KEY` is not set. */
export const DEFAULT_IDLE_MINUTES = 30;

/** Minutes after a (re)start during which a resource-group is NEVER stopped, regardless of
 * request count — prevents flapping immediately after a wake. Not currently overridable per
 * group (no observed need yet); revisit if a group needs a different grace window. */
export const DEFAULT_GRACE_MINUTES = 10;

/** Consecutive 1-minute periods with >=1 ALB 5xx required before waking a stopped resource-group
 * (`Alb5xxCount > 0` for this many CONSECUTIVE minutes) — a debounce against a single stray
 * request (an accidental browser tab, a health-check bot, one retried request) paying the full
 * RDS-start cost. Raised from 3 to 5 on 2026-09-22 (user decision) specifically to reduce how
 * often the environment gets woken unnecessarily. */
export const WAKE_DEBOUNCE_DATAPOINTS = 5;

/** One resource-group's live idle-to-zero status, as reported by `GET /idle-scheduler` — built
 * from CURRENT AWS state (ALB tags + EC2/RDS DescribeInstances), never cached, since staleness
 * here directly means "shows the wrong running/stopped state for a cost-relevant resource". */
export interface IdleSchedulerGroup {
  /** The ALB's name — the natural human identifier and also the tag-carrying resource, used as
   * this group's stable id. */
  albName: string;
  region: string;
  ec2InstanceId: string;
  rdsInstanceId: string;
  idleMinutes: number;
  /** Current EC2 state (`running` | `stopped` | `stopping` | `pending` | ...), read live. */
  ec2State: string;
  /** Current RDS status (`available` | `stopped` | `stopping` | `starting` | ...), read live. */
  rdsStatus: string;
  /** `true` when the managed EC2 instance currently carries `idle-scheduler:hold=true` (an
   * in-progress deploy/migration is holding it — the next idle-stop tick will skip it). */
  held: boolean;
  /** The name of this group's dedicated CloudWatch Alarm (ALB 5xx -> wake) — lets the UI deep-link
   * to it rather than making the operator guess the naming convention. */
  wakeAlarmName: string;
  /** Current `ActionsEnabled` on the wake alarm — surfaced so a disabled alarm (which would
   * silently break waking) is visible on the dashboard, not just caught an hour later by the watchdog. */
  wakeAlarmActionsEnabled: boolean;
}

export interface IdleSchedulerResponse {
  groups: IdleSchedulerGroup[];
  generatedAt: string;
}

/** `POST /idle-scheduler` request body — registers (or updates) a resource-group by tagging the
 * ALB. Idempotent: calling it again with a different `idleMinutes` updates the tag in place. */
export interface CreateIdleSchedulerGroupRequest {
  albName: string;
  ec2InstanceId: string;
  rdsInstanceId: string;
  /** Omit to use `DEFAULT_IDLE_MINUTES`. */
  idleMinutes?: number;
}

/** EC2 instance id pattern, mirrors `scheduled-actions-execute.ts`'s `EC2_INSTANCE_ID_PATTERN`. */
export const IDLE_SCHEDULER_EC2_INSTANCE_ID_PATTERN = /^i-[0-9a-f]{8,17}$/;
/** RDS instance identifier pattern, mirrors `scheduled-actions-execute.ts`'s
 * `RDS_INSTANCE_IDENTIFIER_PATTERN`. */
export const IDLE_SCHEDULER_RDS_INSTANCE_IDENTIFIER_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
