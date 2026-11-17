import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { RiskLevel, ServiceCategory } from '@ops-dashboard/shared';
import { classifyByThreshold } from './recommendations.js';

// Feature: infra-review-dashboard-revamp, Property 1: Classifies by a measured threshold
//
// For all resource (EC2/RDS/NAT), measured value, and threshold, if the measured value crosses the
// threshold in the configured "bad" direction (below for CPU/throughput usage), `classifyByThreshold`
// SHALL return a `RecommendationItem` referencing that resource; otherwise it SHALL return `null`.
//
// Validates: Requirements 1.3, 2.2, 3.3

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

const directionArb: fc.Arbitrary<'below' | 'above'> = fc.constantFrom('below', 'above');

const finiteFloatArb = fc.float({ min: -1_000_000, max: 1_000_000, noNaN: true });

const classifyByThresholdInputArb = fc.record({
  resourceId: fc.string(),
  resourceType: fc.string(),
  resourceName: fc.string(),
  measuredValue: finiteFloatArb,
  thresholdValue: finiteFloatArb,
  direction: directionArb,
  category: serviceCategoryArb,
  action: fc.string(),
  risk: riskLevelArb,
  findingType: fc.constant('ec2LowCpu' as const),
});

describe('classifyByThreshold (Property 1)', () => {
  it('returns a RecommendationItem referencing the resource iff the measured value crosses the threshold in the configured bad direction, else null', () => {
    fc.assert(
      fc.property(classifyByThresholdInputArb, (input) => {
        const { measuredValue, thresholdValue, direction } = input;

        const isBad =
          direction === 'below' ? measuredValue <= thresholdValue : measuredValue >= thresholdValue;

        const result = classifyByThreshold(input);

        if (isBad) {
          expect(result).not.toBeNull();
          expect(result?.resourceId).toBe(input.resourceId);
          expect(result?.resourceType).toBe(input.resourceType);
          expect(result?.resourceName).toBe(input.resourceName);
          expect(result?.category).toBe(input.category);
          expect(result?.recommendedAction).toBe(input.action);
          expect(result?.risk).toBe(input.risk);
        } else {
          expect(result).toBeNull();
        }
      }),
      { numRuns: 100 },
    );
  });
});
