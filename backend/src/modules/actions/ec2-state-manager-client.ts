import { GetParameterCommand } from '@aws-sdk/client-ssm';
import { getSsmClient } from '../../core/aws-clients.js';
import { config } from '../../config.js';

/**
 * Client that calls `StateManager` — a separate system, outside `Ops_Dashboard` (project
 * `ec2-state-manager`, same AWS account/region) — to execute EC2_Start/EC2_Stop. See design.md,
 * section "StateManager — Confirmed contract".
 *
 * This is a plain HTTPS POST to `StateManager`'s Lambda Function URL (`AuthType: NONE`, NOT
 * API Gateway, NOT SigV4/AWS_IAM), authenticated with an `x-service-token` header (a shared secret
 * stored in `Ops_Dashboard`'s own SSM Parameter Store) — NEVER call
 * `StartInstancesCommand`/`StopInstancesCommand` from `@aws-sdk/client-ec2` directly (Requirement
 * 9.1, verified by a dedicated static test — this file and every other file in
 * `action-execution-fn` must NOT import `@aws-sdk/client-ec2`).
 */

const HTTP_TIMEOUT_MS = 30_000;

/**
 * Cache the secret value at module scope (cold start) — fetch SSM only once per execution
 * environment, following the same module-scope cached-fetch pattern already used in
 * `threshold-history-service.ts` and `StateManager`'s own `service-token.ts`. Errors are not
 * cached — the next call in the same execution environment gets retried.
 */
let cachedTokenPromise: Promise<string> | undefined;

function fetchCachedToken(paramName: string): Promise<string> {
  if (!cachedTokenPromise) {
    cachedTokenPromise = getSsmClient()
      .send(new GetParameterCommand({ Name: paramName, WithDecryption: true }))
      .then((result) => {
        const value = result.Parameter?.Value;
        if (!value) throw new Error(`SSM Parameter '${paramName}' has no value`);
        return value;
      })
      .catch((err) => {
        cachedTokenPromise = undefined;
        throw err;
      });
  }
  return cachedTokenPromise;
}

/** `StateManager`'s standard response envelope, applying to every endpoint of that system. */
interface Ec2StateManagerSuccessEnvelope {
  success: true;
  data: {
    instanceId: string;
    region: string;
    previousState: string;
    /** A TRANSITIONAL state (e.g. 'pending'/'stopping') — NOT the final, converged state. */
    currentState: string;
  };
  error: null;
}

interface Ec2StateManagerErrorEnvelope {
  success: false;
  data: null;
  error: { code: string; message: string };
}

type Ec2StateManagerEnvelope = Ec2StateManagerSuccessEnvelope | Ec2StateManagerErrorEnvelope;

export interface CallEc2StateManagerResult {
  success: boolean;
  /** Transitional state returned DIRECTLY from `StateManager`, not mapped/transformed. */
  state?: string;
  error?: string;
}

/**
 * Calls `POST {functionUrl}/instances/{region}/{instanceId}/{start|stop}` — with NO request body,
 * every parameter lives on the URL path (matching `StateManager`'s actual contract).
 * Authenticated with the `x-service-token` header, 30,000ms timeout via `AbortController`
 * (Requirement 9.1).
 *
 * - success: true → returns `{ success: true, state: data.currentState }`.
 * - success: false, non-2xx HTTP error, network error, JSON parse error, or timeout → returns
 *   `{ success: false, error: '<message>' }`.
 */
export async function callEc2StateManager(
  instanceId: string,
  region: string,
  action: 'start' | 'stop',
): Promise<CallEc2StateManagerResult> {
  let token: string;
  try {
    token = await fetchCachedToken(config.ec2StateManagerServiceTokenParamName);
  } catch (err) {
    return { success: false, error: `Could not read the service token from SSM: ${errorMessage(err)}` };
  }

  const url = `${config.ec2StateManagerFunctionUrl.replace(/\/$/, '')}/instances/${region}/${instanceId}/${action}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'x-service-token': token },
      signal: controller.signal,
    });
  } catch (err) {
    if (controller.signal.aborted) {
      return { success: false, error: `StateManager did not respond within ${HTTP_TIMEOUT_MS}ms (timeout)` };
    }
    return { success: false, error: `Network error calling StateManager: ${errorMessage(err)}` };
  } finally {
    clearTimeout(timeoutId);
  }

  let envelope: Ec2StateManagerEnvelope;
  try {
    envelope = (await response.json()) as Ec2StateManagerEnvelope;
  } catch (err) {
    return { success: false, error: `Could not parse StateManager's response: ${errorMessage(err)}` };
  }

  if (!response.ok || !envelope.success) {
    const message = !envelope.success ? envelope.error.message : `HTTP ${response.status}`;
    return { success: false, error: message };
  }

  return { success: true, state: envelope.data.currentState };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
