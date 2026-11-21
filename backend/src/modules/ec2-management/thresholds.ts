import type { ThresholdMeta } from '@ops-dashboard/shared';

/** Evaluates a value against a warn/critical threshold pair — shared across all tabs. */
export function evalThreshold(
  value: number,
  { warnAt, criticalAt, direction, okReason, warnReason, criticalReason }: {
    warnAt: number;
    criticalAt: number;
    /** 'above' = exceeding the threshold is bad (e.g. unhealthy targets); 'below' = falling below the threshold is bad (e.g. free storage). */
    direction: 'above' | 'below';
    okReason: string;
    warnReason: string;
    criticalReason: string;
  },
): ThresholdMeta {
  const isCritical = direction === 'above' ? value >= criticalAt : value <= criticalAt;
  const isWarn = direction === 'above' ? value >= warnAt : value <= warnAt;

  if (isCritical) return { level: 'critical', reason: criticalReason };
  if (isWarn) return { level: 'warn', reason: warnReason };
  return { level: 'ok', reason: okReason };
}

export function stateThreshold(state: string, badStates: string[], warnStates: string[] = []): ThresholdMeta {
  if (badStates.includes(state)) return { level: 'critical', reason: `State: ${state}` };
  if (warnStates.includes(state)) return { level: 'warn', reason: `State: ${state}` };
  return { level: 'ok', reason: `State: ${state}` };
}

/**
 * Tag key that opts a resource OUT of its automatically-computed state/health threshold on the
 * Infra Map — for cases where the "bad" state is actually expected/intentional rather than an
 * incident:
 *
 *   - an EC2 instance deliberately left `stopped` (a seasonal/one-off resource, e.g.
 *     `abc-uat-ec2-pentest`, `abc-prod-ec2-luckydraw-*`, `abc-prod-ec2-dms` — none of these are
 *     meant to be running continuously, so `stateThreshold`'s `critical` for "stopped" is a false
 *     positive for them specifically);
 *   - an ALB whose targets are unhealthy only because the idle-to-zero scheduler
 *     (`modules/idle-scheduler/`, a first-class ops-dashboard feature — see `idleScheduler.ts` in
 *     shared; replaces the retired standalone `infra/stg-idle-scheduler.yaml` stack) has stopped
 *     the app instance behind it to save cost — that is the scheduler working as designed, not an
 *     outage.
 *
 * Presence-based (the value is ignored), matching the existing `ops-dashboard:no-auto-sizing`
 * convention (`lib/s3PolicyStore.ts`) rather than inventing a different tag style.
 *
 * Deliberately does NOT touch CloudWatch Alarms/GuardDuty — this only affects what `Infra Map`
 * displays for the tagged resource. A resource excluded here that DOES need a real CloudWatch
 * alarm should still get one via `alarm-baseline-manager`'s own
 * `ALARM_BASELINE_EXCLUDED_RESOURCES` (a deliberately separate exclusion list, since "hide from
 * this one dashboard tile" and "stop paging alert hub" are different decisions).
 */
// RENAMED to PascalCase 2026-10-08 (tag-standard rollout) — was 'ops-dashboard:monitoring-exempt'.
// Deliberately a separate literal, not `${TAG_PREFIX}:monitoring-exempt` (this module stays a
// pure, env-var-free function module — see the file's own design note) — if `TAG_PREFIX` is ever
// overridden away from the 'OpsDashboard' default, update this literal's prefix to match by hand.
export const MONITORING_EXEMPT_TAG_KEY = 'OpsDashboard:MonitoringExempt';

/**
 * Applies `MONITORING_EXEMPT_TAG_KEY` on top of an already-computed `ThresholdMeta` — downgrades
 * a `critical`/`warn` to `ok` when the tag is present, keeping the ORIGINAL reason visible
 * (prefixed) so the exemption is auditable on the dashboard itself rather than silently hiding
 * the real state. No-op when the tag is absent, or when the threshold is already `ok` (nothing to
 * downgrade).
 */
export function applyMonitoringExemption(threshold: ThresholdMeta, tags: Record<string, string> | undefined): ThresholdMeta {
  if (threshold.level === 'ok') return threshold;
  if (!tags || !(MONITORING_EXEMPT_TAG_KEY in tags)) return threshold;
  return { level: 'ok', reason: `Exempt (${MONITORING_EXEMPT_TAG_KEY}) — was: ${threshold.reason}` };
}

/**
 * `evalRangeThreshold` (spec `realtime-monitoring-dashboard`) — a NEW, additive function. Does NOT
 * modify `evalThreshold`/`stateThreshold` above. Used for the 2-tier warn/critical case that
 * shares a single `direction` — e.g. CPUUtilization, mem/disk %, latency — with a leaner signature
 * than `evalThreshold`: no need to pass 3 custom `reason` strings, `reason` is auto-generated from
 * the value/threshold that was exceeded.
 */
export function evalRangeThreshold(
  value: number,
  { warnAt, criticalAt, direction }: {
    warnAt: number;
    criticalAt: number;
    /** 'above' = exceeding the threshold is bad (e.g. CPU%); 'below' = falling below the threshold is bad (e.g. free storage %). */
    direction: 'above' | 'below';
  },
): ThresholdMeta {
  const isCritical = direction === 'above' ? value >= criticalAt : value <= criticalAt;
  const isWarn = direction === 'above' ? value >= warnAt : value <= warnAt;
  const symbol = direction === 'above' ? '>=' : '<=';

  if (isCritical) return { level: 'critical', reason: `${value} ${symbol} ${criticalAt}` };
  if (isWarn) return { level: 'warn', reason: `${value} ${symbol} ${warnAt}` };
  return { level: 'ok', reason: `${value} within normal range` };
}
