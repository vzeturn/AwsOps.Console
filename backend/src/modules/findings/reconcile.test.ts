import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type { Finding, FindingDraft } from '@ops-dashboard/shared';
import { reconcile, type ReconcileInput } from './reconcile.js';
import type { StoredFinding } from './keys.js';

const T0 = '2026-09-25T02:50:00.000Z';
const NOW = '2026-09-25T03:00:00.000Z';
const CHECK = 'net.vpc-flow-logs-disabled';

function draft(id: string, overrides: Partial<FindingDraft> = {}): FindingDraft {
  return {
    id,
    checkId: CHECK,
    source: 'network',
    kpi: 'network',
    severity: 'medium',
    vpcId: 'vpc-0aaa1111',
    resourceType: 'vpc',
    resourceId: 'vpc-0aaa1111',
    resourceArn: `arn:${id}`,
    title: 'VPC Flow Logs disabled',
    description: 'd',
    impact: 'i',
    evidence: { observedAt: NOW, data: {} },
    remediation: { steps: ['s'] },
    isoControls: ['A.8.16'],
    ...overrides,
  };
}

function stored(id: string, overrides: Partial<Finding> = {}, version = 1): StoredFinding {
  return {
    version,
    finding: { ...draft(id), status: 'open', firstSeen: T0, lastSeen: T0, occurrences: 1, ...overrides },
  };
}

function run(partial: Partial<ReconcileInput>) {
  return reconcile({ existing: [], drafts: [], healthyCheckIds: new Set([CHECK]), now: NOW, actor: 'system:findings-aggregator', ...partial });
}

describe('reconcile', () => {
  it('creates a new open finding with a created audit event', () => {
    const result = run({ drafts: [draft('a')] });
    expect(result.counts).toEqual({ created: 1, updated: 0, resolved: 0, reopened: 0 });
    const [{ write, audit }] = result.writes;
    expect(write.expectedVersion).toBeNull();
    expect(write.finding).toMatchObject({ status: 'open', firstSeen: NOW, lastSeen: NOW, occurrences: 1 });
    expect(audit).toMatchObject({ action: 'finding.created', entityId: 'a', actor: 'system:findings-aggregator', ts: NOW });
  });

  it('still-open: refreshes lastSeen/severity, keeps firstSeen, status, ticketId and occurrences, no audit', () => {
    const result = run({
      existing: [stored('a', { status: 'acknowledged', ticketId: 'OPS-000001' }, 4)],
      drafts: [draft('a', { severity: 'high' })],
    });
    const [{ write, audit }] = result.writes;
    expect(write.expectedVersion).toBe(4);
    expect(write.finding).toMatchObject({ status: 'acknowledged', severity: 'high', firstSeen: T0, lastSeen: NOW, occurrences: 1, ticketId: 'OPS-000001' });
    expect(audit).toBeUndefined();
    expect(result.counts.updated).toBe(1);
  });

  it('suppressed + seen stays suppressed', () => {
    const suppression = { reason: 'r', until: '2026-10-01T00:00:00.000Z', by: 'a', state: 'active' as const };
    const result = run({ existing: [stored('a', { status: 'suppressed', suppression })], drafts: [draft('a')] });
    expect(result.writes[0].write.finding).toMatchObject({ status: 'suppressed', suppression });
  });

  it('resolves an active finding that is no longer seen when its check is healthy', () => {
    const result = run({ existing: [stored('a', { status: 'acknowledged' }, 2)] });
    const [{ write, audit }] = result.writes;
    expect(write).toMatchObject({ expectedVersion: 2, finding: { status: 'resolved', resolvedAt: NOW, lastSeen: T0 } });
    expect(audit).toMatchObject({ action: 'finding.resolved' });
    expect(result.active).toEqual([]);
  });

  it('stale: never resolves a finding whose check is not healthy, and keeps it active', () => {
    const result = run({ existing: [stored('a')], healthyCheckIds: new Set() });
    expect(result.writes).toEqual([]);
    expect(result.active.map((f) => f.id)).toEqual(['a']);
  });

  it('stale: ignores drafts of an unhealthy check (no create from half-trusted data)', () => {
    const result = run({ drafts: [draft('a')], healthyCheckIds: new Set() });
    expect(result.writes).toEqual([]);
  });

  it('reopens a resolved finding that is seen again', () => {
    const result = run({ existing: [stored('a', { status: 'resolved', resolvedAt: T0, occurrences: 2 }, 5)], drafts: [draft('a')] });
    const [{ write, audit }] = result.writes;
    expect(write.expectedVersion).toBe(5);
    expect(write.finding).toMatchObject({ status: 'open', occurrences: 3, lastSeen: NOW, firstSeen: T0 });
    expect(write.finding).not.toHaveProperty('resolvedAt');
    expect(audit).toMatchObject({ action: 'finding.reopened' });
    expect(result.counts.reopened).toBe(1);
  });

  it('leaves an already-resolved, unseen finding untouched', () => {
    expect(run({ existing: [stored('a', { status: 'resolved', resolvedAt: T0 })] }).writes).toEqual([]);
  });

  it('deduplicates drafts sharing an id (first wins)', () => {
    const result = run({ drafts: [draft('a', { severity: 'high' }), draft('a', { severity: 'low' })] });
    expect(result.writes).toHaveLength(1);
    expect(result.writes[0].write.finding.severity).toBe('high');
  });

  it('is idempotent: re-running with the same drafts over its own output creates/resolves/reopens nothing', () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.string({ minLength: 4, maxLength: 8 }), { maxLength: 8 }), fc.array(fc.boolean(), { minLength: 8, maxLength: 8 }), (ids, seenFlags) => {
        const existing = ids.map((id, i) => stored(id, i % 2 === 0 ? {} : { status: 'resolved', resolvedAt: T0 }));
        const drafts = ids.filter((_, i) => seenFlags[i]).map((id) => draft(id));
        const first = run({ existing, drafts });
        const afterFirst = new Map(existing.map((s) => [s.finding.id, s]));
        for (const { write } of first.writes) afterFirst.set(write.finding.id, { finding: write.finding, version: (write.expectedVersion ?? 0) + 1 });
        const second = run({ existing: [...afterFirst.values()], drafts });
        return second.counts.created === 0 && second.counts.resolved === 0 && second.counts.reopened === 0;
      }),
    );
  });
});
