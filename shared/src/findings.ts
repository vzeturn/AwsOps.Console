/**
 * VPC Ops Console - Finding model. Shared by the backend (findings-aggregator, findings-mutate, router read API) and the
 * frontend (Phase 2 VPC map / Findings page), so both sides agree on ranks and enums.
 */

export const KPIS = ['availability', 'security', 'network', 'resilience', 'compliance', 'cost'] as const;
export type Kpi = (typeof KPIS)[number];

export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const FINDING_STATUSES = ['open', 'acknowledged', 'suppressed', 'resolved'] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

export const FINDING_SOURCES = ['monitoring', 'security-group', 'guardduty', 'backup', 'network', 'cost', 'iso-check'] as const;
export type FindingSource = (typeof FINDING_SOURCES)[number];

/** Lower = worse. Embedded in GSI1SK so an ascending query returns worst-first. */
export const SEVERITY_RANK: Readonly<Record<Severity, number>> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

/** `resolved` MUST stay the highest rank: "GSI1SK < `${STATUS_RANK.resolved}#`" = every active finding. */
export const STATUS_RANK: Readonly<Record<FindingStatus, number>> = { open: 0, acknowledged: 1, suppressed: 2, resolved: 3 };

/** `vpcId` of findings that cannot be attributed to a VPC (the "Account-wide" tab). */
export const ACCOUNT_SCOPE = 'account';

export interface FindingEvidence {
  observedAt: string;
  data: Record<string, unknown>;
}

export interface FindingRemediation {
  steps: string[];
  actionType?: string;
  runbookId?: string;
}

export interface FindingSuppression {
  reason: string;
  until: string;
  by: string;
  confirmedBy?: string;
  state: 'pending' | 'active';
}

export interface Finding {
  /** sha1(source#resourceArn#checkId) - stable across scans. */
  id: string;
  checkId: string;
  source: FindingSource;
  kpi: Kpi;
  severity: Severity;
  status: FindingStatus;
  vpcId: string;
  subnetId?: string;
  az?: string;
  resourceType: string;
  resourceId: string;
  resourceName?: string;
  resourceArn: string;
  title: string;
  description: string;
  impact: string;
  evidence: FindingEvidence;
  remediation: FindingRemediation;
  isoControls: string[];
  firstSeen: string;
  lastSeen: string;
  resolvedAt?: string;
  occurrences: number;
  ticketId?: string;
  suppression?: FindingSuppression;
}

/** What a check emits; reconcile adds status/firstSeen/lastSeen/occurrences. */
export type FindingDraft = Pick<
  Finding,
  | 'id'
  | 'checkId'
  | 'source'
  | 'kpi'
  | 'severity'
  | 'vpcId'
  | 'subnetId'
  | 'az'
  | 'resourceType'
  | 'resourceId'
  | 'resourceName'
  | 'resourceArn'
  | 'title'
  | 'description'
  | 'impact'
  | 'evidence'
  | 'remediation'
  | 'isoControls'
>;

/** Data fetchers of the findings-aggregator (NOT Finding.source). */
export const SOURCE_IDS = [
  'topology',
  'alarms',
  'monitoring-metrics',
  'security-groups',
  'guardduty',
  'compliance',
  'assessment',
  'public-buckets',
  'endpoint-drift',
  'flow-logs',
  'rds',
] as const;
export type SourceId = (typeof SOURCE_IDS)[number];

export type SourceStatus = 'ok' | 'stale' | 'failed';

export interface SourceHealth {
  sourceId: SourceId;
  status: SourceStatus;
  /** When the data this run used was produced (cache generatedAt, or fetch time for live sources). */
  observedAt?: string;
  /** observedAt of the last run in which this source was `ok` - the "last good" time shown when stale. */
  lastOkAt?: string;
  reason?: string;
}

export type AuditEntityType = 'finding';
export type AuditAction = 'finding.created' | 'finding.resolved' | 'finding.reopened' | 'finding.acknowledged';

/** Append-only (spec §3.2): there is no update/delete path for audit events. */
export interface AuditEvent {
  id: string;
  ts: string;
  entityType: AuditEntityType;
  entityId: string;
  action: AuditAction;
  actor: string;
  details?: Record<string, unknown>;
}

export interface ScanRunCounts {
  created: number;
  updated: number;
  resolved: number;
  reopened: number;
  writeConflicts: number;
}

export interface VpcListItem {
  vpcId: string;
  name: string;
  cidrBlock?: string;
  isDefault: boolean;
  /** open + acknowledged (suppressed excluded). */
  activeCount: number;
  worstSeverity: Severity | null;
}

export interface ScanRun {
  runId: string;
  correlationId: string;
  startedAt: string;
  finishedAt: string;
  sources: SourceHealth[];
  counts: ScanRunCounts;
  vpcs: VpcListItem[];
}

export interface KpiSummary {
  kpi: Kpi;
  open: number;
  acknowledged: number;
  suppressed: number;
  worstSeverity: Severity | null;
  stale: boolean;
  /** Oldest "last good" time among this KPI's non-ok sources; absent when not stale. */
  staleSince?: string;
}

export interface VpcsResponse {
  vpcs: VpcListItem[];
  scannedAt: string | null;
  sources: SourceHealth[];
}

export interface VpcSummaryResponse {
  vpcId: string;
  activeCount: number;
  worstSeverity: Severity | null;
  kpis: KpiSummary[];
  scannedAt: string | null;
}

export interface FindingsListResponse {
  items: Finding[];
  truncated: boolean;
}

export const ACKNOWLEDGE_NOTE_MAX_LENGTH = 500;

export interface AcknowledgeFindingRequest {
  note?: string;
}

export function worstSeverity(severities: Iterable<Severity>): Severity | null {
  let worst: Severity | null = null;
  for (const severity of severities) {
    if (worst === null || SEVERITY_RANK[severity] < SEVERITY_RANK[worst]) worst = severity;
  }
  return worst;
}

function isMember<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (list as readonly string[]).includes(value);
}

export function isKpi(value: unknown): value is Kpi {
  return isMember(KPIS, value);
}

export function isSeverity(value: unknown): value is Severity {
  return isMember(SEVERITIES, value);
}

export function isFindingStatus(value: unknown): value is FindingStatus {
  return isMember(FINDING_STATUSES, value);
}
