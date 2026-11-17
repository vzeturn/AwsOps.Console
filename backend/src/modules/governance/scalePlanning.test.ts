import { describe, expect, it } from 'vitest';
import { computeEcsScaleOutTarget, computeRdsStorageIncreaseTarget } from './scalePlanning.js';

describe('computeEcsScaleOutTarget', () => {
  it('increases by at least 1 task when the current desiredCount is 1', () => {
    expect(computeEcsScaleOutTarget(1, undefined)).toBe(2);
  });

  it('increases by 50% (rounded up) when the current desiredCount > 1', () => {
    expect(computeEcsScaleOutTarget(4, undefined)).toBe(6); // +2 (50% of 4)
    expect(computeEcsScaleOutTarget(3, undefined)).toBe(5); // +2 (ceil(1.5))
  });

  it('does not exceed the maxCapacity registered in Application Auto Scaling', () => {
    expect(computeEcsScaleOutTarget(10, 11)).toBe(11);
    expect(computeEcsScaleOutTarget(10, 10)).toBe(10); // already at max, cannot increase further
  });

  it('does not exceed MAX_DESIRED_COUNT_HARD_CAP when there is no maxCapacity', () => {
    expect(computeEcsScaleOutTarget(40, undefined)).toBe(50);
  });
});

describe('computeRdsStorageIncreaseTarget', () => {
  it('increases by exactly 20% (rounded up) per AWS recommendation', () => {
    expect(computeRdsStorageIncreaseTarget(100)).toBe(120);
    expect(computeRdsStorageIncreaseTarget(50)).toBe(60);
  });

  it('rounds up when the result is not an integer', () => {
    expect(computeRdsStorageIncreaseTarget(25)).toBe(30); // 25 * 1.2 = 30 (already an integer)
    expect(computeRdsStorageIncreaseTarget(33)).toBe(40); // 33 * 1.2 = 39.6 -> 40
  });
});
