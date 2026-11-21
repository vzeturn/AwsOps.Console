import type { RecommendationFindingType } from './index.js';

/**
 * `runbookCatalog.ts` — the single source of truth for OPERATIONAL RUNBOOKS: what a finding or
 * alarm actually MEANS, how to confirm it before acting, what the safe remediation is, how to
 * undo it if something goes wrong, and when to stop and escalate instead of acting alone.
 *
 * This is deliberately SEPARATE from `action-catalog.ts`. `action-catalog.ts` answers "is there a
 * 1-click automation for this, and is it reversible" — a machine-checkable classification used to
 * gate execution. A `RunbookEntry` answers "what should a HUMAN understand and do about this" —
 * even for the ~40% of findings that have NO 1-click automation at all (manual-only by design,
 * see `matchActionCatalogForFinding`'s doc comment) a runbook still exists, because "no button"
 * must never mean "no guidance". Per SRE/ITIL runbook practice, every entry follows the same fixed
 * shape (symptom -> diagnosis -> remediation -> rollback -> escalation) so an operator reading
 * unfamiliar territory at 2am follows the same mental model every time, rather than a different
 * ad-hoc structure per finding.
 *
 * Referenced by both `RecommendationFindingType` (Assessment findings) and by a small set of
 * well-known CloudWatch metric names (Monitoring alarms/metric panels) — see `RUNBOOK_BY_METRIC`
 * below. Kept in `shared` (not `backend`-only) so the frontend can render the SAME text the
 * backend would use if it ever needs to (e.g. embedding a runbook excerpt in a hub alert),
 * with no risk of the two copies drifting apart.
 */

export type RunbookSeverity = 'info' | 'warning' | 'critical';

export interface RunbookEntry {
  /** Short, human title — shown as the drawer/panel heading. */
  title: string;
  /** How this typically presents / what an operator would notice — grounds the reader in "is this
   * actually what I'm looking at" before they read further. */
  symptom: string;
  /** Concrete steps or signals to check BEFORE acting — the AWS Console page/API/metric to look
   * at, and what a false positive looks like, so the runbook helps rule the finding out, not just
   * confirm it. */
  diagnosis: string[];
  /** The recommended fix, as concrete steps. When a 1-click automation exists (per
   * `matchActionCatalogForFinding`), this describes what that automation actually does under the
   * hood, not a duplicate/independent recipe — the two must never contradict each other. */
  remediation: string[];
  /** How to undo the remediation if it turns out to be wrong — omitted (`undefined`) only for a
   * finding whose remediation is inherently non-actionable from this runbook alone (e.g. a
   * pure-warning finding with no corresponding action at all) — every actionable remediation MUST
   * have a rollback described, even if the rollback is "manually reverse the AWS API call". */
  rollback?: string[];
  /** When to STOP and get another person/team involved instead of proceeding alone — the runbook
   * equivalent of a circuit breaker. Always non-empty: even a low-risk finding has at least one
   * condition ("if this is a production resource with active traffic and no clear owner") worth
   * naming explicitly, per the ITIL practice that every runbook states its own escalation
   * boundary rather than leaving it implicit. */
  escalateWhen: string[];
  /** Default severity if the caller has no more specific signal (Recommendation_Item.priority
   * for findings, ThresholdLevel for alarms — those take precedence over this when available). */
  defaultSeverity: RunbookSeverity;
}

/**
 * One runbook per `RecommendationFindingType` — EVERY value in that union has an entry here,
 * enforced by `runbookCatalog.test.ts`'s completeness check (iterates the same literal list this
 * file's own union type constrains `Record` to, so adding a new finding type without a runbook
 * entry is a compile error, not a runtime gap someone has to notice).
 */
export const RUNBOOK_BY_FINDING: Record<RecommendationFindingType, RunbookEntry> = {
  ec2LowCpu: {
    title: 'EC2 instance running well below its provisioned CPU',
    symptom: 'Average CPU utilization has stayed low (typically single digits) over a sustained 30-day window.',
    diagnosis: [
      'Check the CPU trend over the full 30 days (not just the current snapshot) in the CloudWatch console — a single quiet week does not mean the instance is oversized.',
      'Check whether this instance has predictable BURSTY load (batch jobs, month-end processing, marketing campaigns) that a 30-day average would hide — if so, this finding is a false positive; see ec2Underprovisioned below for the opposite failure mode.',
      'Confirm the instance is not a warm standby / DR target kept intentionally idle.',
    ],
    remediation: [
      'EC2_Rightsize automation (if triggered from this finding) stops the instance, steps it down exactly one size within the SAME instance family, verifies CPU-architecture compatibility, then restarts it.',
      'If no automation is available for the target family, do this manually: stop the instance, ModifyInstanceAttribute(InstanceType) to one size down in the same family, start it, and monitor CPU/memory for the next 24-48h.',
    ],
    rollback: [
      'Re-run the same action (automation or manual ModifyInstanceAttribute) with the ORIGINAL instance type — this is a same-architecture, same-family change with no data loss either direction.',
    ],
    escalateWhen: [
      'The instance backs a production service with an SLA and no maintenance window is scheduled — the stop/start step causes brief downtime.',
      'You are unsure whether the low CPU reflects normal idle time for this specific workload (ask the resource owner before resizing).',
    ],
    defaultSeverity: 'info',
  },

  ec2Stopped: {
    title: 'EC2 instance has been stopped for an extended period',
    symptom: 'The instance is in the "stopped" state and has been for long enough to be flagged — still billed for its attached EBS volumes even while stopped.',
    diagnosis: [
      'Check the instance\'s StoppedAt reason/history in the console or CloudTrail (StopInstances events) — was it stopped deliberately (a scheduled downsize window, a decommission in progress) or unexpectedly?',
      'Check attached EBS volumes\' size/type — this is where the ongoing cost actually comes from while stopped.',
      'Confirm no other resource (an ALB target group, an Auto Scaling group) still expects this instance to be running.',
    ],
    remediation: [
      'If genuinely no longer needed: terminate the instance (after confirming no snapshot/backup is required first) to stop paying for its EBS volumes.',
      'If needed again later but not now: leave it stopped, but consider EC2_Rightsize if it was oversized when last running — no benefit to resizing an instance that is never started, but doing so before the NEXT time it starts avoids paying for the larger size unnecessarily.',
    ],
    rollback: [
      'A stopped-but-not-terminated instance can simply be started again — no rollback needed for leaving it stopped. Once TERMINATED, there is no rollback: this is why remediation requires confirming no backup is needed first.',
    ],
    escalateWhen: [
      'You cannot determine why the instance was stopped or who owns it — terminating an instance someone else stopped intentionally (e.g. mid-migration) can cause real damage.',
    ],
    defaultSeverity: 'warning',
  },

  rdsLowCpu: {
    title: 'RDS instance running well below its provisioned CPU',
    symptom: 'Average CPU utilization has stayed low over a sustained window, suggesting the instance class is larger than the workload needs.',
    diagnosis: [
      'Check CPU AND memory (FreeableMemory) trends together — an instance can be CPU-idle while memory-constrained (common for SQL Server/reporting workloads); downsizing CPU alone in that case would make memory pressure worse.',
      'Check DatabaseConnections for a realistic concurrency picture — low CPU with high connection count may mean many idle connections, not genuine low load.',
      'Confirm this is not a read replica intentionally sized for burst failover capacity rather than steady-state load.',
    ],
    remediation: [
      'No 1-click automation exists for this finding — evaluate a smaller instance class manually via ModifyDBInstance during a maintenance window, and monitor CPU/memory/connections for the following week before considering it settled.',
    ],
    escalateWhen: [
      'The instance is Multi-AZ or serves a production application with an availability SLA — instance class changes on RDS can require a brief failover/restart depending on engine.',
      'You are not the resource owner and cannot confirm the workload\'s peak pattern from metrics alone.',
    ],
    defaultSeverity: 'info',
  },

  rdsLowConnections: {
    title: 'RDS instance has very few active connections',
    symptom: 'DatabaseConnections has stayed near zero over a sustained window — the database may be unused or replaced by another data store.',
    diagnosis: [
      'Confirm no application is configured to connect but currently failing silently (check application logs/error rates, not just the DB side) — a connection failure looks identical to "nobody uses this" from the RDS metric alone.',
      'Check the instance\'s creation date and any recent deployment/migration history — a newly provisioned instance with low connections may just not be cut over yet.',
    ],
    remediation: [
      'If confirmed unused: take a final snapshot, then stop (not delete) the instance for a grace period before deciding to delete it entirely.',
    ],
    rollback: [
      'A stopped RDS instance can be started again (RDS_Start) with no data loss. Only the eventual delete step is irreversible — always snapshot first.',
    ],
    escalateWhen: [
      'You cannot identify the application/team that should be using this database — stopping a database that another team relies on, even briefly, can cause an incident.',
    ],
    defaultSeverity: 'warning',
  },

  rdsMissingMultiAz: {
    title: 'RDS instance has no Multi-AZ standby',
    symptom: 'A production-tier RDS instance is running Single-AZ — an AZ outage or underlying host failure means downtime with no automatic failover.',
    diagnosis: [
      'Confirm this instance is actually production-tier and not a dev/test/staging database where Single-AZ is an intentional cost decision.',
      'Check the instance\'s RPO/RTO requirement with the resource owner — Multi-AZ roughly doubles the compute+storage cost of the instance, so this is a real cost/resilience trade-off, not a free win.',
    ],
    remediation: [
      'ModifyDBInstance with MultiAZ=true during a maintenance window — RDS provisions and syncs a standby in a different AZ; this incurs a brief write pause during the initial sync, not full downtime.',
    ],
    rollback: [
      'ModifyDBInstance with MultiAZ=false to remove the standby — reverses the cost increase, no data loss (only removes the redundant copy).',
    ],
    escalateWhen: [
      'This is a dev/test/staging instance — do not enable Multi-AZ without confirming with the owner first, since it doubles cost for no resilience benefit if it is genuinely non-production.',
    ],
    defaultSeverity: 'warning',
  },

  natGatewayLowThroughput: {
    title: 'NAT Gateway processing very little traffic',
    symptom: 'BytesOutToDestination/BytesInFromDestination stay low over a sustained window relative to the NAT Gateway\'s fixed hourly cost.',
    diagnosis: [
      'Check which subnets route through this NAT Gateway and whether the resources in them are still active.',
      'Confirm there is no OTHER NAT Gateway serving the same subnets redundantly (a leftover from a past migration) — check each private subnet\'s route table for its actual 0.0.0.0/0 target.',
    ],
    remediation: [
      'If the subnets it serves have no active resources needing outbound internet: delete the NAT Gateway and its associated Elastic IP (if any) after updating the route tables that pointed to it.',
      'If a cheaper alternative (VPC endpoints for S3/DynamoDB/other AWS services, or an EC2 NAT instance for very light traffic) would cover the actual need: migrate to that first, then delete the NAT Gateway.',
    ],
    rollback: [
      'Deleting a NAT Gateway is a one-way action — the same gateway ID cannot be restored. Recreate a new NAT Gateway and update route tables if outbound connectivity turns out to still be needed.',
    ],
    escalateWhen: [
      'You cannot confirm every private subnet\'s outbound dependency (a resource with no CloudWatch presence, like an EC2 instance mid-provisioning, would use the NAT Gateway without showing up in recent traffic).',
    ],
    defaultSeverity: 'info',
  },

  albAllTargetsUnhealthy: {
    title: 'ALL targets behind a load balancer / target group are unhealthy',
    symptom: 'Every registered target fails its health check — the load balancer has nowhere to route traffic; end users see 502/503 errors.',
    diagnosis: [
      'Check the target group\'s health check path/port/protocol settings against what the application actually serves — a recently changed app port/path is the most common cause.',
      'Check the targets themselves (EC2/ECS) directly — are they even running? A stopped or crashed fleet behind a healthy-looking load balancer config is a different root cause than a misconfigured health check.',
      'Check security groups between the load balancer and the targets — a recently tightened SG rule can silently block health check traffic while looking like an application failure.',
    ],
    remediation: [
      'This is an ACTIVE INCIDENT, not a cost/optimization finding — treat it with incident urgency. Fix the underlying cause found in diagnosis (restart/redeploy the targets, correct the health check config, or open the blocked SG rule) rather than any single fixed remediation step.',
    ],
    escalateWhen: [
      'This is ALWAYS escalate-worthy for a production load balancer — treat as a P1/P2 incident and involve the service owner immediately rather than debugging alone if the cause is not obvious within a few minutes.',
    ],
    defaultSeverity: 'critical',
  },

  ebsVolumeUnattached: {
    title: 'EBS volume not attached to any instance',
    symptom: 'A volume exists with no InstanceId — it is billed for its full provisioned size while doing nothing.',
    diagnosis: [
      'Check the volume\'s tags/name for context (e.g. "backup-before-migration", a snapshot source) — an intentionally detached volume kept as a manual backup looks identical to an orphaned one.',
      'Check how long it has been unattached (CreateTime vs. now) — a volume detached minutes ago from an in-progress operation is a false positive.',
    ],
    remediation: [
      'Snapshot_And_Delete_EBS_Volume automation: creates a snapshot of the volume first, THEN deletes the volume — the snapshot is the safety net, never skip straight to delete.',
    ],
    rollback: [
      'Restore a new volume from the snapshot created during remediation (CreateVolume from the SnapshotId) — the data is fully recoverable as long as the snapshot step succeeded, which the action result confirms via `createdSnapshotId`.',
    ],
    escalateWhen: [
      'The volume\'s tags suggest it is a deliberate manual backup or holds data with a compliance retention requirement — confirm with the owner before snapshotting and deleting.',
    ],
    defaultSeverity: 'warning',
  },

  s3BucketNoLifecyclePolicy: {
    title: 'S3 bucket has no lifecycle policy',
    symptom: 'Objects accumulate in Standard storage indefinitely with no transition to cheaper storage classes or expiration — cost grows unbounded over time.',
    diagnosis: [
      'Check the bucket\'s actual access pattern (S3 Storage Lens or access logs) — data accessed frequently should NOT be moved to a cold tier; a lifecycle policy is only a cost win for data that ages out of frequent access.',
      'Check for any compliance/legal hold requirement on this bucket\'s data before proposing an expiration rule (not just a storage-class transition).',
    ],
    remediation: [
      'Apply_S3_Lifecycle_Policy automation applies a transition rule (e.g. to S3 Standard-IA/Glacier after N days) — review the exact day threshold makes sense for this bucket\'s actual access pattern before confirming, rather than accepting a default blindly.',
    ],
    rollback: [
      'PutBucketLifecycleConfiguration again with the policy removed or adjusted — stops FUTURE transitions, but objects ALREADY transitioned to a colder storage class stay there (retrieval may incur a delay/cost to move back, this is not instantly reversible for already-transitioned objects).',
    ],
    escalateWhen: [
      'The bucket holds data under a legal hold, audit retention requirement, or compliance mandate — do not apply an expiration rule without legal/compliance sign-off.',
    ],
    defaultSeverity: 'info',
  },

  savingsPlanCoverageLow: {
    title: 'Savings Plan coverage is low for a service with steady usage',
    symptom: 'A meaningful share of On-Demand spend on a service could be covered by a Savings Plan commitment, based on recent usage stability.',
    diagnosis: [
      'Check usage TREND, not just the current snapshot — a service scaling up or down significantly changes the right commitment size; commit against a stable baseline, not a temporary peak or trough.',
      'Check whether this usage is already covered by a Reserved Instance or a different Savings Plan that this finding\'s coverage calculation might not be accounting for.',
    ],
    remediation: [
      'No 1-click automation exists (a financial commitment decision, not an infrastructure change) — review the AWS Cost Explorer Savings Plans recommendation for the exact commitment size/term, and route the purchase decision through whoever owns cloud financial commitments at your organization.',
    ],
    escalateWhen: [
      'ALWAYS — a Savings Plan is a 1-3 year financial commitment; this must go through whoever owns budget/FinOps decisions, never purchased unilaterally from a dashboard finding alone.',
    ],
    defaultSeverity: 'info',
  },

  backupJobFailed: {
    title: 'A scheduled backup job failed, expired, or was aborted',
    symptom: 'The most recent AWS Backup job for this resource did not complete successfully — the resource\'s recovery point may be stale or missing entirely.',
    diagnosis: [
      'Check the job\'s failure message in the AWS Backup console for the specific cause (permission error, resource busy, vault capacity, timeout) — the remediation differs by cause.',
      'Check whether this is a ONE-OFF transient failure (e.g. the resource was mid-maintenance at backup time) or a RECURRING failure (same job failing every run) — recurring failures need root-cause fixing, not just a retry.',
    ],
    remediation: [
      'Backup_RetryJob automation triggers a new on-demand backup job for the exact resource — appropriate for a one-off transient failure.',
      'For a recurring failure: fix the underlying cause first (IAM permission on the backup role, vault access policy, resource-specific blocker) before retrying, or the retry will simply fail again.',
    ],
    rollback: [
      'Not applicable — retrying a backup only creates an additional recovery point, it does not modify or delete anything existing.',
    ],
    escalateWhen: [
      'The SAME job has failed 2+ consecutive scheduled runs — this points to a systemic cause that a simple retry will not fix; involve whoever owns the backup vault/IAM configuration.',
      'The resource holds data with a compliance-mandated recovery point objective (RPO) that is now at risk of being missed.',
    ],
    defaultSeverity: 'critical',
  },

  ebsVolumeGp2ShouldBeGp3: {
    title: 'EBS volume on gp2 could move to gp3 for lower cost',
    symptom: 'A gp2 volume exists where gp3 would provide the same or better baseline performance at a lower per-GB price.',
    diagnosis: [
      'Check the volume\'s actual IOPS/throughput usage (CloudWatch VolumeReadOps/VolumeWriteOps) against gp3\'s baseline (3,000 IOPS / 125 MiB/s) — if this volume genuinely needs more than baseline, gp3 still supports provisioning extra IOPS/throughput independently, but that costs extra; check whether that changes the expected savings.',
    ],
    remediation: [
      'EBS_ModifyVolumeType automation converts the volume to gp3 online, with no downtime and no data loss — this is an AWS-native, live, in-place volume modification.',
    ],
    rollback: [
      'ModifyVolume back to gp2 with the same API, also online with no downtime — genuinely reversible in either direction.',
    ],
    escalateWhen: [
      'The volume backs a performance-sensitive workload where you are not confident baseline gp3 performance is sufficient — verify with the resource owner or a load test in a non-production copy first.',
    ],
    defaultSeverity: 'info',
  },

  cloudWatchLogGroupNoRetention: {
    title: 'CloudWatch Log Group has no retention policy ("Never Expire")',
    symptom: 'Logs accumulate forever in this log group, growing storage cost indefinitely with no automatic cleanup.',
    diagnosis: [
      'Check the log group\'s current stored size and growth rate to gauge urgency.',
      'Check whether this log group needs LONGER retention than any default you\'re about to apply for compliance/audit reasons (e.g. security/access logs) before setting a short retention period.',
    ],
    remediation: [
      'CloudWatchLogGroup_SetRetention automation ONLY applies when no retention policy currently exists (it will not silently override a deliberate existing setting) — sets a standard retention period going forward.',
    ],
    rollback: [
      'PutRetentionPolicy again with a different (or no) value changes the policy going forward — logs already deleted under the previous policy, if any, cannot be recovered; this only affects future retention behavior.',
    ],
    escalateWhen: [
      'This log group captures security-relevant events (access logs, audit trails) with a compliance-mandated minimum retention — confirm the correct retention period with whoever owns that compliance requirement before applying a generic default.',
    ],
    defaultSeverity: 'info',
  },

  elasticIpUnused: {
    title: 'Elastic IP allocated but not associated with any resource',
    symptom: 'An Elastic IP is reserved in the account but not attached to a running instance/network interface — AWS charges for unassociated Elastic IPs.',
    diagnosis: [
      'Check whether the IP is referenced anywhere OUTSIDE AWS\'s own view (a DNS record, a firewall allowlist at a partner, a hardcoded config on a system outside this account) — releasing an IP that a still-referenced external system depends on breaks that integration silently.',
    ],
    remediation: [
      'ElasticIp_Release automation releases the address back to the AWS pool.',
    ],
    rollback: [
      'Not possible to recover the SAME IP — AWS does not guarantee re-allocating an IP once released, since the address pool is shared account-wide. This action is genuinely irreversible; confirm nothing external depends on this specific address first.',
    ],
    escalateWhen: [
      'You cannot confirm with certainty that nothing outside AWS\'s own visibility (DNS, partner allowlists, hardcoded configs) depends on this specific IP address.',
    ],
    defaultSeverity: 'warning',
  },

  backupVaultNotProtected: {
    title: 'Backup vault has no access policy protecting its recovery points',
    symptom: 'The vault\'s recovery points could be deleted by any principal with backup:DeleteRecoveryPoint permission — no additional protection layer beyond IAM.',
    diagnosis: [
      'Review who/what currently holds backup:Delete* permissions in this account — the protection policy adds a Deny statement, so overly broad existing IAM grants are still worth reviewing independently.',
    ],
    remediation: [
      'BackupVault_ApplyProtectionPolicy automation adds exactly ONE Deny statement (scoped to this vault, distinguishable by its own Sid) preserving every other existing statement on the vault\'s access policy.',
    ],
    rollback: [
      'DeleteBackupVaultAccessPolicy, or re-apply PutBackupVaultAccessPolicy without the added Deny statement — removes the protection, does not affect any existing recovery point.',
    ],
    escalateWhen: [
      'The vault already has a custom access policy with statements you don\'t fully understand — review with whoever set up that policy before adding a new statement on top of it.',
    ],
    defaultSeverity: 'warning',
  },

  restoreTestingNotConfigured: {
    title: 'No AWS Backup Restore Testing plan configured for the account',
    symptom: 'Backups exist but are never automatically test-restored — an unusable/corrupted backup would only be discovered during an actual disaster recovery attempt, too late to matter.',
    diagnosis: [
      'This finding is account-wide (resourceId is always "account-wide") — there is nothing resource-specific to check; the gap is the absence of the testing plan itself.',
    ],
    remediation: [
      'BackupRestoreTesting_CreatePlan automation creates one Restore Testing Plan plus 2 standard selections (RDS, EC2) on a weekly cadence, restoring to a small instance size to control cost.',
    ],
    rollback: [
      'DeleteRestoreTestingPlan / DeleteRestoreTestingSelection for the created plan/selections — does not affect any existing recovery point or production resource, only stops future automatic test restores.',
    ],
    escalateWhen: [
      'Your organization already has an equivalent restore-testing process outside AWS Backup (e.g. a manual DR drill schedule) — confirm this wouldn\'t create a redundant/conflicting process before adding it.',
    ],
    defaultSeverity: 'warning',
  },

  ec2Underprovisioned: {
    title: 'AWS Compute Optimizer flags this EC2 instance as UNDERPROVISIONED',
    symptom: 'Compute Optimizer\'s CPU P99.5 + headroom + memory analysis indicates this instance is too SMALL for its actual peak load — the exact opposite of a rightsizing opportunity.',
    diagnosis: [
      'This is a pure warning, not a cost-saving suggestion — review the specific bottleneck Compute Optimizer identifies (CPU, memory, network, EBS throughput) in its own recommendation detail.',
      'Cross-check against the SIMPLE 30-day-average CPU (used by the separate ec2LowCpu rule) — if that average looks low while Compute Optimizer says underprovisioned, the workload likely has high, brief bursts a simple average hides; trust Compute Optimizer\'s P99.5-based analysis over the average here.',
    ],
    remediation: [
      'No 1-click automation exists — deciding to increase size/change instance family needs a human to weigh budget against the workload\'s actual peak-load requirement. Review Compute Optimizer\'s specific size recommendation and plan a change during a maintenance window.',
    ],
    escalateWhen: [
      'The affected instance is customer-facing or has an active incident/performance complaint associated with it — treat as higher urgency than a routine sizing review.',
    ],
    defaultSeverity: 'warning',
  },

  rdsUnderprovisioned: {
    title: 'AWS Compute Optimizer flags this RDS instance as UNDERPROVISIONED',
    symptom: 'Compute Optimizer\'s analysis indicates this RDS instance is too SMALL for its actual peak load.',
    diagnosis: [
      'Review Compute Optimizer\'s specific bottleneck (CPU, memory, connections, IOPS) for this instance.',
      'Check whether rdsResourceGovernanceMissing is ALSO flagged for the same instance — a missing resource-governance configuration can make a correctly-sized instance LOOK underprovisioned by letting one workload (e.g. an ad-hoc report) starve the rest; fixing governance first may resolve the symptom without needing a larger instance.',
    ],
    remediation: [
      'No 1-click automation exists — plan an instance class change (ModifyDBInstance) during a maintenance window based on Compute Optimizer\'s specific recommendation.',
    ],
    escalateWhen: [
      'The instance serves a production application with an availability SLA — an instance class change may require a brief failover/restart depending on engine and Multi-AZ configuration.',
    ],
    defaultSeverity: 'warning',
  },

  rdsResourceGovernanceMissing: {
    title: 'RDS instance missing standard resource-governance configuration',
    symptom: 'No parameter-group settings limit how much CPU/RAM a single heavy query or reporting workload can consume — one bad query can starve every other service sharing the same database.',
    diagnosis: [
      'Identify the engine (SQL Server vs. PostgreSQL) — the specific parameters differ: SQL Server uses max degree of parallelism / max server memory / query governor cost limit; PostgreSQL uses statement_timeout / max_parallel_workers_per_gather / work_mem.',
      'Check whether this instance uses a SHARED default.* parameter group (the automation refuses to modify one) — if so, a dedicated parameter group must be created and associated first.',
    ],
    remediation: [
      'RDS_ApplyResourceGovernance automation applies the standard governance parameters for the detected engine via ModifyDBParameterGroup.',
    ],
    rollback: [
      'ModifyDBParameterGroup again with the previous parameter values — no data loss, though some parameters have ApplyType static and need an instance reboot to take effect either direction (the action result\'s `requiresReboot` flag tells you which).',
    ],
    escalateWhen: [
      'The instance is shared by multiple teams/applications with different performance expectations — coordinate the new limits with all of them, since a query that used to complete without limits may now be capped.',
    ],
    defaultSeverity: 'warning',
  },
};

/**
 * A handful of well-known CloudWatch metric names (Monitoring_Page alarms/metric panels) get a
 * dedicated runbook too — these are the same recurring names `monitoringThresholds.ts` already
 * classifies into ok/warn/critical, so a person looking at a red metric panel has the same
 * symptom/diagnosis/remediation guidance the assessment-driven findings above already provide.
 * NOT exhaustive (unlike `RUNBOOK_BY_FINDING`, which covers every `RecommendationFindingType`) —
 * `getRunbookForMetric()` returns `undefined` for a metric name not listed here, and callers must
 * treat that as "no runbook available yet", not an error.
 */
export const RUNBOOK_BY_METRIC: Record<string, RunbookEntry> = {
  CPUUtilization: {
    title: 'High CPU utilization',
    symptom: 'CPU usage on the instance is sustained above the alarm threshold — the workload may be undersized, or something is consuming more CPU than expected.',
    diagnosis: [
      'Check whether this is a sudden spike (a specific event: deploy, traffic surge, runaway process) or a gradual climb (organic growth, a slow leak) — the two need different responses.',
      'For EC2: use SSM Run Command\'s read-only presets (top-like process view) from the Run Command tab to see what is actually consuming CPU, without needing to SSH in.',
      'For ECS: check whether the service\'s desiredCount vs. runningCount suggests autoscaling is already responding — if so, this may resolve itself shortly.',
    ],
    remediation: [
      'ECS: ECS_ScaleOut adds capacity immediately if the service is under genuine sustained load and autoscaling has not caught up yet.',
      'EC2: if sustained and the instance is genuinely undersized, plan an EC2_Rightsize / instance-family change (NOT a downsize — see ec2Underprovisioned) during a maintenance window; this is not a same-second fix.',
      'If caused by a runaway/misbehaving process: address that process directly (restart the service, roll back a bad deploy) — resizing hardware does not fix a software bug.',
    ],
    escalateWhen: [
      'CPU stays pegged near 100% with no clear cause and the service is customer-facing — treat as an active incident, not a routine capacity review.',
    ],
    defaultSeverity: 'warning',
  },
  FreeableMemory: {
    title: 'Low freeable memory',
    symptom: 'Available memory on the instance/database is low relative to its total — risk of swapping (severe performance loss) or an out-of-memory failure.',
    diagnosis: [
      'For RDS SQL Server specifically: a low FreeableMemory% reading can be NORMAL (SQL Server\'s buffer pool intentionally holds memory up to its configured cap) — cross-check against `max server memory` and actual query performance before treating this as a real problem; see the detailed threshold-tuning history in `monitoringThresholds.ts` if you need the full reasoning.',
      'For other engines/EC2 Linux/Windows: check SwapUsage alongside FreeableMemory — rising swap alongside falling free memory is the real danger signal, low free memory alone with zero swap can just mean the OS is using memory for cache (which it will release on demand).',
    ],
    remediation: [
      'If genuinely memory-constrained (confirmed via swap usage or OOM events): plan an instance/class size increase — this is a capacity change, not a 1-click action.',
      'If caused by a memory leak in the application: fix/restart the application, do not just add memory to mask a leak.',
    ],
    escalateWhen: [
      'SwapUsage is actively climbing alongside low FreeableMemory on a production resource — this is close to an availability incident, escalate rather than monitor passively.',
    ],
    defaultSeverity: 'warning',
  },
  FreeStorageSpace: {
    title: 'Low free storage space',
    symptom: 'Remaining disk space on the RDS instance is low — risk of the database going read-only or failing writes entirely once storage fills.',
    diagnosis: [
      'Check what is actually consuming space — data growth, bloated logs/temp files, or a recent large import/backup operation.',
      'Check the storage autoscaling configuration (if enabled) — RDS storage autoscaling may already be handling this, in which case the alarm may just be lagging the autoscale event.',
    ],
    remediation: [
      'RDS_IncreaseStorage increases allocated storage — NOTE: this is IRREVERSIBLE (AWS does not support decreasing RDS allocated storage once increased), so confirm the increase amount deliberately rather than over-provisioning "just in case".',
    ],
    escalateWhen: [
      'Free space is critically low (single-digit % remaining) on a production database — this can become a full outage within hours; treat as urgent even outside business hours.',
    ],
    defaultSeverity: 'critical',
  },
  DatabaseConnections: {
    title: 'High database connection count',
    symptom: 'The number of active connections is approaching the engine/instance-class connection limit — new connection attempts will start failing once the limit is reached.',
    diagnosis: [
      'Check for a connection leak in the application (connections opened but never closed/returned to a pool) — this is the most common cause, more common than genuine traffic growth.',
      'Check whether a connection pooler (RDS Proxy, PgBouncer, application-level pooling) is in place and correctly configured.',
    ],
    remediation: [
      'No 1-click automation — the fix is almost always application-side (fix the connection leak, tune pool size) rather than an infrastructure change. An instance class increase only raises the connection LIMIT, it does not fix a leak.',
    ],
    escalateWhen: [
      'Connections are near the hard limit RIGHT NOW on a production database — this is an active incident (new connections will start failing imminently), involve the application team immediately.',
    ],
    defaultSeverity: 'critical',
  },
  SwapUsage: {
    title: 'Instance is swapping memory to disk',
    symptom: 'The OS has started using swap space — a strong signal of genuine memory pressure, since swapping is drastically slower than RAM and directly degrades performance.',
    diagnosis: [
      'Confirm this metric is even PUBLISHED for the engine/OS in question — RDS SQL Server on Windows does NOT publish SwapUsage at all (verified against real instances — see the correction note in `monitoringThresholds.ts`); do not treat its absence there as "swap is zero and healthy", it means the signal does not exist for that engine.',
      'Check how much swap is in use and for how long — a brief, small swap event during a burst is very different from sustained heavy swapping.',
    ],
    remediation: [
      'Sustained swap usage means the workload needs more memory than currently provisioned — plan an instance/class size increase, or fix the application-level memory leak causing it.',
    ],
    escalateWhen: [
      'Swap usage is sustained and growing on a production resource — this typically precedes a severe performance degradation or OOM event; escalate rather than wait for it to resolve on its own.',
    ],
    defaultSeverity: 'critical',
  },
  UnHealthyHostCount: {
    title: 'One or more targets behind a load balancer are unhealthy',
    symptom: 'A target group reports unhealthy targets — SOME capacity is unavailable to serve traffic, though (unlike albAllTargetsUnhealthy) not necessarily all of it.',
    diagnosis: [
      'Check whether the unhealthy count is a SUBSET of total targets (partial degradation, other targets still serving traffic — less urgent) or equal to total targets (see albAllTargetsUnhealthy for that case, which is a full outage).',
      'Check the specific target(s) failing health checks — a rolling deploy in progress can show this transiently and resolve itself within minutes.',
    ],
    remediation: [
      'If caused by an in-progress deploy: monitor briefly, it likely resolves on its own as new targets pass health checks.',
      'If NOT resolving: investigate the specific unhealthy target directly (application logs, health check endpoint response) rather than restarting broadly.',
    ],
    escalateWhen: [
      'The unhealthy count is not decreasing after a few minutes and represents a meaningful share of total capacity — escalate before it degrades further toward a full outage.',
    ],
    defaultSeverity: 'warning',
  },
  StatusCheckFailed: {
    title: 'EC2 instance status check failure',
    symptom: 'AWS\'s own instance or system status check is failing — the instance may be unresponsive at the OS level or the underlying host has a problem.',
    diagnosis: [
      'Check WHICH status check failed: instance status (OS-level — often fixable with a reboot) vs. system status (underlying AWS hardware/host — needs a stop/start to migrate to new hardware, a reboot alone will not fix it).',
    ],
    remediation: [
      'Instance status check failure: EC2_Reboot is usually sufficient.',
      'System status check failure: stop and start the instance (not just reboot) — this moves it to different underlying hardware, which a same-host reboot cannot do.',
    ],
    escalateWhen: [
      'The instance does not recover after the appropriate remediation (reboot for instance-level, stop/start for system-level) — this may indicate a deeper issue (corrupted volume, AMI problem) needing AWS Support.',
    ],
    defaultSeverity: 'critical',
  },

  // --- CIS AWS Foundations Benchmark metric-filter alarms (v3.0/v5.0 §4.1-4.13) ---
  //
  // These 12 entries back the `CIS-*-Alarm` CloudWatch alarms (namespace `CISBenchmark`) that
  // this project's own `alarm-baseline-manager.ts` does NOT create or manage — they were
  // provisioned out-of-band (a standard CIS Benchmark CloudTrail metric-filter alarm pack) and
  // point at a DIFFERENT SNS topic (`abc-prod-security-alerts`) than `AlarmNotificationTopic`.
  // Someone later subscribed `alerting-notifier-fn` to that topic too, so these alarms flow
  // through the SAME notifier/runbook pipeline as everything else in this catalog — but until
  // this entry existed, `getRunbookForMetric()` returned `undefined` for all 12, which is
  // EXACTLY why they always rendered as SEV-2 with the generic "no dedicated runbook exists yet"
  // impact text (see `alarm-notifier.ts`'s `alarmSevTier`: SEV-1 requires a resolvable
  // runbook). Adding these entries is what upgrades a genuine CIS breach to SEV-1.
  //
  // WHY THESE ALARMS ARE STRUCTURALLY VAGUE, AND WHAT THIS RUNBOOK CANNOT FIX ON ITS OWN. Every
  // one of these 12 alarms is a `Namespace: CISBenchmark` metric filter over CloudTrail Logs with
  // `Dimensions: []` — the metric value is a raw COUNT of matching log lines in the evaluation
  // period, carrying NO who/what/where (confirmed live: `describe-alarms` on this account shows
  // `Dimensions: []` on all 12; the metric literally cannot carry a dimension, because the same
  // filter pattern matches many different callers/IPs/resources over time). The account/IAM
  // principal/source IP/exact API call/resource ARN a reader actually needs can ONLY come from
  // re-querying the underlying CloudTrail event for the alarm's own evaluation window — see
  // `lookupCisBenchmarkEvent` in `alarm-notifier.ts`, which this runbook's `diagnosis`
  // step below assumes will have already run and attached that detail to the Impact/Metadata
  // fields BEFORE a human ever needs to open the console.
  CloudTrailConfigChangesCount: {
    title: 'CIS 3.5 (v3.0) / 4.3 (v5.0) — CloudTrail configuration changed',
    symptom: 'A CloudTrail trail was created, updated, deleted, started, or stopped — this metric filter fires on `CreateTrail`/`UpdateTrail`/`DeleteTrail`/`StartLogging`/`StopLogging` CloudTrail management events.',
    diagnosis: [
      'Check the enriched CloudTrail event detail this alert should already carry (eventName/userIdentity/sourceIPAddress/requestParameters) — if it is missing, the automated CloudTrail lookup itself failed; re-run `aws cloudtrail lookup-events --lookup-attributes AttributeKey=EventName,AttributeValue=<StopLogging|DeleteTrail|UpdateTrail>` for the alarm\'s StateChangeTime window.',
      'Confirm whether this was a planned change (a deliberate trail reconfiguration by an authorized admin, e.g. adding a new log destination) or unexpected.',
      '`StopLogging`/`DeleteTrail` are the highest-risk of this group — they can be the FIRST step of an attacker covering their tracks; treat those two event names with more urgency than `UpdateTrail`.',
    ],
    remediation: [
      'If unauthorized: immediately re-enable logging (`StartLogging`) or recreate the deleted trail, then rotate credentials for the identity that made the change.',
      'If authorized but undocumented: record the change in your change log so the next occurrence is recognized as expected.',
    ],
    rollback: [
      'Not applicable in the usual sense — the "rollback" IS the remediation (restore logging). There is no data to revert; the risk is the logging GAP itself, which cannot be retroactively filled once closed.',
    ],
    escalateWhen: [
      'The identity that made the change is not a recognized account administrator, or the change happened outside any planned maintenance window — treat as a potential active compromise and involve whoever owns account security immediately.',
      'A `DeleteTrail`/`StopLogging` event has no corresponding change-ticket/notification from a known admin.',
    ],
    defaultSeverity: 'critical',
  },
  ConsoleLoginFailuresCount: {
    title: 'CIS 3.6 (v3.0) / 4.4 (v5.0) — repeated AWS Console sign-in failures',
    symptom: 'Multiple failed AWS Management Console login attempts within the evaluation window — could be a forgotten password, or a credential-stuffing/brute-force attempt against a known IAM username.',
    diagnosis: [
      'Check the enriched CloudTrail `ConsoleLogin` event(s) (userIdentity.userName, sourceIPAddress, additionalEventData.MFAUsed) for this window — a single user failing their own login a few times from a known office/VPN IP is low risk; many failures across DIFFERENT usernames from the same IP, or the same username from an unfamiliar IP/country, is the real signal.',
      'Cross-check the source IP against your organization\'s known office/VPN egress ranges.',
    ],
    remediation: [
      'If a legitimate user locked themselves out: help them reset their password through the normal IAM/Identity Center flow — no security action needed.',
      'If it looks like brute-forcing: disable the targeted IAM user\'s console access, force a password reset, and confirm MFA is enrolled before re-enabling.',
    ],
    escalateWhen: [
      'Failures span multiple distinct usernames from the same source IP (credential-stuffing pattern), or ANY failure is followed by a SUCCESSFUL login from a different, unfamiliar IP shortly after — treat as an active account-takeover attempt and involve account security immediately.',
    ],
    defaultSeverity: 'warning',
  },
  ConsoleSigninWithoutMFACount: {
    title: 'CIS 3.2 (v3.0) / 4.2 (v5.0) — console sign-in without MFA',
    symptom: 'An IAM user or the root account signed in to the AWS Console without multi-factor authentication — the account is one leaked password away from full compromise.',
    diagnosis: [
      'Check the enriched CloudTrail `ConsoleLogin` event\'s `userIdentity.userName` and whether `arn` indicates the ROOT account specifically (root sign-ins without MFA are far more severe than a non-root IAM user — root cannot be permission-restricted).',
      'Confirm this identity does not already have MFA enrolled but the login used an SSO/federated path that this filter cannot see correctly — verify against `iam get-user`/`get-mfa-devices` before assuming MFA is genuinely absent.',
    ],
    remediation: [
      'Enroll MFA for the affected IAM user immediately (or verify/reconfigure Identity Center MFA enforcement if this is a federated identity).',
      'If root: this should almost never happen — verify root sign-in was performed by an authorized administrator for a task that genuinely required root (very few tasks do), and enroll a hardware/virtual MFA device on the root account if none exists.',
    ],
    escalateWhen: [
      'The sign-in is the ROOT account — always escalate immediately regardless of whether it turns out to be authorized, since root has no permission boundary to limit blast radius.',
      'The identity does not recognize performing this sign-in when asked — treat as a compromised credential.',
    ],
    defaultSeverity: 'critical',
  },
  IAMPolicyChangesCount: {
    title: 'CIS 3.4 (v3.0) / 4.5 (v5.0) — IAM policy changed',
    symptom: 'An IAM policy, role, user, or group\'s permissions were created, attached, detached, or deleted — this is exactly how privilege escalation and persistence are established during a compromise, and also how normal admin work grants access.',
    diagnosis: [
      'Check the enriched CloudTrail event (`eventName` — one of `PutUserPolicy`/`PutGroupPolicy`/`PutRolePolicy`/`CreatePolicy`/`CreatePolicyVersion`/`AttachUserPolicy`/`AttachRolePolicy`/`AttachGroupPolicy`/`DeleteUserPolicy`/`DeleteGroupPolicy`/`DeleteRolePolicy`/`DeletePolicy`/`DeletePolicyVersion`/`DetachUserPolicy`/`DetachRolePolicy`/`DetachGroupPolicy`/`CreateRole`) plus `requestParameters` for exactly WHAT permission was granted/revoked and to WHOM.',
      'Check whether the granted permissions include anything broad (`*:*`, `iam:*`, `AdministratorAccess`) — a narrow, scoped grant is routine; a broad grant to an unexpected principal is the highest-risk pattern this alarm exists to catch.',
    ],
    remediation: [
      'If unauthorized: immediately revert the policy change (detach/delete the added policy, or restore the previous policy version), then rotate credentials for the identity that made the change.',
      'If authorized: no action needed beyond confirming it matches an approved change request.',
    ],
    rollback: [
      'IAM policies are versioned — use `SetDefaultPolicyVersion` to roll back to the prior version, or manually re-apply the previous policy document if no version history exists (inline policies have none).',
    ],
    escalateWhen: [
      'The change grants broad/administrative permissions to a principal that did not previously have them, and no matching change request exists — treat as an active privilege-escalation attempt.',
      'The identity that made the change is itself unfamiliar or was recently created.',
    ],
    defaultSeverity: 'critical',
  },
  KMSKeyDisableOrDeleteCount: {
    title: 'CIS 3.7 (v3.0) / 4.6 (v5.0) — KMS customer master key disabled or scheduled for deletion',
    symptom: 'A KMS key was disabled or scheduled for deletion — any data encrypted under that key becomes permanently unreadable once deletion completes (KMS enforces a 7-30 day waiting period, this is NOT instant).',
    diagnosis: [
      'Check the enriched CloudTrail event (`DisableKey` vs. `ScheduleKeyDeletion`) and `requestParameters.keyId` to identify exactly which key and confirm what it encrypts (check the key\'s aliases/tags and any resource whose encryption config references this KeyId — RDS, S3, EBS, Secrets Manager all commonly reference a specific CMK).',
      'If `ScheduleKeyDeletion`: note the `pendingWindowInDays` in the response — this is the exact time-boxed window to act within before deletion becomes irreversible.',
    ],
    remediation: [
      'If unintentional and still within the pending window: `CancelKeyDeletion` immediately, then re-`EnableKey` if it was also disabled.',
      'If a key was disabled but not scheduled for deletion: `EnableKey` to restore access to data encrypted under it.',
    ],
    rollback: [
      'Not possible once the pending-deletion window fully elapses and AWS completes the deletion — this is the ONE truly irreversible action in this entire runbook catalog; there is no rollback after that point, only cancellation BEFORE it.',
    ],
    escalateWhen: [
      'ALWAYS, immediately, if the key is scheduled for deletion (`ScheduleKeyDeletion`) and you are not certain every dependent resource has been identified — the pending window is the only chance to prevent permanent, unrecoverable data loss.',
    ],
    defaultSeverity: 'critical',
  },
  NACLChangesCount: {
    title: 'CIS 3.11 (v3.0) / 4.10 (v5.0) — Network ACL changed',
    symptom: 'A Network ACL (subnet-level firewall) was created, replaced, or had an entry/association changed — this can open or close traffic at the subnet boundary, affecting every resource in that subnet at once.',
    diagnosis: [
      'Check the enriched CloudTrail event (`CreateNetworkAcl`/`ReplaceNetworkAclEntry`/`CreateNetworkAclEntry`/`DeleteNetworkAclEntry`/`ReplaceNetworkAclAssociation`) and `requestParameters` for the exact rule (CIDR, port range, protocol, Allow/Deny) added or removed.',
      'Check which subnets the affected NACL is associated with, and whether any of them host production resources — a NACL change to an isolated dev subnet is far lower risk than one on a subnet with production databases/load balancers.',
    ],
    remediation: [
      'If the new rule is an unintended broad opening (e.g. `0.0.0.0/0` on a sensitive port): replace/delete the offending entry to restore the intended restriction.',
      'If authorized: confirm it matches a planned network change.',
    ],
    rollback: [
      'Re-apply the previous NACL entry (Network ACLs have no built-in versioning — the previous rule set must be known/documented ahead of time, e.g. via your IaC template, to revert precisely).',
    ],
    escalateWhen: [
      'The change opens inbound access from `0.0.0.0/0` on a subnet hosting production databases or internal-only services, and no corresponding change ticket exists.',
    ],
    defaultSeverity: 'warning',
  },
  RootAccountUsageCount: {
    title: 'CIS 1.7 (v3.0) / 1.8 (v5.0) — root account used',
    symptom: 'The AWS account root user performed an action (signed in, or made an API call) — root should be used only for the small set of tasks that genuinely require it (e.g. closing the account, changing support plan), never for routine operations.',
    diagnosis: [
      'Check the enriched CloudTrail event\'s `eventName` and `sourceIPAddress` — was this a console sign-in, or a specific API call? Root API usage for a routine operational task (anything an IAM role could have done instead) is itself the finding, independent of whether the source IP looks legitimate.',
      'Confirm with whoever holds root credentials whether this usage was expected.',
    ],
    remediation: [
      'If expected and genuinely required root (e.g. an account-level billing/support-plan change): no security action needed, but consider documenting WHY root was required for future reference.',
      'If root was used for something an IAM role/user could have done: create/use an appropriately-scoped IAM role for that task going forward, and treat this as a process gap even if not a security incident.',
    ],
    escalateWhen: [
      'Nobody who holds root credentials recognizes performing this action — treat as a compromised root credential, the highest-severity possible event in an AWS account, and begin credential rotation/account lockdown immediately.',
      'The action is a sensitive one (e.g. modifying account-level security settings, creating access keys) rather than a benign billing task.',
    ],
    defaultSeverity: 'critical',
  },
  RouteTableChangesCount: {
    title: 'CIS 3.13 (v3.0) / 4.12 (v5.0) — VPC route table changed',
    symptom: 'A route table was created, replaced, or had a route added/deleted — this controls where traffic from a subnet is actually sent, and can silently redirect or black-hole traffic if changed incorrectly (or maliciously).',
    diagnosis: [
      'Check the enriched CloudTrail event (`CreateRoute`/`ReplaceRoute`/`DeleteRoute`/`CreateRouteTable`/`ReplaceRouteTableAssociation`) and `requestParameters` for the exact destination CIDR and target (internet gateway, NAT gateway, peering connection, transit gateway, or a specific ENI) that was added/changed.',
      'A new default route (`0.0.0.0/0`) pointing somewhere unexpected (e.g. an unfamiliar ENI or peering connection instead of the usual IGW/NAT) is the highest-risk pattern — it can silently exfiltrate all outbound traffic from that subnet through an attacker-controlled path.',
    ],
    remediation: [
      'If the route is unintended/malicious: delete or replace it with the correct target immediately.',
      'If authorized: confirm it matches a planned network change (e.g. a new VPC peering or transit gateway attachment going live).',
    ],
    rollback: [
      'Re-apply the previous route (ReplaceRoute back to the original target) — requires knowing what the previous target was, ideally from your IaC template/state rather than memory.',
    ],
    escalateWhen: [
      'A default route or any route affecting a production subnet now points to a target nobody on the team recognizes provisioning — treat as a possible traffic-interception/exfiltration attempt.',
    ],
    defaultSeverity: 'critical',
  },
  S3BucketPolicyChangesCount: {
    title: 'CIS 3.9 (v3.0) / 4.8 (v5.0) — S3 bucket policy changed',
    symptom: 'An S3 bucket policy, ACL, public access block configuration, or bucket-level replication/lifecycle-affecting-access setting was changed — this is one of the most common paths to accidental (or deliberate) public data exposure.',
    diagnosis: [
      'Check the enriched CloudTrail event (`PutBucketPolicy`/`PutBucketAcl`/`PutBucketPublicAccessBlock`/`DeleteBucketPolicy`) and `requestParameters` for the bucket name and the actual policy/ACL content that was applied.',
      'Check the bucket\'s current public-access status directly (`aws s3api get-public-access-block`, `get-bucket-policy-status`) — do not rely on the alarm alone to confirm exposure, verify live.',
    ],
    remediation: [
      'If the bucket is now unintentionally public or grants broader access than intended: restore the S3 Block Public Access settings and/or revert the bucket policy to its previous, more restrictive version immediately.',
      'If authorized (e.g. deliberately publishing a static website bucket): confirm the exposed content contains no sensitive data before leaving it public.',
    ],
    rollback: [
      'PutBucketPolicy again with the previous policy document (keep policy documents in version control/IaC specifically so this rollback is always possible without guessing).',
    ],
    escalateWhen: [
      'The bucket now allows public read/write and its contents are not confirmed to be intentionally public — treat as a potential data breach and involve account security immediately; check access logs for any GetObject calls from unfamiliar principals since the policy changed.',
    ],
    defaultSeverity: 'critical',
  },
  SecurityGroupChangesCount: {
    title: 'CIS 3.10 (v3.0) / 4.9 (v5.0) — security group changed',
    symptom: 'A security group rule was authorized or revoked — this is the most common way both legitimate deployments AND unauthorized access open a path to a resource.',
    diagnosis: [
      'Check the enriched CloudTrail event (`AuthorizeSecurityGroupIngress`/`AuthorizeSecurityGroupEgress`/`RevokeSecurityGroupIngress`/`RevokeSecurityGroupEgress`/`CreateSecurityGroup`) and `requestParameters` for the exact CIDR/port/protocol added or removed, and which security group (by GroupId — cross-reference against Infra_Tab to see which resources use it).',
      'An ingress rule opening a sensitive port (22/3389/3306/5432/1433/6379/9200 etc.) from `0.0.0.0/0` is the highest-risk pattern this alarm exists to catch — check for that specifically before anything else.',
    ],
    remediation: [
      'If the new rule is an unintended broad opening: revoke it immediately and replace with a scoped CIDR (a specific office/VPN range, or a peer security group reference) if access is still needed.',
      'If authorized (e.g. a new ALB needing a rule to reach its targets): confirm it matches a planned deployment.',
    ],
    rollback: [
      'RevokeSecurityGroupIngress/Egress with the exact same rule parameters that were authorized — security groups have no built-in versioning, so knowing the PREVIOUS rule set (via IaC/tags) matters for a clean revert.',
    ],
    escalateWhen: [
      'A sensitive port is opened to `0.0.0.0/0` on a security group attached to a production resource and no deployment/change ticket explains it — treat as an active exposure and revoke immediately rather than investigating first.',
    ],
    defaultSeverity: 'critical',
  },
  UnauthorizedAPICallsCount: {
    title: 'CIS 3.1 (v3.0) / 4.1 (v5.0) — unauthorized API call attempted',
    symptom: 'An API call was made that failed with `AccessDenied`/`UnauthorizedOperation` — this can be routine (someone testing permissions, a misconfigured but harmless script) or the reconnaissance phase of an attack (a compromised credential enumerating what it CAN reach by trying everything).',
    diagnosis: [
      'Check the enriched CloudTrail event\'s `userIdentity`, `eventName`, and `sourceIPAddress` — ONE denied call from a known internal identity/IP is routine; MANY different denied calls across many services from the SAME identity in a short window is the reconnaissance pattern.',
      'Check whether the identity making the denied calls is one that should exist/be active at all — a denied call from a deactivated or unfamiliar IAM user/role is far more concerning than from an active, known one.',
    ],
    remediation: [
      'If a known identity hit a real permission gap for legitimate work: grant the specific permission needed through the normal least-privilege review process — do not broaden the identity\'s permissions beyond what was actually denied.',
      'If it looks like reconnaissance from a compromised credential: disable the identity\'s access keys/console access immediately, then investigate what it DID successfully access before this pattern started.',
    ],
    escalateWhen: [
      'The same identity generates a BROAD spread of denied calls across many different, unrelated services/actions in a short window (the classic "probing what I can reach" pattern) — treat as an active compromise, not a permissions question.',
      'The identity is one that should not be active at all (a former employee\'s user, a role that should have been deleted).',
    ],
    defaultSeverity: 'warning',
  },
  VPCChangesCount: {
    title: 'CIS 3.14 (v3.0) / 4.13 (v5.0) — VPC changed',
    symptom: 'A VPC, VPC peering connection, VPN gateway, or VPC-to-VPC/on-prem connectivity component was created, deleted, or changed — this is the network perimeter itself moving, not just a rule within it.',
    diagnosis: [
      'Check the enriched CloudTrail event (`CreateVpc`/`DeleteVpc`/`CreateVpcPeeringConnection`/`AcceptVpcPeeringConnection`/`CreateVpnConnection`/`CreateVpnGateway`/`AttachClassicLinkVpc`/`EnableVpcClassicLink`) and `requestParameters` for exactly what connectivity was established or removed.',
      'A NEW peering connection or VPN gateway that nobody on the team recognizes provisioning is the highest-risk pattern — it can create a persistent, hard-to-notice bridge into (or out of) the account\'s network.',
    ],
    remediation: [
      'If an unrecognized peering connection/VPN gateway was created: delete it immediately (this also removes the routes that reference it — check RouteTableChangesCount alerts around the same time for any routes that were added alongside it).',
      'If authorized (e.g. a planned peering with a partner account or a new on-prem VPN): confirm it matches a documented network change.',
    ],
    rollback: [
      'DeleteVpcPeeringConnection / DeleteVpnConnection / DeleteVpnGateway reverses the connectivity — this does not affect resources INSIDE the VPC, only the connectivity component itself.',
    ],
    escalateWhen: [
      'A new peering connection, VPN gateway, or VPC was created and NO ONE on the team can immediately identify who requested it — treat as a potential persistent-access mechanism and involve account security before deciding whether to delete it (deleting first may destroy evidence needed for investigation).',
    ],
    defaultSeverity: 'critical',
  },
};

/** Looks up the runbook for an Assessment finding — always succeeds (every `RecommendationFindingType`
 * has an entry, enforced at compile time via the `Record` above). */
export function getRunbookForFinding(findingType: RecommendationFindingType): RunbookEntry {
  return RUNBOOK_BY_FINDING[findingType];
}

/** Looks up the runbook for a well-known CloudWatch metric name — returns `undefined` for a
 * metric not in `RUNBOOK_BY_METRIC` (not every metric this dashboard surfaces has a dedicated
 * runbook yet; callers must handle the "no runbook available" case explicitly rather than
 * assuming one always exists, unlike `getRunbookForFinding`). */
export function getRunbookForMetric(metricName: string): RunbookEntry | undefined {
  return RUNBOOK_BY_METRIC[metricName];
}
