import { ACTION_CATALOG, getReversibilityClass, isOperatorOnlyActionType, type ActionType } from '@ops-dashboard/shared';

/**
 * `agentAutoExecutionPolicy.ts` — the SINGLE SOURCE OF TRUTH for which `ActionType`s the AI Ops
 * Agent (`ai-ops-agent.ts`) is allowed to execute WITHOUT a human clicking Confirm.
 *
 * WHY A HARDCODED ALLOWLIST, NOT A MODEL DECISION
 *
 * The agent's Claude API call (`agentClaudeDecision.ts`) decides WHICH of the eligible findings to
 * act on and WHY (prioritization, rationale) — it does NOT decide WHETHER a given actionType is
 * safe to auto-execute at all. That boundary is deliberately kept in plain TypeScript, reviewed and
 * deployed like any other code change, never something an LLM output can expand. An LLM asked "is
 * this action safe to automate" will rationalize a plausible-sounding yes for almost anything if the
 * surrounding context makes it seem urgent — the same failure mode prompt injection exploits. Fixing
 * the allowlist in code means the worst a manipulated model output can do is decline to act on
 * something in the allowlist, or ask a human — never expand its own authority.
 *
 * THE ALLOWLIST ITSELF (deliberately short — every entry has a specific reason it is safe unattended)
 *
 *   EC2_Rightsize                    — same-family step-down only, CPU-architecture verified twice
 *                                      (see ec2-rightsize-action-service.ts); can be reversed by
 *                                      applying this same action again with the previous type.
 *   EBS_ModifyVolumeType             — gp2->gp3 only, online (no downtime), AWS supports converting
 *                                      back with the same API.
 *   CloudWatchLogGroup_SetRetention  — only ever sets a policy where NONE currently exists (never
 *                                      overwrites a deliberate human choice — see the action
 *                                      service's own re-check), and only deletes FUTURE logs
 *                                      gradually, never an immediate bulk delete.
 *   RDS_ApplyResourceGovernance      — parameter-only change, idempotent, immediate ApplyMethod
 *                                      (no reboot), refuses to touch a shared `default.*` parameter
 *                                      group.
 *   Backup_RetryJob                 — only ever CREATES an additional recovery point; cannot
 *                                      delete or modify an existing one.
 *   ECS_ScaleOut                    — only ever increases desiredCount, capped by the service's own
 *                                      registered MaxCapacity (or a hard cap with no autoscaling
 *                                      config) — cannot scale below the current count.
 *
 * EVERYTHING ELSE is proposal-only: the agent may still produce a recommendation for it, but
 * execution stays behind the existing human-facing `ConfirmationDialog` flow (typed resource-id
 * confirmation for irreversible/security-impacting actions included) exactly as it works today for
 * a person clicking a button. Nothing about the existing human flow changes.
 *
 * DEFENSE IN DEPTH: `isAgentAutoExecutable()` does not just check membership in
 * `AGENT_AUTO_EXECUTE_ALLOWLIST` — it ALSO re-derives from `ACTION_CATALOG` that the actionType is
 * `reversible` and NOT operator-only, and refuses if either check fails. This means a future
 * mistake — accidentally adding an irreversible or operator-only actionType to the allowlist array
 * below — is caught at runtime rather than silently taking effect. Both checks must independently
 * agree that autonomous execution is safe.
 */
export const AGENT_AUTO_EXECUTE_ALLOWLIST: readonly ActionType[] = [
  'EC2_Rightsize',
  'EBS_ModifyVolumeType',
  'CloudWatchLogGroup_SetRetention',
  'RDS_ApplyResourceGovernance',
  'Backup_RetryJob',
  'ECS_ScaleOut',
];

const ALLOWLIST_SET: ReadonlySet<ActionType> = new Set(AGENT_AUTO_EXECUTE_ALLOWLIST);

/**
 * `true` only when ALL of the following hold:
 *   1. `actionType` is in the explicit allowlist above.
 *   2. `ACTION_CATALOG` independently classifies it as `reversible`.
 *   3. `ACTION_CATALOG`-derived operator-only status (`isOperatorOnlyActionType`) is `false`.
 *   4. `actionType` actually exists in `ACTION_CATALOG` at all (guards against a typo in the
 *      allowlist referring to a renamed/removed actionType — `getReversibilityClass` defaults to
 *      `'irreversible'` for anything not found, which already fails check 2, but this is checked
 *      explicitly too so the reason is unambiguous if it is ever logged).
 *
 * Any single failing check is enough to refuse — this function has no code path that returns
 * `true` from only a partial match.
 */
export function isAgentAutoExecutable(actionType: string): actionType is ActionType {
  if (!ALLOWLIST_SET.has(actionType as ActionType)) return false;
  const existsInCatalog = ACTION_CATALOG.some((entry) => entry.actionType === actionType);
  if (!existsInCatalog) return false;
  if (getReversibilityClass(actionType) !== 'reversible') return false;
  if (isOperatorOnlyActionType(actionType)) return false;
  return true;
}
