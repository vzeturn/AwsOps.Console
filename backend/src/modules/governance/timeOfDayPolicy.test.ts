// backend/src/lib/timeOfDayPolicy.test.ts
import { describe, it, expect } from 'vitest';
import {
  analyzePeakWindows,
  decideTimeOfDaySizing,
  computeOffPeakType,
  computePeakType,
  MIN_PEAK_OFFPEAK_RATIO,
  PRE_PEAK_LEAD_MINUTES,
  type HourlyMetricPoint,
  type TimeOfDaySizingInput,
} from './timeOfDayPolicy.js';
import type { FamilySizeInfo } from './ec2Rightsizing.js';

function point(dayOfWeek: number, hour: number, p75CpuPercent: number): HourlyMetricPoint {
  return { dayOfWeek, hour, p75CpuPercent };
}

describe('analyzePeakWindows', () => {
  it('a clear pattern (peak/off-peak ratio >= MIN_PEAK_OFFPEAK_RATIO) -> returns the correct contiguous peak window', () => {
    // Monday (dayOfWeek=1): hours 8-9 have high CPU (60%), other hours are low (10%) -> ratio 6.0 >= 2.0
    const metrics: HourlyMetricPoint[] = [
      point(1, 7, 10),
      point(1, 8, 60),
      point(1, 9, 60),
      point(1, 10, 10),
    ];
    const windows = analyzePeakWindows(metrics);
    expect(windows).toEqual([{ dayOfWeek: 1, startHour: 8, endHour: 10 }]);
  });

  it('a pattern that is not reliable enough (ratio < MIN_PEAK_OFFPEAK_RATIO) -> returns empty, does not guess at a peak', () => {
    // CPU varies only slightly, 15% vs 20% -> ratio 1.33 < 2.0
    const metrics: HourlyMetricPoint[] = [point(1, 8, 20), point(1, 9, 15)];
    expect(analyzePeakWindows(metrics)).toEqual([]);
  });

  it('an empty list -> returns empty', () => {
    expect(analyzePeakWindows([])).toEqual([]);
  });

  it('multiple days of the week with their own peaks -> each day gets its own independent window', () => {
    const metrics: HourlyMetricPoint[] = [
      point(1, 8, 60), point(1, 9, 10),
      point(3, 14, 50), point(3, 15, 5),
    ];
    const windows = analyzePeakWindows(metrics);
    expect(windows).toEqual(
      expect.arrayContaining([
        { dayOfWeek: 1, startHour: 8, endHour: 9 },
        { dayOfWeek: 3, startHour: 14, endHour: 15 },
      ]),
    );
    expect(windows).toHaveLength(2);
  });
});

function baseInput(overrides: Partial<TimeOfDaySizingInput>): TimeOfDaySizingInput {
  return {
    instanceId: 'i-1',
    baselineType: 't3.large',
    currentType: 't3.large',
    metrics: [point(1, 8, 60), point(1, 9, 10)],
    policy: { scaleMarginPercent: 0, minInstanceType: undefined, maxInstanceType: undefined, optOut: false },
    coDirection: 'none',
    ...overrides,
  };
}

describe('decideTimeOfDaySizing', () => {
  it('Compute Optimizer already has an opinion (coDirection is not none) -> always none, does not contend for decision authority', () => {
    expect(decideTimeOfDaySizing(baseInput({ coDirection: 'up' }))).toEqual({ action: 'none' });
    expect(decideTimeOfDaySizing(baseInput({ coDirection: 'down' }))).toEqual({ action: 'none' });
  });

  it('optOut=true (no-auto-sizing tag) -> none even with a clear pattern', () => {
    const input = baseInput({ policy: { scaleMarginPercent: 0, minInstanceType: undefined, maxInstanceType: undefined, optOut: true } });
    expect(decideTimeOfDaySizing(input)).toEqual({ action: 'none' });
  });

  it('a pattern that is not reliable enough -> none', () => {
    const input = baseInput({ metrics: [point(1, 8, 20), point(1, 9, 15)] });
    expect(decideTimeOfDaySizing(input)).toEqual({ action: 'none' });
  });

  it('a clear pattern, coDirection=none, not opted out -> schedulePeak with the correct windows/peakType/offPeakType', () => {
    const result = decideTimeOfDaySizing(baseInput({}));
    expect(result.action).toBe('schedulePeak');
    if (result.action === 'schedulePeak') {
      expect(result.windows).toEqual([{ dayOfWeek: 1, startHour: 8, endHour: 9 }]);
      expect(typeof result.peakType).toBe('string');
      expect(typeof result.offPeakType).toBe('string');
    }
  });
});

function familySize(instanceType: string, size: string, vcpus: number, memoryMiB: number): FamilySizeInfo {
  return { instanceType, size, vcpus, memoryMiB, architectures: ['x86_64'] };
}

describe('computeOffPeakType / computePeakType', () => {
  const t3Family: FamilySizeInfo[] = [
    familySize('t3.small', 'small', 2, 2048),
    familySize('t3.medium', 'medium', 2, 4096),
    familySize('t3.large', 'large', 2, 8192),
    familySize('t3.xlarge', 'xlarge', 4, 16384),
  ];

  it('computeOffPeakType: returns one size smaller within the same family', () => {
    expect(computeOffPeakType('t3.large', t3Family, undefined)).toBe('t3.medium');
  });

  it('computeOffPeakType: blocked by minInstanceType -> does not go below the minimum', () => {
    expect(computeOffPeakType('t3.medium', t3Family, 't3.medium')).toBeUndefined();
  });

  it('computePeakType: returns one size larger within the same family', () => {
    expect(computePeakType('t3.medium', t3Family, undefined)).toBe('t3.large');
  });

  it('computePeakType: blocked by maxInstanceType -> does not exceed the maximum', () => {
    expect(computePeakType('t3.large', t3Family, 't3.large')).toBeUndefined();
  });

  it('no smaller/larger size in the family -> returns undefined', () => {
    expect(computeOffPeakType('t3.small', t3Family, undefined)).toBeUndefined();
    expect(computePeakType('t3.xlarge', t3Family, undefined)).toBeUndefined();
  });
});

describe('constants', () => {
  it('MIN_PEAK_OFFPEAK_RATIO = 2.0, PRE_PEAK_LEAD_MINUTES = 20', () => {
    expect(MIN_PEAK_OFFPEAK_RATIO).toBe(2.0);
    expect(PRE_PEAK_LEAD_MINUTES).toBe(20);
  });
});
