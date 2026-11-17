/**
 * `ec2Uptime.ts` — pure function shared between `alarm-baseline-manager.ts` (warm-up alarm after
 * an instance just started, to avoid false CPU/StatusCheckFailed alerts during boot) and
 * `patch-scheduler.ts` (only patch instances that have been running stably for >= 30 minutes).
 * Split out so the two modules don't drift on how they compute uptime.
 *
 * Does NOT depend on the AWS SDK/network — safe to import from any Lambda, easy to unit test.
 */

/** Number of minutes the instance has been running continuously, from `launchTime` to `now`. Can
 * be negative if `launchTime` is in the future relative to `now` (abnormal data) — the caller
 * decides how to handle that; this function only does the pure calculation, no validation. */
export function computeUptimeMinutes(launchTime: Date, now: Date): number {
  return (now.getTime() - launchTime.getTime()) / (60 * 1000);
}
