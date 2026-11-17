import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { RiskLevel } from '@ops-dashboard/shared';
import { computePriority } from './recommendations.js';

// Feature: infra-review-dashboard-revamp, Property 5: Assigns priority monotonically by savings and risk
// Validates: Requirements 7.3

const riskArb: fc.Arbitrary<RiskLevel> = fc.constantFrom('low', 'medium', 'high');

// Risk score scale: lower risk -> higher score (risk is "no riskier" when its score >= the other's).
const RISK_SCORE: Record<RiskLevel, number> = { high: 0, medium: 1, low: 2 };

// Priority score scale for comparing order low < medium < high.
const PRIORITY_SCORE: Record<'low' | 'medium' | 'high', number> = { low: 0, medium: 1, high: 2 };

describe('computePriority — Property 5', () => {
  it('increasing savings or decreasing risk never decreases priority', () => {
    fc.assert(
      fc.property(
        // savings: uses a non-negative offset to ensure savings' >= savings (null treated as 0).
        fc.option(fc.float({ min: 0, max: 1_000_000, noNaN: true }), { nil: null }),
        fc.float({ min: 0, max: 1_000_000, noNaN: true }),
        riskArb,
        riskArb,
        (savings, savingsOffset, risk, riskPrime) => {
          // risk' must be "no riskier" than risk: RISK_SCORE[riskPrime] >= RISK_SCORE[risk].
          // Picks the pair (riskLower, riskHigherOrEqual) by score so the condition always holds.
          const riskA = RISK_SCORE[risk] <= RISK_SCORE[riskPrime] ? risk : riskPrime;
          const riskB = RISK_SCORE[risk] <= RISK_SCORE[riskPrime] ? riskPrime : risk;
          // riskA has a score <= riskB (riskB is no riskier than riskA)

          const savingsBase = savings ?? 0;
          const savingsPrime = savingsBase + savingsOffset;

          const priorityBase = computePriority(savings, riskA);
          const priorityPrime = computePriority(savingsPrime, riskB);

          expect(PRIORITY_SCORE[priorityPrime]).toBeGreaterThanOrEqual(PRIORITY_SCORE[priorityBase]);
        },
      ),
      { numRuns: 100 },
    );
  });
});
