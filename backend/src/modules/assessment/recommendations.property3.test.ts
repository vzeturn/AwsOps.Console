import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { classifyByState } from './recommendations.js';
import type { RiskLevel } from '@ops-dashboard/shared';

const RISK_LEVELS: RiskLevel[] = ['low', 'medium', 'high'];

// Feature: infra-review-dashboard-revamp, Property 3: Candidate missing a lifecycle policy
describe('Property 3: Candidate missing a lifecycle policy', () => {
  it('S3 bucket without a lifecycle policy appears as a candidate; with one, it does not', () => {
    fc.assert(
      fc.property(
        fc.record({
          resourceId: fc.string({ minLength: 1, maxLength: 40 }),
          resourceType: fc.constant('s3-bucket'),
          resourceName: fc.string({ minLength: 1, maxLength: 40 }),
          hasLifecyclePolicy: fc.boolean(),
          action: fc.string({ minLength: 1, maxLength: 60 }),
          risk: fc.constantFrom(...RISK_LEVELS),
        }),
        ({ resourceId, resourceType, resourceName, hasLifecyclePolicy, action, risk }) => {
          const result = classifyByState({
            resourceId,
            resourceType,
            resourceName,
            isBadState: !hasLifecyclePolicy,
            category: 'storage',
            action,
            risk,
            findingType: 's3BucketNoLifecyclePolicy',
          });

          if (hasLifecyclePolicy === false) {
            // A bucket missing a lifecycle policy SHALL appear in the recommendation list.
            expect(result).not.toBeNull();
            expect(result?.resourceId).toBe(resourceId);
            expect(result?.category).toBe('storage');
          } else {
            // A bucket that already has a lifecycle policy SHALL NOT appear in the recommendation list.
            expect(result).toBeNull();
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
