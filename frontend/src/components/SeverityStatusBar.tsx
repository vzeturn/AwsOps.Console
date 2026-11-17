import Box from '@cloudscape-design/components/box';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import type { ThresholdLevel } from '@ops-dashboard/shared';
import { statusIndicatorType } from '../lib/thresholdStatus';

/**
 * The "everything at a glance" strip — a row of colored counts by severity, the pattern every
 * Datadog/CloudWatch-style monitoring page opens with (e.g. "3 critical · 5 warning · 42 ok")
 * instead of making the reader scan a whole table to count how many rows are red. Placed once near
 * the top of a page's `ContentLayout`, above whatever detailed table/tree/chart follows.
 *
 * Counts with 0 are still rendered (not hidden) — "0 critical" is a positive, reassuring signal
 * worth showing, not noise to hide; a monitoring page that only shows non-zero counts risks looking
 * broken/empty when everything is actually fine.
 */
export interface SeverityCounts {
  critical: number;
  warn: number;
  ok: number;
  /** Resources/checks with no threshold verdict at all (e.g. a metric with no sensible universal
   * threshold) — kept separate from `ok` so "healthy" and "not evaluated" are never conflated. */
  unmonitored?: number;
}

const LEVEL_LABEL: Record<ThresholdLevel, string> = {
  critical: 'Critical',
  warn: 'Warning',
  ok: 'OK',
};

export function SeverityStatusBar({ counts }: { counts: SeverityCounts }) {
  const entries: { level: ThresholdLevel; count: number }[] = [
    { level: 'critical', count: counts.critical },
    { level: 'warn', count: counts.warn },
    { level: 'ok', count: counts.ok },
  ];

  return (
    <Box padding={{ vertical: 'xs' }}>
      <SpaceBetween direction="horizontal" size="l">
        {entries.map(({ level, count }) => (
          <SpaceBetween key={level} direction="horizontal" size="xs" alignItems="center">
            <StatusIndicator type={statusIndicatorType(level)}>
              <Box fontWeight="bold" fontSize="heading-m" display="inline">
                {count}
              </Box>{' '}
              {LEVEL_LABEL[level]}
            </StatusIndicator>
          </SpaceBetween>
        ))}
        {counts.unmonitored != null && counts.unmonitored > 0 && (
          <SpaceBetween direction="horizontal" size="xs" alignItems="center">
            <StatusIndicator type="info">
              <Box fontWeight="bold" fontSize="heading-m" display="inline">
                {counts.unmonitored}
              </Box>{' '}
              Unmonitored
            </StatusIndicator>
          </SpaceBetween>
        )}
      </SpaceBetween>
    </Box>
  );
}
