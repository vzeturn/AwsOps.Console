// backend/src/collectors/time-of-day-collector.ts
import { GetMetricDataCommand, type CloudWatchClient } from '@aws-sdk/client-cloudwatch';
import { PATCH_TIMEZONE } from '../modules/ec2-management/tagConventions.js';
import type { HourlyMetricPoint } from '../modules/governance/timeOfDayPolicy.js';
import { logger } from '../shared-kernel/logger.js';

/** The hour-of-day pattern survey window — 60 days (wider than `ec2-collector.ts`'s
 * `SURVEY_PERIOD_DAYS=30` because it needs enough samples for EACH distinct (dayOfWeek, hour) pair,
 * not a single overall average). */
const HOURLY_SURVEY_PERIOD_DAYS = 60;
const HOURLY_PERIOD_SECONDS = 3600;

const WEEKDAY_FORMATTER = new Intl.DateTimeFormat('en-US', { timeZone: PATCH_TIMEZONE, weekday: 'short' });
const HOUR_FORMATTER = new Intl.DateTimeFormat('en-US', { timeZone: PATCH_TIMEZONE, hour: 'numeric', hour12: false });
const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function dayOfWeekInTz(date: Date): number {
  return WEEKDAY_INDEX[WEEKDAY_FORMATTER.format(date)] ?? 0;
}

function hourInTz(date: Date): number {
  const raw = HOUR_FORMATTER.format(date);
  const hour = raw === '24' ? 0 : Number(raw);
  return Number.isFinite(hour) ? hour : 0;
}

function percentile75(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.75) - 1);
  return sorted[Math.max(0, index)] ?? 0;
}

/**
 * Fetches hourly CPUUtilization (`Period: 3600`) over 60 days for one instance, grouped by
 * `(dayOfWeek, hour)` in `PATCH_TIMEZONE`, computing p75 per group — the raw data for
 * `timeOfDayPolicy.ts::analyzePeakWindows`. Wraps errors following the same pattern as
 * `ec2-collector.ts::loadInstanceMetrics`: a CloudWatch error does not throw, it returns empty (the
 * caller treats this as "not enough data" and does NOT guess at a pattern).
 */
export async function collectHourlyMetrics(
  cloudwatch: CloudWatchClient,
  instanceId: string,
  endTime: Date,
): Promise<HourlyMetricPoint[]> {
  const startTime = new Date(endTime.getTime() - HOURLY_SURVEY_PERIOD_DAYS * 24 * 60 * 60 * 1000);

  try {
    const { MetricDataResults = [] } = await cloudwatch.send(
      new GetMetricDataCommand({
        MetricDataQueries: [
          {
            Id: 'cpu',
            MetricStat: {
              Metric: { Namespace: 'AWS/EC2', MetricName: 'CPUUtilization', Dimensions: [{ Name: 'InstanceId', Value: instanceId }] },
              Period: HOURLY_PERIOD_SECONDS,
              Stat: 'Average',
            },
            ReturnData: true,
          },
        ],
        StartTime: startTime,
        EndTime: endTime,
      }),
    );

    const result = MetricDataResults.find((r) => r.Id === 'cpu');
    const timestamps = result?.Timestamps ?? [];
    const values = result?.Values ?? [];

    const grouped = new Map<string, number[]>();
    for (let i = 0; i < timestamps.length; i++) {
      const ts = timestamps[i];
      const value = values[i];
      if (!ts || typeof value !== 'number') continue;
      const key = `${dayOfWeekInTz(ts)}:${hourInTz(ts)}`;
      const list = grouped.get(key) ?? [];
      list.push(value);
      grouped.set(key, list);
    }

    const points: HourlyMetricPoint[] = [];
    for (const [key, list] of grouped) {
      const [dayOfWeekStr, hourStr] = key.split(':');
      points.push({ dayOfWeek: Number(dayOfWeekStr), hour: Number(hourStr), p75CpuPercent: percentile75(list) });
    }
    return points;
  } catch (err) {
    logger.error(`time-of-day-collector: GetMetricData failed for ${instanceId} (skipping, returning empty)`, err);
    return [];
  }
}
