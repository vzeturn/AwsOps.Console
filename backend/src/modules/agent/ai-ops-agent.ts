import { GetObjectCommand } from '@aws-sdk/client-s3';
import { InvokeCommand } from '@aws-sdk/client-lambda';
import { getS3Client, getLambdaClient } from '../../core/aws-clients.js';
import type {
  ActionExecutionRequest,
  ActionExecutionResult,
  ActionType,
  AssessmentReport,
  RecommendationItem,
} from '@ops-dashboard/shared';
import { matchActionCatalogForFinding, getRunbookForFinding } from '@ops-dashboard/shared';
import { isAgentAutoExecutable } from './agentAutoExecutionPolicy.js';
import { isAgentAutoExecuteEnabled } from './agentKillSwitch.js';
import { reserveAgentExecutionBudget } from './agentRateLimiter.js';
import { decideAgentActions, type AgentDecisionCandidate } from './agentClaudeDecision.js';
import { postDiscordEmbeds, type DiscordEmbed, buildOpsNotificationEmbed, type OpsNotificationSeverity } from '../alerting/index.js';
import { logger } from '../../shared-kernel/logger.js';

/**
 * `ai-ops-agent.ts` — the "AI Ops Agent" Lambda, run on a schedule (see
 * `AiOpsAgentScheduleExpression`, `infra/ops-dashboard.yaml`). Reads the SAME assessment report
 * `infra-review-collector.ts` already produces, asks the Anthropic Claude API to prioritize among
 * the findings that are ALREADY proven safe to automate, and executes AT MOST a rate-limited
 * handful of them per run through the EXACT SAME `action-execution-fn` pipeline a human clicking a
 * button in `ConfirmationDialog` goes through — same IAM role, same per-action safety checks (each
 * `execute*ActionService` re-verifies state at execution time), same `ActionAuditRecord` trail
 * (distinguished only by `executedBy: 'agent:ops-ai-agent'`, never a human email).
 *
 * FOUR INDEPENDENT SAFETY LAYERS, EACH ABLE TO STOP EXECUTION ON ITS OWN — read in the order this
 * handler actually applies them, each one a hard gate the run cannot proceed past:
 *
 *   1. KILL SWITCH (`agentKillSwitch.ts`) — checked FIRST, before touching the assessment report at
 *      all. `AGENT_AUTO_EXECUTE_ENABLED` defaults to disabled (see the CFN parameter default in
 *      `infra/ops-dashboard.yaml`) — this feature ships INERT. An operator flips one SSM Parameter
 *      to turn it off immediately, with no deploy and no waiting for a warm Lambda to cycle out
 *      (see that file's own header comment on why it is read fresh every call).
 *   2. ALLOWLIST (`agentAutoExecutionPolicy.ts`) — a finding is only a "candidate" at all if
 *      `matchActionCatalogForFinding()` resolves it to one of the 6 hardcoded, independently
 *      reversible, non-operator-only actionTypes. This is plain TypeScript, reviewed and deployed
 *      like any other code change — nothing the model says can expand it.
 *   3. RATE LIMIT (`agentRateLimiter.ts`) — a hard, system-wide cap on how many actions can be
 *      auto-executed per rolling hour, independent of how many candidates exist or what the model
 *      would have approved. Budget is reserved BEFORE asking the model to choose, so it is never
 *      even offered more slots than remain.
 *   4. CLAUDE DECISION (`agentClaudeDecision.ts`) — chooses WHICH of the (already-safe,
 *      already-in-budget) candidates to act on this run, for prioritization only. Its output is
 *      treated as untrusted: any `candidateId` the model returns that isn't one this handler
 *      generated from its own eligible-findings map is dropped, never acted on (see that file's own
 *      header comment for the full threat model).
 *
 * WHY THIS OPERATES ON `AssessmentReport` / `RecommendationItem`, NOT `MonitoringData`/`AlarmSummary`
 *
 * The assessment report is the ONE feed in this project already scored by dollar impact
 * (`estimatedMonthlySavingsUsd`) and already classified by `findingType` — exactly the two signals
 * an autonomous prioritization decision needs (how much does this matter, what safe automation
 * exists for it). Monitoring alarms are a different domain — they're about ACTIVE incidents needing
 * a human's judgment on scope/impact, not a backlog of optimization opportunities a model can help
 * triage. Nothing here prevents extending this pattern to another feed later; it simply hasn't been
 * asked for.
 *
 * NOTE ON `ECS_ScaleOut`: it is on the allowlist for structural completeness (a real, independently
 * reversible, non-operator-only action), but as of this writing NO `RecommendationFindingType` maps
 * to it via `FINDING_TYPE_ACTION_OVERRIDES` (`shared/src/action-catalog.ts`) — it is currently only
 * reachable as a human quick-action from a Monitoring_Page runbook, never from an assessment
 * finding. This handler will simply never select it until/unless a future finding is wired to it;
 * that is a limitation of the data source, not a bug in this file.
 */

const ASSESSMENT_OBJECT_KEY = 'assessment-report.json';
const AGENT_EXECUTED_BY = 'agent:ops-ai-agent';

/**
 * Reads `assessment-report.json` directly with its own minimal S3 client — deliberately NOT
 * importing `services/assessment-service.ts` (which imports `config.ts`, the singleton that
 * validates EVERY required app-wide environment variable, most of which this Lambda has no
 * business needing — e.g. `entraTenantId`/`ec2StateManagerFunctionUrl`). This is the SAME
 * least-privilege/minimal-dependency pattern `ec2-rightsize-applier.ts` already uses for its own
 * audit writes (see that file's `writeAuditRecordMinimal` comment) — a Lambda's imports should
 * only require what it actually reads from the environment.
 *
 * Never throws: a missing bucket name, a missing object (collector never ran yet), or a read/parse
 * failure all resolve to `undefined` — the caller treats that identically to "no eligible findings
 * this run", never a reason to crash the schedule.
 */
async function readAssessmentReport(): Promise<AssessmentReport | undefined> {
  const bucketName = process.env.ASSESSMENT_BUCKET_NAME;
  if (!bucketName) {
    logger.error('ai-ops-agent: missing required environment variable ASSESSMENT_BUCKET_NAME (skipping this run)');
    return undefined;
  }
  try {
    const { Body } = await getS3Client().send(new GetObjectCommand({ Bucket: bucketName, Key: ASSESSMENT_OBJECT_KEY }));
    const raw = await Body?.transformToString();
    if (!raw) return undefined;
    return JSON.parse(raw) as AssessmentReport;
  } catch (err) {
    logger.error('ai-ops-agent: failed to read assessment-report.json (treating as no findings this run)', err);
    return undefined;
  }
}

interface EligibleFinding {
  /** Opaque id handed to `decideAgentActions()` — see `agentClaudeDecision.ts`'s file header for
   * why the model itself never sees `actionType`/`resourceId` directly. */
  candidateId: string;
  item: RecommendationItem;
  actionType: ActionType;
}

/**
 * Filters `report.recommendations` down to findings that are BOTH matched to a concrete action
 * (`matchActionCatalogForFinding`) AND independently cleared for unattended execution
 * (`isAgentAutoExecutable`) — see the file header for why both checks are required. A finding with
 * `executed: true` (an optimistic client-side flag — see its own doc comment in `shared/src`,
 * never actually set by the collector that writes this report) is skipped defensively anyway,
 * since acting on it again would be redundant, not unsafe.
 */
export function findEligibleFindings(report: AssessmentReport): EligibleFinding[] {
  const eligible: EligibleFinding[] = [];
  let index = 0;
  for (const item of report.recommendations) {
    if (item.executed) continue;
    const entry = matchActionCatalogForFinding(item.findingType);
    if (!entry) continue;
    if (!isAgentAutoExecutable(entry.actionType)) continue;
    eligible.push({ candidateId: `c${index}`, item, actionType: entry.actionType });
    index += 1;
  }
  return eligible;
}

function buildDecisionCandidates(eligible: readonly EligibleFinding[]): AgentDecisionCandidate[] {
  return eligible.map((e) => ({
    candidateId: e.candidateId,
    summary: `${e.item.resourceName} (${e.item.category}/${e.item.resourceType}): ${e.item.recommendedAction}`,
    estimatedMonthlySavingsUsd: e.item.estimatedMonthlySavingsUsd,
  }));
}

/**
 * Every actionType currently on the allowlist (`AGENT_AUTO_EXECUTE_ALLOWLIST`) is fully
 * self-contained given only a `resourceId` — none of their `execute*` service functions read
 * `event.params` (each recomputes what it needs from live AWS state at execution time, the same
 * defense-in-depth already documented in each service file). `params: {}` is therefore correct for
 * every action this handler can ever dispatch; if a future addition to the allowlist needs
 * parameters, this function is the one place that would need to grow a case per actionType.
 */
function buildExecutionRequest(finding: EligibleFinding, region: string): ActionExecutionRequest {
  return {
    actionType: finding.actionType,
    resourceId: finding.item.resourceId,
    region,
    params: {},
    executedBy: AGENT_EXECUTED_BY,
  };
}

/**
 * Invokes `action-execution-fn` exactly the way `actions-execute.ts` (the router handler behind a
 * human clicking Confirm) already does — same `InvocationType: 'RequestResponse'`, same JSON
 * payload/response contract. This Lambda's own IAM role grants `lambda:InvokeFunction` scoped
 * ONLY to this one function's ARN (see `infra/ops-dashboard.yaml`) — it has no direct AWS mutate
 * permission of its own; every actual infrastructure change happens inside `action-execution-fn`,
 * under ITS role, with ITS own per-action safety checks.
 */
async function invokeActionExecution(request: ActionExecutionRequest): Promise<ActionExecutionResult> {
  const functionName = process.env.ACTION_EXECUTION_FUNCTION_NAME;
  if (!functionName) {
    return { outcome: 'failure', reason: 'Internal error: missing ACTION_EXECUTION_FUNCTION_NAME' };
  }
  try {
    const response = await getLambdaClient().send(
      new InvokeCommand({
        FunctionName: functionName,
        InvocationType: 'RequestResponse',
        Payload: Buffer.from(JSON.stringify(request)),
      }),
    );
    if (response.FunctionError) {
      return { outcome: 'failure', reason: 'action-execution-fn threw an unhandled error' };
    }
    const payloadText = Buffer.from(response.Payload ?? new Uint8Array()).toString('utf-8');
    return JSON.parse(payloadText) as ActionExecutionResult;
  } catch (err) {
    return { outcome: 'failure', reason: `Failed to invoke action-execution-fn: ${(err as Error).message}` };
  }
}

interface ExecutedEntry {
  finding: EligibleFinding;
  rationale: string;
  result: ActionExecutionResult;
}

/**
 * One consolidated Discord notification per run (never one per action — a run that auto-executes 3
 * things should not flood the channel with 3 separate messages). Severity is `success` only when
 * EVERY executed action succeeded; a single failure/rejection downgrades the whole notification to
 * `warning` so it isn't mistaken for a fully clean run. Each action's own outcome/reason and the
 * model's one-sentence rationale are both shown, since "what happened" and "why the agent thought
 * it was worth doing" are both operationally relevant to a human reviewing this after the fact.
 */
function buildAgentRunEmbed(executed: readonly ExecutedEntry[]): DiscordEmbed {
  const succeeded = executed.filter((e) => e.result.outcome === 'success');
  const failedCount = executed.length - succeeded.length;
  const severity: OpsNotificationSeverity = failedCount === 0 ? 'success' : 'warning';
  const region = process.env.AWS_REGION;

  return buildOpsNotificationEmbed({
    what: `AI Ops Agent auto-executed ${succeeded.length}/${executed.length} action(s) this run`,
    severity,
    who: 'system:ai-ops-agent',
    // Impact only stated on a genuinely mixed/failed run — a fully successful run's "impact" is
    // just the intended optimization already described per-action below, nothing extra to flag.
    impact: failedCount > 0 ? `${failedCount} of ${executed.length} autonomous action(s) did NOT complete successfully — see each action's outcome below for whether the underlying resource was left unchanged (rejected/failure) or partially modified.` : undefined,
    why: 'Findings selected from the current assessment report, within this run\'s rate-limit budget.',
    links: region ? [{ label: 'action-execution-fn Logs', url: `https://${region}.console.aws.amazon.com/cloudwatch/home?region=${region}#logsV2:log-groups/log-group/$252Faws$252Flambda$252Fabc-ops-dashboard-prod-action-execution-fn` }] : undefined,
    region,
    footer: 'ops-dashboard · AI Ops Agent (autonomous)',
    extra: executed.map((e) => {
      // Every RecommendationFindingType has a runbook (RUNBOOK_BY_FINDING is total). Citing the
      // rollback step here matters MORE than in a human-confirmed action: nobody clicked
      // "Confirm" on this specific execution, so the first time an operator learns about it is
      // this notification — it has to answer "was this safe, and can I undo it" on its own,
      // without requiring a trip to the dashboard's Runbook drawer first.
      const runbook = getRunbookForFinding(e.finding.item.findingType);
      const rollbackNote = runbook.rollback?.[0];
      return {
        name: `${e.finding.item.resourceName} — ${e.finding.actionType}`,
        value: [
          `**${e.result.outcome.toUpperCase()}**${e.result.reason ? `: ${e.result.reason}` : ''}`,
          `_${e.rationale}_`,
          e.result.outcome === 'success' && rollbackNote ? `Rollback: ${rollbackNote}` : undefined,
        ]
          .filter(Boolean)
          .join('\n'),
        inline: false,
      };
    }),
  });
}

export interface AiOpsAgentResult {
  ok: true;
  eligibleCount: number;
  selectedCount: number;
  executedCount: number;
  succeededCount: number;
}

export async function handler(): Promise<AiOpsAgentResult> {
  const empty = (eligibleCount = 0): AiOpsAgentResult => ({ ok: true, eligibleCount, selectedCount: 0, executedCount: 0, succeededCount: 0 });

  const enabled = await isAgentAutoExecuteEnabled();
  if (!enabled) {
    logger.info('ai-ops-agent: auto-execute is disabled (kill switch off) — skipping this run.');
    return empty();
  }

  const report = await readAssessmentReport();
  if (!report || report.recommendations.length === 0) {
    logger.info('ai-ops-agent: no assessment report / no recommendations available this run.');
    return empty();
  }

  const eligible = findEligibleFindings(report);
  if (eligible.length === 0) {
    logger.info('ai-ops-agent: no findings are eligible for auto-execution this run (nothing on the allowlist matched).');
    return empty();
  }

  const budgetDecision = await reserveAgentExecutionBudget(eligible.length);
  if (budgetDecision.allowedCount === 0) {
    logger.warn(
      `ai-ops-agent: rate-limit budget exhausted — 0 of ${eligible.length} eligible finding(s) can be auto-executed this run.`,
    );
    return empty(eligible.length);
  }

  const candidates = buildDecisionCandidates(eligible);
  const decision = await decideAgentActions(candidates, budgetDecision.allowedCount);

  const byCandidateId = new Map(eligible.map((e) => [e.candidateId, e]));
  const executed: ExecutedEntry[] = [];

  for (const selection of decision.selected) {
    const finding = byCandidateId.get(selection.candidateId);
    // Defense-in-depth: decideAgentActions()/parseAgentDecision() already restrict candidateId to
    // the exact set this handler generated, but a lookup miss is still handled gracefully rather
    // than throwing or dereferencing undefined.
    if (!finding) {
      logger.warn(`ai-ops-agent: selected candidateId "${selection.candidateId}" did not resolve to a known finding (skipping)`);
      continue;
    }
    const request = buildExecutionRequest(finding, report.region);
    const result = await invokeActionExecution(request);
    executed.push({ finding, rationale: selection.rationale, result });
  }

  const succeededCount = executed.filter((e) => e.result.outcome === 'success').length;
  logger.info(
    `ai-ops-agent: eligible=${eligible.length} budgetAllowed=${budgetDecision.allowedCount} selected=${decision.selected.length} executed=${executed.length} succeeded=${succeededCount}`,
  );

  if (executed.length > 0) {
    await postDiscordEmbeds([buildAgentRunEmbed(executed)]);
  }

  return {
    ok: true,
    eligibleCount: eligible.length,
    selectedCount: decision.selected.length,
    executedCount: executed.length,
    succeededCount,
  };
}
