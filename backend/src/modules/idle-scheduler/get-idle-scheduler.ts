/**
 * `GET /idle-scheduler` — reads DIRECTLY (not through the mutate Lambda) the live state of every
 * managed resource-group: discovers every ALB tagged `idle-scheduler:managed=true`, then reads
 * the current EC2 state, RDS status, hold-tag, and the group's dedicated wake alarm's
 * `ActionsEnabled`. Follows the same "router only Describes/Lists/Gets" principle as
 * `get-scheduled-actions.ts`.
 */
import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from 'aws-lambda';
import { DescribeLoadBalancersCommand, DescribeTagsCommand } from '@aws-sdk/client-elastic-load-balancing-v2';
import { DescribeInstancesCommand } from '@aws-sdk/client-ec2';
import { DescribeDBInstancesCommand } from '@aws-sdk/client-rds';
import { DescribeAlarmsCommand } from '@aws-sdk/client-cloudwatch';
import { getElasticLoadBalancingV2Client, getEc2Client, getRdsClient, getCloudWatchClient } from '../../core/aws-clients.js';
import { tagsToMap } from '../../core/awsTags.js';
import { fetchAllPages } from '../../core/pagination.js';
import type { IdleSchedulerGroup, IdleSchedulerResponse } from '@ops-dashboard/shared';
import { IDLE_SCHEDULER_HOLD_TAG_KEY } from '@ops-dashboard/shared';
import { ok } from '../../shared-kernel/response.js';
import { parseManagedGroupTags } from './idle-scheduler-logic.js';
import { buildWakeAlarmName } from './idle-scheduler-naming.js';

const elb = getElasticLoadBalancingV2Client();
const ec2 = getEc2Client();
const rds = getRdsClient();
const cw = getCloudWatchClient();

async function buildGroup(albName: string, region: string, ec2InstanceId: string, rdsInstanceId: string, idleMinutes: number): Promise<IdleSchedulerGroup> {
  const [instanceResp, dbResp, alarmResp] = await Promise.all([
    ec2.send(new DescribeInstancesCommand({ InstanceIds: [ec2InstanceId] })).catch(() => undefined),
    rds.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: rdsInstanceId })).catch(() => undefined),
    cw.send(new DescribeAlarmsCommand({ AlarmNames: [buildWakeAlarmName(albName)] })).catch(() => undefined),
  ]);

  const instance = instanceResp?.Reservations?.[0]?.Instances?.[0];
  const tags = tagsToMap(instance?.Tags);
  const alarm = alarmResp?.MetricAlarms?.[0];

  return {
    albName,
    region,
    ec2InstanceId,
    rdsInstanceId,
    idleMinutes,
    ec2State: instance?.State?.Name ?? 'unknown',
    rdsStatus: dbResp?.DBInstances?.[0]?.DBInstanceStatus ?? 'unknown',
    held: tags[IDLE_SCHEDULER_HOLD_TAG_KEY] === 'true',
    wakeAlarmName: buildWakeAlarmName(albName),
    wakeAlarmActionsEnabled: alarm?.ActionsEnabled ?? false,
  };
}

export async function handler(event: LambdaFunctionURLEvent): Promise<LambdaFunctionURLResult> {
  const region = process.env.AWS_REGION ?? '';
  const groups: IdleSchedulerGroup[] = [];

  const allLoadBalancers = await fetchAllPages(async (marker) => {
    const { LoadBalancers = [], NextMarker } = await elb.send(new DescribeLoadBalancersCommand({ Marker: marker }));
    return { items: LoadBalancers, nextToken: NextMarker };
  });
  const withArn = allLoadBalancers.filter((lb) => lb.LoadBalancerArn && lb.LoadBalancerName);

  for (let i = 0; i < withArn.length; i += 20) {
    const batch = withArn.slice(i, i + 20);
    const arns = batch.map((lb) => lb.LoadBalancerArn!);
    const { TagDescriptions = [] } = await elb.send(new DescribeTagsCommand({ ResourceArns: arns }));
    for (const lb of batch) {
      const tagsList = TagDescriptions.find((td) => td.ResourceArn === lb.LoadBalancerArn)?.Tags ?? [];
      const tags = tagsToMap(tagsList);
      const parsed = parseManagedGroupTags(tags);
      if (!parsed || !parsed.ec2InstanceId || !parsed.rdsInstanceId) continue;
      groups.push(await buildGroup(lb.LoadBalancerName!, region, parsed.ec2InstanceId, parsed.rdsInstanceId, parsed.idleMinutes));
    }
  }

  const response: IdleSchedulerResponse = { groups, generatedAt: new Date().toISOString() };
  return ok(event, response);
}
