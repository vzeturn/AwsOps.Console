import { describe, it, expect } from 'vitest';
import type { Finding } from '@ops-dashboard/shared';
import {
  toFindingItem,
  fromFindingItem,
  vpcGsiSk,
  vpcGsiSkPrefix,
  RESOLVED_GSI1SK_FLOOR,
  ttlEpochSeconds,
  toAuditItem,
  toScanRunItem,
  fromScanRunItem,
} from './keys.js';

export const BASE_FINDING: Finding = {
  id: 'a'.repeat(40),
  checkId: 'net.vpc-flow-logs-disabled',
  source: 'network',
  kpi: 'network',
  severity: 'medium',
  status: 'open',
  vpcId: 'vpc-0aaa1111',
  resourceType: 'vpc',
  resourceId: 'vpc-0aaa1111',
  resourceArn: 'arn:aws:ec2:ap-southeast-1:123456789012:vpc/vpc-0aaa1111',
  title: 't',
  description: 'd',
  impact: 'i',
  evidence: { observedAt: '2026-09-25T03:00:00.000Z', data: {} },
  remediation: { steps: ['s'] },
  isoControls: ['A.8.16'],
  firstSeen: '2026-09-25T03:00:00.000Z',
  lastSeen: '2026-09-25T03:00:00.000Z',
  occurrences: 1,
};

describe('finding item mapping', () => {
  it('builds spec §3.3 keys', () => {
    const item = toFindingItem({ finding: BASE_FINDING, version: 3 });
    expect(item).toMatchObject({
      PK: `FINDING#${BASE_FINDING.id}`,
      SK: 'META',
      GSI1PK: 'VPC#vpc-0aaa1111',
      GSI1SK: '0#2#network#2026-09-25T03:00:00.000Z',
      GSI2PK: 'CHECK#net.vpc-flow-logs-disabled',
      GSI2SK: '2026-09-25T03:00:00.000Z',
      version: 3,
    });
    expect(item).not.toHaveProperty('expiresAt');
  });

  it('sets a 400-day TTL only on resolved findings', () => {
    const resolved = { ...BASE_FINDING, status: 'resolved' as const, resolvedAt: '2026-09-25T00:00:00.000Z' };
    const item = toFindingItem({ finding: resolved, version: 1 });
    expect(item.expiresAt).toBe(Date.parse('2026-09-25T00:00:00.000Z') / 1000 + 400 * 86400);
    expect(String(item.GSI1SK).startsWith(RESOLVED_GSI1SK_FLOOR)).toBe(true);
  });

  it('round-trips a finding and its version, stripping storage attributes', () => {
    const stored = fromFindingItem(toFindingItem({ finding: BASE_FINDING, version: 7 }));
    expect(stored).toEqual({ finding: BASE_FINDING, version: 7 });
  });

  it('every active status sorts below the resolved floor', () => {
    for (const status of ['open', 'acknowledged', 'suppressed'] as const) {
      expect(vpcGsiSk({ ...BASE_FINDING, status }) < RESOLVED_GSI1SK_FLOOR).toBe(true);
    }
  });

  it('builds the longest key prefix the filter allows, in key order', () => {
    expect(vpcGsiSkPrefix({})).toBeUndefined();
    expect(vpcGsiSkPrefix({ kpi: 'network' })).toBeUndefined();
    expect(vpcGsiSkPrefix({ status: 'open' })).toBe('0#');
    expect(vpcGsiSkPrefix({ status: 'open', severity: 'high' })).toBe('0#1#');
    expect(vpcGsiSkPrefix({ status: 'open', severity: 'high', kpi: 'network' })).toBe('0#1#network#');
    expect(vpcGsiSkPrefix({ status: 'open', kpi: 'network' })).toBe('0#');
  });

  it('computes TTL in epoch seconds', () => {
    expect(ttlEpochSeconds('1970-01-01T00:00:00.000Z', 1)).toBe(86400);
  });
});

describe('audit and scan-run items', () => {
  it('partitions audit events by month and indexes them by entity (no TTL)', () => {
    const item = toAuditItem({
      id: 'u-1',
      ts: '2026-09-25T03:00:00.000Z',
      entityType: 'finding',
      entityId: 'abc',
      action: 'finding.created',
      actor: 'system:findings-aggregator',
    });
    expect(item).toMatchObject({
      PK: 'AUDIT#2026-09',
      SK: '2026-09-25T03:00:00.000Z#u-1',
      GSI1PK: 'ENTITY#finding#abc',
      GSI1SK: '2026-09-25T03:00:00.000Z',
    });
    expect(item).not.toHaveProperty('expiresAt');
  });

  it('partitions scan runs by day with a 400-day TTL and round-trips', () => {
    const run = {
      runId: 'r-1',
      correlationId: 'c-1',
      startedAt: '2026-09-25T03:00:00.000Z',
      finishedAt: '2026-09-25T03:00:20.000Z',
      sources: [],
      counts: { created: 0, updated: 0, resolved: 0, reopened: 0, writeConflicts: 0 },
      vpcs: [],
    };
    const item = toScanRunItem(run);
    expect(item).toMatchObject({ PK: 'SCAN#2026-09-25', SK: '2026-09-25T03:00:00.000Z' });
    expect(item.expiresAt).toBe(ttlEpochSeconds('2026-09-25T03:00:00.000Z'));
    expect(fromScanRunItem(item)).toEqual(run);
  });
});
