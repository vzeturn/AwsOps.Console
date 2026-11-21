import { GetParameterCommand } from '@aws-sdk/client-ssm';
import { getSsmClient } from '../../core/aws-clients.js';
import { logger } from '../../shared-kernel/logger.js';

/**
 * `agentKillSwitch.ts` — reads the `AGENT_AUTO_EXECUTE_ENABLED` SSM Parameter fresh on EVERY call,
 * with NO cross-invocation caching (unlike `alertHook.ts`'s `fetchCachedWebhookUrl`, which
 * caches for the lifetime of the execution environment because a webhook URL essentially never
 * changes). The entire point of a kill switch is that flipping it takes effect immediately — an
 * operator who just noticed the agent behaving badly and set this parameter to "false" cannot be
 * asked to also wait for a warm Lambda execution environment to cycle out. `ai-ops-agent.ts` runs
 * on a schedule (every 15-30 minutes, not per-request), so the extra `GetParameter` call on every
 * invocation is a negligible cost (SSM Standard-tier GetParameter is free) for a large gain in
 * responsiveness.
 *
 * FAIL-SAFE DEFAULT: disabled. Every failure path — the SSM parameter doesn't exist, the read
 * throws (network/permission error), or the value is anything other than the exact string
 * `"true"` — resolves to `false` (auto-execution disabled). There is no failure mode that
 * resolves to `true`. This mirrors the same fail-closed philosophy already used for
 * `operatorGroupIds` (`config.ts`: empty means nobody is an operator, not everybody).
 */
const AGENT_KILL_SWITCH_PARAM_NAME = process.env.AGENT_KILL_SWITCH_PARAM_NAME;

/**
 * `true` only when the SSM Parameter named by `AGENT_KILL_SWITCH_PARAM_NAME` exists and its value
 * is EXACTLY the string `"true"` (case-sensitive, no trimming leniency beyond a single
 * `.trim()` — "True"/"TRUE"/" true"/"1"/"yes" are all treated as disabled, on purpose: a kill
 * switch must never be ambiguous about what turns it ON, only about what counts as OFF, and
 * "everything except the one exact expected value is OFF" is the only rule that can't be
 * misread).
 */
export async function isAgentAutoExecuteEnabled(): Promise<boolean> {
  if (!AGENT_KILL_SWITCH_PARAM_NAME) {
    logger.warn('agentKillSwitch: AGENT_KILL_SWITCH_PARAM_NAME is not configured — treating auto-execute as disabled (fail-safe).');
    return false;
  }

  try {
    const result = await getSsmClient().send(new GetParameterCommand({ Name: AGENT_KILL_SWITCH_PARAM_NAME }));
    const value = result.Parameter?.Value?.trim();
    return value === 'true';
  } catch (err) {
    logger.error(
      'agentKillSwitch: failed to read the kill-switch SSM Parameter (treating auto-execute as disabled, fail-safe)',
      err,
    );
    return false;
  }
}
