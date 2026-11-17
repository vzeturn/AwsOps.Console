// Feature: resource-actions-and-aurora-ui, Property 3: Reversibility_Class lookup is total with a safe irreversible default

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { ACTION_CATALOG } from './index.js';
import { getReversibilityClass } from './action-catalog.js';

/**
 * **Validates: Requirements 2.1, 2.2**
 *
 * Property 3 (design.md): for any actionType string, getReversibilityClass(actionType) MUST
 * return the exact reversibilityClass defined in ACTION_CATALOG when actionType matches one of
 * the 4 known values, and MUST return 'irreversible' for every other input (including the empty
 * string and "near-miss" values that don't match a known actionType).
 */
describe('Property 3: getReversibilityClass lookup is total with a safe irreversible default', () => {
  it('returns the exact reversibilityClass from ACTION_CATALOG for each known actionType', () => {
    fc.assert(
      fc.property(fc.constantFrom(...ACTION_CATALOG), (entry) => {
        expect(getReversibilityClass(entry.actionType)).toBe(entry.reversibilityClass);
      }),
      { numRuns: 100 },
    );
  });

  it('returns "irreversible" for any arbitrary string not matching a known actionType', () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => !ACTION_CATALOG.some((e) => e.actionType === s)),
        (actionType) => {
          expect(getReversibilityClass(actionType)).toBe('irreversible');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('resolves the empty string to "irreversible"', () => {
    expect(getReversibilityClass('')).toBe('irreversible');
  });

  it('resolves strings that are close-but-not-equal to a known actionType to "irreversible"', () => {
    const closeButNotEqual = [
      'ec2_start', // lowercase of 'EC2_Start' — matching is case-sensitive, not case-insensitive
      'EC2_Start ', // trailing whitespace
      ' EC2_Start', // leading whitespace
      'EC2Start', // missing underscore
      'ec2_stop',
      'EC2_Stop ',
      'snapshot_and_delete_ebs_volume',
      'Snapshot_And_Delete_EBS_Volum', // missing the last character
      'apply_s3_lifecycle_policy',
      'Apply_S3_Lifecycle_Policy_v2', // has an added suffix
    ];

    for (const actionType of closeButNotEqual) {
      // Ensure these test values genuinely do NOT match any actionType in the catalog, so this
      // test doesn't accidentally become meaningless if ACTION_CATALOG changes in the future.
      expect(ACTION_CATALOG.some((e) => e.actionType === actionType)).toBe(false);
      expect(getReversibilityClass(actionType)).toBe('irreversible');
    }
  });
});
