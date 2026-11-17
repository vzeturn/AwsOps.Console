import { CreateScheduleCommand, DeleteScheduleCommand } from '@aws-sdk/client-scheduler';
import { getSchedulerClient } from '../../core/aws-clients.js';
import { logger } from '../../shared-kernel/logger.js';

/**
 * `scheduled-actions-mutate-fn` — dedicated mutate Lambda for the dashboard's Scheduled Actions
 * feature (following the same mutate-separation pattern as `action-execution-fn`: the router only
 * reads/forwards, and this Lambda is the ONLY place with `scheduler:CreateSchedule`/
 * `scheduler:DeleteSchedule` permissions). Receives a `ScheduledActionsMutateEvent` typed directly
 * from `lambda:InvokeFunction` (not via an HTTP event), same as `action-execution-handler.ts`.
 */

export interface CreateScheduleMutateEvent {
  kind: 'create';
  runAtIso: string;
  rds?: { instanceIdentifier: string; targetClass?: string; availabilityZone?: string };
  ec2?: { instanceId: string; targetType: string };
}

export interface DeleteScheduleMutateEvent {
  kind: 'delete';
  scheduleName: string;
}

export type ScheduledActionsMutateEvent = CreateScheduleMutateEvent | DeleteScheduleMutateEvent;

export type ScheduledActionsMutateResult =
  | { ok: true; scheduleName: string }
  | { ok: false; error: string };

const scheduler = getSchedulerClient();

function randomSuffix(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 4; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

function buildScheduleName(runAtIso: string): string {
  const d = new Date(runAtIso);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const min = String(d.getUTCMinutes()).padStart(2, '0');
  return `abc-prod-downsize-${yyyy}${mm}${dd}-${hh}${min}-${randomSuffix()}`;
}

function toScheduleExpression(runAtIso: string): string {
  // EventBridge Scheduler's `at()` expression requires the format "yyyy-MM-ddTHH:mm:ss" (no milliseconds/Z).
  const d = new Date(runAtIso);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const min = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `at(${yyyy}-${mm}-${dd}T${hh}:${min}:${ss})`;
}

async function createSchedule(event: CreateScheduleMutateEvent): Promise<ScheduledActionsMutateResult> {
  if (!event.rds && !event.ec2) {
    return { ok: false, error: 'Need at least one of: rds or ec2' };
  }
  const runAt = new Date(event.runAtIso);
  if (Number.isNaN(runAt.getTime())) {
    return { ok: false, error: 'Invalid runAtIso' };
  }
  if (runAt.getTime() <= Date.now()) {
    return { ok: false, error: 'runAtIso must be in the future' };
  }

  const functionArn = process.env.DOWNSIZE_SCHEDULER_FUNCTION_ARN;
  const invokeRoleArn = process.env.DOWNSIZE_SCHEDULER_INVOKE_ROLE_ARN;
  if (!functionArn || !invokeRoleArn) {
    return { ok: false, error: 'Missing configuration: DOWNSIZE_SCHEDULER_FUNCTION_ARN/DOWNSIZE_SCHEDULER_INVOKE_ROLE_ARN' };
  }

  const scheduleName = buildScheduleName(event.runAtIso);
  const input: { rds?: typeof event.rds; ec2?: typeof event.ec2 } = {};
  if (event.rds) input.rds = event.rds;
  if (event.ec2) input.ec2 = event.ec2;

  try {
    await scheduler.send(
      new CreateScheduleCommand({
        Name: scheduleName,
        ScheduleExpression: toScheduleExpression(event.runAtIso),
        ScheduleExpressionTimezone: 'UTC',
        FlexibleTimeWindow: { Mode: 'OFF' },
        ActionAfterCompletion: 'DELETE',
        Target: {
          Arn: functionArn,
          RoleArn: invokeRoleArn,
          Input: JSON.stringify(input),
        },
      }),
    );
    logger.info(`scheduled-actions-mutate: created schedule ${scheduleName} successfully.`);
    return { ok: true, scheduleName };
  } catch (err) {
    logger.error(`scheduled-actions-mutate: CreateSchedule failed for ${scheduleName}`, err);
    return { ok: false, error: (err as Error).message };
  }
}

async function deleteSchedule(event: DeleteScheduleMutateEvent): Promise<ScheduledActionsMutateResult> {
  try {
    await scheduler.send(new DeleteScheduleCommand({ Name: event.scheduleName }));
    logger.info(`scheduled-actions-mutate: deleted schedule ${event.scheduleName} successfully.`);
    return { ok: true, scheduleName: event.scheduleName };
  } catch (err) {
    logger.error(`scheduled-actions-mutate: DeleteSchedule failed for ${event.scheduleName}`, err);
    return { ok: false, error: (err as Error).message };
  }
}

export async function handler(event: ScheduledActionsMutateEvent): Promise<ScheduledActionsMutateResult> {
  if (event.kind === 'create') return createSchedule(event);
  return deleteSchedule(event);
}
