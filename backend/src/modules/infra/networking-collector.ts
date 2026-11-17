import { DescribeNatGatewaysCommand } from '@aws-sdk/client-ec2';
import type { NatGateway } from '@aws-sdk/client-ec2';
import { GetMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import {
  DescribeLoadBalancersCommand,
  DescribeTargetGroupsCommand,
  DescribeTargetHealthCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import { logger } from '../../shared-kernel/logger.js';
import { fetchAllPages } from '../../core/pagination.js';
import { getEc2Client, getCloudWatchClient, getElasticLoadBalancingV2Client } from '../../core/aws-clients.js';

/**
 * Raw collector for network data (NAT Gateway throughput + ALB target health), used by
 * `infra-review-collector`. Functions here ONLY fetch raw data from AWS — classifying
 * "NAT Gateway replacement/consolidation candidates" (Requirement 3.3) or "ALB risk of all
 * targets unhealthy" (Requirement 3.4) belongs to `lib/recommendations.ts`, run from the
 * `infra-review-collector.ts` Lambda entrypoint, not here.
 *
 * Each source (NAT / ALB) wraps its own errors — one source failing doesn't break the other,
 * per the Error Handling pattern in design.md.
 */

/** The Lambda runtime always sets this variable itself — no need for CloudFormation to declare it or to validate it. */
const AWS_REGION = process.env.AWS_REGION as string;

/** Number of days in the survey period used to compute the average NAT Gateway traffic/day. */
const SURVEY_PERIOD_DAYS = 14;

/** Max NAT Gateways per GetMetricData call (AWS limit: max 500 metric queries/request). */
const METRIC_QUERY_BATCH_SIZE = 100;

export interface NatGatewayRawSummary {
  natGatewayId: string;
  region: string;
  /** Average bytes processed (BytesOutToDestination)/day over the survey period. */
  avgBytesProcessedPerDay: number;
}

export interface AlbRawSummary {
  name: string;
  region: string;
  unhealthyTargets: number;
  totalTargets: number;
}

export interface NetworkingCollectorResult {
  natGateways: NatGatewayRawSummary[];
  albs: AlbRawSummary[];
}

function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

async function loadNatGateways(): Promise<NatGatewayRawSummary[]> {
  let natGateways: NatGateway[] = [];
  try {
    // DescribeNatGateways returns a bounded page (NextToken in/out) — paginated via
    // fetchAllPages (core/pagination.ts) so an account with more NAT gateways than fit on one
    // page is not silently truncated. topology-collector.ts's loadNatGatewayPlacement already
    // pages this same API correctly; this brings loadNatGateways in line with it.
    natGateways = await fetchAllPages(async (nextToken) => {
      const { NatGateways = [], NextToken } = await getEc2Client().send(new DescribeNatGatewaysCommand({ NextToken: nextToken }));
      return { items: NatGateways, nextToken: NextToken };
    });
  } catch (err) {
    // NAT source failed right at Describe: nothing to return, doesn't affect ALB.
    logger.error('networking-collector: DescribeNatGateways failed (skipping, returning empty)', err);
    return [];
  }

  const natGatewayIds = natGateways
    .map((nat) => nat.NatGatewayId)
    .filter((id): id is string => Boolean(id));
  const bytesByNatGatewayId = new Map<string, number>();

  if (natGatewayIds.length > 0) {
    try {
      const now = new Date();
      const startTime = new Date(now.getTime() - SURVEY_PERIOD_DAYS * 24 * 60 * 60 * 1000);

      for (const idBatch of chunk(natGatewayIds, METRIC_QUERY_BATCH_SIZE)) {
        const { MetricDataResults = [] } = await getCloudWatchClient().send(
          new GetMetricDataCommand({
            StartTime: startTime,
            EndTime: now,
            MetricDataQueries: idBatch.map((natGatewayId, index) => ({
              Id: `nat${index}`,
              MetricStat: {
                Metric: {
                  Namespace: 'AWS/NATGateway',
                  MetricName: 'BytesOutToDestination',
                  Dimensions: [{ Name: 'NatGatewayId', Value: natGatewayId }],
                },
                Period: 86400, // 1 day
                Stat: 'Sum',
              },
              ReturnData: true,
            })),
          }),
        );

        MetricDataResults.forEach((result, index) => {
          const natGatewayId = idBatch[index];
          const totalBytes = (result.Values ?? []).reduce((sum, value) => sum + value, 0);
          bytesByNatGatewayId.set(natGatewayId, totalBytes / SURVEY_PERIOD_DAYS);
        });
      }
    } catch (err) {
      // CloudWatch failed (throttling, missing permissions...): still return the NAT Gateway
      // list already Described, just missing throughput numbers (defaulting to 0) — don't let
      // the whole NAT source go empty over a secondary failure.
      logger.error(
        'networking-collector: GetMetricData (NAT BytesOutToDestination) failed (skipping, avgBytesProcessedPerDay=0)',
        err,
      );
    }
  }

  return natGateways.map((nat) => ({
    natGatewayId: nat.NatGatewayId ?? '',
    region: AWS_REGION,
    avgBytesProcessedPerDay: bytesByNatGatewayId.get(nat.NatGatewayId ?? '') ?? 0,
  }));
}

async function loadAlbs(): Promise<AlbRawSummary[]> {
  try {
    // DescribeLoadBalancers returns a bounded page (Marker in/out, NextMarker on the response) —
    // paginated via fetchAllPages (core/pagination.ts) so an account with more load balancers
    // than fit on one page is not silently truncated.
    const LoadBalancers = await fetchAllPages(async (marker) => {
      const { LoadBalancers: page = [], NextMarker } = await getElasticLoadBalancingV2Client().send(new DescribeLoadBalancersCommand({ Marker: marker }));
      return { items: page, nextToken: NextMarker };
    });
    const result: AlbRawSummary[] = [];

    for (const lb of LoadBalancers) {
      const { TargetGroups = [] } = await getElasticLoadBalancingV2Client().send(
        new DescribeTargetGroupsCommand({ LoadBalancerArn: lb.LoadBalancerArn }),
      );

      let totalTargets = 0;
      let unhealthyTargets = 0;
      for (const tg of TargetGroups) {
        const { TargetHealthDescriptions = [] } = await getElasticLoadBalancingV2Client().send(
          new DescribeTargetHealthCommand({ TargetGroupArn: tg.TargetGroupArn }),
        );
        totalTargets += TargetHealthDescriptions.length;
        unhealthyTargets += TargetHealthDescriptions.filter(
          (t) => t.TargetHealth?.State !== 'healthy',
        ).length;
      }

      result.push({
        name: lb.LoadBalancerName ?? '',
        region: AWS_REGION,
        unhealthyTargets,
        totalTargets,
      });
    }
    return result;
  } catch (err) {
    // ALB source failed: return empty, doesn't affect the NAT Gateway results already collected.
    logger.error('networking-collector: fetching ALB data failed (skipping, returning empty)', err);
    return [];
  }
}

/** Collects raw network data (NAT Gateway + ALB) — 2 independent sources, run in parallel. */
export async function collectNetworkingData(): Promise<NetworkingCollectorResult> {
  const [natGateways, albs] = await Promise.all([loadNatGateways(), loadAlbs()]);
  return { natGateways, albs };
}
