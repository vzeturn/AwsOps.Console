import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  KPIS,
  SEVERITIES,
  FINDING_STATUSES,
  SEVERITY_RANK,
  STATUS_RANK,
  worstSeverity,
  isKpi,
  isSeverity,
  isFindingStatus,
} from './index.js';

describe('findings shared model', () => {
  it('ranks severities worst-first (critical=0) so an ascending GSI1 query returns worst first', () => {
    const ranks = SEVERITIES.map((s) => SEVERITY_RANK[s]);
    expect(ranks).toEqual([0, 1, 2, 3, 4]);
  });

  it('ranks resolved last so "GSI1SK < 3#" selects exactly the active statuses', () => {
    expect(FINDING_STATUSES.map((s) => STATUS_RANK[s])).toEqual([0, 1, 2, 3]);
    expect(STATUS_RANK.resolved).toBe(3);
  });

  it('has the six spec KPIs in spec order', () => {
    expect(KPIS).toEqual(['availability', 'security', 'network', 'resilience', 'compliance', 'cost']);
  });

  it('worstSeverity returns null for empty input and the lowest rank otherwise', () => {
    expect(worstSeverity([])).toBeNull();
    expect(worstSeverity(['low', 'high', 'medium'])).toBe('high');
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...SEVERITIES), { minLength: 1 }), (list) => {
        const worst = worstSeverity(list);
        return worst !== null && list.every((s) => SEVERITY_RANK[s] >= SEVERITY_RANK[worst]);
      }),
    );
  });

  it('type guards accept only exact lowercase members', () => {
    expect(isKpi('network')).toBe(true);
    expect(isKpi('Network')).toBe(false);
    expect(isSeverity('critical')).toBe(true);
    expect(isSeverity('urgent')).toBe(false);
    expect(isFindingStatus('open')).toBe(true);
    expect(isFindingStatus('OPEN')).toBe(false);
    expect(isFindingStatus(undefined)).toBe(false);
  });
});
