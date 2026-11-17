import { getS3Client, getEc2Client, getCloudWatchClient } from '../../../core/aws-clients.js';

export const s3 = getS3Client();
export const ec2 = getEc2Client();
export const cloudwatch = getCloudWatchClient();

/**
 * The `infra-review-collector` Lambda is granted only the `ASSESSMENT_BUCKET_NAME` env var in
 * CloudFormation (least-privilege principle) — it does NOT import `config.ts` (the singleton
 * module that validates the entire `AppConfig`, including variables unrelated to this Lambda like
 * `ENTRA_TENANT_ID`). Reads the env directly + fails loud on its own, following the same pattern
 * as `COST_CACHE_PARAM_NAME` in `cost-collector.ts`.
 */
export const ASSESSMENT_BUCKET_NAME = process.env.ASSESSMENT_BUCKET_NAME;
if (!ASSESSMENT_BUCKET_NAME) throw new Error('Missing required environment variable: ASSESSMENT_BUCKET_NAME');

/** The AWS Account ID of the account deploying this stack (CloudFormation pseudo-param
 * `${AWS::AccountId}` — see `infra/ops-dashboard.yaml`) — NOT hardcoded, so the Lambda works
 * correctly on ANY AWS account, not just the project's original account. Coerced to `string`
 * (not `string | undefined`) RIGHT HERE via a throw-if-missing expression — this avoids
 * TypeScript "forgetting" the narrowing when this module-scope variable is read again from
 * inside `handler()`'s closure (unlike a separate `if (!x) throw` — that kind of narrowing does
 * NOT survive across nested function boundaries). */
export const AWS_ACCOUNT_ID: string =
  process.env.AWS_ACCOUNT_ID ??
  (() => {
    throw new Error('Missing required environment variable: AWS_ACCOUNT_ID');
  })();
