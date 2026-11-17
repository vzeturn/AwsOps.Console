import { DescribeLogGroupsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { logger } from '../../shared-kernel/logger.js';
import { getCloudWatchLogsClient } from '../../core/aws-clients.js';

/** The Lambda runtime always sets this variable automatically — no need for CloudFormation to declare it, no need to validate it. */
const AWS_REGION = process.env.AWS_REGION as string;

/**
 * Raw data for a single CloudWatch Log Group — the collector ONLY gathers measured data, it does
 * NOT decide on a recommendation itself. The orchestrator (`infra-review-collector.ts`) uses
 * `retentionInDays === null` + `storedBytes` to generate a `RecommendationItem` (findingType
 * `cloudWatchLogGroupNoRetention`) with an estimated savings based on real CloudWatch Logs storage
 * pricing ($0.03/GB-month in ap-southeast-1, confirmed via the AWS Pricing API — NOT a made-up number).
 */
export interface CloudWatchLogGroupRaw {
  logGroupName: string;
  region: string;
  /** `null` = "Never Expire" (no retention policy) — this is exactly the finding that needs
   * flagging. The log group accumulates data indefinitely, needlessly driving up storage cost
   * forever. */
  retentionInDays: number | null;
  /** Stored size (bytes) — used to estimate savings if a sensible retention were set. */
  storedBytes: number;
}

/**
 * Surveys every CloudWatch Log Group in the AWS account — only returns raw data
 * (retention/storage), does not decide on a recommendation itself (that's `infra-review-collector.ts`'s job).
 * Wraps errors on its own: if `DescribeLogGroups` fails, log it and return empty — don't break the
 * other collectors (matches the `getStorageData()`/`collectRds()` pattern).
 */
export async function collectCloudWatchLogGroups(): Promise<CloudWatchLogGroupRaw[]> {
  const result: CloudWatchLogGroupRaw[] = [];
  let nextToken: string | undefined;

  try {
    do {
      const { logGroups = [], nextToken: token } = await getCloudWatchLogsClient().send(
        new DescribeLogGroupsCommand({ nextToken }),
      );
      for (const lg of logGroups) {
        if (!lg.logGroupName) continue;
        result.push({
          logGroupName: lg.logGroupName,
          region: AWS_REGION,
          retentionInDays: lg.retentionInDays ?? null,
          storedBytes: lg.storedBytes ?? 0,
        });
      }
      nextToken = token;
    } while (nextToken);
  } catch (err) {
    logger.error('cloudwatch-logs-collector: DescribeLogGroups failed (skipping, returning empty)', err);
    return [];
  }

  return result;
}
