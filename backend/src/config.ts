/**
 * Reads & validates configuration from environment variables. Fails loud when a required
 * variable is missing — no silent fallback, to avoid a deploy that "looks like it works" but
 * has broken config.
 */

export interface AppConfig {
  allowedOrigins: string[];
  entraTenantId: string;
  entraClientId: string;
  allowedGroupIds: string[];
  operatorGroupIds: string[];
  /** Region of the AWS account being deployed to — the Lambda runtime sets this automatically via
   * the `AWS_REGION` variable; the dashboard only reads/observes it, no multi-region support needed. */
  awsRegion: string;
  /**
   * AWS Account ID (12 digits) of the account this stack is deployed into — used to construct
   * ARNs ourselves in places where the AWS SDK response does NOT return a full ARN (e.g. RDS
   * `DescribeDBInstances` only returns `DBInstanceIdentifier`, not an ARN). Read from the
   * CloudFormation pseudo-param `${AWS::AccountId}` via the `AWS_ACCOUNT_ID` environment variable
   * (see `infra/ops-dashboard.yaml`) — NOT hardcoded, so the stack can deploy into ANY AWS
   * account, not just the project's original account.
   */
  awsAccountId: string;
  /** Name of the S3 bucket holding assessment-report.json (infra-review-collector) and
   * cost-cache.json (cost-collector) — shared bucket, distinguished by object key. */
  assessmentBucketName: string;
  /**
   * Name of the SSM Parameter (belonging to Ops_Dashboard itself, NOT the StateManager-side
   * parameter) holding the `x-service-token` secret used for service-to-service auth when
   * action-execution-fn calls StateManager — see design.md, section "StateManager —
   * Confirmed contract".
   */
  ec2StateManagerServiceTokenParamName: string;
  /** Base URL of StateManager's Lambda Function URL (AuthType NONE, not API Gateway). */
  ec2StateManagerFunctionUrl: string;
  /** Name (or ARN) of the `action-execution-fn` Lambda that the router synchronously InvokeFunctions from `POST /actions/execute`. */
  actionExecutionFunctionName: string;
  scheduledActionsMutateFunctionName: string;
  /** Name (or ARN) of the `approval-mutate-fn` Lambda that the router synchronously InvokeFunctions
   * from `POST /actions/request-approval`, `POST /actions/decide-approval`, and internally from
   * `POST /actions/execute-approval` (to mark a request `executed`) — see `approval-mutate-handler.ts`. */
  approvalMutateFunctionName: string;
  /** Name (or ARN) of the `idle-scheduler-mutate-fn` Lambda that the router synchronously
   * InvokeFunctions from `POST /idle-scheduler` and `POST /idle-scheduler/{albName}/deregister` —
   * see `modules/idle-scheduler/idle-scheduler-mutate-handler.ts`. */
  idleSchedulerMutateFunctionName: string;
  /** Name (or ARN) of the `findings-mutate-fn` Lambda that the router synchronously
   * InvokeFunctions from `POST /findings/{id}/acknowledge` — see `findings-mutate-handler.ts`.
   *
   * OPTIONAL: the route/handler that consumes this does not exist yet (added
   * ahead of time as groundwork for the findings feature). Making this
   * `readRequiredEnv` like its siblings above would make `config.ts` throw at MODULE LOAD for
   * every Lambda that imports it — including `RouterFunction`/`ActionExecutionFunction`, which
   * have nothing to do with findings — the moment `infra/ops-dashboard.yaml` is deployed without
   * `FINDINGS_MUTATE_FUNCTION_NAME` wired into their environment (it isn't, yet). Caught by
   * `src/lambda-boot.test.ts`, which boots each Lambda with ONLY the env vars the template
   * actually grants it. Switch this back to `readRequiredEnv('FINDINGS_MUTATE_FUNCTION_NAME')`
   * in the same change that wires `FindingsMutateFunction`'s ARN into every Lambda env that needs
   * it in the template — not before, or this reintroduces the crash. */
  findingsMutateFunctionName: string;
}

function readRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function readCsvEnv(name: string): string[] {
  const raw = process.env[name] ?? '';
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function loadConfig(): AppConfig {
  return {
    allowedOrigins: readCsvEnv('ALLOWED_ORIGINS'),
    entraTenantId: readRequiredEnv('ENTRA_TENANT_ID'),
    entraClientId: readRequiredEnv('ENTRA_CLIENT_ID'),
    allowedGroupIds: readCsvEnv('ALLOWED_GROUP_IDS'),
    operatorGroupIds: readCsvEnv('OPERATOR_GROUP_IDS'),
    awsRegion: readRequiredEnv('AWS_REGION'),
    awsAccountId: readRequiredEnv('AWS_ACCOUNT_ID'),
    assessmentBucketName: readRequiredEnv('ASSESSMENT_BUCKET_NAME'),
    ec2StateManagerServiceTokenParamName: readRequiredEnv('EC2_STATE_MANAGER_SERVICE_TOKEN_PARAM_NAME'),
    ec2StateManagerFunctionUrl: readRequiredEnv('EC2_STATE_MANAGER_FUNCTION_URL'),
    actionExecutionFunctionName: readRequiredEnv('ACTION_EXECUTION_FUNCTION_NAME'),
    scheduledActionsMutateFunctionName: readRequiredEnv('SCHEDULED_ACTIONS_MUTATE_FUNCTION_NAME'),
    approvalMutateFunctionName: readRequiredEnv('APPROVAL_MUTATE_FUNCTION_NAME'),
    idleSchedulerMutateFunctionName: readRequiredEnv('IDLE_SCHEDULER_MUTATE_FUNCTION_NAME'),
    // Not readRequiredEnv — see the field's doc comment on AppConfig: no route/handler consumes
    // this yet, and infra/ops-dashboard.yaml does not grant it to any Lambda yet either.
    findingsMutateFunctionName: process.env.FINDINGS_MUTATE_FUNCTION_NAME ?? '',
  };
}

/** Singleton config — throws immediately when the module is loaded if a required env var is missing. */
export const config: AppConfig = loadConfig();

/**
 * CORS headers for the response. Only set when the origin is in the configured allowlist —
 * NEVER a wildcard, since the API uses JWT Bearer (credentialed requests). The API runs via a
 * Lambda Function URL (authType NONE, no platform-level CORS), so the OPTIONS preflight response
 * must return the full set of CORS headers itself.
 */
export function corsHeaders(origin?: string): Record<string, string> {
  if (!origin || !config.allowedOrigins.includes(origin)) {
    return {};
  }
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-credentials': 'true',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'authorization,content-type',
    'access-control-max-age': '600',
    vary: 'Origin',
  };
}
