import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { getCostImpactWarning } from './action-catalog.js';

// Feature: resource-actions-and-aurora-ui, Property 17: Cost impact warning defaults to "warn" for every unclassified action type
//
// For any string actionType (including all 4 known catalog values and any arbitrary/unknown
// string), getCostImpactWarning(actionType) SHALL return undefined if and only if actionType is
// exactly 'EC2_Stop' or 'Apply_S3_Lifecycle_Policy', and SHALL return a non-empty warning string
// for every other input, including unknown action types.
//
// Validates: Requirements 17.4, 17.5

const NO_WARNING_ACTIONS = new Set(['EC2_Stop', 'Apply_S3_Lifecycle_Policy']);

describe('getCostImpactWarning (Property 17)', () => {
  it('returns undefined iff actionType is exactly EC2_Stop or Apply_S3_Lifecycle_Policy, else a non-empty warning string', () => {
    fc.assert(
      fc.property(fc.string(), (actionType) => {
        const result = getCostImpactWarning(actionType);

        if (NO_WARNING_ACTIONS.has(actionType)) {
          expect(result).toBeUndefined();
        } else {
          expect(typeof result).toBe('string');
          expect((result as string).length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('resolves all 4 known ActionType values explicitly with no ambiguity', () => {
    const ecStart = getCostImpactWarning('EC2_Start');
    expect(typeof ecStart).toBe('string');
    expect((ecStart as string).length).toBeGreaterThan(0);

    expect(getCostImpactWarning('EC2_Stop')).toBeUndefined();

    const snapshotAndDelete = getCostImpactWarning('Snapshot_And_Delete_EBS_Volume');
    expect(typeof snapshotAndDelete).toBe('string');
    expect((snapshotAndDelete as string).length).toBeGreaterThan(0);

    expect(getCostImpactWarning('Apply_S3_Lifecycle_Policy')).toBeUndefined();
  });
});
