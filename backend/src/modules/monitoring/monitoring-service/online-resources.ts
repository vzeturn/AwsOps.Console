import { DescribeInstancesCommand, DescribeVolumesCommand } from '@aws-sdk/client-ec2';
import { DescribeDBInstancesCommand } from '@aws-sdk/client-rds';
import { ListClustersCommand, ListServicesCommand, DescribeServicesCommand } from '@aws-sdk/client-ecs';
import type { AlbTargetGroupHealth } from '@ops-dashboard/shared';
// Lean_Lambda_Exception (Requirement 6.4a): direct import, not `../../infra/index.js`. This
// file is re-exported by `monitoring-service.ts`, which is imported by `alert-service.ts`, which
// is used by `health-report-fn` (a lean standalone Lambda) — the infra barrel also re-exports
// `get-infra.ts`/`get-topology.ts`, which import `config.ts` at module scope (see
// `lambda-boot.test.ts`).
import { loadAlb } from '../../infra/infra-service.js';
import { AWS_REGION, ec2, rds, ecs } from './clients.js';

// ---- Online_Resource data shapes (internal — not exported via the API; MonitoringResource/
// RealtimeMetric in `@ops-dashboard/shared` is the actual API contract) ----

export interface OnlineEc2Instance {
  instanceId: string;
  name: string;
  region: string;
  instanceType: string;
}

export interface OnlineEbsVolume {
  volumeId: string;
  region: string;
  /** 'standard' | 'gp2' | 'gp3' | 'io1' | 'io2' | 'st1' | 'sc1' — used to decide whether to add
   * VolumeThroughputPercentage (Requirement 3.2). */
  volumeType: string;
  sizeGb: number;
  /** The `running` parent EC2 instance this volume is `attached` to (Requirement 3.1/3.5). */
  instanceId: string;
}

export interface OnlineRdsInstance {
  dbInstanceIdentifier: string;
  region: string;
  dbInstanceClass: string;
  engine: string;
  /** `AllocatedStorage` (GiB) from `DescribeDBInstances` — needed by `evalMonitoringThreshold()` to
   * compute the free % of `FreeStorageSpace` (Requirement 4.4). `undefined` if AWS doesn't return
   * this value (never observed in practice, but the API field is optional). */
  allocatedStorageGb?: number;
}

export interface AlbTargetsSummary {
  name: string;
  region: string;
  unhealthyTargets: number;
  totalTargets: number;
  /** The ARN suffix `app/<name>/<id>` — the ACTUAL `LoadBalancer` dimension value CloudWatch needs
   * (see `extractAlbArnSuffix` in infra-service.ts). `undefined` if the ALB ARN doesn't match the
   * expected structure — in that case this ALB is NOT included in the CloudWatch query (no valid
   * dimension value to call with), the same way EBS/EC2/RDS are skipped when a required
   * identifier is missing. */
  arnSuffix?: string;
  /** Breakdown per target group — lets Monitoring_Page show exactly which target group is
   * unhealthy (see `AlbTargetGroupHealth`, instead of only showing an ALB-wide aggregate count). */
  targetGroups: AlbTargetGroupHealth[];
  /** The ALB's tags — carried through so `getMonitoringData()` can apply
   * `applyMonitoringExemption()` (modules/ec2-management/thresholds.ts) the SAME way `infra-service.ts` does for its
   * own `AlbSummary.threshold`. Without this, an ALB tagged `ops-dashboard:monitoring-exempt`
   * would stop showing critical on the Infra tab but flip back to critical on Infra Map the
   * moment CloudWatch's own UnHealthyHostCount datapoint catches up with target health — the 2
   * threshold systems drifting apart is exactly what `monitoringThresholds.ts`'s file header
   * says must never happen. */
  tags: Record<string, string>;
}

export interface OnlineResources {
  ec2: OnlineEc2Instance[];
  ebs: OnlineEbsVolume[];
  rds: OnlineRdsInstance[];
  alb: AlbTargetsSummary[];
  ecs: OnlineEcsService[];
}

// ---- Online_Resource loading (Requirement 6.1, 6.2, 6.3) ----

/**
 * `Online_Resource` for EC2: an instance in `running` state (Glossary requirements.md).
 * Re-evaluated entirely from the current `DescribeInstances` call's result — no state is
 * read/stored across cycles (Requirement 6.3).
 */
export async function loadOnlineEc2(): Promise<OnlineEc2Instance[]> {
  const result: OnlineEc2Instance[] = [];
  let nextToken: string | undefined;
  do {
    const { Reservations = [], NextToken } = await ec2.send(new DescribeInstancesCommand({ NextToken: nextToken }));
    for (const reservation of Reservations) {
      for (const instance of reservation.Instances ?? []) {
        const instanceId = instance.InstanceId;
        if (!instanceId) continue;
        if (instance.State?.Name !== 'running') continue; // Online_Resource: only 'running'.

        const nameTag = instance.Tags?.find((t) => t.Key === 'Name')?.Value ?? '(no Name tag)';
        result.push({
          instanceId,
          name: nameTag,
          region: AWS_REGION,
          instanceType: instance.InstanceType ?? '',
        });
      }
    }
    nextToken = NextToken;
  } while (nextToken);
  return result;
}

/**
 * `Online_Resource` for EBS_Volume: `attached` TO an EC2 instance that is `running` (Glossary).
 * Reuses `onlineEc2` (the `loadOnlineEc2()` result from the SAME current cycle — doesn't call
 * `DescribeInstances` again) to determine "the running parent instance", per design.md.
 */
export async function loadOnlineEbs(onlineEc2: OnlineEc2Instance[]): Promise<OnlineEbsVolume[]> {
  const onlineInstanceIds = new Set(onlineEc2.map((instance) => instance.instanceId));
  const { Volumes = [] } = await ec2.send(new DescribeVolumesCommand({}));
  const result: OnlineEbsVolume[] = [];

  for (const volume of Volumes) {
    const volumeId = volume.VolumeId;
    if (!volumeId) continue;

    const attachment = volume.Attachments?.[0];
    if (!attachment || attachment.State !== 'attached') continue; // must be 'attached'.

    const instanceId = attachment.InstanceId;
    if (!instanceId || !onlineInstanceIds.has(instanceId)) continue; // + parent instance must be running.

    result.push({
      volumeId,
      region: AWS_REGION,
      volumeType: volume.VolumeType ?? '',
      sizeGb: volume.Size ?? 0,
      instanceId,
    });
  }
  return result;
}

/**
 * `Online_Resource` for RDS: an instance in `available` state (Glossary).
 */
export async function loadOnlineRds(): Promise<OnlineRdsInstance[]> {
  const { DBInstances = [] } = await rds.send(new DescribeDBInstancesCommand({}));
  const result: OnlineRdsInstance[] = [];

  for (const db of DBInstances) {
    const dbInstanceIdentifier = db.DBInstanceIdentifier;
    if (!dbInstanceIdentifier) continue;
    if (db.DBInstanceStatus !== 'available') continue; // Online_Resource: only 'available'.

    result.push({
      dbInstanceIdentifier,
      region: AWS_REGION,
      dbInstanceClass: db.DBInstanceClass ?? '',
      engine: db.Engine ?? '',
      allocatedStorageGb: db.AllocatedStorage,
    });
  }
  return result;
}

/**
 * ALB has no separate `Online_Resource` concept (Requirement 5.1 only requires "exists in
 * AWS_Account", unlike EC2/RDS/EBS_Volume) — returns every load balancer found.
 *
 * Reuses the EXACT `DescribeLoadBalancers`/`DescribeTargetGroups`/`DescribeTargetHealth` logic
 * already in `infra-service.ts` (imports `loadAlb` directly, no copy-paste — keeps
 * `InfraTab`/`evalThreshold` behavior unchanged), only extracting the `unhealthyTargets`/
 * `totalTargets` needed for Monitoring_Page's ALB thresholds (Requirement 5.2/5.3, Property 6).
 */
export async function loadAlbTargets(): Promise<AlbTargetsSummary[]> {
  const albs = await loadAlb();
  return albs.map((alb) => ({
    name: alb.name,
    region: alb.region,
    unhealthyTargets: alb.unhealthyTargets,
    totalTargets: alb.totalTargets,
    arnSuffix: alb.arnSuffix,
    targetGroups: alb.targetGroups,
    tags: alb.tags ?? {},
  }));
}

/** ECS_Service — an ECS cluster/service that is `ACTIVE` AND has `runningCount > 0`
 * (`Online_Resource` for ECS, similar to how EC2 only counts `running`/RDS only counts
 * `available`) — ECS only emits metrics to CloudWatch when a task is RUNNING (AWS ECS CloudWatch
 * docs), so including a service with no running task in the `GetMetricData` query would only
 * waste quota and never produce a datapoint. */
export interface OnlineEcsService {
  serviceName: string;
  clusterName: string;
  region: string;
}

/**
 * `Online_Resource` for ECS_Service: lists EVERY cluster, EVERY service in each cluster, keeping
 * only services where `status === 'ACTIVE'` AND `runningCount > 0` (ECS only emits CloudWatch
 * metrics when a task is RUNNING — a service with no running task would always return 0
 * datapoints, the same reason EC2 only counts `running` instances).
 */
export async function loadOnlineEcsServices(): Promise<OnlineEcsService[]> {
  const { clusterArns = [] } = await ecs.send(new ListClustersCommand({}));
  if (clusterArns.length === 0) return [];

  const result: OnlineEcsService[] = [];
  for (const clusterArn of clusterArns) {
    const { serviceArns = [] } = await ecs.send(new ListServicesCommand({ cluster: clusterArn }));
    if (serviceArns.length === 0) continue;

    const { services = [] } = await ecs.send(
      new DescribeServicesCommand({ cluster: clusterArn, services: serviceArns }),
    );

    for (const service of services) {
      if (service.status !== 'ACTIVE') continue;
      if ((service.runningCount ?? 0) <= 0) continue;
      const serviceName = service.serviceName;
      // clusterArn has the form arn:aws:ecs:<region>:<account>:cluster/<clusterName> — the
      // CloudWatch ClusterName dimension needs the NAME, not the full ARN.
      const clusterName = clusterArn.split('/').pop();
      if (!serviceName || !clusterName) continue;
      result.push({ serviceName, clusterName, region: AWS_REGION });
    }
  }
  return result;
}

/** Calls the load functions above for every `Online_Resource` of the current refresh cycle. */
export async function loadOnlineResources(): Promise<OnlineResources> {
  const ec2Instances = await loadOnlineEc2();
  const [ebsVolumes, rdsInstances, albTargets, ecsServices] = await Promise.all([
    loadOnlineEbs(ec2Instances),
    loadOnlineRds(),
    loadAlbTargets(),
    loadOnlineEcsServices(),
  ]);
  return { ec2: ec2Instances, ebs: ebsVolumes, rds: rdsInstances, alb: albTargets, ecs: ecsServices };
}
