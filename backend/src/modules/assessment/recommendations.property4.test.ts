import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { RiskLevel } from '@ops-dashboard/shared';
import { buildSavingsPlanRecommendation } from './recommendations.js';

// Feature: infra-review-dashboard-revamp, Property 4: Commitment-purchase candidate with a non-negative savings estimate
// Validates: Requirements 5.2

const riskArb: fc.Arbitrary<RiskLevel> = fc.constantFrom('low', 'medium', 'high');

describe('buildSavingsPlanRecommendation — Property 4', () => {
  it('returns a recommendation with estimatedMonthlySavingsUsd >= 0 when coverage is below the threshold', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 20 }),
        fc.float({ min: 0, max: 1_000_000, noNaN: true }),
        fc.float({ min: 0, max: 100, noNaN: true }),
        fc.float({ min: 0, max: 100, noNaN: true }),
        fc.float({ min: 0, max: 1, noNaN: true }),
        riskArb,
        (service, onDemandUsd, coveragePercent, thresholdOffset, estimatedSavingsRate, risk) => {
          // Ensures coveragePercent is always below the threshold: threshold = coveragePercent + offset (offset > 0)
          const coveragePercentThreshold = coveragePercent + thresholdOffset + 0.0001;

          const result = buildSavingsPlanRecommendation({
            service,
            onDemandUsd,
            coveredUsd: 0,
            coveragePercent,
            coveragePercentThreshold,
            estimatedSavingsRate,
            risk,
          });

          expect(result).not.toBeNull();
          expect(result!.estimatedMonthlySavingsUsd).not.toBeNull();
          expect(result!.estimatedMonthlySavingsUsd as number).toBeGreaterThanOrEqual(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('increasing onDemandUsd never decreases estimatedMonthlySavingsUsd (monotonic)', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 20 }),
        fc.float({ min: 0, max: 100, noNaN: true }),
        fc.float({ min: 0, max: 100, noNaN: true }),
        fc.float({ min: 0, max: 1, noNaN: true }),
        riskArb,
        fc.float({ min: 0, max: 500_000, noNaN: true }),
        fc.float({ min: 0, max: 500_000, noNaN: true }),
        (service, coveragePercent, thresholdOffset, estimatedSavingsRate, risk, delta1, delta2) => {
          const coveragePercentThreshold = coveragePercent + thresholdOffset + 0.0001;

          const onDemandUsd1 = Math.min(delta1, delta2);
          const onDemandUsd2 = Math.max(delta1, delta2);

          const result1 = buildSavingsPlanRecommendation({
            service,
            onDemandUsd: onDemandUsd1,
            coveredUsd: 0,
            coveragePercent,
            coveragePercentThreshold,
            estimatedSavingsRate,
            risk,
          });

          const result2 = buildSavingsPlanRecommendation({
            service,
            onDemandUsd: onDemandUsd2,
            coveredUsd: 0,
            coveragePercent,
            coveragePercentThreshold,
            estimatedSavingsRate,
            risk,
          });

          expect(result1).not.toBeNull();
          expect(result2).not.toBeNull();

          const savings1 = result1!.estimatedMonthlySavingsUsd as number;
          const savings2 = result2!.estimatedMonthlySavingsUsd as number;

          expect(savings2).toBeGreaterThanOrEqual(savings1);
        },
      ),
      { numRuns: 100 },
    );
  });
});
