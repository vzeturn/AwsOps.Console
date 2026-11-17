import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { ACTION_CATALOG, type ServiceCategory } from './index.js';
import { matchActionCatalog } from './action-catalog.js';

// Feature: resource-actions-and-aurora-ui, Property 1: Action_Catalog matching is exact,
// case-sensitive, and exhaustive
//
// For any RecommendationItem-shaped (category, resourceType) pair with arbitrary string values
// (including values that differ from a catalog entry only by letter case, or that belong to
// savingsPlans), matchActionCatalog SHALL return the matching ActionCatalogEntry if and only if
// both category and resourceType are byte-for-byte equal to some entry's category/resourceType (no
// case-insensitive or partial match), and SHALL return undefined otherwise — in particular, every
// savingsPlans item SHALL always be classified manual-only.
//
// Validates: Requirements 1.2, 1.3, 1.4, 11.3, 11.4

const knownServiceCategoryArb: fc.Arbitrary<ServiceCategory> = fc.constantFrom(
  'compute',
  'database',
  'networking',
  'storage',
  'serverless',
  'savingsPlans',
  'backup',
);

// Mix a "valid" category (one of the 7 ServiceCategory values) with an arbitrary garbage category
// to cover both cases: "valid category but wrong resourceType" and "category is pure garbage".
const categoryArb: fc.Arbitrary<string> = fc.oneof(knownServiceCategoryArb, fc.string());

const exactMatch = (category: string, resourceType: string) =>
  ACTION_CATALOG.some((entry) => entry.category === category && entry.resourceType === resourceType);

describe('matchActionCatalog (Property 1)', () => {
  it('returns the matching entry iff (category, resourceType) is byte-for-byte equal to some catalog entry, else undefined', () => {
    fc.assert(
      fc.property(categoryArb, fc.string(), (category, resourceType) => {
        // matchActionCatalog declares `category: ServiceCategory` by type, but since this test
        // exercises the correctness of the runtime match (not static type-checking), we cast so we
        // can also generate garbage values outside ServiceCategory (Requirement 1.3: a non-matching
        // category must also return undefined, even when that category isn't one of the 7 valid values).
        const result = matchActionCatalog({ category: category as ServiceCategory, resourceType });

        const expected = ACTION_CATALOG.find(
          (entry) => entry.category === category && entry.resourceType === resourceType,
        );

        if (expected === undefined) {
          expect(result).toBeUndefined();
        } else {
          expect(result).toEqual(expected);
        }

        expect(result !== undefined).toBe(exactMatch(category, resourceType));
      }),
      { numRuns: 100 },
    );
  });

  it('never matches when category or resourceType differs only by letter case', () => {
    for (const entry of ACTION_CATALOG) {
      const upperCategory = entry.category.toUpperCase();
      const lowerCategory = entry.category.toLowerCase();
      const upperResourceType = entry.resourceType.toUpperCase();
      const lowerResourceType = entry.resourceType.toLowerCase();

      // Only assert when the transform actually changes the string (e.g. 'ec2-instance' still has
      // lowercase characters that change under uppercase — 'EC2-INSTANCE' is clearly different from
      // 'ec2-instance', so it always changes; but we still guard for safety/generality in case the
      // catalog changes in the future).
      if (upperCategory !== entry.category) {
        expect(matchActionCatalog({ category: upperCategory as ServiceCategory, resourceType: entry.resourceType })).toBeUndefined();
      }
      if (lowerCategory !== entry.category) {
        expect(matchActionCatalog({ category: lowerCategory as ServiceCategory, resourceType: entry.resourceType })).toBeUndefined();
      }
      if (upperResourceType !== entry.resourceType) {
        expect(matchActionCatalog({ category: entry.category, resourceType: upperResourceType })).toBeUndefined();
      }
      if (lowerResourceType !== entry.resourceType) {
        expect(matchActionCatalog({ category: entry.category, resourceType: lowerResourceType })).toBeUndefined();
      }
    }
  });

  it('never matches savingsPlans items — every savingsPlans RecommendationItem is manual-only', () => {
    fc.assert(
      fc.property(fc.string(), (resourceType) => {
        expect(matchActionCatalog({ category: 'savingsPlans', resourceType })).toBeUndefined();
      }),
      { numRuns: 100 },
    );
  });
});
