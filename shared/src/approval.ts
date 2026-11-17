import { ACTION_CATALOG, getReversibilityClass, isOperatorOnlyActionType, type ActionType } from './index.js';

/**
 * `approval.ts` — the maker-checker (two-person) approval data model. Per change-management best
 * practice (ITIL "segregation of duties" / SOC 2 CC8.1 change-approval controls), a HIGH-RISK
 * action must be REQUESTED by one person and APPROVED by a DIFFERENT person before it executes —
 * neither the existing single-person `ConfirmationDialog` type-to-confirm mechanism (still a
 * SINGLE person, just with anti-fat-finger friction) nor the AI Ops Agent's kill-switch/allowlist/
 * rate-limit (an unattended system, no human counter-signature at all) provide this. This file
 * adds the missing THIRD mode: request -> pending -> a DIFFERENT human decides -> execute.
 *
 * This does NOT replace either existing mode:
 *   - Actions that are reversible AND not operator-gated keep working exactly as they do today —
 *     one person opens ConfirmationDialog and clicks Confirm, no approval step. Requiring a
 *     second approver for a routine, reversible, low-risk action (e.g. EC2_Rightsize) would add
 *     friction with no proportional safety benefit — the same reasoning `agentAutoExecutionPolicy.ts`
 *     already applies when deciding what the AI agent may act on unattended.
 *   - The AI Ops Agent's own safety layers (kill switch/allowlist/rate limit) are UNCHANGED — an
 *     agent-selected action never goes through this human approval queue; it is either on the
 *     agent's own hardcoded allowlist (and therefore reversible + non-operator-only by
 *     definition, see `agentAutoExecutionPolicy.ts`) or the agent does not touch it at all.
 *
 * WHICH ACTIONS REQUIRE APPROVAL — `isApprovalRequiredActionType()` below returns `true` for an
 * actionType if EITHER:
 *   1. `getReversibilityClass()` says `irreversible` (the action cannot be undone if it turns out
 *      to be a mistake — the exact same signal `ConfirmationDialog` already uses to require typed
 *      confirmation, extended here to also require a SECOND person's sign-off), OR
 *   2. `isOperatorOnlyActionType()` says `true` (resource lifecycle / Security Group / EC2
 *      management / SSM Run Command — the 4 families already gated by `operatorGroupIds`, because
 *      these touch production resource state or network exposure directly).
 * A future actionType automatically inherits the correct approval requirement from these two
 * existing classifications — nobody has to remember to update a third, separate list.
 */

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'executed' | 'expired';

/** How long an APPROVED request remains eligible to execute before it expires — a security
 * measure against "approved 3 weeks ago, conditions have since changed, executes anyway": an
 * approval reflects an assessment of CURRENT conditions, not a standing authorization. A PENDING
 * (not yet decided) request has no separate expiry here — `listPendingApprovals` surfaces its age
 * directly so a stale pending request is visible and can be actioned or explicitly left to expire
 * once it eventually gets approved past this window. */
export const APPROVAL_VALID_FOR_MS = 24 * 60 * 60 * 1000;

export interface ApprovalRequest {
  /** Opaque unique id (UUID) — the primary key used to decide/look up this request. */
  id: string;
  actionType: ActionType;
  resourceId: string;
  region: string;
  params: Record<string, string | number>;
  /** Free-text reason the REQUESTER gives for wanting this action — required (see
   * `actions-request-approval.ts`'s validation): a maker-checker approval with no stated reason
   * gives the checker nothing to actually evaluate. */
  requestedReason: string;
  /** Identity from the requester's verified JWT claim — same `preferred_username`-then-`sub`
   * resolution `actions-execute.ts` already uses for `executedBy`. */
  requestedBy: string;
  requestedAt: string; // ISO datetime
  status: ApprovalStatus;
  /** Set only once `status` moves to `approved`/`rejected` — the identity of whoever decided,
   * resolved the SAME way as `requestedBy`. MUST differ from `requestedBy` — enforced server-side
   * (see `approval-service.ts::decideApproval`), never trust a client-supplied claim of "I am a
   * different person" without checking against the stored `requestedBy`. */
  decidedBy?: string;
  decidedAt?: string; // ISO datetime
  /** Free-text reason the APPROVER/REJECTER gives for their decision — required when rejecting
   * (a rejection with no reason leaves the requester unable to fix and resubmit); optional when
   * approving (a straightforward "looks fine" approval doesn't need one, though the field is
   * still available for the approver to leave a note, e.g. a scheduling constraint). */
  decisionReason?: string;
  /** Set once this approval has actually been executed via `action-execution-fn` — an APPROVED
   * request is not automatically executed; a THIRD action (Execute) still has to be taken (by
   * either the original requester or the approver — either is acceptable, since a second person
   * has already reviewed the substance of the change; the two-person control is satisfied at the
   * approval step, not the execute step). */
  executedAt?: string; // ISO datetime
}

/**
 * `true` when `actionType` needs to go through the approval queue (`POST /actions/request-approval`
 * -> pending -> a DIFFERENT person decides via `POST /actions/decide-approval` -> only THEN may it
 * be executed) rather than the existing direct `ConfirmationDialog` -> execute flow. See this
 * file's header comment for the exact rule and rationale.
 */
export function isApprovalRequiredActionType(actionType: string): boolean {
  const existsInCatalog = ACTION_CATALOG.some((entry) => entry.actionType === actionType);
  if (!existsInCatalog) return true; // fail-closed: an unrecognized actionType is treated as needing approval, never as exempt from it.
  return getReversibilityClass(actionType) === 'irreversible' || isOperatorOnlyActionType(actionType);
}

/**
 * `true` when `decidingIdentity` is allowed to decide (approve/reject) `request` — the core
 * segregation-of-duties rule: the person who REQUESTED an action can never be the one who
 * APPROVES it, even if they otherwise hold operator/approver permission. Compares case-insensitively
 * (identities here are Entra ID `preferred_username` emails or `sub` claims, both of which should
 * be compared without case sensitivity for email-shaped values — matches the same leniency
 * `auth.ts`'s claim reading already assumes implicitly by trusting the verified JWT's exact string).
 */
export function canDecideApproval(request: Pick<ApprovalRequest, 'requestedBy'>, decidingIdentity: string): boolean {
  return request.requestedBy.trim().toLowerCase() !== decidingIdentity.trim().toLowerCase();
}

/** `true` when a `status === 'approved'` request is still within its execution validity window —
 * see `APPROVAL_VALID_FOR_MS`'s doc comment for why an approval is not a standing authorization. */
export function isApprovalStillValid(request: Pick<ApprovalRequest, 'decidedAt'>, now: number = Date.now()): boolean {
  if (!request.decidedAt) return false;
  return now - new Date(request.decidedAt).getTime() <= APPROVAL_VALID_FOR_MS;
}
