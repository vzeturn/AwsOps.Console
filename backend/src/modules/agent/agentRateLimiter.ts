import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getS3Client } from '../../core/aws-clients.js';
import { logger } from '../../shared-kernel/logger.js';

/**
 * `agentRateLimiter.ts` — a hard, system-wide cap on how many actions the AI Ops Agent can
 * auto-execute in a rolling time window, independent of what the kill switch or the allowlist
 * say. This exists as a SEPARATE layer on purpose: the allowlist (`agentAutoExecutionPolicy.ts`)
 * decides WHICH actionTypes are safe to automate at all, and the kill switch
 * (`agentKillSwitch.ts`) is a manual all-or-nothing lever — neither one limits HOW MANY actions
 * happen per run if the agent (or a manipulated/degenerate model response) decided every eligible
 * finding this run deserved to be auto-executed. A single scheduled run touching, say, 40 RDS
 * parameter groups because a model response happened to approve all of them is exactly the kind of
 * automation-goes-wrong scenario a rate limit exists to bound, even though every individual action
 * would have been within the allowlist.
 *
 * STATE STORAGE: a single JSON object (`agent-state/rate-limit.json`, in the same
 * `AssessmentReportBucket` every other collector already uses) holding the epoch-millisecond
 * timestamp of every auto-execution in the current window. This is a READ-MODIFY-WRITE on shared
 * state — the same trade-off `threshold-history-service.ts` already accepts elsewhere in this
 * codebase (see `action-audit-service.ts`'s own comment contrasting itself with that file). It is
 * intentionally NOT the audit trail (`action-audit/`) — this file's only job is "how many, how
 * recently", not "what happened" — and it is safe to lose or reset (worst case: the budget quietly
 * resets early, which only makes the limiter MORE permissive for one window, never less safe).
 * The agent runs on a single EventBridge Schedule (not invoked concurrently in normal operation),
 * so the classic read-modify-write race is a low-probability, low-severity risk here, unlike a
 * financial ledger.
 */

/** Rolling window length. 1 hour is short enough that a bad run self-limits quickly, long enough
 * that the collector's own daily/hourly cadence (infra-review-collector runs once a day) never
 * bumps into it under normal operation. */
export const AGENT_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

/** Maximum auto-executions allowed within the rolling window, across ALL actionTypes combined —
 * not per-actionType. A conservative number: enough to make a real dent in a backlog of findings
 * over a day of runs, small enough that hitting the cap is a clear, noticeable signal (which
 * `ai-ops-agent.ts` surfaces via Discord) rather than routine background noise. */
export const AGENT_RATE_LIMIT_MAX_EXECUTIONS = 5;

const RATE_LIMIT_STATE_KEY = 'agent-state/rate-limit.json';

interface RateLimitState {
  /** Epoch-millisecond timestamps of past auto-executions, unsorted, may include entries already
   * outside the window (pruned lazily by `pruneTimestampsWithinWindow`, never on write). */
  executionTimestamps: number[];
}

/** Pure — keeps only timestamps within `windowMs` of `now`. Exported for direct unit testing
 * without touching S3. */
export function pruneTimestampsWithinWindow(timestamps: readonly number[], now: number, windowMs: number): number[] {
  const cutoff = now - windowMs;
  return timestamps.filter((t) => t > cutoff);
}

export interface RateLimitDecision {
  /** How many of the `requestedCount` actions the caller is cleared to execute right now — always
   * `0 <= allowedCount <= requestedCount`. The caller MUST only execute this many (e.g. the first
   * `allowedCount` actions in whatever priority order the model returned), never more. */
  allowedCount: number;
  /** Remaining budget in the window AFTER `allowedCount` is consumed — surfaced so the caller can
   * log/notify "budget exhausted" accurately instead of guessing. */
  budgetRemainingAfter: number;
}

/**
 * Pure decision function — given how many timestamps are already within the window and how many
 * NEW executions are being requested, returns how many are actually allowed. Never allows more
 * than the remaining budget; `requestedCount <= 0` always yields `allowedCount: 0` (a defensive
 * floor — a negative or zero request should never be able to consume or free budget).
 */
export function computeRateLimitDecision(
  currentCountInWindow: number,
  requestedCount: number,
  maxExecutions: number = AGENT_RATE_LIMIT_MAX_EXECUTIONS,
): RateLimitDecision {
  const remainingBudget = Math.max(0, maxExecutions - currentCountInWindow);
  const allowedCount = requestedCount > 0 ? Math.min(requestedCount, remainingBudget) : 0;
  return { allowedCount, budgetRemainingAfter: remainingBudget - allowedCount };
}

function bucketName(): string {
  const name = process.env.ASSESSMENT_BUCKET_NAME;
  if (!name) throw new Error('Missing required environment variable: ASSESSMENT_BUCKET_NAME');
  return name;
}

/** Reads the current rate-limit state from S3. Any failure (object doesn't exist yet, corrupted
 * JSON, permission error) is treated as "no prior executions recorded" — fail-safe in the
 * PERMISSIVE direction for THIS read (an unreadable state must not itself become a reason to
 * refuse automation forever), but note the actual safety net is `computeRateLimitDecision`'s cap,
 * not this fallback. */
async function loadState(): Promise<RateLimitState> {
  try {
    const { Body } = await getS3Client().send(new GetObjectCommand({ Bucket: bucketName(), Key: RATE_LIMIT_STATE_KEY }));
    const raw = await Body?.transformToString();
    if (!raw) return { executionTimestamps: [] };
    const parsed = JSON.parse(raw) as Partial<RateLimitState>;
    return { executionTimestamps: Array.isArray(parsed.executionTimestamps) ? parsed.executionTimestamps : [] };
  } catch (err) {
    logger.error('agentRateLimiter: failed to read rate-limit state from S3 (treating as no prior executions)', err);
    return { executionTimestamps: [] };
  }
}

/** Never throws — a failed write only means the next invocation's budget calculation is based on
 * stale (undercounted) data, which is the same permissive-in-one-direction trade-off as
 * `loadState`'s own fallback; it does not widen the allowlist or bypass the kill switch. */
async function saveState(state: RateLimitState): Promise<void> {
  try {
    await getS3Client().send(
      new PutObjectCommand({
        Bucket: bucketName(),
        Key: RATE_LIMIT_STATE_KEY,
        Body: JSON.stringify(state),
        ContentType: 'application/json',
      }),
    );
  } catch (err) {
    logger.error('agentRateLimiter: failed to write rate-limit state to S3 (ignored, not thrown)', err);
  }
}

/**
 * Reserves budget for up to `requestedCount` NEW auto-executions: reads the current window state,
 * prunes expired entries, computes how many are allowed via `computeRateLimitDecision`, and — ONLY
 * for the `allowedCount` actually granted — appends that many new timestamps (all set to `now`)
 * and writes the state back immediately, so a second call within the same run (or a concurrent
 * one) sees the reservation already consumed rather than being able to double-spend the same
 * budget by reading stale state.
 *
 * The caller passes the number of actions it WANTS to execute this run; it must then execute at
 * most `allowedCount` of them (in whatever priority order it has already decided) — this function
 * has no way to know which specific actions the caller picks, so it does not accept or return
 * action identities, only a count.
 */
export async function reserveAgentExecutionBudget(requestedCount: number, now: number = Date.now()): Promise<RateLimitDecision> {
  const state = await loadState();
  const pruned = pruneTimestampsWithinWindow(state.executionTimestamps, now, AGENT_RATE_LIMIT_WINDOW_MS);
  const decision = computeRateLimitDecision(pruned.length, requestedCount, AGENT_RATE_LIMIT_MAX_EXECUTIONS);

  if (decision.allowedCount > 0) {
    const newTimestamps = [...pruned, ...Array<number>(decision.allowedCount).fill(now)];
    await saveState({ executionTimestamps: newTimestamps });
  } else if (pruned.length !== state.executionTimestamps.length) {
    // Nothing new to reserve, but pruning shrank the list — write back anyway so the state object
    // doesn't grow without bound across many no-op runs (e.g. the kill switch left off for weeks).
    await saveState({ executionTimestamps: pruned });
  }

  return decision;
}
