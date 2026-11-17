import type { MetricTrendPoint } from '@ops-dashboard/shared';

// ---- Metric_Trend (Requirement 13.1) ----

/** The maximum width of Metric_Trend — the most recent 60 minutes as of the current refresh time
 * (Requirement 13.1, Property 11). The "at least 15 minutes" mark is a CloudWatch `StartTime`
 * parameter required by the caller (Task 3.10), not a filter condition of this pure function —
 * see the task 3.8 description. */
export const METRIC_TREND_WINDOW_MS = 60 * 60 * 1000;

/**
 * Trims the `GetMetricData`-returned datapoint array down to the most recent 60-minute window as
 * of `now`, re-sorts ascending by time (in case the caller passes in an unsorted array — the
 * source array is assumed already sorted by time, but this function re-sorts defensively rather
 * than relying on the caller getting it right), then maps to `MetricTrendPoint[]` (ISO string
 * timestamp). Never returns a point with a timestamp in the future relative to `now` (Property 11).
 */
export function buildMetricTrend(datapoints: { timestamp: Date; value: number }[], now: Date): MetricTrendPoint[] {
  const nowMs = now.getTime();
  const windowStartMs = nowMs - METRIC_TREND_WINDOW_MS;

  return datapoints
    .filter((point) => {
      const pointMs = point.timestamp.getTime();
      return pointMs <= nowMs && pointMs >= windowStartMs;
    })
    .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
    .map((point) => ({ timestamp: point.timestamp.toISOString(), value: point.value }));
}
