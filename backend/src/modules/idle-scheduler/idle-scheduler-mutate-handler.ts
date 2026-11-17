/**
 * `idle-scheduler-mutate-fn` — dedicated mutate Lambda for the Idle-to-Zero feature (same
 * mutate-separation pattern as `scheduled-actions-mutate-handler.ts`/`action-execution-fn`: the
 * router only reads/forwards via `lambda:InvokeFunction`, and this Lambda is the ONLY place with
 * `elasticloadbalancing:AddTags`/`RemoveTags` and `cloudwatch:PutMetricAlarm`/`DeleteAlarms`
 * permission for this feature).
 *
 * Registering a group = tagging its ALB with the `idle-scheduler:*` tags (see `idleScheduler.ts`)
 * PLUS creating that group's dedicated wake alarm (`AWS/ApplicationELB` `HTTPCode_ELB_5XX_Count`,
 * `WAKE_DEBOUNCE_DATAPOINTS` consecutive breaching minutes, `AlarmActions` pointing at the shared
 * `IdleSchedulerWakeTopic`). Deregistering = the exact inverse (removes the tags, deletes the alarm).
 * Both are idempotent.
 */
import { AddTagsCommand, RemoveTagsCommand, DescribeLoadBalancersCommand } from '@aws-sdk/client-elastic-load-balancing-v2';
import { PutMetricAlarmCommand, DeleteAlarmsCommand } from '@aws-sdk/client-cloudwatch';
import { getElasticLoadBalancingV2Client, getCloudWatchClient } from '../../core/aws-clients.js';
import {
  IDLE_SCHEDULER_MANAGED_TAG_KEY,
  IDLE_SCHEDULER_EC2_INSTANCE_ID_TAG_KEY,
  IDLE_SCHEDULER_RDS_INSTANCE_ID_TAG_KEY,
  IDLE_SCHEDULER_IDLE_MINUTES_TAG_KEY,
  IDLE_SCHEDULER_EC2_INSTANCE_ID_PATTERN,
  IDLE_SCHEDULER_RDS_INSTANCE_IDENTIFIER_PATTERN,
  WAKE_DEBOUNCE_DATAPOINTS,
  DEFAULT_IDLE_MINUTES,
} from '@ops-dashboard/shared';
import { buildWakeAlarmName } from './idle-scheduler-naming.js';
import { logger } from '../../shared-kernel/logger.js';
// Same direct-import exception idle-scheduler-tick.ts already uses (see that file's header):
// reuses the exact ALB-ARN-suffix extraction infra-service.ts has, instead of re-deriving it with
// a second, slightly different implementation — that duplication is exactly what caused the
// double `app/` prefix bug fixed here (2026-09-22).
import { extractAlbArnSuffix } from '../infra/infra-service.js';

const elb = getElasticLoadBalancingV2Client();
const cw = getCloudWatchClient();

export interface RegisterGroupMutateEvent {
  kind: 'register';
  albName: string;
  ec2InstanceId: string;
  rdsInstanceId: string;
  idleMinutes?: number;
}

export interface DeregisterGroupMutateEvent {
  kind: 'deregister';
  albName: string;
}

export type IdleSchedulerMutateEvent = RegisterGroupMutateEvent | DeregisterGroupMutateEvent;

export type IdleSchedulerMutateResult = { ok: true; albName: string } | { ok: false; error: string };

async function findAlbArn(albName: string): Promise<string | undefined> {
  const { LoadBalancers = [] } = await elb.send(new DescribeLoadBalancersCommand({ Names: [albName] }));
  return LoadBalancers[0]?.LoadBalancerArn;
}

async function registerGroup(event: RegisterGroupMutateEvent): Promise<IdleSchedulerMutateResult> {
  if (!IDLE_SCHEDULER_EC2_INSTANCE_ID_PATTERN.test(event.ec2InstanceId)) {
    return { ok: false, error: 'Invalid ec2InstanceId' };
  }
  if (!IDLE_SCHEDULER_RDS_INSTANCE_IDENTIFIER_PATTERN.test(event.rdsInstanceId)) {
    return { ok: false, error: 'Invalid rdsInstanceId' };
  }
  const idleMinutes = event.idleMinutes && event.idleMinutes > 0 ? event.idleMinutes : DEFAULT_IDLE_MINUTES;

  const albArn = await findAlbArn(event.albName);
  if (!albArn) return { ok: false, error: `ALB ${event.albName} not found` };

  const wakeTopicArn = process.env.IDLE_SCHEDULER_WAKE_TOPIC_ARN;
  if (!wakeTopicArn) return { ok: false, error: 'Missing configuration: IDLE_SCHEDULER_WAKE_TOPIC_ARN' };

  try {
    await elb.send(
      new AddTagsCommand({
        ResourceArns: [albArn],
        Tags: [
          { Key: IDLE_SCHEDULER_MANAGED_TAG_KEY, Value: 'true' },
          { Key: IDLE_SCHEDULER_EC2_INSTANCE_ID_TAG_KEY, Value: event.ec2InstanceId },
          { Key: IDLE_SCHEDULER_RDS_INSTANCE_ID_TAG_KEY, Value: event.rdsInstanceId },
          { Key: IDLE_SCHEDULER_IDLE_MINUTES_TAG_KEY, Value: String(idleMinutes) },
        ],
      }),
    );
  } catch (err) {
    logger.error(`idle-scheduler-mutate: AddTags failed for ${event.albName}`, err);
    return { ok: false, error: (err as Error).message };
  }

  // `extractAlbArnSuffix` returns the `app/<name>/<id>` form already — do NOT prepend another
  // `app/` when building the dimension below (see the import's comment for the bug this fixes).
  const albArnSuffix = extractAlbArnSuffix(albArn) ?? event.albName;
  try {
    await cw.send(
      new PutMetricAlarmCommand({
        AlarmName: buildWakeAlarmName(event.albName),
        AlarmDescription: `idle-scheduler: wakes ${event.ec2InstanceId}/${event.rdsInstanceId} on the first real request after idle-stop (ALB ${event.albName}). Requires ${WAKE_DEBOUNCE_DATAPOINTS} consecutive breaching minutes.`,
        Namespace: 'AWS/ApplicationELB',
        MetricName: 'HTTPCode_ELB_5XX_Count',
        Dimensions: [{ Name: 'LoadBalancer', Value: albArnSuffix }],
        Statistic: 'Sum',
        Period: 60,
        EvaluationPeriods: WAKE_DEBOUNCE_DATAPOINTS,
        DatapointsToAlarm: WAKE_DEBOUNCE_DATAPOINTS,
        Threshold: 0,
        ComparisonOperator: 'GreaterThanThreshold',
        TreatMissingData: 'notBreaching',
        AlarmActions: [wakeTopicArn],
      }),
    );
  } catch (err) {
    logger.error(`idle-scheduler-mutate: PutMetricAlarm failed for ${event.albName}`, err);
    return { ok: false, error: (err as Error).message };
  }

  logger.info(`idle-scheduler-mutate: registered group for ALB ${event.albName} (ec2=${event.ec2InstanceId} rds=${event.rdsInstanceId} idleMinutes=${idleMinutes})`);
  return { ok: true, albName: event.albName };
}

async function deregisterGroup(event: DeregisterGroupMutateEvent): Promise<IdleSchedulerMutateResult> {
  const albArn = await findAlbArn(event.albName);
  if (albArn) {
    try {
      await elb.send(
        new RemoveTagsCommand({
          ResourceArns: [albArn],
          TagKeys: [IDLE_SCHEDULER_MANAGED_TAG_KEY, IDLE_SCHEDULER_EC2_INSTANCE_ID_TAG_KEY, IDLE_SCHEDULER_RDS_INSTANCE_ID_TAG_KEY, IDLE_SCHEDULER_IDLE_MINUTES_TAG_KEY],
        }),
      );
    } catch (err) {
      logger.error(`idle-scheduler-mutate: RemoveTags failed for ${event.albName}`, err);
      return { ok: false, error: (err as Error).message };
    }
  }

  try {
    await cw.send(new DeleteAlarmsCommand({ AlarmNames: [buildWakeAlarmName(event.albName)] }));
  } catch (err) {
    logger.error(`idle-scheduler-mutate: DeleteAlarms failed for ${event.albName}`, err);
    return { ok: false, error: (err as Error).message };
  }

  logger.info(`idle-scheduler-mutate: deregistered group for ALB ${event.albName}`);
  return { ok: true, albName: event.albName };
}

export async function handler(event: IdleSchedulerMutateEvent): Promise<IdleSchedulerMutateResult> {
  if (event.kind === 'register') return registerGroup(event);
  return deregisterGroup(event);
}
