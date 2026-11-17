import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { buildProtectionGapFinding } from './recommendations.js';

// Feature: infra-review-dashboard-revamp, Property 8: Records a risk/protection gap for a production resource
// Validates: Requirements 2.3, 6.2

// resourceId/resourceName/resourceType/reason represent real identifiers/content — empty strings
// are allowed since buildProtectionGapFinding does not enforce a non-empty constraint, it only
// checks isProduction/hasProtection.
const stringArb = fc.string({ maxLength: 40 });

describe('Property 8: Records a risk/protection gap for a production resource', () => {
  it('returns a ProtectionGap referencing the correct resource when isProduction = true and hasProtection = false; otherwise returns null', () => {
    fc.assert(
      fc.property(
        stringArb,
        stringArb,
        stringArb,
        stringArb,
        fc.boolean(),
        fc.boolean(),
        (resourceId, resourceName, resourceType, reason, isProduction, hasProtection) => {
          const result = buildProtectionGapFinding({
            resourceId,
            resourceName,
            resourceType,
            isProduction,
            hasProtection,
            reason,
          });

          if (isProduction && !hasProtection) {
            expect(result).not.toBeNull();
            expect(result!.resourceId).toBe(resourceId);
            expect(result!.resourceName).toBe(resourceName);
            expect(result!.resourceType).toBe(resourceType);
            expect(result!.reason).toBe(reason);
          } else {
            expect(result).toBeNull();
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
