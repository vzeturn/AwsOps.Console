import type { RecommendationPriority, Severity } from '@ops-dashboard/shared';

/**
 * Phase 1 single source of truth for findings tunables. Phase 4 (Settings) replaces these with a
 * versioned settings item; until then nothing else may hard-code these numbers.
 */
export const FINDINGS_DEFAULTS = {
  /** Resolved findings + scan runs (spec §3.3, covers an annual ISO audit cycle). */
  ttlDays: 400,
  sourceTimeoutMs: 20_000,
  sourceConcurrency: 4,
  writeConcurrency: 8,
  /** Max findings returned by GET /findings before `truncated: true`. */
  listLimit: 500,
  /** Upper bound for GET /vpcs/{id}/summary (active findings of one VPC). */
  summaryLimit: 5_000,
  maxAgeMs: {
    topology: 30 * 60_000,
    monitoring: 30 * 60_000,
    compliance: 30 * 60_000,
    assessment: 36 * 3_600_000,
    endpointDrift: 36 * 3_600_000,
  },
  guardDutyMinSeverity: 4,
  guardDutyMaxFindings: 500,
  aggregatorActor: 'system:findings-aggregator',
} as const;

export const ALARM_STATE_SEVERITY: Severity = 'high';

export const MONITORING_THRESHOLD_SEVERITY: Readonly<Record<'warn' | 'critical', Severity>> = { critical: 'high', warn: 'medium' };

export const BACKUP_THRESHOLD_SEVERITY: Readonly<Record<'warn' | 'critical', Severity>> = { critical: 'high', warn: 'medium' };

export const COST_PRIORITY_SEVERITY: Readonly<Record<RecommendationPriority, Severity>> = { high: 'medium', medium: 'low', low: 'info' };

/** GuardDuty's own bands: 9-10 critical (extended), 7-8.9 high, 4-6.9 medium; below 4 ignored. */
export function guardDutySeverity(score: number): Severity | undefined {
  if (score >= 9) return 'critical';
  if (score >= 7) return 'high';
  if (score >= FINDINGS_DEFAULTS.guardDutyMinSeverity) return 'medium';
  return undefined;
}
