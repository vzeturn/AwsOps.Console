import type { StatusIndicatorProps } from '@cloudscape-design/components/status-indicator';
import type { ThresholdLevel } from '@ops-dashboard/shared';

/** Maps the shared `ThresholdLevel` (ok/warn/critical) onto Cloudscape's own `StatusIndicator`
 * type vocabulary — kept in one place so every page renders the same status color/icon for the
 * same level, rather than each page re-deciding the mapping. */
export function statusIndicatorType(level: ThresholdLevel): StatusIndicatorProps.Type {
  switch (level) {
    case 'ok':
      return 'success';
    case 'warn':
      return 'warning';
    case 'critical':
      return 'error';
  }
}
