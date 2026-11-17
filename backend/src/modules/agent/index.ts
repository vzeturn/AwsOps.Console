/**
 * `agent` Domain_Module — public export surface for anything outside this module that needs to
 * reference the AI Ops Agent's own symbols. As of this writing, grep across `backend/src` (see
 * `backend-core-foundation` Task 13.1) found NO external importer of any symbol in this module —
 * `ai-ops-agent.ts` is a Lambda entrypoint invoked only via its bundled handler
 * (`infra/scripts/build-artifacts.mjs`), and every other file in this module (`agentKillSwitch.ts`,
 * `agentRateLimiter.ts`, `agentClaudeDecision.ts`, `agentAutoExecutionPolicy.ts`) is only imported
 * by `ai-ops-agent.ts` itself or by this module's own tests. This barrel file exists for
 * consistency with every other Domain_Module (Requirement 6.2) and is ready to grow if a future
 * cross-module dependency needs one of these symbols.
 */
export { handler as aiOpsAgentHandler, findEligibleFindings } from './ai-ops-agent.js';
export { isAgentAutoExecuteEnabled } from './agentKillSwitch.js';
export { isAgentAutoExecutable, AGENT_AUTO_EXECUTE_ALLOWLIST } from './agentAutoExecutionPolicy.js';
export { reserveAgentExecutionBudget, pruneTimestampsWithinWindow, computeRateLimitDecision, AGENT_RATE_LIMIT_WINDOW_MS, AGENT_RATE_LIMIT_MAX_EXECUTIONS } from './agentRateLimiter.js';
export { decideAgentActions, parseAgentDecision, type AgentDecisionCandidate, type AgentDecisionResult } from './agentClaudeDecision.js';
