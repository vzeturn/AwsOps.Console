/**
 * `idle-scheduler-naming.ts` — the ONE place that defines how a resource-group's dedicated wake
 * alarm is named, shared by `idle-scheduler-mutate-handler.ts` (creates the alarm) and
 * `idle-scheduler-wake.ts` (parses the ALB name back out of an incoming alarm notification) so
 * the two can never drift out of sync with each other.
 */

/** CloudWatch Alarm names are capped at 255 characters and this prefix + a typical ALB name stays
 * well within that — no truncation handling needed. */
export const WAKE_ALARM_NAME_PREFIX = 'idle-scheduler-wake-';

export function buildWakeAlarmName(albName: string): string {
  return `${WAKE_ALARM_NAME_PREFIX}${albName}`;
}

/** Inverse of `buildWakeAlarmName` — returns `undefined` when `alarmName` doesn't match the
 * convention (e.g. some unrelated alarm happened to be on the same SNS topic). */
export function albNameFromWakeAlarmName(alarmName: string): string | undefined {
  if (!alarmName.startsWith(WAKE_ALARM_NAME_PREFIX)) return undefined;
  const albName = alarmName.slice(WAKE_ALARM_NAME_PREFIX.length);
  return albName.length > 0 ? albName : undefined;
}
