import { GetParameterCommand } from '@aws-sdk/client-ssm';
import { getSsmClient } from '../../core/aws-clients.js';
import { logger } from '../../shared-kernel/logger.js';

/**
 * `agentClaudeDecision.ts` — the ONLY place `ai-ops-agent.ts` talks to an LLM. Calls the Anthropic
 * Claude API directly (`https://api.anthropic.com/v1/messages`) via `fetch`, the same lightweight
 * approach `alertHook.ts` already uses for an external HTTPS API — no SDK dependency, just an
 * API key read from SSM Parameter Store and cached at cold start (`fetchCachedApiKey`, mirroring
 * `alertHook.ts`'s `fetchCachedWebhookUrl`).
 *
 * Scope is deliberately narrow: given a set of findings that are ALREADY confirmed safe to
 * auto-execute (allowlisted actionType, reversible, not operator-only — see
 * `agentAutoExecutionPolicy.ts`) and ALREADY within budget (see `agentRateLimiter.ts`), ask the
 * model to pick WHICH of them are worth acting on right now and WHY, for the alert
 * a human will read afterward. The model has NO power to expand its own scope — see the "WHAT THE
 * MODEL CANNOT DO" section below.
 *
 * WHAT THE MODEL CAN DO: reorder/select among a fixed, pre-vetted list of candidates by priority
 * (e.g. "the $340/month EBS finding matters more than the $2/month log retention finding this
 * run"), and write a short human-readable rationale per selected candidate for the notification.
 *
 * WHAT THE MODEL CANNOT DO (enforced structurally, not just by prompt wording):
 *   - It never sees or chooses an `actionType` or `resourceId` string directly. The prompt only
 *     ever shows an opaque `candidateId` (an index into the map the caller already built from
 *     already-allowlisted, already-verified findings) — the model can only refer to a
 *     `candidateId` it was given, never invent a new action or resource to touch.
 *   - `parseAgentDecision()` (below) treats the model's response as UNTRUSTED input: every
 *     `candidateId` it returns is checked against the caller-supplied `eligibleCandidateIds` set,
 *     and anything not in that set is silently dropped, never acted on. A model output that
 *     hallucinates an id, repeats one, or is manipulated by injected text in a finding's
 *     description cannot cause an action outside the set the caller already decided was eligible.
 *   - It cannot change how many actions get executed beyond what the caller's rate-limit budget
 *     already allows — this module has no visibility into or influence over
 *     `agentRateLimiter.ts`; the caller (`ai-ops-agent.ts`) truncates the model's selection to the
 *     budget AFTER this module returns, independent of anything the model said.
 *
 * FAIL-SAFE ON ANY ERROR: `decideAgentActions()` never throws. An API error (including the API key
 * being unreadable), a malformed/non-JSON response, or a response that fails schema validation all
 * resolve to an EMPTY decision (`selected: []`) — the safe default is to act on nothing and let the
 * finding surface through the normal human-facing recommendation flow instead, never to guess or
 * fall back to "auto-approve everything offered".
 */

export interface AgentDecisionCandidate {
  /** Opaque identifier — NOT the real actionType/resourceId (see file header). The caller
   * generates these (e.g. `"c0"`, `"c1"`, ...) and is the only party that ever maps them back to a
   * real `ActionExecutionRequest`. */
  candidateId: string;
  /** Human-readable summary of the finding, safe to hand to the model — no need to also expose
   * the raw actionType/resourceId for the model to make a useful prioritization decision. */
  summary: string;
  /** Estimated monthly savings in USD, if known — the strongest signal for prioritization when
   * the rate-limit budget forces a choice among more eligible candidates than can be executed. */
  estimatedMonthlySavingsUsd: number | null;
}

export interface AgentDecisionResult {
  selected: { candidateId: string; rationale: string }[];
}

const EMPTY_DECISION: AgentDecisionResult = { selected: [] };

/**
 * Name of the SSM Parameter holding the Anthropic API key (SecureString is preferred here — unlike
 * `AlertHookUrlParameter`/`Ec2StateManagerServiceTokenParameter` elsewhere in this project,
 * which use plain String only because `AWS::SSM::Parameter` in CloudFormation cannot create a
 * SecureString directly; this key is provisioned out-of-band via the AWS CLI specifically so it
 * CAN be a SecureString — see the CFN comment in `infra/ops-dashboard.yaml`).
 */
const CLAUDE_API_KEY_PARAM_NAME_ENV_VAR = 'AGENT_CLAUDE_API_KEY_PARAM_NAME';
const CLAUDE_MODEL_ENV_VAR = 'AGENT_CLAUDE_MODEL_ID';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

/** Hard output cap, set explicitly on every request — the expected response is a short JSON
 * object, a few hundred tokens is generous headroom. */
const MAX_OUTPUT_TOKENS = 2048;

/** Cached at module scope (cold start) — reads SSM only once per execution environment, the same
 * pattern `alertHook.ts`'s `fetchCachedWebhookUrl` already uses. Errors are NOT cached — the
 * next call within the same execution environment retries. */
let cachedApiKeyPromise: Promise<string> | undefined;

function fetchCachedApiKey(): Promise<string> {
  if (!cachedApiKeyPromise) {
    const paramName = process.env[CLAUDE_API_KEY_PARAM_NAME_ENV_VAR];
    if (!paramName) {
      cachedApiKeyPromise = Promise.reject(new Error(`Missing required environment variable: ${CLAUDE_API_KEY_PARAM_NAME_ENV_VAR}`));
    } else {
      cachedApiKeyPromise = getSsmClient()
        .send(new GetParameterCommand({ Name: paramName, WithDecryption: true }))
        .then((result) => {
          const value = result.Parameter?.Value;
          if (!value) throw new Error(`SSM Parameter '${paramName}' has no value`);
          return value;
        });
    }
    cachedApiKeyPromise = cachedApiKeyPromise.catch((err) => {
      cachedApiKeyPromise = undefined;
      throw err;
    });
  }
  return cachedApiKeyPromise;
}

function buildPrompt(candidates: readonly AgentDecisionCandidate[], budget: number): string {
  const candidateLines = candidates
    .map((c) => `- id="${c.candidateId}": ${c.summary} (estimated savings: ${c.estimatedMonthlySavingsUsd !== null ? `$${c.estimatedMonthlySavingsUsd.toFixed(2)}/month` : 'unknown'})`)
    .join('\n');

  return [
    'You are an AWS operations assistant helping prioritize a small number of ALREADY-APPROVED, low-risk, reversible infrastructure changes.',
    'Every candidate below has ALREADY been verified safe to execute automatically by other systems — your only job is to choose which ones are worth acting on THIS run, given a strict budget, and to give a one-sentence rationale for each you select.',
    `You may select AT MOST ${budget} candidate(s) — fewer is fine if fewer are worth acting on. Do not select any candidate not listed below. Do not invent new candidates.`,
    '',
    'Candidates:',
    candidateLines,
    '',
    'Respond with ONLY a JSON object matching exactly this shape, and nothing else (no markdown fences, no commentary):',
    '{"selected": [{"candidateId": "<one of the ids above>", "rationale": "<one short sentence>"}]}',
    'If none are worth acting on this run, respond with {"selected": []}.',
  ].join('\n');
}

/**
 * Parses and validates the model's raw text response. Untrusted input — see the file header for
 * the full threat model. Returns `EMPTY_DECISION` for anything that doesn't parse to the exact
 * expected shape, and silently drops (never throws on) any `candidateId` not present in
 * `eligibleCandidateIds`.
 */
export function parseAgentDecision(rawText: string, eligibleCandidateIds: ReadonlySet<string>): AgentDecisionResult {
  let parsed: unknown;
  try {
    // Models occasionally wrap JSON in a markdown code fence despite instructions not to — strip
    // a single leading/trailing ``` fence if present before parsing, but do not attempt any other
    // repair (a response that still doesn't parse as JSON after this is treated as malformed).
    const stripped = rawText.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
    parsed = JSON.parse(stripped);
  } catch {
    logger.error('agentClaudeDecision: model response was not valid JSON (fail-safe: selecting nothing)', { rawText });
    return EMPTY_DECISION;
  }

  if (typeof parsed !== 'object' || parsed === null || !('selected' in parsed) || !Array.isArray((parsed as { selected: unknown }).selected)) {
    logger.error('agentClaudeDecision: model response did not match the expected {selected: [...]} shape (fail-safe: selecting nothing)', { parsed });
    return EMPTY_DECISION;
  }

  const rawSelected = (parsed as { selected: unknown[] }).selected;
  const selected: AgentDecisionResult['selected'] = [];
  const seenIds = new Set<string>();

  for (const entry of rawSelected) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { candidateId, rationale } = entry as { candidateId?: unknown; rationale?: unknown };
    if (typeof candidateId !== 'string' || typeof rationale !== 'string') continue;
    // The core trust boundary: an id the model invented, hallucinated, or was manipulated into
    // returning (e.g. via injected text inside a finding's own description) that isn't in the
    // caller-supplied eligible set is dropped here, silently and without throwing — this candidate
    // simply never becomes an action.
    if (!eligibleCandidateIds.has(candidateId)) {
      logger.warn('agentClaudeDecision: model selected a candidateId outside the eligible set — dropping it (not acted on)', { candidateId });
      continue;
    }
    if (seenIds.has(candidateId)) continue; // A duplicate selection of the same real candidate — keep only the first.
    seenIds.add(candidateId);
    selected.push({ candidateId, rationale: rationale.slice(0, 500) });
  }

  return { selected };
}

interface AnthropicMessagesResponse {
  content?: { type: string; text?: string }[];
}

/**
 * Asks Claude to prioritize among `candidates`, capped to `budget` selections by the prompt
 * (defense-in-depth only — the caller MUST still truncate the returned `selected` array to
 * `budget` itself, since a prompt is a request, not an enforcement mechanism).
 *
 * Fail-safe: ANY error (missing API key/model config, network/HTTP error, malformed response)
 * resolves to `EMPTY_DECISION` rather than throwing — a failure to get a prioritization decision
 * must never be treated as "approve everything" or crash the whole agent run.
 */
export async function decideAgentActions(
  candidates: readonly AgentDecisionCandidate[],
  budget: number,
): Promise<AgentDecisionResult> {
  if (candidates.length === 0 || budget <= 0) return EMPTY_DECISION;

  const model = process.env[CLAUDE_MODEL_ENV_VAR];
  if (!model) {
    logger.error(`agentClaudeDecision: missing required environment variable ${CLAUDE_MODEL_ENV_VAR} (fail-safe: selecting nothing)`);
    return EMPTY_DECISION;
  }

  const eligibleCandidateIds = new Set(candidates.map((c) => c.candidateId));

  let responseText: string;
  try {
    const apiKey = await fetchCachedApiKey();
    const res = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model,
        max_tokens: MAX_OUTPUT_TOKENS,
        temperature: 0,
        messages: [{ role: 'user', content: buildPrompt(candidates, budget) }],
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '(could not read response body)');
      throw new Error(`Anthropic API returned ${res.status}: ${body}`);
    }

    const data = (await res.json()) as AnthropicMessagesResponse;
    const block = data.content?.find((c) => c.type === 'text' && typeof c.text === 'string');
    if (!block?.text) {
      logger.error('agentClaudeDecision: Claude response had no text content (fail-safe: selecting nothing)', data);
      return EMPTY_DECISION;
    }
    responseText = block.text;
  } catch (err) {
    logger.error('agentClaudeDecision: Claude API call failed (fail-safe: selecting nothing)', err);
    return EMPTY_DECISION;
  }

  const decision = parseAgentDecision(responseText, eligibleCandidateIds);
  // Defense-in-depth truncation — even though the prompt asked for at most `budget`, never trust
  // the model to have honored it.
  return { selected: decision.selected.slice(0, budget) };
}
