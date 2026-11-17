import type { AuditAction, AuditEvent, Finding, FindingDraft, ScanRunCounts } from '@ops-dashboard/shared';
import type { StoredFinding } from './keys.js';

export interface FindingWrite {
  finding: Finding;
  /** null = create (condition attribute_not_exists); else the version the write is conditional on. */
  expectedVersion: number | null;
}

export type AuditEventDraft = Omit<AuditEvent, 'id'>;

export interface ReconcileInput {
  existing: readonly StoredFinding[];
  drafts: readonly FindingDraft[];
  /** Checks whose every required source was `ok` AND that ran without throwing this run. */
  healthyCheckIds: ReadonlySet<string>;
  now: string;
  actor: string;
}

export interface ReconcileResult {
  writes: Array<{ write: FindingWrite; audit?: AuditEventDraft }>;
  counts: Omit<ScanRunCounts, 'writeConflicts'>;
  /** Every non-resolved finding after this run (for the VPC rollup). */
  active: Finding[];
}

function withoutResolvedAt(finding: Finding): Finding {
  const copy = { ...finding };
  delete copy.resolvedAt;
  return copy;
}

/**
 * Spec §3.1 reconcile. Pure: all I/O happens in findings-aggregator.ts.
 *
 * | stored            | seen | check healthy | result                                   |
 * |-------------------|------|---------------|------------------------------------------|
 * | none              | yes  | yes           | create open, audit created               |
 * | open/ack/supp.    | yes  | yes           | refresh draft fields + lastSeen          |
 * | resolved          | yes  | yes           | reopen: open, occurrences++, audit       |
 * | open/ack/supp.    | no   | yes           | resolved, resolvedAt=now, audit          |
 * | open/ack/supp.    | no   | no (stale)    | untouched - NEVER a false all-clear      |
 * | any               | yes  | no            | draft ignored (drafts of an unhealthy check are never trusted) |
 */
export function reconcile(input: ReconcileInput): ReconcileResult {
  const { existing, drafts, healthyCheckIds, now, actor } = input;
  const existingById = new Map(existing.map((s) => [s.finding.id, s]));
  const seen = new Map<string, FindingDraft>();
  for (const d of drafts) {
    if (healthyCheckIds.has(d.checkId) && !seen.has(d.id)) seen.set(d.id, d);
  }

  const writes: ReconcileResult['writes'] = [];
  const active: Finding[] = [];
  const counts = { created: 0, updated: 0, resolved: 0, reopened: 0 };
  const audit = (finding: Finding, action: AuditAction): AuditEventDraft => ({
    ts: now,
    entityType: 'finding',
    entityId: finding.id,
    action,
    actor,
    details: { checkId: finding.checkId, vpcId: finding.vpcId, resourceId: finding.resourceId, severity: finding.severity },
  });

  for (const d of seen.values()) {
    const prior = existingById.get(d.id);
    if (!prior) {
      const created: Finding = { ...d, status: 'open', firstSeen: now, lastSeen: now, occurrences: 1 };
      writes.push({ write: { finding: created, expectedVersion: null }, audit: audit(created, 'finding.created') });
      active.push(created);
      counts.created += 1;
    } else if (prior.finding.status === 'resolved') {
      const reopened: Finding = withoutResolvedAt({ ...prior.finding, ...d, status: 'open', lastSeen: now, occurrences: prior.finding.occurrences + 1 });
      writes.push({ write: { finding: reopened, expectedVersion: prior.version }, audit: audit(reopened, 'finding.reopened') });
      active.push(reopened);
      counts.reopened += 1;
    } else {
      const updated: Finding = { ...prior.finding, ...d, lastSeen: now };
      writes.push({ write: { finding: updated, expectedVersion: prior.version } });
      active.push(updated);
      counts.updated += 1;
    }
  }

  for (const prior of existing) {
    if (seen.has(prior.finding.id) || prior.finding.status === 'resolved') continue;
    if (!healthyCheckIds.has(prior.finding.checkId)) {
      active.push(prior.finding);
      continue;
    }
    const resolved: Finding = { ...prior.finding, status: 'resolved', resolvedAt: now };
    writes.push({ write: { finding: resolved, expectedVersion: prior.version }, audit: audit(resolved, 'finding.resolved') });
    counts.resolved += 1;
  }

  return { writes, counts, active };
}
