import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { RiskLevel, ServiceCategory } from '@ops-dashboard/shared';
import { classifyByState, classifyByThreshold } from './recommendations.js';

// Feature: infra-review-dashboard-revamp, Property 7: Full schema of Recommendation_Item
// Validates: Requirements 7.5

const serviceCategoryArb: fc.Arbitrary<ServiceCategory> = fc.constantFrom(
  'compute',
  'database',
  'networking',
  'storage',
  'serverless',
  'savingsPlans',
  'backup',
);

const riskLevelArb: fc.Arbitrary<RiskLevel> = fc.constantFrom('low', 'medium', 'high');

// resourceId/resourceName/action represent real resource identifiers (non-empty) — always have
// length >= 1, matching the values actually returned by AWS APIs (Describe*/List*) in practice.
const nonEmptyStringArb = fc.string({ minLength: 1, maxLength: 40 });

function expectFullSchema(item: {
  resourceId: string;
  resourceName: string;
  currentState: string;
  recommendedAction: string;
  risk: RiskLevel;
  estimatedMonthlySavingsUsd: number | null;
}): void {
  expect(typeof item.resourceId).toBe('string');
  expect(item.resourceId.length).toBeGreaterThan(0);

  expect(typeof item.resourceName).toBe('string');
  expect(item.resourceName.length).toBeGreaterThan(0);

  expect(typeof item.currentState).toBe('string');
  expect(item.currentState.length).toBeGreaterThan(0);

  expect(typeof item.recommendedAction).toBe('string');
  expect(item.recommendedAction.length).toBeGreaterThan(0);

  expect(typeof item.risk).toBe('string');
  expect(item.risk.length).toBeGreaterThan(0);

  if (item.estimatedMonthlySavingsUsd !== null) {
    expect(typeof item.estimatedMonthlySavingsUsd).toBe('number');
    expect(item.estimatedMonthlySavingsUsd).toBeGreaterThanOrEqual(0);
  }
}

describe('Property 7: Full schema of Recommendation_Item', () => {
  it('classifyByThreshold always returns a RecommendationItem with the full schema when isBad = true', () => {
    fc.assert(
      fc.property(
        nonEmptyStringArb,
        fc.string({ minLength: 0, maxLength: 20 }),
        nonEmptyStringArb,
        nonEmptyStringArb,
        serviceCategoryArb,
        riskLevelArb,
        (resourceId, resourceType, resourceName, action, category, risk) => {
          // direction: 'below', measuredValue: 0, thresholdValue: 1 -> 0 <= 1 -> isBad is always true,
          // ensuring classifyByThreshold never returns null.
          const item = classifyByThreshold({
            resourceId,
            resourceType,
            resourceName,
            measuredValue: 0,
            thresholdValue: 1,
            direction: 'below',
            category,
            action,
            risk,
            findingType: 'ec2LowCpu',
          });

          expect(item).not.toBeNull();
          expectFullSchema(item!);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('classifyByState always returns a RecommendationItem with the full schema when isBadState = true', () => {
    fc.assert(
      fc.property(
        nonEmptyStringArb,
        fc.string({ minLength: 0, maxLength: 20 }),
        nonEmptyStringArb,
        nonEmptyStringArb,
        serviceCategoryArb,
        riskLevelArb,
        (resourceId, resourceType, resourceName, action, category, risk) => {
          // isBadState is always true -> classifyByState never returns null.
          const item = classifyByState({
            resourceId,
            resourceType,
            resourceName,
            isBadState: true,
            category,
            action,
            risk,
            findingType: 'ec2Stopped',
          });

          expect(item).not.toBeNull();
          expectFullSchema(item!);
        },
      ),
      { numRuns: 100 },
    );
  });
});
