import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { classifyByState } from './recommendations.js';
import type { RiskLevel, ServiceCategory } from '@ops-dashboard/shared';

const RISK_LEVELS: RiskLevel[] = ['low', 'medium', 'high'];
const SERVICE_CATEGORIES: ServiceCategory[] = [
  'compute',
  'database',
  'networking',
  'storage',
  'serverless',
  'savingsPlans',
  'backup',
];

// Feature: infra-review-dashboard-revamp, Property 2: Classifies by a bad resource state
// Validates: Requirements 1.4, 3.4, 4.3
describe('Property 2: Classifies by a bad resource state', () => {
  it('returns a RecommendationItem when isBadState = true, and null when isBadState = false', () => {
    fc.assert(
      fc.property(
        fc.record({
          resourceId: fc.string({ minLength: 1, maxLength: 40 }),
          resourceType: fc.string({ minLength: 1, maxLength: 30 }),
          resourceName: fc.string({ minLength: 1, maxLength: 40 }),
          isBadState: fc.boolean(),
          category: fc.constantFrom(...SERVICE_CATEGORIES),
          action: fc.string({ minLength: 1, maxLength: 60 }),
          risk: fc.constantFrom(...RISK_LEVELS),
        }),
        ({ resourceId, resourceType, resourceName, isBadState, category, action, risk }) => {
          const result = classifyByState({
            resourceId,
            resourceType,
            resourceName,
            isBadState,
            category,
            action,
            risk,
            findingType: 'ec2Stopped',
          });

          if (isBadState) {
            // A bad resource state (EC2 stopped, EBS unattached, ALB with all targets
            // unhealthy, S3 missing a lifecycle policy) SHALL produce a RecommendationItem
            // referencing the correct resource.
            expect(result).not.toBeNull();
            expect(result?.resourceId).toBe(resourceId);
            expect(result?.resourceType).toBe(resourceType);
            expect(result?.resourceName).toBe(resourceName);
            expect(result?.category).toBe(category);
            expect(result?.recommendedAction).toBe(action);
            expect(result?.risk).toBe(risk);
          } else {
            // A normal resource state SHALL NOT produce a recommendation.
            expect(result).toBeNull();
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
