# Disaster Recovery Plan & Published SLOs — ops-dashboard

> Subject of this document: **ops-dashboard itself** (the control-plane application), not the AWS
> infrastructure it monitors. It publishes RTO/RPO per component and the SLOs with their
> error budget. Reviewed alongside RUNBOOK.md, which
> covers day-to-day incident triage; this document covers recovery targets and reliability targets.

## 1. Disaster Recovery Plan

### 1.1 Recovery order

If the whole stack needs to be rebuilt from scratch (worst case — account compromise, accidental
stack deletion, region-wide AWS outage), components are restored in this order because each later
group depends on an earlier one:

1. **`AssessmentReportBucket`** (S3) — `DeletionPolicy: Retain`, survives a stack delete on its own;
   nothing else needs to wait for this unless the bucket itself was destroyed out-of-band.
2. **SSM Parameters** (`AlertHookUrlParamName`, `Ec2StateManagerServiceTokenParamName`,
   `AgentClaudeApiKeyParamName`-referenced SecureString, `AiOpsAgentKillSwitchParameter`) — must
   exist before any Lambda that reads them at cold start can run without erroring.
3. **IAM Roles** — created by the same `aws cloudformation deploy` as the Lambdas; no separate step.
4. **Core Lambdas**: `RouterFunction`, `StaticServerFunction` — the user-facing surface; restoring
   these first re-establishes sign-in and the dashboard UI even before every collector has caught up.
5. **Collector Lambdas**: `CostCollectorFunction`, `InfraCollectorFunction`,
   `InfraReviewCollectorFunction` — repopulate `cost-cache.json`/`infra-cache.json`/
   `compliance-cache.json`/`assessment-report.json` on their next scheduled run (or can be invoked
   manually via `aws lambda invoke` to skip waiting for the schedule).
6. **Automation Lambdas**: `AlarmBaselineManagerFunction` (recreates the standard alarm set within
   1 reconcile cycle), `PatchSchedulerFunction`, `Ec2RightsizeApplierFunction`,
   `DownsizeSchedulerFunction`, `TimeOfDayTriggerFunction`, `AiOpsAgentFunction`,
   `ScheduledActionsMutateFunction`, `ActionExecutionFunction` — none of these hold state of their
   own; they read from the bucket/SSM parameters restored in steps 1-2 and start working immediately.
7. **Notification path**: `DiscordAlarmNotifierFunction`, `HealthReportFunction` — restored last is
   acceptable (a short gap in alerting is recoverable), but not indefinitely — see RTO below.

Full rebuild is `bash infra/deploy.sh` (one command, the whole template) — there is no
component-by-component manual deploy path; the ordering above describes what becomes *usable* as
the single deploy progresses through CloudFormation's own dependency graph, not separate deploy
invocations.

### 1.2 RTO / RPO per component

RTO = maximum acceptable time to restore the component to working order. RPO = maximum acceptable
data loss, measured in how old the restored data is allowed to be.

| Component | RTO | RPO | Basis |
|---|---|---|---|
| `RouterFunction` / `StaticServerFunction` (sign-in + UI) | 30 min | N/A (stateless) | Time to re-run `deploy.sh` (build+test+package+deploy, measured ~3-5 min) plus time to notice the outage via `*FunctionErrorsAlarm`/`HealthReportFunction`. No state to lose — a fresh deploy from `main` is fully equivalent to the previous one. |
| `AssessmentReportBucket` (S3: caches, `assessment-report.json`, `action-audit/`) | 1 hour (bucket itself: `DeletionPolicy: Retain` means it almost never needs restoring) | **`action-audit/*`: 0 (zero loss)** — versioned, never overwritten, no expiration. **Cache objects (`*-cache.json`, `assessment-report.json`): up to 1 collector cycle** (5 min–1 day depending on which cache — see README's collector cadence table) — regenerated automatically by the next scheduled run, so "loss" here just means "briefly stale," not gone. | Versioning (task 3 of this hardening pass) + the fact every cache is a scheduled-collector *output*, not a primary data store — the primary data (the monitored AWS account's own resources) is always the source of truth. |
| SSM Parameters (alert hook URL, EC2 State Manager token, Claude API key, kill-switch) | 1 hour | 0 for the kill-switch (defaults fail-safe to `false`/disabled if missing — see `agentKillSwitch.ts`) — the 3 secrets need to be **manually re-entered** if actually lost (they are not stored anywhere CloudFormation can restore, by design). | Manual `aws ssm put-parameter` re-entry is the only recovery path for a genuinely lost secret; RTO bound by how quickly an operator can be reached to re-paste the 3 values. |
| `AlarmBaselineManagerFunction`'s alarm set (CloudWatch Alarms) | 1 hour | 0 — fully regenerated from AWS's actual resource inventory on the next reconcile (`rate(1 hour)`), not from any stored state. | The reconcile loop is idempotent by design (see alarm-baseline-manager.ts). |
| Automation Lambdas (patch/rightsize/downsize/time-of-day/AI agent/scheduled-actions/action-execution) | 30 min | 0 — stateless, read current AWS state + the bucket/SSM restored above. | Same `deploy.sh` re-run as the core Lambdas. |
| Notification path (hub alert hook delivery) | 2 hours | Missed alerts during the outage are NOT re-sent (the hook is fire-and-forget, no replay) — `action-audit/` and CloudWatch's own alarm history remain the record of what happened during the gap. | `HealthReportFunction`'s independent `DescribeAlarms` cross-check (runs every 15 min, see README) is the backstop that surfaces "something is wrong" even if the primary SNS→hub path is down. |

**Overall stack RTO: 1 hour** (dominated by the SSM secrets re-entry step, which is the only
manual, human-in-the-loop recovery action in the whole plan — everything else is one
`bash infra/deploy.sh` run). **Overall stack RPO: near-zero for anything that matters for audit/
compliance** (`action-audit/*` is versioned and never overwritten); **at most 1 day** for the
least-fresh cache (`assessment-report.json`, `rate(1 day)` by default).

### 1.3 Recovery testing

**Not yet performed** (recommended practice: test recovery at least every 12 months,
recording the actually-measured recovery time and data-loss point, compared against
the RTO/RPO above). This is a deliberate scope boundary for this hardening pass: writing the
targets down is the prerequisite for a future recovery drill, not a substitute for one. Recommended
next step: schedule a tabletop or actual recovery drill (e.g. deploy the stack to a fresh AWS
account from scratch, time it, compare against the 1-hour target above) within the next 12 months,
and record the result as an update to this document.

## 2. Published SLOs

Three SLOs, each with a measurable metric, a numeric target, and a 30-day rolling measurement
window (matching the SRE Workbook's standard practice — see `sre.google/workbook/implementing-slos`).

| # | SLO | Metric | Target | Window |
|---|---|---|---|---|
| SLO-1 | Router availability | `1 - (Sum(Errors) / Sum(Invocations))` on `RouterFunction`, from the `AWS/Lambda` namespace | ≥ 99.5% | Rolling 30 days |
| SLO-2 | Collector freshness | `assessment-report.json` age at read time ≤ 2x its schedule interval (`InfraReviewScheduleExpression`, default 1 day) | ≥ 99% of daily checks pass | Rolling 30 days |
| SLO-3 | Alert delivery | Every `ALARM`/`OK` state transition on a `PutMetricAlarm`-managed alarm results in exactly one hub alert (warning/critical) or log record (OK) via `DiscordAlarmNotifierFunction`, cross-checked by `HealthReportFunction`'s independent `DescribeAlarms` poll finding no undelivered `ALARM` state | ≥ 99.9% delivery | Rolling 30 days |

### 2.1 Error budgets

| # | Error budget (100% − target) | What it means in absolute terms over 30 days |
|---|---|---|
| SLO-1 | 0.5% | ≈ 3.6 hours of router downtime/error budget per 30-day window |
| SLO-2 | 1% | ≈ 7 stale-data days (or fractional equivalents) tolerated per 30-day window |
| SLO-3 | 0.1% | Roughly 1 missed/duplicated alert tolerated per ~1,000 alarm transitions |

**Policy when a budget is exhausted mid-window** (Google SRE Workbook's error-budget-policy
pattern, `sre.google/workbook/error-budget-policy`): once an SLO's error budget for the current
30-day window is fully spent, new feature work affecting that component pauses — only
reliability fixes and security patches continue — until the rolling window's consumption drops
back under 100%. This is a policy statement for whoever operates this project next; there is no
automated enforcement of it today (that would require the SLO metrics above to actually be
computed and tracked somewhere, which they currently are not — see "Not yet instrumented" below).

### 2.2 Not yet instrumented

The 3 SLOs above are **defined but not yet automatically computed**. Actually tracking them (a
CloudWatch metric math expression or a scheduled Lambda computing the ratio and writing it
somewhere queryable) is future work, tracked here rather than silently assumed to already exist.
The `*FunctionErrorsAlarm`/`*FunctionNoInvocationsAlarm` CloudWatch Alarms already in
`infra/ops-dashboard.yaml` are the closest existing proxy for SLO-1/SLO-2 today, but they alarm on
a single evaluation period, not a rolling 30-day compliance percentage.
