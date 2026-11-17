/**
 * `POST /idle-scheduler` (register) and `POST /idle-scheduler/{albName}/deregister` — router
 * handlers that validate input and forward the actual mutation to `idle-scheduler-mutate-fn` via
 * `lambda:InvokeFunction`, mirroring `scheduled-actions-execute.ts`'s create/delete split.
 */
import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from 'aws-lambda';
import { InvokeCommand } from '@aws-sdk/client-lambda';
import { getLambdaClient } from '../../core/aws-clients.js';
import type { CreateIdleSchedulerGroupRequest } from '@ops-dashboard/shared';
import { IDLE_SCHEDULER_EC2_INSTANCE_ID_PATTERN, IDLE_SCHEDULER_RDS_INSTANCE_IDENTIFIER_PATTERN } from '@ops-dashboard/shared';
import type { IdleSchedulerMutateEvent, IdleSchedulerMutateResult } from './idle-scheduler-mutate-handler.js';
import { ok } from '../../shared-kernel/response.js';
import { badRequest, badGateway } from '../../shared-kernel/errors.js';
import { config } from '../../config.js';

const lambdaClient = getLambdaClient();

function parseBody<T>(event: LambdaFunctionURLEvent): T {
  try {
    return JSON.parse(event.body ?? '{}') as T;
  } catch {
    throw badRequest('Invalid JSON body');
  }
}

async function invokeMutate(event: IdleSchedulerMutateEvent): Promise<IdleSchedulerMutateResult> {
  let payloadText: string;
  let functionError: string | undefined;
  try {
    const response = await lambdaClient.send(
      new InvokeCommand({
        FunctionName: config.idleSchedulerMutateFunctionName,
        InvocationType: 'RequestResponse',
        Payload: Buffer.from(JSON.stringify(event)),
      }),
    );
    payloadText = Buffer.from(response.Payload ?? new Uint8Array()).toString('utf-8');
    functionError = response.FunctionError;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    throw badGateway(`Failed to invoke idle-scheduler-mutate-fn: ${message}`);
  }

  if (functionError) {
    throw badGateway('idle-scheduler-mutate-fn threw an unhandled error');
  }

  try {
    return JSON.parse(payloadText) as IdleSchedulerMutateResult;
  } catch {
    throw badGateway('idle-scheduler-mutate-fn returned an invalid response');
  }
}

export async function createHandler(event: LambdaFunctionURLEvent): Promise<LambdaFunctionURLResult> {
  const body = parseBody<Partial<CreateIdleSchedulerGroupRequest>>(event);

  if (typeof body.albName !== 'string' || body.albName.length === 0) {
    throw badRequest('Missing or invalid: albName');
  }
  if (typeof body.ec2InstanceId !== 'string' || !IDLE_SCHEDULER_EC2_INSTANCE_ID_PATTERN.test(body.ec2InstanceId)) {
    throw badRequest('Missing or invalid: ec2InstanceId');
  }
  if (typeof body.rdsInstanceId !== 'string' || !IDLE_SCHEDULER_RDS_INSTANCE_IDENTIFIER_PATTERN.test(body.rdsInstanceId)) {
    throw badRequest('Missing or invalid: rdsInstanceId');
  }
  if (body.idleMinutes !== undefined && (typeof body.idleMinutes !== 'number' || body.idleMinutes <= 0)) {
    throw badRequest('Invalid: idleMinutes must be a positive number');
  }

  const result = await invokeMutate({
    kind: 'register',
    albName: body.albName,
    ec2InstanceId: body.ec2InstanceId,
    rdsInstanceId: body.rdsInstanceId,
    ...(body.idleMinutes !== undefined ? { idleMinutes: body.idleMinutes } : {}),
  });
  return ok(event, result);
}

export async function deregisterHandler(event: LambdaFunctionURLEvent, albName: string): Promise<LambdaFunctionURLResult> {
  if (!albName) {
    throw badRequest('Missing albName');
  }
  const result = await invokeMutate({ kind: 'deregister', albName });
  return ok(event, result);
}
