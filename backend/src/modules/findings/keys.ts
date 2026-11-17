import { SEVERITY_RANK, STATUS_RANK } from '@ops-dashboard/shared';
import type { AuditEvent, Finding, FindingStatus, Kpi, ScanRun, Severity } from '@ops-dashboard/shared';
import { FINDINGS_DEFAULTS } from './defaults.js';

/** A finding plus its optimistic-lock version (every write is conditional on it). */
export interface StoredFinding {
  finding: Finding;
  version: number;
}

export const FINDING_SK = 'META';
export const findingPk = (id: string): string => `FINDING#${id}`;
export const vpcGsiPk = (vpcId: string): string => `VPC#${vpcId}`;
export const checkGsiPk = (checkId: string): string => `CHECK#${checkId}`;
export const scanPk = (iso: string): string => `SCAN#${iso.slice(0, 10)}`;

/** GSI1SK floor: every key strictly below it is an active (non-resolved) finding. */
export const RESOLVED_GSI1SK_FLOOR = `${STATUS_RANK.resolved}#`;

export function vpcGsiSk(f: Pick<Finding, 'status' | 'severity' | 'kpi' | 'lastSeen'>): string {
  return `${STATUS_RANK[f.status]}#${SEVERITY_RANK[f.severity]}#${f.kpi}#${f.lastSeen}`;
}

export interface VpcFindingsFilter {
  status?: FindingStatus;
  severity?: Severity;
  kpi?: Kpi;
}

/** Longest GSI1SK prefix the filter pins down (key order: status, severity, kpi). */
export function vpcGsiSkPrefix(filter: VpcFindingsFilter): string | undefined {
  if (!filter.status) return undefined;
  if (!filter.severity) return `${STATUS_RANK[filter.status]}#`;
  if (!filter.kpi) return `${STATUS_RANK[filter.status]}#${SEVERITY_RANK[filter.severity]}#`;
  return `${STATUS_RANK[filter.status]}#${SEVERITY_RANK[filter.severity]}#${filter.kpi}#`;
}

export function ttlEpochSeconds(fromIso: string, days: number = FINDINGS_DEFAULTS.ttlDays): number {
  return Math.floor(Date.parse(fromIso) / 1000) + days * 86_400;
}

const STORAGE_ATTRIBUTES = ['PK', 'SK', 'GSI1PK', 'GSI1SK', 'GSI2PK', 'GSI2SK', 'entity', 'version', 'expiresAt'] as const;

function stripStorageAttributes(item: Record<string, unknown>): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...item };
  for (const key of STORAGE_ATTRIBUTES) delete rest[key];
  return rest;
}

export function toFindingItem(stored: StoredFinding): Record<string, unknown> {
  const { finding, version } = stored;
  return {
    ...finding,
    PK: findingPk(finding.id),
    SK: FINDING_SK,
    GSI1PK: vpcGsiPk(finding.vpcId),
    GSI1SK: vpcGsiSk(finding),
    GSI2PK: checkGsiPk(finding.checkId),
    GSI2SK: finding.lastSeen,
    entity: 'finding',
    version,
    ...(finding.status === 'resolved' && finding.resolvedAt ? { expiresAt: ttlEpochSeconds(finding.resolvedAt) } : {}),
  };
}

export function fromFindingItem(item: Record<string, unknown>): StoredFinding {
  const version = typeof item.version === 'number' ? item.version : 0;
  return { finding: stripStorageAttributes(item) as unknown as Finding, version };
}

export function toAuditItem(event: AuditEvent): Record<string, unknown> {
  return {
    ...event,
    PK: `AUDIT#${event.ts.slice(0, 7)}`,
    SK: `${event.ts}#${event.id}`,
    GSI1PK: `ENTITY#${event.entityType}#${event.entityId}`,
    GSI1SK: event.ts,
    entity: 'audit',
  };
}

export function toScanRunItem(run: ScanRun): Record<string, unknown> {
  return { ...run, PK: scanPk(run.startedAt), SK: run.startedAt, entity: 'scan-run', expiresAt: ttlEpochSeconds(run.startedAt) };
}

export function fromScanRunItem(item: Record<string, unknown>): ScanRun {
  return stripStorageAttributes(item) as unknown as ScanRun;
}
