# RUNBOOK — ops-dashboard

Operating the ops-dashboard system. Read `README.md` first for the architecture overview. Resource names in this runbook follow the template defaults `Org=abc` and `Environment=prod`; substitute your own values if you changed them.

## 0. Lambda naming convention (domain-prefixed)

Every Lambda's AWS-facing name follows `abc-ops-dashboard-prod-<domain>-<capability>-fn`, grouped into 6
domains so the function list in the AWS Console/CLI sorts by responsibility instead of being a flat
alphabetical list:

| Domain | Meaning | Functions |
|---|---|---|
| `web-*` | Frontend-facing | `web-router-fn`, `web-static-fn` |
| `collector-*` | Scheduled data collection into S3 cache | `collector-cost-fn`, `collector-infra-fn`, `collector-compliance-fn` |
| `alerting-*` | Detects and notifies about problems | `alerting-notifier-fn`, `alerting-baseline-manager-fn`, `alerting-health-report-fn`, `alerting-topic-guardian-fn` |
| `governance-*` | Automatically adjusts resources per policy | `governance-patch-scheduler-fn`, `governance-rightsize-applier-fn`, `governance-downsize-scheduler-fn`, `governance-timeofday-trigger-fn`, `governance-exemption-auditor-fn` |
| `security-*` | Security posture automation | `security-guardduty-triage-fn`, `security-public-bucket-guardian-fn`, `security-endpoint-drift-detector-fn` |
| `agent-*` | AI-driven automation | `agent-ai-ops-fn` |
| `action-*` | User/system-triggered mutations | `action-execution-fn`, `action-schedule-mutate-fn`, `action-approval-mutate-fn` |

(`infra-review-collector` was renamed `collector-compliance` — it backs the Compliance/Assessment tab, not
a second infra collector; `discord-alarm-notifier` became `alerting-notifier` since it now also fans out
GuardDuty/RDS event messages, not only CloudWatch Alarms; `ec2-rightsize-applier`/`time-of-day-trigger`
got the `governance-` prefix — both auto-adjust EC2 sizing on a policy, the same family as
`patch-scheduler`/`downsize-scheduler`.)

## 1. When a Discord alert comes in

Every CloudWatch Alarm in the stack (8 Lambda Errors alarms from Phase B + the standard EC2/RDS/ALB/ECS
alarm set managed by `alerting-baseline-manager-fn`) is sent via `AlarmNotificationTopic` (SNS) →
`alerting-notifier-fn` → Discord webhook. There is NO email fallback. `alerting-notifier-fn` is also the
sole subscriber of the account's security-alerts topic (CIS Benchmark alarms) and the GuardDuty
Finding EventBridge rule — see section 5.

**The first step is always to read the CloudWatch Logs of the Lambda named in the alarm:**

```bash
aws logs tail /aws/lambda/abc-ops-dashboard-prod-<function-suffix>-fn --since 1h --region ap-southeast-1
```

| Alarm name contains | Log group | What to check |
|---|---|---|
| `collector-cost-fn-errors` | `/aws/lambda/abc-ops-dashboard-prod-collector-cost-fn` | Cost Explorer API throttle/quota, SSM cache write errors |
| `collector-compliance-fn-errors` | `.../collector-compliance-fn` | Describe* API throttle, S3 PutObject errors writing `assessment-report.json` |
| `collector-infra-fn-errors` | `/aws/lambda/abc-ops-dashboard-prod-collector-infra-fn` | Describe* throttle, S3 PutObject errors — backs the Infra/Compliance tabs (see section 3) |
| `governance-patch-scheduler-fn-errors` | `.../governance-patch-scheduler-fn` | SSM SendCommand/GetCommandInvocation errors, instance offline |
| `governance-rightsize-applier-fn-errors` | `.../governance-rightsize-applier-fn` | ModifyInstanceAttribute errors (instance currently running won't allow a type change) |
| `action-execution-fn-errors` | `.../action-execution-fn` | A specific user-triggered action failed — see `action-audit/` in S3 |
| `web-router-fn-errors` | `.../web-router-fn` | Request from the frontend failed — check Entra auth, downstream service |
| `web-static-fn-errors` | `.../web-static-fn` | Static asset serving error (rare) |
| `alerting-baseline-manager-fn-errors` | `.../alerting-baseline-manager-fn` | PutMetricAlarm/DeleteAlarms error — see the dedicated Discord embed (Task 4) for count details |
| `alerting-topic-guardian-fn-errors` | `.../alerting-topic-guardian-fn` | Failed to list SNS topics/subscriptions — check `sns:ListTopics`/`ListSubscriptionsByTopic` IAM |
| `security-guardduty-triage-fn-errors` | `.../security-guardduty-triage-fn` | Failed to archive a finding/tag lookup — check `guardduty:ArchiveFindings`/`ec2:DescribeTags` IAM |
| `security-public-bucket-guardian-fn-errors` | `.../security-public-bucket-guardian-fn` | Failed to list buckets/policy status — check `s3:GetBucketPolicyStatus`/`GetBucketTagging` IAM |
| `governance-exemption-auditor-fn-errors` | `.../governance-exemption-auditor-fn` | Failed to describe tags across EC2/ALB — check `ec2:DescribeTags`/`elasticloadbalancing:DescribeTags` IAM |
| `security-endpoint-drift-detector-fn-errors` | `.../security-endpoint-drift-detector-fn` | SSM RunCommand failed/timed out — check the instance is SSM-managed and online |

## 2. When an EventBridge Schedule keeps failing (message lands in the DLQ)

All scheduled Lambdas (`collector-cost`, `collector-compliance`, `alerting-baseline-manager`,
`governance-patch-scheduler`, `alerting-topic-guardian`, `security-public-bucket-guardian`,
`governance-exemption-auditor`, `security-endpoint-drift-detector`) have a `RetryPolicy` (2 retries, up to
1h) + a shared DLQ `abc-ops-dashboard-prod-scheduler-dlq`.

Check whether the DLQ has any messages (a message in the DLQ means the Lambda failed both retries):

```bash
aws sqs get-queue-attributes \
  --queue-url $(aws sqs get-queue-url --queue-name abc-ops-dashboard-prod-scheduler-dlq --region ap-southeast-1 --query QueueUrl --output text) \
  --attribute-names ApproximateNumberOfMessages --region ap-southeast-1
```

If message count > 0: check the CloudWatch Logs of the corresponding Lambda (table in section 1) to find the root cause.
A message in the DLQ keeps the original payload (the EventBridge Scheduler event) for 14 days — no manual replay
is needed; the next scheduled run will retry normally on its own (the schedule is unaffected by the DLQ).

## 3. When a tab shows a "Stale data" badge

The badge appears when the snapshot's `cachedAt`/`generatedAt` exceeds the writing collector's normal refresh
cycle — a sign that collector has failed across several consecutive runs. Check the corresponding alarm
(section 1) first; the badge is a secondary signal in the UI, not the primary diagnostic source.

| Tab | Written by | Cadence | Stale after |
|---|---|---|---|
| Monitoring | `web-router-fn` itself, on a cache miss | TTL, 4 min | n/a — rebuilt on demand |
| Infra / Compliance | `collector-infra-fn` | 5 min | ~15 min |
| Cost | `collector-cost-fn` | 6h | 6h |
| Assessment | `collector-compliance-fn` | 1 day | 24h |

`collector-infra-fn` writes its two caches independently via `Promise.allSettled` — one failing source
leaves the other fresh and leaves the failing source's PREVIOUS cache in place, so the tab shows
stale-but-real data rather than emptying out. The log line `infra-collector: infra=... compliance=...`
tells you which source failed.

**Monitoring is different: it has no collector.** `GET /monitoring` serves `monitoring-cache.json` when it
is younger than `MONITORING_CACHE_TTL_MS` (4 min) and otherwise rebuilds it inline — which is the billed
CloudWatch `GetMetricData` call. Consequences when triaging:

- A stale Monitoring tab is not a collector failure. Look at `web-router-fn` logs instead.
- If `web-router-fn` loses `s3:GetObject`/`s3:PutObject` on `monitoring-cache.json`, nothing visibly breaks —
  every request just rebuilds. Symptom is latency and a rising `GMD-Metrics` line in Cost Explorer, not an
  error. Grep the router logs for `Failed to write S3 cache "monitoring-cache.json"`.
- The TTL is the cost ceiling for this route. Raising it lowers the worst case proportionally. See the cost
  table in `README.md`.

## 4. Deploy

See the "Deployment" section in `README.md`. `infra/deploy.sh` now runs `npm run test --workspaces` + `npm audit
--audit-level=high` as a MANDATORY gate before build/package/deploy — the deploy stops immediately if either
command fails, with NO way to bypass it via an environment variable (this is intentional, see STANDARDS.md §4b "A
report-only security gate is not a gate").

## 5. The 5 self-healing automation Lambdas

These Lambdas automate checks that are otherwise easy to miss in a manual audit: an alerting SNS topic with
no subscribers (alarms fire into a void), S3 buckets that are publicly readable with no tag stating whether
that is intentional, and GuardDuty findings caused by sanctioned activity that still need triage. Each Lambda
below turns that one-time manual check into a recurring, automatic one — same "reconcile loop" pattern as
`alerting-baseline-manager-fn`.

| Lambda | Schedule | What it checks | Discord embed fires when |
|---|---|---|---|
| `alerting-topic-guardian-fn` | `rate(1 day)` | Every SNS topic with `AlarmActions`/GuardDuty/RDS-event subscribers | A topic used for alerting has 0 confirmed subscriptions |
| `security-guardduty-triage-fn` | GuardDuty Finding EventBridge rule | New/updated finding vs. the affected resource's `SecurityException` tag | The resource has NO exception tag (auto-archives + stays silent when it DOES have one) |
| `security-public-bucket-guardian-fn` | `rate(1 day)` | Every S3 bucket's public-access status vs. its `DataClass` tag | A bucket is publicly readable/writable but NOT tagged `DataClass=public` |
| `governance-exemption-auditor-fn` | `rate(1 day)` | Every `ops-dashboard:monitoring-exempt`/`SecurityException*` tag vs. its `SecurityExceptionReviewDate` | An exemption's review date has passed (nobody re-confirmed it's still needed) |
| `security-endpoint-drift-detector-fn` | `rate(1 day)` via SSM RunCommand | Running processes matching known VPN/tunnel binaries (tailscaled/netbird/cloudflared) on every SSM-managed instance | A VPN/tunnel process is found on an instance with NO `SecurityException` tag |

All 5 post through the same `AlarmNotificationTopic` → `alerting-notifier-fn` → Discord path as every other
alarm in section 1 — no new notification channel was added. None of them mutate anything (archiving a
GuardDuty finding is the only exception, and only when a `SecurityException` tag already justifies it);
they only read and notify, same trust level as `collector-*`/`alerting-baseline-manager-fn`.
