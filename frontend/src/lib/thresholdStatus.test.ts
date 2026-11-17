import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type { ThresholdLevel } from '@ops-dashboard/shared';
import { statusIndicatorType } from './thresholdStatus';

describe('statusIndicatorType', () => {
  it('maps every ThresholdLevel to the corresponding Cloudscape StatusIndicator type', () => {
    expect(statusIndicatorType('ok')).toBe('success');
    expect(statusIndicatorType('warn')).toBe('warning');
    expect(statusIndicatorType('critical')).toBe('error');
  });

  it('never returns the same Cloudscape type for two different ThresholdLevels (no information loss)', () => {
    const levels: ThresholdLevel[] = ['ok', 'warn', 'critical'];
    const mapped = levels.map(statusIndicatorType);
    expect(new Set(mapped).size).toBe(levels.length);
  });

  it('is a total, pure function over the ThresholdLevel domain — never throws for any valid level', () => {
    fc.assert(
      fc.property(fc.constantFrom<ThresholdLevel>('ok', 'warn', 'critical'), (level) => {
        expect(() => statusIndicatorType(level)).not.toThrow();
      }),
    );
  });
});
