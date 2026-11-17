import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { RecommendationItem, RecommendationPriority, RiskLevel, ServiceCategory } from '@ops-dashboard/shared';
import { sortByPriorityDesc } from './recommendations.js';

// Feature: infra-review-dashboard-revamp, Property 6: Sorts Recommendation_Item by priority descending
// Validates: Requirements 7.4

// Priority score on the low < medium < high scale, used to assert descending order in the result.
const PRIORITY_SCORE: Record<RecommendationPriority, number> = { low: 0, medium: 1, high: 2 };

const priorityArb: fc.Arbitrary<RecommendationPriority> = fc.constantFrom('low', 'medium', 'high');
const riskArb: fc.Arbitrary<RiskLevel> = fc.constantFrom('low', 'medium', 'high');
const categoryArb: fc.Arbitrary<ServiceCategory> = fc.constantFrom(
  'compute',
  'database',
  'networking',
  'storage',
  'serverless',
  'savingsPlans',
  'backup',
);

// Generator for a valid RecommendationItem with a random priority — the other fields just need to
// satisfy the schema (non-empty for required string fields), since this property only cares about priority order.
const recommendationItemArb: fc.Arbitrary<RecommendationItem> = fc.record({
  id: fc.string({ minLength: 1, maxLength: 20 }),
  category: categoryArb,
  resourceType: fc.string({ minLength: 1, maxLength: 20 }),
  resourceId: fc.string({ minLength: 1, maxLength: 20 }),
  resourceName: fc.string({ minLength: 1, maxLength: 20 }),
  currentState: fc.string({ minLength: 1, maxLength: 20 }),
  recommendedAction: fc.string({ minLength: 1, maxLength: 20 }),
  estimatedMonthlySavingsUsd: fc.option(fc.float({ min: 0, max: 100_000, noNaN: true }), { nil: null }),
  risk: riskArb,
  priority: priorityArb,
  findingType: fc.constant('ec2LowCpu' as const),
});

describe('sortByPriorityDesc — Property 6', () => {
  it('returns a list sorted descending by priority for every pair of adjacent elements', () => {
    fc.assert(
      fc.property(fc.array(recommendationItemArb, { minLength: 0, maxLength: 50 }), (items) => {
        const sorted = sortByPriorityDesc(items);

        // No elements lost or added — only reordered.
        expect(sorted.length).toBe(items.length);

        for (let i = 0; i < sorted.length - 1; i++) {
          const earlierScore = PRIORITY_SCORE[sorted[i].priority];
          const laterScore = PRIORITY_SCORE[sorted[i + 1].priority];
          expect(earlierScore).toBeGreaterThanOrEqual(laterScore);
        }
      }),
      { numRuns: 100 },
    );
  });
});
