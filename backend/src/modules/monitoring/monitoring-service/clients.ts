import {
  getEc2Client,
  getRdsClient,
  getEcsClient,
  getCloudWatchClient,
} from '../../../core/aws-clients.js';

/**
 * `monitoring-service` runs inside the `router` Lambda, on the handling path of every `GET
 * /monitoring` request (spec `realtime-monitoring-dashboard`) — NOT a scheduled Lambda. Reads the
 * region directly from `process.env.AWS_REGION` (the Lambda runtime always sets this variable
 * itself), matching the `cost-collector.ts`/`infra-review-collector.ts`/`ec2-collector.ts`
 * pattern — does NOT import `config.ts` (a singleton module that validates the entire `AppConfig`,
 * including variables unrelated to this service).
 */
export const AWS_REGION = process.env.AWS_REGION as string;

export const ec2 = getEc2Client();
export const rds = getRdsClient();
export const ecs = getEcsClient();
export const cloudwatch = getCloudWatchClient();
