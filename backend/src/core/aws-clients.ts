/**
 * Centralized AWS SDK v3 client construction — the ONLY place in `backend/src` allowed to call
 * `new <Service>Client(...)` for production code once every existing call site has been migrated
 * onto this module (enforced by `core/no-direct-client-construction.test.ts`).
 *
 * Each exported `getXxxClient()` function is a memoized lazy singleton: the first call constructs
 * the client, every later call within the same Lambda execution environment/module import returns
 * the SAME instance — the same lazy-singleton idiom already used ad hoc in `ai-ops-agent.ts`
 * (`function s3(): S3Client { if (!s3Client) s3Client = new S3Client(...); return s3Client; }`),
 * generalized here into one reusable helper instead of hand-writing it per client, per file.
 *
 * Region: read directly from `process.env.AWS_REGION`, NOT via `config.ts` — `config.ts` is a
 * fail-loud singleton that throws at import time if any required ROUTER environment variable is
 * missing (ENTRA_TENANT_ID, ACTION_EXECUTION_FUNCTION_NAME, ...). A scheduled collector Lambda is
 * granted only its own narrow set of environment variables, so merely importing `config.js` would
 * kill it at module load time on every invocation (the exact failure already documented on
 * `lib/awsRegion.ts`'s `AWS_REGION` export, and on `ASSESSMENT_BUCKET_NAME` in
 * `infra/ops-dashboard.yaml` above `InfraCollectorFunction`). This module must be safely
 * importable from ANY Lambda in this project, so it never imports `config.js`.
 *
 * Retry configuration: every client gets an explicit `maxAttempts`/`retryMode` rather than relying
 * on the SDK's own default — CloudWatch gets the `throttle-prone` profile (higher attempt budget,
 * adaptive mode) since every collector that batches `GetMetricData` calls per-resource is the most
 * likely call path to hit `ThrottlingException` on an account with many resources; every other
 * service gets the `standard` profile, which is the SDK's own default made explicit rather than
 * left implicit.
 */

import { ApplicationAutoScalingClient } from '@aws-sdk/client-application-auto-scaling';
import { BackupClient } from '@aws-sdk/client-backup';
import { CloudTrailClient } from '@aws-sdk/client-cloudtrail';
import { CloudWatchClient } from '@aws-sdk/client-cloudwatch';
import { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import { ComputeOptimizerClient } from '@aws-sdk/client-compute-optimizer';
import { ConfigServiceClient } from '@aws-sdk/client-config-service';
import { CostExplorerClient } from '@aws-sdk/client-cost-explorer';
import { DLMClient } from '@aws-sdk/client-dlm';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { EC2Client } from '@aws-sdk/client-ec2';
import { ECSClient } from '@aws-sdk/client-ecs';
import { ElasticLoadBalancingV2Client } from '@aws-sdk/client-elastic-load-balancing-v2';
import { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import { GuardDutyClient } from '@aws-sdk/client-guardduty';
import { LambdaClient } from '@aws-sdk/client-lambda';
import { RDSClient } from '@aws-sdk/client-rds';
import { S3Client } from '@aws-sdk/client-s3';
import { SchedulerClient } from '@aws-sdk/client-scheduler';
import { SNSClient } from '@aws-sdk/client-sns';
import { SSMClient } from '@aws-sdk/client-ssm';

type RetryProfileName = 'standard' | 'throttle-prone';

interface RetryProfile {
  maxAttempts: number;
  retryMode: 'standard' | 'adaptive';
}

const RETRY_PROFILES: Record<RetryProfileName, RetryProfile> = {
  // The SDK's own default (3 attempts, standard mode), made explicit rather than left implicit.
  standard: { maxAttempts: 3, retryMode: 'standard' },
  // Applied to CloudWatch: every collector that batches GetMetricData per-resource
  // (ec2-collector.ts, rds-collector.ts, serverless-collector.ts, storage-collector.ts,
  // networking-collector.ts) is the most throttle-prone call path in this codebase.
  'throttle-prone': { maxAttempts: 8, retryMode: 'adaptive' },
};

/** Region for every client except Cost Explorer (see `getCostExplorerClient` below) — read at
 * CALL time (inside each memoized builder), not at module-import time, so a test that sets
 * `process.env.AWS_REGION` after this module is first imported still takes effect on the first
 * real client construction. */
function region(): string {
  return process.env.AWS_REGION ?? '';
}

function memoize<T>(build: () => T): () => T {
  let instance: T | undefined;
  return () => {
    if (!instance) instance = build();
    return instance;
  };
}

export const getApplicationAutoScalingClient = memoize(
  () => new ApplicationAutoScalingClient({ region: region(), ...RETRY_PROFILES.standard }),
);
export const getBackupClient = memoize(() => new BackupClient({ region: region(), ...RETRY_PROFILES.standard }));
export const getCloudTrailClient = memoize(() => new CloudTrailClient({ region: region(), ...RETRY_PROFILES.standard }));
export const getCloudWatchClient = memoize(
  () => new CloudWatchClient({ region: region(), ...RETRY_PROFILES['throttle-prone'] }),
);
export const getCloudWatchLogsClient = memoize(
  () => new CloudWatchLogsClient({ region: region(), ...RETRY_PROFILES.standard }),
);
export const getComputeOptimizerClient = memoize(
  () => new ComputeOptimizerClient({ region: region(), ...RETRY_PROFILES.standard }),
);
export const getConfigServiceClient = memoize(
  () => new ConfigServiceClient({ region: region(), ...RETRY_PROFILES.standard }),
);
/** Cost Explorer only has an endpoint in `us-east-1` — hardcoded here regardless of
 * `AWS_REGION`, matching the existing behavior of `cost-collector.ts`/`savings-plans-collector.ts`. */
export const getCostExplorerClient = memoize(
  () => new CostExplorerClient({ region: 'us-east-1', ...RETRY_PROFILES.standard }),
);
export const getDlmClient = memoize(() => new DLMClient({ region: region(), ...RETRY_PROFILES.standard }));
export const getEc2Client = memoize(() => new EC2Client({ region: region(), ...RETRY_PROFILES.standard }));
export const getEcsClient = memoize(() => new ECSClient({ region: region(), ...RETRY_PROFILES.standard }));
export const getElasticLoadBalancingV2Client = memoize(
  () => new ElasticLoadBalancingV2Client({ region: region(), ...RETRY_PROFILES.standard }),
);
export const getEventBridgeClient = memoize(
  () => new EventBridgeClient({ region: region(), ...RETRY_PROFILES.standard }),
);
export const getGuardDutyClient = memoize(() => new GuardDutyClient({ region: region(), ...RETRY_PROFILES.standard }));
export const getDynamoDbClient = memoize(() => new DynamoDBClient({ region: region(), ...RETRY_PROFILES.standard }));

/** Document client over the memoized base client. `removeUndefinedValues` so optional Finding
 * fields left `undefined` (subnetId, resolvedAt, ...) are simply absent instead of throwing. */
export const getDynamoDbDocumentClient = memoize(() =>
  DynamoDBDocumentClient.from(getDynamoDbClient(), { marshallOptions: { removeUndefinedValues: true } }),
);
export const getLambdaClient = memoize(() => new LambdaClient({ region: region(), ...RETRY_PROFILES.standard }));
export const getRdsClient = memoize(() => new RDSClient({ region: region(), ...RETRY_PROFILES.standard }));
export const getS3Client = memoize(() => new S3Client({ region: region(), ...RETRY_PROFILES.standard }));
export const getSchedulerClient = memoize(() => new SchedulerClient({ region: region(), ...RETRY_PROFILES.standard }));
export const getSnsClient = memoize(() => new SNSClient({ region: region(), ...RETRY_PROFILES.standard }));
export const getSsmClient = memoize(() => new SSMClient({ region: region(), ...RETRY_PROFILES.standard }));
