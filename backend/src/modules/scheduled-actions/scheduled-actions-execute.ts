import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from 'aws-lambda';
import { InvokeCommand } from '@aws-sdk/client-lambda';
import { getLambdaClient } from '../../core/aws-clients.js';
import type { CreateScheduleRequest } from '@ops-dashboard/shared';
import type { ScheduledActionsMutateEvent, ScheduledActionsMutateResult } from './scheduled-actions-mutate-handler.js';
import { ok } from '../../shared-kernel/response.js';
import { badRequest, badGateway } from '../../shared-kernel/errors.js';
import { config } from '../../config.js';

const lambdaClient = getLambdaClient();

interface CreateScheduleBody {
  runAtIso?: unknown;
  rds?: unknown;
  ec2?: unknown;
}

// `buildScheduleName()` in scheduled-actions-mutate-handler.ts generates names matching this
// pattern — used to block deletion of arbitrary schedules (see Fix 3, final-review-fix-brief.md).
const SCHEDULE_NAME_PATTERN = /^abc-prod-downsize-\d{8}-\d{4}-[a-z0-9]{4}$/;

// RDS instance identifier: lowercase alphanumeric + hyphen, must start with a letter.
const RDS_INSTANCE_IDENTIFIER_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
// RDS instance class, e.g. db.m7g.xlarge.
const RDS_TARGET_CLASS_PATTERN = /^db\.[a-z0-9]+\.[a-z0-9]+$/;
// AWS availability zone, e.g. ap-southeast-1a.
const RDS_AVAILABILITY_ZONE_PATTERN = /^[a-z]{2}-[a-z]+-\d[a-z]$/;
// EC2 instance ID, e.g. i-0a1b2c3d4e5f60002.
const EC2_INSTANCE_ID_PATTERN = /^i-[0-9a-f]{8,17}$/;
// EC2 instance type, e.g. t3.xlarge.
const EC2_TARGET_TYPE_PATTERN = /^[a-z0-9]+\.[a-z0-9]+$/;

function parseBody<T>(event: LambdaFunctionURLEvent): T {
  try {
    return JSON.parse(event.body ?? '{}') as T;
  } catch {
    throw badRequest('Invalid JSON body');
  }
}

function isRdsTarget(value: unknown): value is { instanceIdentifier: string; targetClass?: string; availabilityZone?: string } {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.instanceIdentifier !== 'string' || !RDS_INSTANCE_IDENTIFIER_PATTERN.test(v.instanceIdentifier)) return false;
  const hasTargetClass = v.targetClass !== undefined;
  const hasAvailabilityZone = v.availabilityZone !== undefined;
  if (!hasTargetClass && !hasAvailabilityZone) return false;
  if (hasTargetClass && (typeof v.targetClass !== 'string' || !RDS_TARGET_CLASS_PATTERN.test(v.targetClass))) return false;
  if (hasAvailabilityZone && (typeof v.availabilityZone !== 'string' || !RDS_AVAILABILITY_ZONE_PATTERN.test(v.availabilityZone))) return false;
  return true;
}

function isEc2Target(value: unknown): value is { instanceId: string; targetType: string } {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.instanceId === 'string' &&
    EC2_INSTANCE_ID_PATTERN.test(v.instanceId) &&
    typeof v.targetType === 'string' &&
    EC2_TARGET_TYPE_PATTERN.test(v.targetType)
  );
}

async function invokeMutate(event: ScheduledActionsMutateEvent): Promise<ScheduledActionsMutateResult> {
  let payloadText: string;
  let functionError: string | undefined;
  try {
    const response = await lambdaClient.send(
      new InvokeCommand({
        FunctionName: config.scheduledActionsMutateFunctionName,
        InvocationType: 'RequestResponse',
        Payload: Buffer.from(JSON.stringify(event)),
      }),
    );
    payloadText = Buffer.from(response.Payload ?? new Uint8Array()).toString('utf-8');
    functionError = response.FunctionError;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    throw badGateway(`Failed to invoke scheduled-actions-mutate-fn: ${message}`);
  }

  if (functionError) {
    throw badGateway('scheduled-actions-mutate-fn threw an unhandled error');
  }

  try {
    return JSON.parse(payloadText) as ScheduledActionsMutateResult;
  } catch {
    throw badGateway('scheduled-actions-mutate-fn returned an invalid response');
  }
}

export async function createHandler(event: LambdaFunctionURLEvent): Promise<LambdaFunctionURLResult> {
  const body = parseBody<CreateScheduleBody>(event);

  if (typeof body.runAtIso !== 'string' || body.runAtIso.length === 0) {
    throw badRequest('Missing or invalid: runAtIso');
  }
  const rds = isRdsTarget(body.rds) ? body.rds : undefined;
  const ec2 = isEc2Target(body.ec2) ? body.ec2 : undefined;
  if (!rds && !ec2) {
    throw badRequest('Need at least one of: rds or ec2');
  }

  const request: CreateScheduleRequest = { runAtIso: body.runAtIso, ...(rds ? { rds } : {}), ...(ec2 ? { ec2 } : {}) };
  const result = await invokeMutate({ kind: 'create', ...request });
  return ok(event, result);
}

export async function deleteHandler(event: LambdaFunctionURLEvent, scheduleName: string): Promise<LambdaFunctionURLResult> {
  if (!scheduleName) {
    throw badRequest('Missing scheduleName');
  }
  if (!SCHEDULE_NAME_PATTERN.test(scheduleName)) {
    throw badRequest('Invalid scheduleName');
  }
  const result = await invokeMutate({ kind: 'delete', scheduleName });
  return ok(event, result);
}
