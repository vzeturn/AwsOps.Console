/**
 * `idle-scheduler-logic.ts` — PURE functions for the Idle-to-Zero feature (no AWS SDK calls), kept
 * separate from the Lambda entrypoints (`idle-scheduler-tick.ts`/`idle-scheduler-watchdog.ts`) so
 * the decision logic is unit-testable without mocking `@aws-sdk/*`, following the same split this
 * codebase already uses for `patchScheduling.ts`/`ec2AutoRightsizing.ts` vs their applier Lambdas.
 */

import {
  DEFAULT_IDLE_MINUTES,
  DEFAULT_GRACE_MINUTES,
  IDLE_SCHEDULER_MANAGED_TAG_KEY,
  IDLE_SCHEDULER_EC2_INSTANCE_ID_TAG_KEY,
  IDLE_SCHEDULER_RDS_INSTANCE_ID_TAG_KEY,
  IDLE_SCHEDULER_IDLE_MINUTES_TAG_KEY,
  IDLE_SCHEDULER_HOLD_TAG_KEY,
} from '@ops-dashboard/shared';

/** One resource-group as discovered from an ALB's own tags — the tag-driven "registry" this
 * feature reads instead of a database or a hardcoded CloudFormation parameter (see
 * `idleScheduler.ts`'s file header for the full rationale). `undefined` fields mean the ALB
 * carries `IDLE_SCHEDULER_MANAGED_TAG_KEY=true` but is missing a REQUIRED companion tag — callers
 * must treat that as a misconfigured group (log + skip), never guess a value. */
export interface DiscoveredGroupTags {
  ec2InstanceId: string | undefined;
  rdsInstanceId: string | undefined;
  idleMinutes: number;
}

/** Parses one ALB's tag set into a `DiscoveredGroupTags`, or `undefined` when the ALB is not
 * opted into idle-to-zero at all (`IDLE_SCHEDULER_MANAGED_TAG_KEY` absent or not `"true"` —
 * presence-AND-value-based, unlike the presence-only `ops-dashboard:monitoring-exempt`
 * convention, because this tag also has to survive being copied/templated across ALBs without
 * accidentally opting one in with a stray empty value). */
export function parseManagedGroupTags(tags: Record<string, string>): DiscoveredGroupTags | undefined {
  if (tags[IDLE_SCHEDULER_MANAGED_TAG_KEY] !== 'true') return undefined;

  const idleMinutesRaw = tags[IDLE_SCHEDULER_IDLE_MINUTES_TAG_KEY];
  const parsedIdleMinutes = idleMinutesRaw !== undefined ? Number(idleMinutesRaw) : NaN;

  return {
    ec2InstanceId: tags[IDLE_SCHEDULER_EC2_INSTANCE_ID_TAG_KEY],
    rdsInstanceId: tags[IDLE_SCHEDULER_RDS_INSTANCE_ID_TAG_KEY],
    idleMinutes: Number.isFinite(parsedIdleMinutes) && parsedIdleMinutes > 0 ? parsedIdleMinutes : DEFAULT_IDLE_MINUTES,
  };
}

export type IdleStopSkipReason = 'misconfigured' | 'hold' | 'not-running' | 'grace-period' | 'active';
export type IdleStopDecision = { action: 'skip'; reason: IdleStopSkipReason } | { action: 'stop' };

/**
 * Decides whether ONE resource-group should be stopped on this tick — mirrors the exact decision
 * order the retired `abc-stg-idle-stop` Lambda used (hold tag first, then EC2 state, then grace
 * period, then request count), generalized to work for ANY tag-discovered group rather than one
 * hardcoded instance.
 */
export function decideIdleStop(params: {
  ec2State: string;
  ec2LaunchTime: Date | undefined;
  held: boolean;
  idleMinutes: number;
  requestsInIdleWindow: number;
  now: Date;
  graceMinutes?: number;
}): IdleStopDecision {
  const graceMinutes = params.graceMinutes ?? DEFAULT_GRACE_MINUTES;

  // IT-21 precedent, generalized: a deploy/migration pipeline holding the instance always wins,
  // regardless of what else is true about it.
  if (params.held) return { action: 'skip', reason: 'hold' };

  if (params.ec2State !== 'running') return { action: 'skip', reason: 'not-running' };

  if (params.ec2LaunchTime) {
    const ageMinutes = (params.now.getTime() - params.ec2LaunchTime.getTime()) / 60_000;
    if (ageMinutes < graceMinutes) return { action: 'skip', reason: 'grace-period' };
  }

  if (params.requestsInIdleWindow > 0) return { action: 'skip', reason: 'active' };

  return { action: 'stop' };
}

export type WakeDecision = { action: 'start-ec2' | 'skip-ec2'; reason?: string };

/** Decides whether the wake path should actually call `StartInstances`/`StartDBInstance` for one
 * resource — a no-op when the resource is already running/available/pending a state change
 * (mirrors the retired `abc-stg-wake` Lambda's own idempotency check, generalized to any state
 * string rather than one hardcoded pair of resources). */
export function shouldStart(currentState: string, stoppedStateValue: string): boolean {
  return currentState === stoppedStateValue;
}

/** One drift finding the watchdog checks for a SPECIFIC resource-group (the per-group checks —
 * `tagMissing`/`wakeAlarmActionsDisabled` — as opposed to the mechanism-wide checks which live in
 * `WatchdogMechanismDrift` below). */
export interface WatchdogGroupDrift {
  albName: string;
  tagMissing: boolean;
  wakeAlarmActionsDisabled: boolean;
}

/** Drift findings for the mechanism as a WHOLE (not per-group) — the tick schedule being disabled
 * or either Lambda's reserved concurrency being zeroed affects every resource-group at once. */
export interface WatchdogMechanismDrift {
  tickScheduleDisabled: boolean;
  tickFunctionBlocked: boolean;
  wakeFunctionBlocked: boolean;
}

/** `true` when ANY finding (mechanism-wide or per-group) indicates drift — used to decide whether
 * to publish the `WatchdogDriftDetected` metric and send a hub alert. */
export function hasAnyDrift(mechanism: WatchdogMechanismDrift, groups: WatchdogGroupDrift[]): boolean {
  if (mechanism.tickScheduleDisabled || mechanism.tickFunctionBlocked || mechanism.wakeFunctionBlocked) return true;
  return groups.some((g) => g.tagMissing || g.wakeAlarmActionsDisabled);
}
