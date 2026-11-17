/** Data types shared between the backend and frontend — the single source of truth for the API contract. */

export type ThresholdLevel = 'ok' | 'warn' | 'critical';

export interface ThresholdMeta {
  level: ThresholdLevel;
  reason: string;
}

export interface Me {
  sub: string;
  name: string;
  email: string;
  isOperator: boolean;
  /**
   * `true` when operator status CANNOT be determined because the token uses `_claim_names`
   * instead of `groups` (Entra ID group overage — the account belongs to too many groups to list
   * directly in the claim). `isOperator` is `false` in that case per fail-closed, but that means
   * "unknown", NOT "no permission" — the UI uses this field to state the reason clearly instead of
   * letting a real operator see a read-only dashboard with no explanation. Optional: a normal
   * token does NOT have this field (doesn't break the existing contract).
   */
  operatorStatusUnknown?: boolean;
}

// ---- Infra tab ----

export interface Ec2Summary {
  instanceId: string;
  name: string;
  region: string;
  state: string;
  instanceType: string;
  /** `'windows'` if `Instance.Platform === 'windows'` (DescribeInstances), otherwise `'linux'` —
   * used to pick the right SSM document (RunShellScript/RunPowerShellScript) for SSM Run Command. */
  platform: 'linux' | 'windows';
  threshold: ThresholdMeta;
  /** The instance's current tags (key -> value), read from `Instance.Tags` in DescribeInstances.
   * Optional: a cache entry older than the Tag Management feature may not have this field yet. */
  tags?: Record<string, string>;
  /** SG ids currently attached to the instance, read from `Instance.SecurityGroups[].GroupId` in
   * DescribeInstances. Optional for the same reason as `tags`. Used to compute the +N/-M diff when
   * editing Ec2_ModifySecurityGroups (Task 9) and to filter the selectable SG list down to the
   * instance's own VPC (an SG from a different VPC makes ModifyInstanceAttribute fail on AWS). */
  securityGroupIds?: string[];
}

export interface RdsSummary {
  dbInstanceIdentifier: string;
  region: string;
  status: string;
  engine: string;
  multiAz: boolean;
  freeStorageGb: number;
  allocatedStorageGb: number;
  threshold: ThresholdMeta;
}

/** Health of one specific target group belonging to an ALB — used to show a breakdown of "which
 * target group has the problem" when that ALB is unhealthy (instead of only the ALB's aggregate
 * unhealthy/total count). */
export interface AlbTargetGroupHealth {
  targetGroupName: string;
  unhealthyTargets: number;
  totalTargets: number;
}

export interface AlbSummary {
  name: string;
  region: string;
  state: string;
  unhealthyTargets: number;
  totalTargets: number;
  threshold: ThresholdMeta;
  /**
   * The tail of the ARN in `app/<name>/<id>` form — the value CloudWatch ACTUALLY requires for
   * the `LoadBalancer` dimension of the `AWS/ApplicationELB` namespace (NOT `name` — CloudWatch
   * doesn't accept a bare load balancer name). Optional so as not to break the existing contract
   * of current consumers (`InfraTab`) that don't need this value; `monitoring-service.ts`/
   * alert-service.ts MUST use this field when building a `MetricDataQuery`/console link for an ALB.
   */
  arnSuffix?: string;
  /** Breakdown per target group belonging to this ALB — used to show "which target group has the
   * problem" on Monitoring_Page when the ALB has unhealthyTargets > 0, instead of only the
   * aggregate count. */
  targetGroups: AlbTargetGroupHealth[];
  /** The ALB's tags (key -> value), read via `elasticloadbalancing:DescribeTags`. Optional: a
   * cache entry older than this field's introduction may not have it yet. Used to apply
   * `ops-dashboard:monitoring-exempt` (see `lib/thresholds.ts`, `applyMonitoringExemption`). */
  tags?: Record<string, string>;
}

/** ECS_Service — a container service running in an ECS cluster (Fargate or EC2 launch type). */
export interface EcsServiceSummary {
  serviceName: string;
  clusterName: string;
  region: string;
  status: string;
  desiredCount: number;
  runningCount: number;
}

export interface InfraData {
  ec2: Ec2Summary[];
  rds: RdsSummary[];
  alb: AlbSummary[];
  generatedAt: string;
  asOf: string;
}

// ---- Compliance & Backup tab ----

export interface BackupJobSummary {
  jobId: string;
  resourceName: string;
  state: string;
  creationDate: string;
  threshold: ThresholdMeta;
}

export interface DlmPolicySummary {
  policyId: string;
  description: string;
  state: string;
  targetVolumeCount: number;
}

export interface ConfigComplianceSummary {
  ruleName: string;
  complianceType: string;
  threshold: ThresholdMeta;
}

/** 'evaluated' = AWS Config returned a result (even 0 non-compliant rules);
 * 'unavailable' = data could not be fetched (Config not enabled/API error) — MUST NOT be treated as compliant. */
export type ConfigComplianceStatus = 'evaluated' | 'unavailable';

export interface ComplianceData {
  recentBackupJobs: BackupJobSummary[];
  dlmPolicies: DlmPolicySummary[];
  configRules: ConfigComplianceSummary[];
  configStatus: ConfigComplianceStatus;
  generatedAt: string;
  asOf: string;
}

// ---- Cost tab ----

export interface CostByService {
  service: string;
  amountUsd: number;
}

/** Daily cost, used for the cost trend chart (Requirement 9.1). */
export interface DailyCost {
  date: string; // ISO date
  amountUsd: number;
}

/** A service whose cost changed significantly between two consecutive months — used for the "Top
 * services increasing/decreasing cost" section of the monthly report. `deltaUsd`/`deltaPercent`
 * are always computed as (this month - previous month) — positive = increase, negative = decrease.
 * `deltaPercent` is `null` when the previous month = 0 (can't divide by 0 — the service is
 * entirely new this month). */
export interface CostServiceMover {
  service: string;
  currentMonthUsd: number;
  previousMonthUsd: number;
  deltaUsd: number;
  deltaPercent: number | null;
}

/** One month in the monthly cost history report (Period_Report) — `month` is in "YYYY-MM" form.
 * `deltaUsd`/`deltaPercent` are relative to the month IMMEDIATELY BEFORE this one in the same
 * `monthlyHistory` array (the first month in history always has `deltaUsd: 0`/`deltaPercent: null`
 * — there's no previous month to compare against). `topIncreasedServices`/`topDecreasedServices`
 * are capped at 5 services, sorted by descending magnitude of $ change — so it's immediately clear
 * which services are driving cost up/down the most. Does NOT keep the full `byService` for every
 * month here (13 months × every service exceeds the SSM Parameter Standard's 32KB limit, which
 * used to make cost-collector fail at the cache-write step every time) — `topIncreasedServices`/
 * `topDecreasedServices` is enough for the UI; see `CostData.byService` for the current month. */
export interface MonthlyCostSummary {
  month: string;
  totalUsd: number;
  deltaUsd: number;
  deltaPercent: number | null;
  topIncreasedServices: CostServiceMover[];
  topDecreasedServices: CostServiceMover[];
}

// ---- Department cost allocation (Cost tab) ----

/**
 * The 4 real business units that every AWS resource's cost is ultimately allocated to — applied via the `Department` tag
 * (see `backend/src/modules/ec2-management/tagConventions.ts`).
 * `SHARED` is NOT a 5th business unit here on purpose: it is a tag VALUE used on infrastructure
 * with no single owner (bastion hosts, NAT gateways, CI/CD buckets...), whose cost is always
 * redistributed across these 4 units before reaching the UI — see `CostByDepartment.sharedShareUsd`
 * and `backend/src/lib/costAllocation.ts`.
 */
export type BusinessUnit = 'SALE' | 'MKT' | 'HR' | 'SERVICE';

export const BUSINESS_UNITS: readonly BusinessUnit[] = ['SALE', 'MKT', 'HR', 'SERVICE'];

/**
 * One business unit's cost breakdown for the period — always sums to
 * `directUsd + sharedShareUsd === totalUsd`. `sharedShareUsd` is this unit's PROPORTIONAL slice of
 * the `SHARED`-tagged pool (see `CostAllocationSummary.sharedPoolUsd`), computed by
 * `allocateSharedCost` in `backend/src/lib/costAllocation.ts`: `directUsd / sumOfAllDirectUsd *
 * sharedPoolUsd`. A unit with $0 direct cost this period gets $0 of the shared pool too (nothing
 * to be proportional to) — this can legitimately happen for a small business unit in a quiet
 * period, it is not a bug.
 */
export interface CostByDepartment {
  department: BusinessUnit;
  directUsd: number;
  sharedShareUsd: number;
  totalUsd: number;
}

/**
 * The full department cost-allocation result for the period (Requirement: all AWS cost
 * must be fully allocated to SALE/MKT/HR/SERVICE, with shared cost split in a reasonable proportion).
 * `byDepartment` always covers `directUsd + sharedShareUsd` for the 4 `BusinessUnit`s;
 * `unallocatedUsd` is cost that could NOT be attributed to any of them for this period — either a
 * resource is missing the `Department` tag entirely, or the cost was incurred BEFORE the tag was
 * applied (Cost Explorer groups by the tag value AT THE TIME the cost was incurred, not
 * retroactively — a resource tagged today will show untagged cost for every prior day in the same
 * report). `unallocatedUsd` is surfaced explicitly (never silently dropped or merged into one of
 * the 4 units) so a report is never mistaken for "100% allocated" when it is not — see the FinOps
 * Foundation's "Managing Shared Cloud Cost" principle that unallocated cost must stay visible.
 */
export interface CostAllocationSummary {
  byDepartment: CostByDepartment[];
  /** Total cost tagged `Department=SHARED` for the period, before being redistributed into each
   * unit's `sharedShareUsd` above. Shown so an operator can see how large the "shared pool" is
   * relative to direct costs, not just the post-split result. */
  sharedPoolUsd: number;
  /** Cost with no `Department` tag value at all for the period — see the interface comment. */
  unallocatedUsd: number;
}

export interface CostData {
  monthToDateUsd: number;
  forecastMonthUsd: number;
  /** `false` when `GetCostForecastCommand` fails (e.g. insufficient history, throttling) — in
   * that case `forecastMonthUsd` is just a placeholder (equal to `monthToDateUsd`), NOT a real
   * forecast from AWS. The UI must show "No forecast data available" instead of a misleading
   * $0.00 that implies "AWS forecasts $0". */
  forecastAvailable: boolean;
  previousMonthUsd: number;
  byService: CostByService[];
  threshold: ThresholdMeta;
  /** When the cost-collector Lambda wrote the cache — NOT when the request was made. */
  cachedAt: string;
  /** Daily cost over the last 30 days, used for the trend chart (Requirement 9.1). */
  dailyCostUsd: DailyCost[];
  /** Monthly cost history (Period_Report), up to the most recent 13 months (12 closed months plus
   * the current in-progress month, month-to-date) — sorted in ASCENDING time order (oldest month
   * first) so the table/trend chart reads in natural order. Empty if cost-collector hasn't been
   * running long enough yet to accumulate history (first-ever run). */
  monthlyHistory: MonthlyCostSummary[];
  /** Month-to-date cost allocated to each business unit (SALE/MKT/HR/SERVICE), with `SHARED`
   * infrastructure cost redistributed proportionally — see `CostAllocationSummary`. `undefined`
   * only for a cache written before this field existed (older `cost-collector` deploy) — the UI
   * must treat that the same as "not available yet", not as "$0 for every department". */
  departmentAllocation?: CostAllocationSummary;
}

export type ExportableTab = 'infra' | 'compliance' | 'cost';

// ---- Scheduled Actions (EventBridge Scheduler one-time + EventBridge Rule recurring) ----

export interface RecurringRule {
  name: string;
  scheduleExpression: string;
  state: 'ENABLED' | 'DISABLED';
  targetFunctionName: string;
  description?: string;
}

export interface OneTimeSchedule {
  name: string;
  runAtIso: string;
  actionAfterCompletion: 'DELETE' | 'NONE';
  targetFunctionName: string;
  rds?: { instanceIdentifier: string; targetClass: string };
  ec2?: { instanceId: string; targetType: string };
}

export interface ScheduledActionsResponse {
  recurringRules: RecurringRule[];
  oneTimeSchedules: OneTimeSchedule[];
}

export interface CreateScheduleRequest {
  runAtIso: string;
  rds?: { instanceIdentifier: string; targetClass?: string; availabilityZone?: string };
  ec2?: { instanceId: string; targetType: string };
}

// ---- Assessment / Recommendation (Group A) ----

export type RiskLevel = 'low' | 'medium' | 'high';

export type RecommendationPriority = 'low' | 'medium' | 'high';

export type ServiceCategory =
  | 'compute'
  | 'database'
  | 'networking'
  | 'storage'
  | 'serverless'
  | 'savingsPlans'
  | 'backup';

/**
 * A STABLE identifier for EACH rule that produces a `RecommendationItem` in
 * `infra-review-collector.ts`/`lib/recommendations.ts` — used to look up the CORRECT
 * runbook/playbook (`costRunbookCatalog.ts`) and the CORRECT corresponding `ActionType` (if a
 * safe automation exists), rather than inferring via `category`+`resourceType` (not enough to
 * distinguish cases — e.g. one `ebs-volume` can have TWO separate findings:
 * `ebsVolumeUnattached` AND `ebsVolumeGp2ShouldBeGp3` — two completely different automations).
 */
export type RecommendationFindingType =
  | 'ec2LowCpu'
  | 'ec2Stopped'
  | 'rdsLowCpu'
  | 'rdsLowConnections'
  | 'rdsMissingMultiAz'
  | 'natGatewayLowThroughput'
  | 'albAllTargetsUnhealthy'
  | 'ebsVolumeUnattached'
  | 's3BucketNoLifecyclePolicy'
  | 'savingsPlanCoverageLow'
  | 'backupJobFailed'
  | 'ebsVolumeGp2ShouldBeGp3'
  | 'cloudWatchLogGroupNoRetention'
  | 'elasticIpUnused'
  | 'backupVaultNotProtected'
  | 'restoreTestingNotConfigured'
  // ec2Underprovisioned/rdsUnderprovisioned: AWS Compute Optimizer (the OFFICIAL data source,
  // using CPU P99.5 + headroom + memory — NOT a simple average like ec2LowCpu/rdsLowCpu) confirms
  // the resource is UNDERPROVISIONED — the EXACT OPPOSITE of rightsizing (downsizing). This is a
  // PURE WARNING finding with NO corresponding 1-click automation (deciding to increase size/change
  // instance type needs a human to weigh budget + workload specifics) — see
  // `matchActionCatalogForFinding` (no override for these 2 findings = manual-only by design).
  // Introduced to PREVENT the ec2LowCpu/rdsLowCpu rule (based on 30-day average CPU, which can be
  // "blind" to workloads with high bursts) from wrongly recommending a downsize for a resource that
  // is actually underprovisioned at peak load — see `infra-review-collector.ts`, the "Compute
  // Optimizer" section.
  | 'ec2Underprovisioned'
  | 'rdsUnderprovisioned'
  // rdsResourceGovernanceMissing: the RDS instance does NOT yet have the standard "resource
  // governance" configuration that prevents a single reporting/Power BI/OLAP workload from
  // consuming all CPU/RAM, starving other services/functions sharing that same database
  // (requirement: "don't let reports consume all resources and starve other functions/services").
  // Specifics per engine — see `lib/rdsResourceGovernance.ts`: SQL Server missing/wrong `max degree
  // of parallelism`/`max server memory`/`query governor cost limit`; PostgreSQL missing
  // `statement_timeout`/limits on `max_parallel_workers_per_gather`/`work_mem`. Has a corresponding
  // 1-click automation (`RDS_ApplyResourceGovernance`) — see `matchActionCatalogForFinding`.
  | 'rdsResourceGovernanceMissing';

export interface RecommendationItem {
  id: string;
  category: ServiceCategory;
  resourceType: string; // e.g. 'ec2-instance', 'rds-instance', 'ebs-volume'
  resourceId: string; // used to cross-reference the Infra tab (Requirement 13.2)
  resourceName: string;
  currentState: string;
  recommendedAction: string;
  estimatedMonthlySavingsUsd: number | null; // null = no savings estimate applies
  risk: RiskLevel;
  priority: RecommendationPriority;
  /** The specific rule that produced this finding — see `RecommendationFindingType`. Required (no
   * rule creates a `RecommendationItem` without knowing what kind of finding it is). */
  findingType: RecommendationFindingType;
  /**
   * `true` when the corresponding Resource_Action was successfully executed in the current
   * session (Requirement 8.1) — a client-side, optimistic-only supplementary field, NOT produced
   * by the collector (`infra-review-collector.ts` never sets this field). `undefined`/`false` =
   * not yet executed or not applicable.
   */
  executed?: boolean;
}

export interface LambdaSummary {
  functionName: string;
  region: string;
  memoryMb: number;
  avgDurationMs: number;
  invocationsInPeriod: number;
  threshold: ThresholdMeta;
}

export interface S3BucketSummary {
  bucketName: string;
  region: string;
  sizeByStorageClassGb: Record<string, number>;
  hasLifecyclePolicy: boolean;
  threshold: ThresholdMeta;
}

export interface EbsVolumeSummary {
  volumeId: string;
  region: string;
  volumeType: string;
  sizeGb: number;
  attached: boolean;
  threshold: ThresholdMeta;
}

export interface NatGatewaySummary {
  natGatewayId: string;
  region: string;
  avgBytesProcessedPerDay: number;
  threshold: ThresholdMeta;
}

export interface SavingsPlanCoverageByService {
  service: string;
  onDemandUsd: number;
  coveredUsd: number;
  coveragePercent: number;
}

export interface ProtectionGap {
  resourceId: string;
  resourceName: string;
  resourceType: string;
  reason: string;
}

export interface AssessmentReport {
  account: string; // '123456789012'
  region: string; // 'ap-southeast-1'
  periodStart: string; // ISO date
  periodEnd: string; // ISO date
  generatedAt: string; // ISO datetime
  compute: { lambda: LambdaSummary[] };
  database: Record<string, never>; // placeholder for additional RDS findings, reuses the existing RdsSummary from /infra
  networking: { natGateways: NatGatewaySummary[] };
  storage: { s3Buckets: S3BucketSummary[]; ebsVolumes: EbsVolumeSummary[] };
  savingsPlans: { coverageByService: SavingsPlanCoverageByService[] };
  backup: { protectionGaps: ProtectionGap[] };
  recommendations: RecommendationItem[]; // sorted by descending priority (Requirement 7.4)
}

// ---- Monitoring tab (Group A + B) ----

export type MonitoringResourceType = 'ec2' | 'rds' | 'alb' | 'ebs' | 'ecs';

export interface MetricTrendPoint {
  timestamp: string; // ISO
  value: number;
}

export interface RealtimeMetric {
  name: string; // e.g. 'CPUUtilization'
  value: number;
  unit: string;
  /** undefined = a metric that "only shows the measured value", with no universally sensible Threshold_Level. */
  threshold?: ThresholdMeta;
  trend: MetricTrendPoint[]; // Metric_Trend, most recent 15-60 minutes
  consoleLink: string; // CloudWatch_Console_Link
}

export interface MonitoringResource {
  resourceType: MonitoringResourceType;
  resourceId: string; // instanceId / dbInstanceIdentifier / albName / volumeId
  resourceName: string;
  region: string;
  metrics: RealtimeMetric[];
  /** ONLY populated when `resourceType === 'alb'` — the target group breakdown so Monitoring_Page
   * can show "which target group has the problem" (see `AlbTargetGroupHealth`). `undefined` for
   * every other resource type. */
  targetGroupHealth?: AlbTargetGroupHealth[];
}

export interface AlarmSummary {
  alarmName: string;
  state: 'OK' | 'ALARM' | 'INSUFFICIENT_DATA';
  threshold: ThresholdMeta; // inferred directly from state — see Requirement 8.3
  namespace: string;
  region: string;
  consoleLink: string;
  /** The related resourceId if inferable from the alarm's Dimensions (Requirement 9.3), else undefined. */
  relatedResourceId?: string;
  /** The alarm's underlying `MetricName` (when it's a single metric alarm, not a composite
   * alarm/metric math) — used to look up the correct legend/runbook for that metric in
   * Dashboard_UI. `undefined` for a composite alarm or one with no single clear metric. */
  metricName?: string;
  /**
   * The alarm's comparison direction — simplified from CloudWatch's real 7-value
   * `ComparisonOperator` (`GreaterThan(OrEqualTo)Threshold` → `'above'`, `LessThan(OrEqualTo)Threshold`
   * → `'below'`) — NECESSARY to distinguish two alarms on the SAME metric whose meanings are
   * COMPLETE OPPOSITES, e.g. ECS target-tracking autoscaling always has BOTH alarms for the same
   * CPUUtilization: "AlarmHigh" (CPU above target, needs scale-out — a problem that NEEDS handling)
   * and "AlarmLow" (CPU below target, autoscaling is ALREADY scaling in on its own — NORMAL
   * behavior, not an incident). Without this field, the UI cannot avoid showing the WRONG runbook
   * "CPU high, needs scale-out" for an alarm that's actually reporting LOW CPU. `undefined` when
   * `ComparisonOperator` doesn't map to one of these two simple directions (`LessThanLowerOrGreaterThan
   * UpperThreshold` — used for an anomaly-detection band, which has no single direction).
   */
  comparisonOperator?: 'above' | 'below';
}

export interface MonitoringData {
  resources: MonitoringResource[]; // contains only Online_Resource at request time
  alerts: AlarmSummary[];
  generatedAt: string;
}

export interface ThresholdHistoryEntry {
  metric: string;
  timestamp: string;
  oldValue: number;
  newValue: number;
  oldLevel: ThresholdLevel;
  newLevel: ThresholdLevel;
}

// ---- Logs viewer tab (CloudWatch Logs) ----

/** Cap on the number of log events returned in ONE page. SHARED: the backend rejects any `limit`
 * above this cap, the frontend sends exactly this value — kept in shared so the two sides can
 * never drift apart. The cap exists because a Function URL returns a buffered response capped at
 * 6 MB; 500 events × 4000 characters ≈ 2 MB, leaving a safe margin. */
export const MAX_LOG_EVENTS_PER_PAGE = 500;

export interface LogGroupSummary {
  logGroupName: string;
  /** `null` = "Never Expire". Shown so the user understands why an old log group has no data in
   * their chosen time range (the log expired, it isn't a system error). */
  retentionInDays: number | null;
  storedBytes: number;
}

export interface LogGroupsResponse {
  groups: LogGroupSummary[];
  /** `true` when the number of log groups exceeds the backend's listing cap — the UI must state
   * clearly that the list is incomplete, instead of letting the user wrongly conclude their log
   * group doesn't exist. */
  truncated: boolean;
}

export interface LogEventItem {
  /** A stable key for a list that accumulates across pages — an array index would break as soon
   * as "Load more" appends a new page. */
  eventId: string;
  /** Epoch milliseconds — kept in AWS's raw numeric form; the client formats it to local time itself. */
  timestamp: number;
  logStreamName: string;
  message: string;
}

/** Parameters identifying ONE log query. `nextToken` is deliberately NOT here: it's a per-page
 * cursor, not part of the query identity — embedding it in `queryKey` would turn every page into
 * its own separate query and break `useInfiniteQuery`'s page-accumulation mechanism. */
export interface LogEventsQuery {
  logGroupName: string;
  startTime: number;
  endTime: number;
  filterPattern?: string;
}

export interface LogEventsPage {
  events: LogEventItem[];
  /** A present `nextToken` means there IS more data, even when `events` is empty:
   * `FilterLogEvents` scans by time window rather than event count, so an empty page in the middle
   * is normal. This is the ONLY correct condition for showing the "Load more" button —
   * `events.length > 0` is the WRONG condition. */
  nextToken?: string;
  /** Number of messages truncated for exceeding the length cap — the UI states this explicitly
   * instead of silently swallowing content from the person debugging. */
  truncatedMessageCount: number;
}

// ---- Resource_Action / Action_Catalog (Group A + B) ----

export type ActionType =
  | 'EC2_Start'
  | 'EC2_Stop'
  | 'Snapshot_And_Delete_EBS_Volume'
  | 'Apply_S3_Lifecycle_Policy'
  | 'ECS_ScaleOut'
  | 'RDS_IncreaseStorage'
  | 'EBS_ModifyVolumeType'
  | 'CloudWatchLogGroup_SetRetention'
  | 'ElasticIp_Release'
  | 'EC2_Rightsize'
  | 'BackupVault_ApplyProtectionPolicy'
  | 'BackupRestoreTesting_CreatePlan'
  | 'Backup_RetryJob'
  | 'RDS_ApplyResourceGovernance'
  // EC2_AutoRightsize: NOT triggered by a user clicking a button — the `ec2-rightsize-applier.ts`
  // Lambda executes it automatically when an instance transitions to `stopped` AND has a pending
  // tag (set by the evaluator in `infra-review-collector.ts`, see `lib/ec2AutoRightsizing.ts`).
  // Still writes an Action_Audit_Record like every other Resource_Action (the original requirement:
  // every infrastructure change must be fully audited) — `executedBy` will be a fixed system value
  // (e.g. 'system:ec2-rightsize-applier'), not a user's email.
  | 'EC2_AutoRightsize'
  | 'EC2_Reboot'
  | 'RDS_Start'
  | 'RDS_Stop'
  | 'RDS_Reboot'
  | 'SecurityGroup_AuthorizeIngress'
  | 'SecurityGroup_RevokeIngress'
  | 'SSM_RunPreset'
  | 'Ec2_ChangeInstanceType'
  | 'Ec2_UpdateTags'
  | 'SecurityGroup_AuthorizeEgress'
  | 'SecurityGroup_RevokeEgress'
  | 'Ec2_ModifySecurityGroups'
  | 'SecurityGroup_Create'
  | 'SecurityGroup_Delete';

export type ReversibilityClass = 'reversible' | 'irreversible';

export interface ActionCatalogEntry {
  actionType: ActionType;
  category: ServiceCategory;
  resourceType: string;
  reversibilityClass: ReversibilityClass;
}

/** The single source of truth for Action_Catalog (Requirement 1.1) — shared by the backend (validate) + frontend (display). */
export const ACTION_CATALOG: readonly ActionCatalogEntry[] = [
  { actionType: 'Snapshot_And_Delete_EBS_Volume', category: 'storage', resourceType: 'ebs-volume', reversibilityClass: 'irreversible' },
  { actionType: 'Apply_S3_Lifecycle_Policy', category: 'storage', resourceType: 's3-bucket', reversibilityClass: 'reversible' },
  { actionType: 'EC2_Start', category: 'compute', resourceType: 'ec2-instance', reversibilityClass: 'reversible' },
  { actionType: 'EC2_Stop', category: 'compute', resourceType: 'ec2-instance', reversibilityClass: 'reversible' },
  // ECS_ScaleOut: increases a service's desiredCount — can later be decreased again (scale-in), reversible.
  { actionType: 'ECS_ScaleOut', category: 'compute', resourceType: 'ecs-service', reversibilityClass: 'reversible' },
  // RDS_IncreaseStorage: AWS does NOT allow decreasing an RDS instance's allocated storage once
  // increased ("You can't deallocate space" — RDS User Guide, "Increasing DB instance storage
  // capacity") — this is a genuinely one-way action and MUST be marked irreversible (not excess caution).
  { actionType: 'RDS_IncreaseStorage', category: 'database', resourceType: 'rds-instance', reversibilityClass: 'irreversible' },
  // EBS_ModifyVolumeType: converts gp2 -> gp3 via ec2:ModifyVolume — AWS supports converting BACK
  // gp3 -> gp2 with this same API (no data loss, online, no downtime) — genuinely reversible, not
  // excess caution.
  { actionType: 'EBS_ModifyVolumeType', category: 'storage', resourceType: 'ebs-volume', reversibilityClass: 'reversible' },
  // CloudWatchLogGroup_SetRetention: logs:PutRetentionPolicy only changes the policy governing logs
  // retained GOING FORWARD (old logs already deleted under the previous policy, if any, CANNOT be
  // recovered — but the act of SETTING this retention itself can be changed back at any time and
  // doesn't by itself cause immediate log loss) — reversible.
  { actionType: 'CloudWatchLogGroup_SetRetention', category: 'compute', resourceType: 'cloudwatch-log-group', reversibilityClass: 'reversible' },
  // ElasticIp_Release: ec2:ReleaseAddress permanently releases the IP — AWS does NOT guarantee
  // re-allocating that exact IP address (the IP pool is a globally shared resource) — genuinely one-way, irreversible.
  { actionType: 'ElasticIp_Release', category: 'networking', resourceType: 'elastic-ip', reversibilityClass: 'irreversible' },
  // EC2_Rightsize: Stop -> ec2:ModifyInstanceAttribute(InstanceType) -> Start. Can be changed BACK
  // to the previous instance type by calling this same action again with targetInstanceType = the
  // old type (no data loss — an EBS-backed instance, not a terminate/recreate) — genuinely
  // reversible, UNLIKE RDS_IncreaseStorage (AWS hard-blocks decreasing allocated storage at the API
  // level). Still causes brief downtime (the stop+start window) and a risk of failing to boot again
  // if the target type isn't compatible with the instance's current OS/architecture — which is why
  // the backend MUST verify architecture compatibility (x86_64/arm64) before executing, see
  // `ec2-rightsize-action-service.ts`.
  { actionType: 'EC2_Rightsize', category: 'compute', resourceType: 'ec2-instance', reversibilityClass: 'reversible' },
  // EC2_AutoRightsize: the same ModifyInstanceAttribute(InstanceType) mechanism as EC2_Rightsize
  // (can be changed BACK, no data loss) — differs only in TRIGGER (automatic when the instance
  // stops on schedule, not a user clicking a button) and DIRECTION (supports BOTH increasing 'up'
  // and decreasing 'down' size, see `ec2AutoRightsizing.ts`/`ec2-rightsize-applier.ts`) — genuinely
  // reversible, for the same reason as EC2_Rightsize.
  { actionType: 'EC2_AutoRightsize', category: 'compute', resourceType: 'ec2-instance', reversibilityClass: 'reversible' },
  // BackupVault_ApplyProtectionPolicy: backup:PutBackupVaultAccessPolicy ONLY adds/replaces EXACTLY
  // ONE Deny statement managed by Ops_Dashboard (its own Sid), PRESERVING every other existing
  // statement (see `buildProtectedVaultAccessPolicy` in `lib/backupVaultPolicy.ts`) — can be
  // removed again at any time via backup:DeleteBackupVaultAccessPolicy or another
  // PutBackupVaultAccessPolicy call — genuinely reversible, UNLIKE AWS Backup Vault Lock
  // (permanent, not used here — see design.md).
  { actionType: 'BackupVault_ApplyProtectionPolicy', category: 'backup', resourceType: 'backup-vault', reversibilityClass: 'reversible' },
  // BackupRestoreTesting_CreatePlan: creates one Restore Testing Plan + 2 selections (RDS, EC2)
  // following the standard configuration previously applied manually (weekly, overridden to a
  // small instance). The plan/selections can be fully deleted again
  // (backup:DeleteRestoreTestingPlan/DeleteRestoreTestingSelection) — doesn't delete/modify any
  // existing recovery point or production resource, genuinely reversible.
  { actionType: 'BackupRestoreTesting_CreatePlan', category: 'backup', resourceType: 'backup-restore-testing', reversibilityClass: 'reversible' },
  // Backup_RetryJob: backup:StartBackupJob triggers a NEW on-demand backup job for a resource
  // whose most recent backup job was FAILED/EXPIRED/ABORTED (findingType backupJobFailed) —
  // doesn't delete/modify any existing recovery point, only CREATES an additional one — reversible
  // (the new job can be cancelled/deleted independently without affecting any other recovery point).
  { actionType: 'Backup_RetryJob', category: 'backup', resourceType: 'backup-job', reversibilityClass: 'reversible' },
  // RDS_ApplyResourceGovernance: rds:ModifyDBParameterGroup ONLY changes parameter values (max
  // degree of parallelism/max server memory/query governor cost limit for SQL Server;
  // statement_timeout/max_parallel_workers_per_gather/work_mem for PostgreSQL) — can be changed
  // BACK to the old value at any time by calling ModifyDBParameterGroup again with a different
  // value, with NO data loss and NO resource deletion/recreation — genuinely reversible. Some
  // parameters have ApplyType='static' (require an instance restart to take effect, see
  // `rds-resource-governance-action-service.ts`) but that's a characteristic of HOW it's applied,
  // not a factor in the change's reversibility.
  { actionType: 'RDS_ApplyResourceGovernance', category: 'database', resourceType: 'rds-instance', reversibilityClass: 'reversible' },
  // EC2_Reboot: ec2:RebootInstances — restarts a running instance, does NOT lose disk data
  // (EBS-backed), private/public IP stays the same (unless the instance uses a dynamic public IP,
  // outside the scope of control here) — genuinely reversible (it's fundamentally a routine
  // operational action, not a one-way configuration change). Gated SEPARATELY via
  // operatorGroupIds (POST /actions/lifecycle), UNLIKE the rest of the actions in this catalog
  // (which are only gated by allowedGroupIds).
  { actionType: 'EC2_Reboot', category: 'compute', resourceType: 'ec2-instance', reversibilityClass: 'reversible' },
  // RDS_Start/RDS_Stop/RDS_Reboot: rds:StartDBInstance/StopDBInstance/RebootDBInstance — the same
  // operational nature as EC2_Start/EC2_Stop (RDS previously had NO start/stop/reboot action at
  // all in the catalog) — a Multi-AZ instance can be auto-rejected by the RDS API on Stop, so the
  // action service must re-check status at execution time (never trust preview data) — reversible.
  // Gated SEPARATELY via operatorGroupIds (POST /actions/lifecycle).
  { actionType: 'RDS_Start', category: 'database', resourceType: 'rds-instance', reversibilityClass: 'reversible' },
  { actionType: 'RDS_Stop', category: 'database', resourceType: 'rds-instance', reversibilityClass: 'reversible' },
  { actionType: 'RDS_Reboot', category: 'database', resourceType: 'rds-instance', reversibilityClass: 'reversible' },
  // SecurityGroup_AuthorizeIngress/RevokeIngress: ec2:AuthorizeSecurityGroupIngress/
  // RevokeSecurityGroupIngress — two APIs that are EXACT INVERSES of each other on the same tuple
  // (protocol, port range, CIDR): calling the other one with that exact tuple returns the SG to its
  // prior state, with no data loss and no resource creation/deletion — genuinely reversible, in the
  // same spirit as EBS_ModifyVolumeType.
  // The real risk is NOT reversibility (it can be undone in 5 seconds) but the EXPOSURE WINDOW
  // while the rule is live — handled via `securityImpactWarning` plus requiring the sg-id to be
  // typed in the Confirmation_Dialog, NOT by wrongly labeling it irreversible (which would dilute
  // the meaning of that flag across the other 18 actions).
  // Gated SEPARATELY via operatorGroupIds (POST /actions/security-group).
  // NOTE: these 2 entries SHARE (category, resourceType), so `matchActionCatalog()` always returns
  // the first entry — harmless because NO findingType has resourceType 'security-group' and NO
  // entry in FINDING_TYPE_ACTION_OVERRIDES points to them (these 2 actions are only reachable from
  // the Security Group tab). If a networking finding is added later, an explicit override MUST be declared.
  { actionType: 'SecurityGroup_AuthorizeIngress', category: 'networking', resourceType: 'security-group', reversibilityClass: 'reversible' },
  { actionType: 'SecurityGroup_RevokeIngress', category: 'networking', resourceType: 'security-group', reversibilityClass: 'reversible' },
  // SSM_RunPreset: ssm:SendCommand runs one of 5 READ-ONLY presets hard-coded in the source
  // (`ssmRunPresets.ts` — df -h / free -m / uptime / tail log / systemctl status). Doesn't change
  // any state on the host that would need undoing — reversible in the strongest sense (a no-op in
  // terms of change). Still writes a full Action_Audit_Record like every other Resource_Action:
  // "who read what on which machine" is operational information that needs to be traceable, no
  // less than "who changed what".
  // Gated SEPARATELY via operatorGroupIds (POST /actions/run-command).
  // NOTE: this entry SHARES (category, resourceType) with EC2_Start/EC2_Stop/EC2_Rightsize/
  // EC2_AutoRightsize/EC2_Reboot, so `matchActionCatalog()` always returns EC2_Start (the first
  // entry) for the pair ('compute','ec2-instance') — harmless because SSM_RunPreset is only
  // reachable from its own "Run command" tab, NO findingType points to it and there's no entry
  // for it in FINDING_TYPE_ACTION_OVERRIDES either. If a future finding needs to recommend running
  // a preset, an explicit override MUST be declared.
  { actionType: 'SSM_RunPreset', category: 'compute', resourceType: 'ec2-instance', reversibilityClass: 'reversible' },
  // Ec2_ChangeInstanceType: ec2:ModifyInstanceAttribute(InstanceType) on an instance CURRENTLY
  // 'stopped' (unlike EC2_Rightsize, where the instance may be running and the backend stops it
  // first). Can be changed back by calling this action again with the old type — genuinely
  // reversible, for the same reason as EC2_Rightsize.
  { actionType: 'Ec2_ChangeInstanceType', category: 'compute', resourceType: 'ec2-instance', reversibilityClass: 'reversible' },
  // Ec2_UpdateTags: ec2:CreateTags/DeleteTags — the old tags can always be restored with another
  // update call, no resource data loss — reversible.
  { actionType: 'Ec2_UpdateTags', category: 'compute', resourceType: 'ec2-instance', reversibilityClass: 'reversible' },
  // SecurityGroup_AuthorizeEgress/RevokeEgress: the same exact-inverse nature as the existing
  // Ingress pair — genuinely reversible, for the same reason given in the SecurityGroup_AuthorizeIngress comment above.
  { actionType: 'SecurityGroup_AuthorizeEgress', category: 'networking', resourceType: 'security-group', reversibilityClass: 'reversible' },
  { actionType: 'SecurityGroup_RevokeEgress', category: 'networking', resourceType: 'security-group', reversibilityClass: 'reversible' },
  // Ec2_ModifySecurityGroups: ec2:ModifyInstanceAttribute(Groups) — a full-replacement-list, can be
  // changed back by calling it again with the old list — reversible. The real risk is the EXPOSURE
  // WINDOW if the wrong SG (one blocking traffic) is accidentally removed — handled via a
  // ConfirmationDialog showing the +N/-M diff, not by wrongly labeling it irreversible.
  { actionType: 'Ec2_ModifySecurityGroups', category: 'networking', resourceType: 'ec2-instance', reversibilityClass: 'reversible' },
  // SecurityGroup_Create: ec2:CreateSecurityGroup — creates a new one, can be deleted right back
  // via SecurityGroup_Delete (as long as no instance has it attached) — reversible.
  { actionType: 'SecurityGroup_Create', category: 'networking', resourceType: 'security-group', reversibilityClass: 'reversible' },
  // SecurityGroup_Delete: ec2:DeleteSecurityGroup — genuinely ONE-WAY (the configured rules are
  // permanently lost, there's no API to restore the same id) — irreversible. Blocked by a
  // pre-flight check (can't delete an SG attached to any instance), but the action itself is still
  // one-way whenever it actually executes.
  { actionType: 'SecurityGroup_Delete', category: 'networking', resourceType: 'security-group', reversibilityClass: 'irreversible' },
] as const;

/**
 * The 4 resource-lifecycle Action_Types — the ONLY permitted entry point is `POST /actions/lifecycle`
 * (gated SEPARATELY via `operatorGroupIds`, see `handlers/actions-lifecycle.ts`). `POST /actions/execute`
 * MUST reject these types (it only gates via `allowedGroupIds` — the general login gate — so
 * accepting them there would be equivalent to dropping the operator gate entirely), and
 * `GET /actions/preview` MUST require operator status to preview them (preview returns the AWS API
 * call/ARN/params up front — reconnaissance for that very bypass).
 *
 * Declared HERE (shared, used by both backend/frontend) instead of duplicated per handler so the 3
 * checkpoints CANNOT drift out of sync when a new lifecycle action is added.
 */
export const LIFECYCLE_ACTION_TYPES: readonly ActionType[] = ['EC2_Reboot', 'RDS_Reboot', 'RDS_Start', 'RDS_Stop'];

/** `true` when `actionType` (the raw, not-yet-validated string from the request) is a resource-lifecycle action. */
export function isLifecycleActionType(actionType: string): boolean {
  return LIFECYCLE_ACTION_TYPES.includes(actionType as ActionType);
}

/**
 * The 2 Security Group administration Action_Types — the ONLY permitted entry point is
 * `POST /actions/security-group` (gated SEPARATELY via `operatorGroupIds`, see
 * `handlers/actions-security-group.ts`). Same reasoning as `LIFECYCLE_ACTION_TYPES`: this is a
 * genuine infrastructure-mutating action, the general login gate isn't enough.
 */
export const SECURITY_GROUP_ACTION_TYPES: readonly ActionType[] = [
  'SecurityGroup_AuthorizeIngress',
  'SecurityGroup_RevokeIngress',
  'SecurityGroup_AuthorizeEgress',
  'SecurityGroup_RevokeEgress',
  'Ec2_ModifySecurityGroups',
  'SecurityGroup_Create',
  'SecurityGroup_Delete',
];

/** `true` when `actionType` (the raw, not-yet-validated string from the request) is a Security Group action. */
export function isSecurityGroupActionType(actionType: string): boolean {
  return SECURITY_GROUP_ACTION_TYPES.includes(actionType as ActionType);
}

/**
 * The 2 Action_Types managing EC2 instance type + tags — the ONLY permitted entry point is
 * `POST /actions/ec2-management` (gated SEPARATELY via `operatorGroupIds`, see
 * `handlers/actions-ec2-management.ts`). Same reasoning as the other operator-only action families.
 */
export const EC2_MANAGEMENT_ACTION_TYPES: readonly ActionType[] = [
  'Ec2_ChangeInstanceType',
  'Ec2_UpdateTags',
];

/** `true` when `actionType` (the raw, not-yet-validated string from the request) is an EC2 Management action. */
export function isEc2ManagementActionType(actionType: string): boolean {
  return EC2_MANAGEMENT_ACTION_TYPES.includes(actionType as ActionType);
}

/**
 * The 1 Action_Type that runs a diagnostic command via SSM Run Command — the ONLY permitted entry
 * point is `POST /actions/run-command` (gated SEPARATELY via `operatorGroupIds`, see
 * `handlers/actions-run-command.ts`). Same reasoning as the two families above: even though all 5
 * presets are READ-ONLY, their output (system logs, disk configuration) is sensitive operational
 * data — the general login gate isn't enough.
 */
export const SSM_RUN_COMMAND_ACTION_TYPES: readonly ActionType[] = ['SSM_RunPreset'];

/** `true` when `actionType` (the raw, not-yet-validated string from the request) is an SSM Run Command action. */
export function isSsmRunCommandActionType(actionType: string): boolean {
  return SSM_RUN_COMMAND_ACTION_TYPES.includes(actionType as ActionType);
}

/**
 * The union of `LIFECYCLE_ACTION_TYPES`, `SECURITY_GROUP_ACTION_TYPES`, `EC2_MANAGEMENT_ACTION_TYPES`
 * and `SSM_RUN_COMMAND_ACTION_TYPES` — the set of actionTypes that REQUIRE operator permission.
 * `POST /actions/execute` MUST reject this entire set (it only gates on login), and
 * `GET /actions/preview` MUST require operator status to preview them.
 *
 * Exists so that adding a new operator-only action FAMILY doesn't require editing 3 separate
 * places correctly — just add it here, and all 3 checkpoints stay in sync automatically.
 */
export function isOperatorOnlyActionType(actionType: string): boolean {
  return (
    isLifecycleActionType(actionType) ||
    isSecurityGroupActionType(actionType) ||
    isSsmRunCommandActionType(actionType) ||
    isEc2ManagementActionType(actionType)
  );
}

export interface ActionPreview {
  actionType: ActionType;
  awsApiCall: string; // e.g. 'ec2:CreateSnapshot + ec2:DeleteVolume', or 'StateManager: POST /actions (action=start)'
  resource: { id: string; arn: string; region: string };
  params: Record<string, string | number>;
  reversibilityClass: ReversibilityClass;
  costImpactWarning?: string; // undefined = no warning (Requirement 17.4/17.5)
  /** Set ONLY when the action INCREASES exposure (opening an ingress rule for a broad source
   * range) — `SecurityGroup_RevokeIngress` never has one. When this field is present, the
   * Confirmation_Dialog REQUIRES the user to type the exact resource id before the confirm button
   * enables (the same mechanism as an irreversible action), and renders it ABOVE
   * `costImpactWarning` with a danger tone — so the generic cost warning (which applies to nearly
   * every action) doesn't dilute this specific security warning. */
  securityImpactWarning?: string;
}

export interface ActionExecutionRequest {
  actionType: ActionType;
  resourceId: string;
  region: string;
  params: Record<string, string | number>;
  /** The executor's identity from the authenticated JWT claim (Requirement 6.1) — attached by the router before InvokeFunction. */
  executedBy: string;
  /** Correlation id generated by the router for the inbound HTTP request that triggered this
   * execution (see backend/src/lib/correlationId.ts) — propagated so action-execution-fn's own
   * CloudWatch log lines and the resulting Action_Audit_Record can be traced back to the exact
   * request that caused them. Optional: callers other than the router (none currently exist,
   * but nothing structurally prevents one) are not required to supply it. */
  correlationId?: string;
  /** Set ONLY when this execution follows the maker-checker approval workflow (`POST
   * /actions/execute-approval`, see `approval.ts`) — the id of the `Approval_Request` that
   * authorized this execution. Carried through so the resulting `Action_Audit_Record` links back
   * to exactly which approval authorized it (Requirement: approval audit trail). Absent for the
   * ordinary direct-execute path (`POST /actions/execute`), which has no approval step. */
  approvalId?: string;
  /** Set together with `approvalId` — the identity of whoever ORIGINALLY requested the action
   * (`ApprovalRequest.requestedBy`), which is generally NOT the same person as `executedBy` (the
   * approver or the original requester may click Execute once approved — see `approval.ts`'s
   * header comment). Kept as a separate field rather than overloading `executedBy`, so the audit
   * record can show both "who asked for this" and "who actually pulled the trigger". */
  requestedBy?: string;
}

export type ActionOutcome = 'success' | 'failure' | 'rejected' | 'partial';

export interface ActionExecutionResult {
  outcome: ActionOutcome;
  reason?: string; // required when outcome != 'success'
  /** Snapshot_And_Delete_EBS_Volume: the id of the snapshot created (Requirement 4.7), can be present even when outcome='failure' (4.6). */
  createdSnapshotId?: string;
  /** EC2_Start/EC2_Stop: the TRANSITIONAL state returned by StateManager (e.g. 'pending'/
   * 'stopping' — NOT the final converged state, see "StateManager — Confirmation Contract"),
   * used as an optimistic hint for the UI while waiting for useMonitoring()/useInfra() to refetch
   * and confirm the real state (Requirement 9.3/8.3/8.4). */
  newState?: string;
  /** ECS_ScaleOut: the NEW desiredCount applied to the service (after UpdateService) — the task
   * needs time to reach the corresponding runningCount, this is only the desired value confirmed as successfully set. */
  newDesiredCount?: number;
  /** RDS_IncreaseStorage: the NEW allocatedStorage (GiB) applied to the DB instance (after
   * ModifyDBInstance) — RDS needs time to finish the storage change (a 'storage-optimization'
   * status), this value only confirms the API call succeeded, not that convergence is complete. */
  newAllocatedStorageGb?: number;
  /** EBS_ModifyVolumeType: the NEW volumeType applied (always 'gp3') — the volume needs time to
   * finish converting (a 'modifying' status), this value only confirms the API call succeeded. */
  newVolumeType?: string;
  /** CloudWatchLogGroup_SetRetention: the NEW retention day count applied to the log group. */
  newRetentionDays?: number;
  /** ElasticIp_Release: the IP address released — display-only for confirmation, this IP no
   * longer belongs to the account once execution succeeds. */
  releasedPublicIp?: string;
  /** EC2_Rightsize: the NEW InstanceType applied to the instance (after ModifyInstanceAttribute) —
   * can appear even when `outcome === 'failure'` if the type-change step succeeded but the
   * subsequent restart step failed/timed out (see `ec2-rightsize-action-service.ts`). */
  newInstanceType?: string;
  /** BackupVault_ApplyProtectionPolicy: the name of the vault the protective access policy was successfully applied to. */
  protectedVaultName?: string;
  /** BackupRestoreTesting_CreatePlan: the name of the plan created (or already existing, treated
   * as success — idempotent, see `backup-restore-testing-action-service.ts`) plus the list of
   * selection names successfully created/confirmed to exist during this execution (may be a
   * subset of the 2 expected selections if one step failed — `outcome` reflects this accurately:
   * only 'success' when ALL 3 steps succeeded or already existed). */
  restoreTestingPlanName?: string;
  createdRestoreTestingSelectionNames?: string[];
  /** Backup_RetryJob: the id of the new on-demand backup job just triggered
   * (backup:StartBackupJob) — the job is still RUNNING when this result is returned
   * (StartBackupJob is async, it doesn't wait for the job to finish), this only confirms the
   * request was submitted successfully. */
  newBackupJobId?: string;
  /** RDS_ApplyResourceGovernance: the names of the parameters successfully applied (e.g. ['max
   * degree of parallelism', 'max server memory (mb)', 'query governor cost limit'] for SQL
   * Server) — used to show the user a confirmation, NOT the full contents of the DB Parameter Group. */
  appliedParameterNames?: string[];
  /** RDS_ApplyResourceGovernance: `true` when AT LEAST 1 applied parameter has `ApplyType:
   * 'static'` (requiring a DB instance restart to actually take effect — SQL Server's `max degree
   * of parallelism`/`max server memory` are 'dynamic' but so is `query governor cost limit`;
   * PostgreSQL's `work_mem`/`statement_timeout` are 'dynamic' but other PostgreSQL parameters can
   * be 'static' depending on engine version) — shows the user a clear warning instead of letting
   * them believe the change took effect immediately when a reboot is actually required. */
  requiresReboot?: boolean;
  /** SecurityGroup_AuthorizeIngress/RevokeIngress: a description of the rule applied, e.g.
   * "OPENED tcp 22 (SSH) for 10.0.0.0/16" — shows the operator exactly what just changed, instead
   * of just "success". */
  appliedSecurityGroupRule?: string;
  /** SSM_RunPreset: the `CommandId` returned by `ssm:SendCommand`. The command has ONLY been
   * SENT, it has NOT finished running yet (SendCommand is async) — the frontend uses this id to
   * poll `GET /actions/run-command/{commandId}/status`. Only present when `outcome === 'success'`. */
  commandId?: string;
  /** Ec2_UpdateTags: the FULL new tag set after applying (set) — only present when outcome is 'success'/'partial'. */
  newTags?: Record<string, string>;
  /** Ec2_UpdateTags outcome='partial': the names of the keys that CreateTags FAILED to apply
   * (DeleteTags succeeded for the keys in `remove`, but 1+ key in `set` was rejected by AWS). */
  partialTagFailures?: string[];
  /** Ec2_ModifySecurityGroups: the FULL list of SG ids applied after the replacement. */
  newSecurityGroupIds?: string[];
  /** SecurityGroup_Create: the id of the newly created SG — used to build the real audit ARN
   * (the resourceId doesn't exist yet at request time, see action-execution-handler.ts buildResourceArn()). */
  createdSecurityGroupId?: string;
}

// ---- Security Group management (sub-project #3) ----

export interface SecurityGroupRuleView {
  /** AWS's `SecurityGroupRuleId` — used ONLY as a stable React key. NOT used to remove a rule: the
   * removal flow goes by the (protocol, port range, CIDR) tuple via RevokeSecurityGroupIngress. */
  ruleId?: string;
  /** AWS's raw string: 'tcp' | 'udp' | 'icmp' | 'icmpv6' | '-1' (all protocols). Kept as-is rather
   * than coerced to a narrow union — a real SG can absolutely contain a protocol outside the 3
   * operable values, and the table still has to display them correctly. */
  protocol: string;
  fromPort: number | null;
  toPort: number | null;
  /** Only present for an IPv4-CIDR-form source rule — this is also exactly the `removable` condition. */
  cidrIp?: string;
  /** Display label for the source (CIDR, '::/0', 'sg-0abc', 'pl-0123'). */
  sourceLabel: string;
  /** `false` for IPv6 / SG reference / prefix list / protocol '-1' — outside sub-project #3's
   * scope. The UI displays that row NORMALLY but disables the "Remove" button with an
   * explanation, instead of hiding the rule and making the user think the Security Group doesn't have it. */
  removable: boolean;
  description?: string;
}

export interface SecurityGroupSummary {
  groupId: string;
  groupName: string;
  vpcId: string;
  description: string;
  ingressRules: SecurityGroupRuleView[];
  egressRules: SecurityGroupRuleView[];
}

export interface SecurityGroupsResponse {
  groups: SecurityGroupSummary[];
  /** `true` when the list was truncated at the safety ceiling — the UI reports this explicitly instead of silently hiding SGs. */
  truncated: boolean;
}

export interface ActionAuditRecord {
  executedBy: string;
  executedAt: string; // ISO datetime
  actionType: ActionType;
  resource: { id: string; arn: string; region: string };
  params: Record<string, string | number>;
  outcome: ActionOutcome;
  reason?: string;
  /** Same correlation id carried on the originating ActionExecutionRequest — lets an operator
   * trace an audit record back to the exact router request (and its CloudWatch log lines) that
   * produced it. Optional for backward compatibility with records written before this field
   * existed. */
  correlationId?: string;
  /** Set ONLY when this execution went through the maker-checker approval workflow — the id of
   * the `Approval_Request` that authorized it (see `ActionExecutionRequest.approvalId`). Lets
   * `GET /actions/audit` show "approved by X, requested by Y, executed by Z" for a high-risk
   * action instead of just "executed by Z", which alone would look identical to a routine
   * single-person action. Absent for actions that never required approval. */
  approvalId?: string;
  /** The identity that originally requested the action, when it went through approval — see
   * `ActionExecutionRequest.requestedBy`. */
  requestedBy?: string;
}

/**
 * Pure Action_Catalog operations (matching/lookup/cost warning) — kept in a separate
 * `action-catalog.ts` file so the backend and frontend both import the exact same logic
 * (Requirement 1.2-1.6, 2.1-2.2, 17.4-17.5).
 */
export {
  matchActionCatalog,
  matchActionCatalogForFinding,
  chooseEc2Action,
  getReversibilityClass,
  getCostImpactWarning,
  rdsLifecycleActionsForStatus,
  type RdsLifecycleActions,
} from './action-catalog.js';

/**
 * Validate/describe a Security Group ingress rule — pure functions kept in a separate file so the
 * frontend (enabling/disabling buttons, inline error messages) and backend (enforcement) run
 * exactly ONE version of the rule, with no two hand-written copies drifting apart.
 */
export {
  parseSecurityGroupIngressRule,
  buildSecurityImpactWarning,
  describeSecurityGroupRule,
  securityGroupHasIngressRule,
  wellKnownPortLabel,
  formatPortRange,
  cidrPrefixLength,
  SENSITIVE_PORTS,
  type SecurityGroupProtocol,
  type SecurityGroupIngressRule,
  type SecurityGroupRuleParseResult,
  type IngressPermissionLike,
} from './securityGroupRule.js';

/**
 * Validate/describe a Security Group egress rule — mirrors the ingress structure exactly,
 * DIFFERING only in the security-warning semantics (broad egress = data-exfiltration risk).
 */
export {
  parseSecurityGroupEgressRule,
  securityGroupHasEgressRule,
  describeSecurityGroupEgressRule,
  buildEgressSecurityImpactWarning,
  type SecurityGroupEgressRule,
  type EgressPermissionLike,
} from './securityGroupEgressRule.js';

/**
 * SSM Run Command presets — kept in `shared` so the frontend dropdown and backend whitelist read
 * from the EXACT SAME source of constants. The frontend only displays them; the backend is where
 * enforcement happens (mapping `presetId` → command).
 */
export {
  SSM_RUN_PRESETS,
  findSsmRunPreset,
  getPresetVariant,
  TERMINAL_RUN_COMMAND_STATUSES,
  SSM_RUN_COMMAND_TIMEOUT_SECONDS,
  SSM_RUN_COMMAND_MAX_OUTPUT_CHARS,
  SSM_RUN_COMMAND_POLL_TIMEOUT_MS,
  type SsmRunPreset,
  type SsmRunCommandVariant,
  type RunCommandInvocationStatus,
  type RunCommandStatus,
} from './ssmRunPresets.js';

/**
 * Operational runbooks (symptom/diagnosis/remediation/rollback/escalation) for every Assessment
 * finding and a set of well-known CloudWatch metrics — see `runbookCatalog.ts` for the full
 * rationale on why this is kept separate from `action-catalog.ts`.
 */
export {
  RUNBOOK_BY_FINDING,
  RUNBOOK_BY_METRIC,
  getRunbookForFinding,
  getRunbookForMetric,
  type RunbookEntry,
  type RunbookSeverity,
} from './runbookCatalog.js';

/**
 * Maker-checker (two-person) approval workflow for high-risk actions — see `approval.ts` for the
 * full rationale on which actions require it and why it is a separate mode from the existing
 * single-person `ConfirmationDialog` flow and the AI Ops Agent's own unattended safety layers.
 */
export {
  APPROVAL_VALID_FOR_MS,
  isApprovalRequiredActionType,
  canDecideApproval,
  isApprovalStillValid,
  type ApprovalRequest,
  type ApprovalStatus,
} from './approval.js';

/**
 * Idle-to-Zero: tag-driven automatic stop/wake for non-production ALB+EC2+RDS resource-groups —
 * see `idleScheduler.ts` for the full rationale (which resources are eligible, why, and the
 * tagging convention that replaces the retired standalone `infra/stg-idle-scheduler.yaml` stack).
 */
export {
  IDLE_SCHEDULER_MANAGED_TAG_KEY,
  IDLE_SCHEDULER_EC2_INSTANCE_ID_TAG_KEY,
  IDLE_SCHEDULER_RDS_INSTANCE_ID_TAG_KEY,
  IDLE_SCHEDULER_IDLE_MINUTES_TAG_KEY,
  IDLE_SCHEDULER_HOLD_TAG_KEY,
  DEFAULT_IDLE_MINUTES,
  DEFAULT_GRACE_MINUTES,
  WAKE_DEBOUNCE_DATAPOINTS,
  IDLE_SCHEDULER_EC2_INSTANCE_ID_PATTERN,
  IDLE_SCHEDULER_RDS_INSTANCE_IDENTIFIER_PATTERN,
  type IdleSchedulerGroup,
  type IdleSchedulerResponse,
  type CreateIdleSchedulerGroupRequest,
} from './idleScheduler.js';

/**
 * RDS Nightly Schedule: tag-driven fixed stop/start schedule for an RDS instance, independent of
 * ALB traffic — see `rdsNightlyScheduler.ts` for the full rationale.
 */
export { RDS_NIGHTLY_SCHEDULER_MANAGED_TAG_KEY } from './rdsNightlyScheduler.js';

// ---- Infra Map (topology) ----

/**
 * The topology contract deliberately carries STRUCTURE ONLY — where things are — and no health.
 *
 * Health is joined CLIENT-SIDE from `/infra` and `/monitoring`, which the dashboard already fetches
 * and already caches. Two reasons this is better than embedding a `ThresholdMeta` here:
 *
 *   1. `lib/monitoringThresholds.ts` is the single source of truth for what counts as warn/critical.
 *      Computing health again in a topology collector would create a second implementation that can
 *      drift, and the SwapUsage and FreeableMemory incidents in this project both came from exactly
 *      that kind of duplicated judgement.
 *   2. Structure changes rarely (a subnet is created once); health changes every few minutes. Binding
 *      them into one payload would force the slow-changing part to be refetched at the speed of the
 *      fast-changing part.
 *
 * So the map renders boxes from this data and colours them from data it already has.
 */
/**
 * `s3` and `tgw` are ACCOUNT-LEVEL resources — they do not live inside a subnet the way the other five
 * kinds do (an S3 bucket has no VPC of its own at all; a Transit Gateway spans several VPCs by design,
 * so pinning it to one would misrepresent it). Both are drawn OUTSIDE every VPC box, in the same "region
 * canvas" a VPC itself sits on — see `TopologyData.accountResources`.
 *
 * The two are collected very differently, and that difference is deliberate rather than an
 * inconsistency:
 *
 *   `tgw`  gets a real edge (`attached-to`, below) because `DescribeTransitGatewayVpcAttachments`
 *          reports one row per (transit gateway, VPC) pair it is ACTUALLY attached to — the exact
 *          same shape of evidence `balances-to`/`egress-via` already require.
 *
 *   `s3`   gets NO edge at all. AWS has no API that reports "this VPC's traffic goes to THIS bucket" —
 *          a VPC Gateway Endpoint's route table entry targets the S3 prefix list for the whole
 *          region, not any one bucket, so there is no way to draw a `vpc -> bucket` line without
 *          guessing which of possibly dozens of buckets it means. Rather than invent that
 *          relationship, buckets are still listed on the map (an operator asking "what does this
 *          account own" should be able to see them) but as bare boxes with no connections, exactly as
 *          honest as the evidence available.
 */
export type TopologyResourceKind = 'ec2' | 'rds' | 'alb' | 'nlb' | 'ecs' | 'natgw' | 's3' | 'tgw';

export interface TopologyResource {
  /** Stable identity, also the React key. Matches the id used by /infra and /monitoring so the two
   * can be joined without any name-massaging: instanceId / dbInstanceIdentifier / load balancer name
   * / `<cluster>/<service>` / natGatewayId. */
  id: string;
  kind: TopologyResourceKind;
  name: string;
  /** Raw AWS state string (`running`, `available`, `active`...). Shown as-is; NOT a health verdict. */
  state: string;
  /** One-line detail for the card, e.g. instance type or DB engine. */
  detail?: string;
  vpcId?: string;
  /**
   * Every subnet the resource occupies. Single-subnet things (EC2, NAT) have exactly one; an ALB or
   * an awsvpc ECS service genuinely spans several, and the map draws those spanning the AZs they
   * really cover rather than pinning them to one arbitrarily.
   */
  subnetIds: string[];
  availabilityZone?: string;
  /** Set when this resource has a counterpart in /monitoring, so the map can navigate into the
   * existing ResourceDetailPage. `undefined` for kinds with no monitoring coverage (e.g. natgw). */
  monitoringType?: MonitoringResourceType;
}

/**
 * A subnet's ROLE in the architecture, derived from its route table — not from its name.
 *
 *   public    default route to an internet gateway. The edge tier: anything here is reachable from,
 *             and can reach, the internet directly.
 *   private   no route to an internet gateway, but a default route through a NAT gateway. The
 *             application tier: outbound internet works, inbound from the internet does not.
 *   isolated  no default route out at all. The data tier: reachable only from inside the VPC. This is
 *             where databases belong, and a database found OUTSIDE it is worth noticing.
 *
 * This is the standard three-tier VPC pattern, and stating the tier explicitly is what turns a picture
 * of boxes into a diagram that shows intent. Derived, never guessed: a subnet named "private" that
 * actually routes to an internet gateway is reported as `public`, because that is what it is.
 */
export type SubnetTier = 'public' | 'private' | 'isolated';

export interface TopologySubnet {
  subnetId: string;
  name: string;
  cidrBlock: string;
  availabilityZone: string;
  tier: SubnetTier;
  /**
   * What this subnet's default route actually points at, when that target is something the map can
   * draw. Gives the egress path a real endpoint instead of an arrow into empty space.
   *
   * NOT NAT-GATEWAY-SPECIFIC, and that is the point. A managed NAT gateway appears in a route table as
   * `NatGatewayId`, but an EC2 NAT instance — the cheaper option, and what `abc-uat-vpc` is moving to —
   * appears as `InstanceId` + `NetworkInterfaceId` with no `NatGatewayId` at all. An earlier version of
   * this field only looked for `NatGatewayId`, so every subnet behind an EC2 NAT would have been
   * classified `isolated`: the map would have claimed those subnets have no way out while they were
   * happily reaching the internet.
   *
   * `kind` exists so the label can name the thing correctly rather than calling an instance a gateway.
   */
  egressVia?: { id: string; kind: 'natgw' | 'instance' };
  /**
   * The Transit Gateway this subnet ACTIVELY routes to, from its own route table — scanned across
   * EVERY route, not only the default `0.0.0.0/0` one, because a TGW attachment is most often used
   * for a specific CIDR (another VPC's range, an on-prem block) rather than as the subnet's overall
   * default egress; checking only the default route would miss the large majority of real Transit
   * Gateway usage the same way `egressTarget` deliberately does NOT (that field IS about the default
   * route, on purpose — see its own doc comment).
   *
   * Independent of `tier`/`egressVia`: unlike `egressVia`, this is not restricted to the private
   * tier. A public subnet can carry both its own internet-gateway default route AND a specific route
   * to an on-prem range via a Transit Gateway at the same time, so this field is populated whenever
   * the evidence exists, regardless of tier.
   *
   * Lets the Infra Map draw a Transit Gateway's `attached-to` edge onto the SPECIFIC tier that
   * actually uses it instead of landing on the VPC as a whole — see `TopologyEdge`'s `attached-to`
   * doc comment for why `DescribeTransitGatewayVpcAttachments` alone only proves "this TGW COULD
   * reach this VPC", not "this is where the traffic actually goes".
   */
  tgwId?: string;
  /**
   * Derived from the ROUTE TABLE, never from the subnet's name: a subnet is public when the route
   * table associated with it (its explicit association, or the VPC's main route table when it has
   * none) carries a default route to an internet gateway.
   *
   * This matters because "public"/"private" in a subnet Name tag is a convention people get wrong,
   * and a map that draws a subnet as private when it actually routes to the internet would be
   * actively misleading about the security posture.
   */
  isPublic: boolean;
  availableIpCount: number;
}

export interface TopologyVpc {
  vpcId: string;
  name: string;
  cidrBlock: string;
  isDefault: boolean;
  /** Sorted by availabilityZone then subnetId, so the rendered map is stable between refreshes. */
  subnets: TopologySubnet[];
}

/**
 * One real, derived connection between two things on the map.
 *
 * Every edge comes from an AWS API answer, never from a naming convention or an assumption. A diagram
 * that invents plausible-looking arrows is worse than one with no arrows: it teaches the reader a
 * dependency graph that does not exist, and they will make decisions on it.
 *
 *   balances-to   load balancer -> the target actually registered in its target group
 *                 (DescribeTargetHealth / the ECS service's own loadBalancers block)
 *   egress-via    subnet -> the NAT gateway its default route points at (route table)
 *   ingress-from  `internet` -> a load balancer in a public subnet (scheme internet-facing)
 *   attached-to   a Transit Gateway resource id -> a VPC id, one edge per REAL, `available`
 *                 attachment (`DescribeTransitGatewayVpcAttachments`) — this is what lets a TGW be
 *                 drawn as a bridge between the specific VPCs it actually connects, rather than a
 *                 free-floating box the reader has to take on faith. `DescribeTransitGatewayVpcAttachments`
 *                 only proves the attachment EXISTS, not which part of the VPC uses it — when a
 *                 subnet's own route table corroborates it (`TopologySubnet.tgwId`), the Infra Map's
 *                 diagram layer re-anchors this same edge onto that specific tier instead of the VPC
 *                 as a whole. This type is unchanged either way; the refinement is purely where the
 *                 line lands on screen, not a new kind of edge or a new claim about connectivity.
 *
 * NOTE ON S3: there is deliberately no `vpc -> bucket` edge kind. A VPC Gateway Endpoint's route
 * targets the S3 prefix list for the whole region, not any one bucket, so no AWS API says which
 * bucket a VPC's traffic actually reaches — drawing one would be exactly the invented dependency
 * this type's own doc comment warns against. S3 buckets are still listed on the map (see
 * `TopologyResourceKind`'s `s3` case) — just with no edges, which is the honest amount of connection
 * the evidence supports.
 */
export interface TopologyEdge {
  from: string;
  to: string;
  kind: 'balances-to' | 'egress-via' | 'ingress-from' | 'attached-to';
}

/** The synthetic node id used as the source of internet ingress, so the edge has somewhere to start. */
export const INTERNET_NODE_ID = 'internet';

export interface TopologyData {
  region: string;
  /**
   * 12-digit AWS account id the topology was collected from (`AWS_ACCOUNT_ID`, same value `config.ts`
   * already reads from the CloudFormation pseudo-param — not a new source of truth, just carried onto
   * this payload too). Optional so an S3 cache written by a collector deployed BEFORE this field existed
   * still deserialises: the frontend must render the account frame without an id label rather than
   * throw on an old cached object the moment this ships.
   *
   * Used only to LABEL the outer "account" frame on the Infra Map — this dashboard has always operated
   * on one account and one region (see `AppConfig.awsRegion`/`awsAccountId`), so this is not the start of
   * multi-account support, just naming the box that was already implicitly there.
   */
  accountId?: string;
  vpcs: TopologyVpc[];
  /** Derived connections. Empty is a valid answer and means "nothing could be established", never
   *  "there are no connections" — the map says so rather than drawing a disconnected picture. */
  edges: TopologyEdge[];
  /** Resources placed inside a subnet of one of the VPCs above. */
  resources: TopologyResource[];
  /**
   * Resources that belong to a VPC which is NOT in `vpcs`, or that report a subnet no longer
   * present. Kept rather than dropped: silently omitting a resource from an infrastructure map is
   * the same class of failure as a metric silently reporting 0 — it makes the picture look complete
   * when it is not.
   */
  unplacedResources: TopologyResource[];
  /**
   * Resources that are ACCOUNT-LEVEL by nature — `kind: 's3' | 'tgw'` — kept SEPARATE from
   * `unplacedResources` even though both end up drawn outside every VPC box, because the two mean
   * different things to an operator reading the map. `unplacedResources` is an ANOMALY signal:
   * "this EC2/RDS/ALB should have a subnet and does not, something is off". An S3 bucket or a
   * Transit Gateway having no subnet is not an anomaly at all — it is the correct, permanent shape
   * of that resource type — so folding them into the same bucket would teach the reader to shrug
   * off a real unplaced-resource warning as "oh, that's just how the map draws S3 too". Optional so
   * a `topology-cache.json` written by a collector deployed BEFORE this field existed still
   * deserialises to `undefined` rather than throwing.
   */
  accountResources?: TopologyResource[];
  generatedAt: string;
}

export {
  KPIS,
  SEVERITIES,
  FINDING_STATUSES,
  FINDING_SOURCES,
  SEVERITY_RANK,
  STATUS_RANK,
  ACCOUNT_SCOPE,
  SOURCE_IDS,
  ACKNOWLEDGE_NOTE_MAX_LENGTH,
  worstSeverity,
  isKpi,
  isSeverity,
  isFindingStatus,
} from './findings.js';
export type {
  Kpi,
  Severity,
  FindingStatus,
  FindingSource,
  FindingEvidence,
  FindingRemediation,
  FindingSuppression,
  Finding,
  FindingDraft,
  SourceId,
  SourceStatus,
  SourceHealth,
  AuditEntityType,
  AuditAction,
  AuditEvent,
  ScanRunCounts,
  VpcListItem,
  ScanRun,
  KpiSummary,
  VpcsResponse,
  VpcSummaryResponse,
  FindingsListResponse,
  AcknowledgeFindingRequest,
} from './findings.js';
