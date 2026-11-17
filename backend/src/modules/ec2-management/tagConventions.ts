/**
 * `tagConventions.ts` — the SINGLE SOURCE for the tag-key + operating-timezone conventions shared
 * by several Lambdas (`patch-scheduler.ts`, `ec2-rightsize-applier.ts`, `infra-review-collector.ts`,
 * `collectors/ec2-collector.ts`) to recognize/write EC2 tags. Kept separate from
 * `patchScheduling.ts`/`ec2AutoRightsizing.ts` (both PURE-function modules that should not read
 * `process.env` themselves) so those two modules stay easy to unit test without setting env vars.
 * (`ec2-collector.ts` now lives at `modules/infra/ec2-collector.ts`.)
 *
 * PORTABILITY: every value here reads from an environment variable FIRST and only falls back to
 * the built-in default when the variable is NOT set. A different org deploying this stack can
 * override a value by setting the Lambda environment variable (`TAG_PREFIX`/`PATCH_TIMEZONE`/
 * `SCHEDULE_TAG_KEY`/`DEPARTMENT_TAG_KEY`) without touching code, while a deployment that does not
 * set these keeps the defaults below.
 *
 * `infra/ops-dashboard.yaml` exposes `TagPrefix`, `ScheduleTagKey` and `PatchTimezone` as
 * CloudFormation Parameters that feed the matching Lambda environment variables. There is no
 * CloudFormation Parameter for `DEPARTMENT_TAG_KEY`; set that variable on the Lambda directly.
 */

/**
 * Ops_Dashboard's own tag prefix (different from `SCHEDULE_TAG_KEY`, which is set by an
 * EXTERNAL on/off scheduling system and is not owned by this project). Every tag that Ops_Dashboard
 * itself writes (patch date, auto-rightsize state, etc.) carries this prefix. Override via the
 * `TAG_PREFIX` env var so a different org can use its own tag-namespace convention (e.g. to avoid
 * clashing with an existing tag of the same name).
 *
 * The `aws:TagKeys` IAM Conditions in `infra/ops-dashboard.yaml` reference the prefix through
 * `!Sub '${TagPrefix}:...'` (PatchSchedulerRole, Ec2RightsizeApplierRole,
 * InfraReviewCollectorRole), so they stay in sync as long as the `TagPrefix` CloudFormation
 * Parameter and this default agree. `thresholds.ts`'s `MONITORING_EXEMPT_TAG_KEY` does NOT read
 * `TAG_PREFIX` (it is hardcoded separately), so it must be edited on its own if the prefix changes.
 */
export const TAG_PREFIX = process.env.TAG_PREFIX?.trim() || 'OpsDashboard';

/** Tag key marking an instance as participating in the automatic on/off schedule — see the full
 * comment in `patchScheduling.ts`. Override via the `SCHEDULE_TAG_KEY` env var if a different
 * org's on/off scheduling system uses a different tag name (this tag is NOT written by
 * Ops_Dashboard, only READ).
 *
 * The external scheduling system that writes this tag must use the same key. If you rename it,
 * update that system and this constant in the same change, or patch-scheduler-fn and
 * ec2-rightsize-applier-fn will stop seeing instances as schedule-managed as soon as the external
 * system starts writing the new key. */
export const SCHEDULE_TAG_KEY = process.env.SCHEDULE_TAG_KEY?.trim() || 'Schedule:Start';

/**
 * Tag key holding the business-unit cost allocation value on every billable resource (EC2/RDS/S3/
 * ECS/ALB/ElastiCache/...) — one of `SALE` | `MKT` | `HR` | `SERVICE` | `SHARED`. The tag is
 * applied to resources outside this project (for example by a one-time tagging pass).
 * `SHARED` marks infrastructure with no single business-unit owner (bastion hosts, NAT gateways,
 * CI/CD buckets, shared utility services...). Its cost is NOT reported as its own bucket; it is
 * redistributed PROPORTIONALLY across the 4 real business units based on their own direct-cost
 * share for the period, see `modules/cost/costAllocation.ts`. Read (not written) by
 * `modules/cost/cost-collector.ts` via Cost Explorer `GetCostAndUsage GroupBy Type=TAG`. Override via the `DEPARTMENT_TAG_KEY` env var
 * if a different org already uses another tag name for the same purpose.
 */
export const DEPARTMENT_TAG_KEY = process.env.DEPARTMENT_TAG_KEY?.trim() || 'Department';

/** Timezone used to compute "today's date" when comparing date tags (patch/auto-rightsize) —
 * should match the real operating hours of the org deploying the stack (an IANA timezone name,
 * e.g. "Asia/Ho_Chi_Minh", "America/New_York"). Override via the `PATCH_TIMEZONE` env var.
 * Defaults to `Asia/Ho_Chi_Minh` when the variable is not set. */
export const PATCH_TIMEZONE = process.env.PATCH_TIMEZONE?.trim() || 'Asia/Ho_Chi_Minh';
