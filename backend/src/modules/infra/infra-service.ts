import { DescribeInstancesCommand } from '@aws-sdk/client-ec2';
import { DescribeDBInstancesCommand } from '@aws-sdk/client-rds';
import {
  DescribeLoadBalancersCommand,
  DescribeTargetGroupsCommand,
  DescribeTargetHealthCommand,
  DescribeTagsCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import type { AlbSummary, AlbTargetGroupHealth, Ec2Summary, InfraData, RdsSummary } from '@ops-dashboard/shared';
// Lean_Lambda_Exception (Requirement 6.4a): direct import, not `../ec2-management/index.js`.
// `infra-service.ts` is used by `infra-collector-fn` (a lean standalone Lambda), and the barrel
// also re-exports handler files (`actions-ec2-management.ts`, `instanceInInfraCache.ts`) that
// import `config.ts`/`shared-kernel/s3Cache.ts` at module scope — going through the barrel would
// make this Lambda depend on env vars it is never granted (see `lambda-boot.test.ts`).
import { evalThreshold, stateThreshold, applyMonitoringExemption } from '../ec2-management/thresholds.js';
import { AWS_REGION } from './awsRegion.js';
import { getEc2Client, getRdsClient, getElasticLoadBalancingV2Client } from '../../core/aws-clients.js';
import { tagsToMap, getTagValue } from '../../core/awsTags.js';
import { fetchAllPages } from '../../core/pagination.js';

const ec2 = getEc2Client();
const rds = getRdsClient();
const elb = getElasticLoadBalancingV2Client();

async function loadEc2(): Promise<Ec2Summary[]> {
  const result: Ec2Summary[] = [];
  const reservations = await fetchAllPages(async (nextToken) => {
    const { Reservations = [], NextToken } = await ec2.send(new DescribeInstancesCommand({ NextToken: nextToken }));
    return { items: Reservations, nextToken: NextToken };
  });
  for (const reservation of reservations) {
    for (const instance of reservation.Instances ?? []) {
      const state = instance.State?.Name ?? 'unknown';
      const nameTag = getTagValue(instance.Tags, 'Name') ?? '(no Name tag)';
      const tags = tagsToMap(instance.Tags);
      result.push({
        instanceId: instance.InstanceId ?? '',
        name: nameTag,
        region: AWS_REGION,
        state,
        instanceType: instance.InstanceType ?? '',
        // `Platform` is only ever 'windows' for Windows (the OFFICIAL DescribeInstances behavior,
        // undefined for every Linux/UNIX) — see the same pattern in ec2-collector.ts. Cast to
        // `string`: the runtime returns the lowercase literal ('windows') even though the SDK's
        // declared type ('PlatformValues') only lists the capitalized 'Windows' — same way
        // ec2-collector.ts reads this field (no narrowing).
        platform: (instance.Platform as string | undefined) === 'windows' ? 'windows' : 'linux',
        // `applyMonitoringExemption` downgrades this to `ok` when the instance carries
        // `ops-dashboard:monitoring-exempt` — for instances that are DELIBERATELY stopped
        // (seasonal/one-off resources) rather than unexpectedly down. See the tag's doc comment.
        threshold: applyMonitoringExemption(stateThreshold(state, ['stopped', 'stopping'], ['pending']), tags),
        tags,
        securityGroupIds: (instance.SecurityGroups ?? []).map((g) => g.GroupId ?? '').filter((id) => id !== ''),
      });
    }
  }
  return result;
}

async function loadRds(): Promise<RdsSummary[]> {
  const { DBInstances = [] } = await rds.send(new DescribeDBInstancesCommand({}));

  return DBInstances.map((db) => {
    const allocatedGb = db.AllocatedStorage ?? 0;
    // The RDS API doesn't return free storage directly — only CloudWatch FreeStorageSpace has
    // it, but an extra CloudWatch call on every render costs a round-trip; approximating via
    // allocated storage + status is good enough for the overview dashboard, not a precise metric source.
    return {
      dbInstanceIdentifier: db.DBInstanceIdentifier ?? '',
      region: AWS_REGION,
      status: db.DBInstanceStatus ?? 'unknown',
      engine: db.Engine ?? '',
      multiAz: db.MultiAZ ?? false,
      freeStorageGb: 0,
      allocatedStorageGb: allocatedGb,
      threshold: stateThreshold(db.DBInstanceStatus ?? 'unknown', ['stopped', 'failed', 'incompatible-restore'], [
        'starting',
        'backing-up',
      ]),
    };
  });
}

// Only adding the `export` keyword (no logic/behavior change) so `monitoring-service.ts` can
// import this DescribeLoadBalancers/DescribeTargetGroups/DescribeTargetHealth logic directly,
// per design.md's (realtime-monitoring-dashboard spec) "import directly, don't copy-paste" requirement.
/**
 * Extracts the `app/<name>/<id>` tail from a full ALB ARN
 * (`arn:aws:elasticloadbalancing:<region>:<account>:loadbalancer/app/<name>/<id>`) — this IS the
 * value CloudWatch requires for the `LoadBalancer` dimension (namespace `AWS/ApplicationELB`), NOT
 * the bare `LoadBalancerName` (Bug found in the wild: using `LoadBalancerName` means
 * `GetMetricData`/`DescribeAlarms` never match any real metric for the ALB — silently returning
 * `undefined`/0 datapoints, no error). Returns `undefined` if the ARN doesn't match the expected
 * structure (doesn't throw — the ALB still displays fine in `InfraTab`, only its Realtime_Metric
 * ends up with no data).
 */
export function extractAlbArnSuffix(loadBalancerArn: string | undefined): string | undefined {
  if (!loadBalancerArn) return undefined;
  const marker = ':loadbalancer/';
  const index = loadBalancerArn.indexOf(marker);
  if (index === -1) return undefined;
  return loadBalancerArn.slice(index + marker.length);
}

export async function loadAlb(): Promise<AlbSummary[]> {
  const { LoadBalancers = [] } = await elb.send(new DescribeLoadBalancersCommand({}));
  const result: AlbSummary[] = [];

  for (const lb of LoadBalancers) {
    const { TargetGroups = [] } = await elb.send(
      new DescribeTargetGroupsCommand({ LoadBalancerArn: lb.LoadBalancerArn }),
    );

    // Tags for `MONITORING_EXEMPT_TAG_KEY` (see thresholds.ts) — e.g. a STG ALB whose targets go
    // unhealthy purely because `modules/idle-scheduler/` stopped the app instance to save cost,
    // not because of a real outage. `DescribeTags` has no resource-level ARN restriction
    // needed here (see IAM in ops-dashboard.yaml, InfraCollectorRole/RouterRole) and — unlike
    // DescribeLoadBalancers/DescribeTargetGroups/DescribeTargetHealth above — takes an ARN per
    // call, so it is skipped entirely when `LoadBalancerArn` is missing rather than guessing.
    let albTags: Record<string, string> = {};
    if (lb.LoadBalancerArn) {
      const { TagDescriptions = [] } = await elb.send(new DescribeTagsCommand({ ResourceArns: [lb.LoadBalancerArn] }));
      albTags = tagsToMap(TagDescriptions[0]?.Tags);
    }

    let totalTargets = 0;
    let unhealthyTargets = 0;
    // Breakdown per INDIVIDUAL target group (new requirement: show "which target group has a
    // problem" when the ALB is unhealthy, not just an ALB-wide aggregate) — 1 entry per target
    // group, even when that target group has no targets at all (totalTargets: 0).
    const targetGroups: AlbTargetGroupHealth[] = [];
    for (const tg of TargetGroups) {
      const { TargetHealthDescriptions = [] } = await elb.send(
        new DescribeTargetHealthCommand({ TargetGroupArn: tg.TargetGroupArn }),
      );
      const tgTotal = TargetHealthDescriptions.length;
      const tgUnhealthy = TargetHealthDescriptions.filter((t) => t.TargetHealth?.State !== 'healthy').length;

      totalTargets += tgTotal;
      unhealthyTargets += tgUnhealthy;
      targetGroups.push({
        targetGroupName: tg.TargetGroupName ?? tg.TargetGroupArn ?? 'unknown',
        unhealthyTargets: tgUnhealthy,
        totalTargets: tgTotal,
      });
    }

    result.push({
      name: lb.LoadBalancerName ?? '',
      region: AWS_REGION,
      state: lb.State?.Code ?? 'unknown',
      unhealthyTargets,
      totalTargets,
      arnSuffix: extractAlbArnSuffix(lb.LoadBalancerArn),
      targetGroups,
      threshold: applyMonitoringExemption(
        evalThreshold(unhealthyTargets, {
          warnAt: 1,
          criticalAt: totalTargets, // all targets unhealthy = critical
          direction: 'above',
          okReason: 'All targets healthy',
          warnReason: `${unhealthyTargets}/${totalTargets} targets unhealthy`,
          criticalReason: 'All targets unhealthy',
        }),
        albTags,
      ),
    });
  }
  return result;
}

export async function getInfraData(): Promise<InfraData> {
  const [ec2Data, rdsData, albData] = await Promise.all([loadEc2(), loadRds(), loadAlb()]);
  const generatedAt = new Date().toISOString();
  return { ec2: ec2Data, rds: rdsData, alb: albData, generatedAt, asOf: generatedAt };
}
