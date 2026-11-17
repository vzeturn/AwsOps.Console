import { describe, it, expect } from 'vitest';
import {
  classifyComputeOptimizerDirection,
  decideAutoRightsizeTagAction,
  evaluateAutoRightsizeCandidates,
  pickSafeCrossFamilyRecommendation,
  AUTO_RIGHTSIZE_COOLDOWN_DAYS,
  NO_AUTO_SIZING_TAG_KEY,
  NO_AUTO_RIGHTSIZE_TAG_KEY,
  type AutoRightsizeCandidateInput,
  type AutoRightsizeTagState,
} from './ec2AutoRightsizing.js';

describe('NO_AUTO_SIZING_TAG_KEY', () => {
  it('the new tag uses the OpsDashboard namespace, differs from the old tag, both coexist (transition period)', () => {
    expect(NO_AUTO_SIZING_TAG_KEY).toBe('OpsDashboard:NoAutoSizing');
    expect(NO_AUTO_RIGHTSIZE_TAG_KEY).toBe('OpsDashboard:NoAutoRightsize');
    expect(NO_AUTO_SIZING_TAG_KEY).not.toBe(NO_AUTO_RIGHTSIZE_TAG_KEY);
  });
});

describe('classifyComputeOptimizerDirection', () => {
  it('UNDERPROVISIONED -> up', () => {
    expect(classifyComputeOptimizerDirection('UNDERPROVISIONED', undefined)).toBe('up');
  });

  it('OVERPROVISIONED (not EBS-only) -> down', () => {
    expect(classifyComputeOptimizerDirection('OVERPROVISIONED', ['CPUOverprovisioned'])).toBe('down');
    expect(classifyComputeOptimizerDirection('OVERPROVISIONED', undefined)).toBe('down');
  });

  it('OVERPROVISIONED but the reason is ONLY EBS -> none (not reliable enough to automate)', () => {
    expect(classifyComputeOptimizerDirection('OVERPROVISIONED', ['EBSThroughputOverprovisioned'])).toBe('none');
  });

  it('OVERPROVISIONED with reasonCodes including both EBS and CPU -> still down (not excluded, has a real CPU code)', () => {
    expect(classifyComputeOptimizerDirection('OVERPROVISIONED', ['EBSThroughputOverprovisioned', 'CPUOverprovisioned'])).toBe('down');
  });

  it('OPTIMIZED/NOTOPTIMIZED/undefined -> none', () => {
    expect(classifyComputeOptimizerDirection('OPTIMIZED', undefined)).toBe('none');
    expect(classifyComputeOptimizerDirection('NOTOPTIMIZED', undefined)).toBe('none');
    expect(classifyComputeOptimizerDirection(undefined, undefined)).toBe('none');
  });
});

function baseState(overrides: Partial<AutoRightsizeTagState & { coFinding: string | undefined; coFindingReasonCodes: string[] | undefined }>) {
  return {
    hasScheduleTag: true,
    exempt: false,
    currentPendingDirection: undefined,
    lastAutoRightsizeDate: undefined,
    coFinding: undefined,
    coFindingReasonCodes: undefined,
    ...overrides,
  };
}

const NOW = new Date('2026-08-12T00:00:00Z');

describe('decideAutoRightsizeTagAction', () => {
  it('out of scope (no schedule:start tag) -> noop if no pending, clearPending if a pending tag exists', () => {
    expect(decideAutoRightsizeTagAction(baseState({ hasScheduleTag: false }), NOW)).toEqual({ action: 'noop' });
    expect(
      decideAutoRightsizeTagAction(baseState({ hasScheduleTag: false, currentPendingDirection: 'down' }), NOW),
    ).toEqual({ action: 'clearPending' });
  });

  it('exempt (no-auto-rightsize tag) -> noop if no pending, clearPending if a pending tag exists', () => {
    expect(decideAutoRightsizeTagAction(baseState({ exempt: true }), NOW)).toEqual({ action: 'noop' });
    expect(decideAutoRightsizeTagAction(baseState({ exempt: true, currentPendingDirection: 'up' }), NOW)).toEqual({
      action: 'clearPending',
    });
  });

  it('Compute Optimizer does not confirm a reliable direction -> noop if no pending, clearPending if a pending tag exists (CO changed its mind)', () => {
    expect(decideAutoRightsizeTagAction(baseState({ coFinding: 'OPTIMIZED' }), NOW)).toEqual({ action: 'noop' });
    expect(
      decideAutoRightsizeTagAction(baseState({ coFinding: 'OPTIMIZED', currentPendingDirection: 'down' }), NOW),
    ).toEqual({ action: 'clearPending' });
  });

  it('Compute Optimizer confirms a NEW direction, no pending, not in cooldown -> setPending', () => {
    expect(decideAutoRightsizeTagAction(baseState({ coFinding: 'UNDERPROVISIONED' }), NOW)).toEqual({
      action: 'setPending',
      direction: 'up',
    });
    expect(decideAutoRightsizeTagAction(baseState({ coFinding: 'OVERPROVISIONED' }), NOW)).toEqual({
      action: 'setPending',
      direction: 'down',
    });
  });

  it('already has a pending tag matching the current direction -> noop (idempotent, avoids rewriting the tag)', () => {
    expect(
      decideAutoRightsizeTagAction(baseState({ coFinding: 'UNDERPROVISIONED', currentPendingDirection: 'up' }), NOW),
    ).toEqual({ action: 'noop' });
  });

  it('has a pending DIFFERENT direction, outside cooldown -> setPending with the new direction (direction change)', () => {
    expect(
      decideAutoRightsizeTagAction(
        baseState({ coFinding: 'UNDERPROVISIONED', currentPendingDirection: 'down', lastAutoRightsizeDate: '2026-07-01' }),
        NOW,
      ),
    ).toEqual({ action: 'setPending', direction: 'up' });
  });

  it('within the cooldown period (< 7 days since lastAutoRightsizeDate) -> noop even if CO confirms a new direction', () => {
    // lastAutoRightsizeDate is exactly 3 days before NOW (2026-08-12).
    expect(
      decideAutoRightsizeTagAction(baseState({ coFinding: 'OVERPROVISIONED', lastAutoRightsizeDate: '2026-08-09' }), NOW),
    ).toEqual({ action: 'noop' });
  });

  it('outside cooldown (exactly at the AUTO_RIGHTSIZE_COOLDOWN_DAYS-day boundary) -> allows setPending', () => {
    const boundaryDate = new Date(NOW.getTime() - (AUTO_RIGHTSIZE_COOLDOWN_DAYS + 1) * 24 * 60 * 60 * 1000);
    const dateStr = boundaryDate.toISOString().slice(0, 10);
    expect(
      decideAutoRightsizeTagAction(baseState({ coFinding: 'OVERPROVISIONED', lastAutoRightsizeDate: dateStr }), NOW),
    ).toEqual({ action: 'setPending', direction: 'down' });
  });

  it('lastAutoRightsizeDate is invalid (parse error) -> fail-safe treats it as NOT in cooldown, allows setPending', () => {
    expect(
      decideAutoRightsizeTagAction(baseState({ coFinding: 'UNDERPROVISIONED', lastAutoRightsizeDate: 'not-a-date' }), NOW),
    ).toEqual({ action: 'setPending', direction: 'up' });
  });
});

describe('pickSafeCrossFamilyRecommendation', () => {
  it('migrationEffort=VeryLow + platformDifferences empty -> returns the recommended instanceType', () => {
    expect(pickSafeCrossFamilyRecommendation({ instanceType: 'm6i.large', migrationEffort: 'VeryLow', platformDifferences: [] })).toBe('m6i.large');
  });

  it('migrationEffort other than VeryLow (Low/Medium/High) -> returns undefined (NOT applied, even if platformDifferences is empty)', () => {
    expect(pickSafeCrossFamilyRecommendation({ instanceType: 'm6g.large', migrationEffort: 'Low', platformDifferences: [] })).toBeUndefined();
    expect(pickSafeCrossFamilyRecommendation({ instanceType: 'm6g.large', migrationEffort: 'Medium', platformDifferences: [] })).toBeUndefined();
    expect(pickSafeCrossFamilyRecommendation({ instanceType: 'm6g.large', migrationEffort: 'High', platformDifferences: [] })).toBeUndefined();
  });

  it('migrationEffort=VeryLow but platformDifferences is NOT empty -> returns undefined (hypervisor/network/storage driver difference)', () => {
    expect(
      pickSafeCrossFamilyRecommendation({ instanceType: 'm6i.large', migrationEffort: 'VeryLow', platformDifferences: ['NetworkInterface'] }),
    ).toBeUndefined();
  });

  it('migrationEffort=undefined (AWS did not return the field) -> returns undefined (fail-safe)', () => {
    expect(pickSafeCrossFamilyRecommendation({ instanceType: 'm6i.large', migrationEffort: undefined, platformDifferences: [] })).toBeUndefined();
  });

  it('option=undefined (no recommendationOptions) -> returns undefined', () => {
    expect(pickSafeCrossFamilyRecommendation(undefined)).toBeUndefined();
  });
});

describe('evaluateAutoRightsizeCandidates', () => {
  it('returns only instances whose tagAction is not noop, preserving instanceId/name', () => {
    const items: AutoRightsizeCandidateInput[] = [
      { instanceId: 'i-1', name: 'abc-prod-ec2-one', ...baseState({ coFinding: 'UNDERPROVISIONED' }) },
      { instanceId: 'i-2', name: 'abc-prod-ec2-two', ...baseState({ coFinding: 'OPTIMIZED' }) }, // noop -> excluded
      { instanceId: 'i-3', name: 'abc-prod-ec2-three', ...baseState({ hasScheduleTag: false, currentPendingDirection: 'up' }) }, // clearPending -> kept
    ];

    const result = evaluateAutoRightsizeCandidates(items, NOW);

    expect(result).toEqual([
      { instanceId: 'i-1', name: 'abc-prod-ec2-one', tagAction: { action: 'setPending', direction: 'up' } },
      { instanceId: 'i-3', name: 'abc-prod-ec2-three', tagAction: { action: 'clearPending' } },
    ]);
  });

  it('empty list -> returns empty', () => {
    expect(evaluateAutoRightsizeCandidates([], NOW)).toEqual([]);
  });

  it('every instance is noop -> returns empty', () => {
    const items: AutoRightsizeCandidateInput[] = [
      { instanceId: 'i-1', name: 'abc-prod-ec2-one', ...baseState({}) },
      { instanceId: 'i-2', name: 'abc-prod-ec2-two', ...baseState({ hasScheduleTag: false }) },
    ];
    expect(evaluateAutoRightsizeCandidates(items, NOW)).toEqual([]);
  });
});
