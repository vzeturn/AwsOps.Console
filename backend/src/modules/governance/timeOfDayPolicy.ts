// backend/src/lib/timeOfDayPolicy.ts
import type { AutoRightsizeDirection } from './ec2AutoRightsizing.js';
import { pickSmallerFamilySize, pickLargerFamilySize, type FamilySizeInfo } from './ec2Rightsizing.js';

/**
 * A PURE module (no AWS SDK calls) — decides the resize schedule based on hour-of-day/day-of-week
 * patterns, kept separate from data collection (`time-of-day-collector.ts`) and execution
 * (`time-of-day-trigger.ts` invoking `DownsizeSchedulerFunction`). Follows the same pattern as
 * `ec2AutoRightsizing.ts`/`rightsize-decision.ts` already established in the project.
 */

export interface HourlyMetricPoint {
  dayOfWeek: number; // 0=Sunday..6=Saturday, in PATCH_TIMEZONE
  hour: number; // 0-23
  p75CpuPercent: number;
}

export interface PeakWindow {
  dayOfWeek: number;
  startHour: number; // peak start hour (inclusive)
  endHour: number; // peak end hour (exclusive)
}

export interface TeamPolicyOverride {
  scaleMarginPercent: number;
  minInstanceType: string | undefined;
  maxInstanceType: string | undefined;
  optOut: boolean;
}

export interface TimeOfDaySizingInput {
  instanceId: string;
  baselineType: string;
  currentType: string;
  metrics: HourlyMetricPoint[];
  policy: TeamPolicyOverride;
  coDirection: AutoRightsizeDirection | 'none';
}

export type TimeOfDaySizingDecision =
  | { action: 'none' }
  | {
      action: 'schedulePeak';
      windows: PeakWindow[];
      peakType: string;
      offPeakType: string;
      /** The ORIGINAL size (between offPeakType and peakType) used as the reference point to compute
       * the two values above — kept so the NEXT run can read it directly as the new baseline, instead
       * of having to derive it backwards from offPeakType/peakType (deriving it backwards in the
       * wrong direction previously caused an unbounded downward ratchet — see Fix round 2). Optional
       * for backward compatibility with old records already saved on S3 before this field existed
       * (JSON.parse returns `undefined` for a missing field, and the caller falls back to
       * `item.instanceType` as it would when there was no prior schedule). */
      baselineType?: string;
    };

/** Minimum p75(peak) / p75(off-peak) ratio for a pattern to be considered reliable enough — below
 * this threshold, the variation is not clear enough to automate, avoiding resizes based on noise. */
export const MIN_PEAK_OFFPEAK_RATIO = 2.0;

/** Minutes before peak starts to trigger an early resize — enough time for the stop->modify->start cycle. */
export const PRE_PEAK_LEAD_MINUTES = 20;

/** Merges consecutive hours within the SAME day whose p75CpuPercent reaches the peak threshold (>=
 * that day's baseline multiplied by MIN_PEAK_OFFPEAK_RATIO) into a single PeakWindow [startHour,
 * endHour). A day with fewer than 2 data points, or without a strong enough CPU swing between
 * high/low hours, produces no window. */
export function analyzePeakWindows(metrics: HourlyMetricPoint[]): PeakWindow[] {
  const byDay = new Map<number, HourlyMetricPoint[]>();
  for (const m of metrics) {
    const list = byDay.get(m.dayOfWeek) ?? [];
    list.push(m);
    byDay.set(m.dayOfWeek, list);
  }

  const windows: PeakWindow[] = [];
  for (const [dayOfWeek, points] of byDay) {
    if (points.length < 2) continue;
    const offPeakBaseline = Math.min(...points.map((p) => p.p75CpuPercent));
    if (offPeakBaseline <= 0) continue; // avoid division by zero — treated as not reliable enough to compute a ratio
    const peakThreshold = offPeakBaseline * MIN_PEAK_OFFPEAK_RATIO;
    const peakHours = points.filter((p) => p.p75CpuPercent >= peakThreshold).map((p) => p.hour).sort((a, b) => a - b);
    if (peakHours.length === 0) continue;

    // Merge consecutive hours into a single window — does not merge across midnight (kept simple, matches spec scope).
    let startHour = peakHours[0]!;
    let prevHour = peakHours[0]!;
    for (let i = 1; i <= peakHours.length; i++) {
      const hour = peakHours[i];
      if (hour !== undefined && hour === prevHour + 1) {
        prevHour = hour;
        continue;
      }
      windows.push({ dayOfWeek, startHour, endHour: prevHour + 1 });
      if (hour !== undefined) {
        startHour = hour;
        prevHour = hour;
      }
    }
  }

  return windows;
}

/** Priority rule: if Compute Optimizer already has an official opinion (coDirection !== 'none'),
 * time-of-day NEVER acts — avoids contending for decision authority with AWS's official data. Also
 * none if optOut is set or the pattern is not reliable enough (analyzePeakWindows returns empty). */
export function decideTimeOfDaySizing(input: TimeOfDaySizingInput): TimeOfDaySizingDecision {
  if (input.coDirection !== 'none') return { action: 'none' };
  if (input.policy.optOut) return { action: 'none' };

  const windows = analyzePeakWindows(input.metrics);
  if (windows.length === 0) return { action: 'none' };

  return {
    action: 'schedulePeak',
    windows,
    // peakType/offPeakType are computed by the caller (assessment-report-builder.ts, which needs
    // fetchFamilySizes from AWS) via computePeakType/computeOffPeakType — this is just a temporary
    // placeholder in the pure decision, since the caller overwrites these two fields after computing
    // them (see Task 3).
    peakType: input.currentType,
    offPeakType: input.currentType,
    // baselineType is NOT used to decide schedulePeak/none (that decision only depends on
    // windows.length/coDirection/policy.optOut above) — it's only plumbed through so the caller can
    // write it back to the PolicyStore, for the next run to read directly as the new reference point
    // (see TimeOfDaySizingDecision).
    baselineType: input.baselineType,
  };
}

/** One size smaller within the SAME family relative to `currentInstanceType`, used for off-peak.
 * `familySizes` MUST be the result of `fetchFamilySizes(ec2, family)` for the CORRECT family
 * containing `currentInstanceType` (the caller is responsible for fetching it — this function does
 * not call the AWS SDK itself, to stay pure). Returns `undefined` if there is no smaller size in the
 * family, or if that smaller size would violate `minType` (smaller than the lower bound allowed by
 * the `ops-dashboard:min-instance-type` tag). */
export function computeOffPeakType(
  currentInstanceType: string,
  familySizes: readonly FamilySizeInfo[],
  minType: string | undefined,
): string | undefined {
  const smaller = pickSmallerFamilySize(currentInstanceType, familySizes);
  if (!smaller) return undefined;
  if (minType) {
    const minSize = familySizes.find((f) => f.instanceType === minType);
    // Compares using the SAME ordering (vcpus then memoryMiB) that pickSmallerFamilySize uses to
    // rank sizes — comparing vcpus alone misses the case where two sizes share the same vcpus but
    // differ in memory (e.g. t3.small/t3.medium both have 2 vCPUs, only memory differs), which would
    // let a size smaller than min slip past the guard.
    if (minSize && (smaller.vcpus < minSize.vcpus || (smaller.vcpus === minSize.vcpus && smaller.memoryMiB < minSize.memoryMiB))) {
      return undefined;
    }
  }
  return smaller.instanceType;
}

/** One size larger within the SAME family relative to `currentInstanceType`, used for peak. Same
 * `familySizes`-fetched-by-caller principle as `computeOffPeakType`. Returns `undefined` if there is
 * no larger size, or if it would exceed the `maxType` limit (the `ops-dashboard:max-instance-type`
 * tag). */
export function computePeakType(
  currentInstanceType: string,
  familySizes: readonly FamilySizeInfo[],
  maxType: string | undefined,
): string | undefined {
  const larger = pickLargerFamilySize(currentInstanceType, familySizes);
  if (!larger) return undefined;
  if (maxType) {
    const maxSize = familySizes.find((f) => f.instanceType === maxType);
    // Symmetric reasoning to computeOffPeakType: compares using the exact ordering (vcpus then
    // memoryMiB) that pickLargerFamilySize uses, avoiding the case of same vcpus but different memory.
    if (maxSize && (larger.vcpus > maxSize.vcpus || (larger.vcpus === maxSize.vcpus && larger.memoryMiB > maxSize.memoryMiB))) {
      return undefined;
    }
  }
  return larger.instanceType;
}
