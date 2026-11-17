import {
  CreateRestoreTestingPlanCommand,
  CreateRestoreTestingSelectionCommand,
} from '@aws-sdk/client-backup';
import type { ActionExecutionResult } from '@ops-dashboard/shared';
import { getBackupClient } from '../../core/aws-clients.js';

/**
 * `backup-restore-testing-action-service.ts` runs inside `action-execution-fn` (a separate
 * mutating Lambda, role `ActionExecutionRole`). Executes Resource_Action
 * `BackupRestoreTesting_CreatePlan` — the user clicks it from the `restoreTestingNotConfigured`
 * finding (account-wide, ISO 27001 A.17).
 *
 * 3-STEP SEQUENTIAL WORKFLOW (AWS Backup Restore Testing requires this order: create the plan
 * first, then create selections — see the `CreateRestoreTestingSelectionCommand` docs: "This
 * request can be sent after CreateRestoreTestingPlan request returns successfully"):
 *  1. `CreateRestoreTestingPlan` — FIXED plan name `abc_prod_restore_testing_plan` (THE SAME name
 *     previously created manually via CLI in an earlier session — if the plan already exists
 *     (from a prior run of this action, OR from that initial manual creation),
 *     `AlreadyExistsException` is treated as SUCCESS (idempotent), and we continue to step 2 — it
 *     is not an error.
 *  2 & 3. `CreateRestoreTestingSelection` for RDS (`abc_rds_restore_test`) and EC2
 *     (`abc_ec2_restore_test`) — uses `ProtectedResourceArns: ["*"]` (a wildcard, NOT hardcoding
 *     individual instances) to AUTOMATICALLY cover every current RDS/EC2 instance AND any
 *     instance added later, so the operator never has to update the selection whenever a new
 *     resource appears — unlike the earlier manual approach (listing specific ARNs); the wildcard
 *     is chosen here because this is an automated action that must stay correct even as the
 *     infrastructure changes later. Each selection also catches its own
 *     `AlreadyExistsException` — idempotent independently per step.
 *
 * All 3 steps use `IamRoleArn` = `AWSBackupDefaultServiceRole`, which already exists in the
 * account (confirmed to already have both managed policies
 * `AWSBackupServiceRolePolicyForBackup`/`ForRestores` — no new role is created).
 *
 * `outcome` is `'success'` only when ALL 3 steps succeed (or already existed) — if step 1 fails
 * FOR REAL (not AlreadyExists), stop immediately and do NOT attempt steps 2/3 (they depend on
 * step 1 existing). If step 1 is ok but step 2 fails for real, step 3 is still attempted (the 2
 * selections are independent of each other), then `failure` is returned along with the list of
 * selections successfully created (`createdRestoreTestingSelectionNames`) so it's clear that
 * "nothing was created" is not the case.
 */
const backup = getBackupClient();

const RESTORE_TESTING_PLAN_NAME = 'abc_prod_restore_testing_plan';
const RESTORE_TESTING_IAM_ROLE_ARN = 'arn:aws:iam::123456789012:role/service-role/AWSBackupDefaultServiceRole';

const RDS_SELECTION_NAME = 'abc_rds_restore_test';
const EC2_SELECTION_NAME = 'abc_ec2_restore_test';

function isAlreadyExists(err: unknown): boolean {
  return (err as { name?: string })?.name === 'AlreadyExistsException';
}

async function ensureRestoreTestingPlanExists(): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await backup.send(
      new CreateRestoreTestingPlanCommand({
        RestoreTestingPlan: {
          RestoreTestingPlanName: RESTORE_TESTING_PLAN_NAME,
          ScheduleExpression: 'cron(0 21 ? * SUN *)',
          ScheduleExpressionTimezone: 'Etc/UTC',
          StartWindowHours: 24,
          RecoveryPointSelection: {
            Algorithm: 'LATEST_WITHIN_WINDOW',
            RecoveryPointTypes: ['SNAPSHOT'],
            IncludeVaults: ['*'],
            SelectionWindowDays: 7,
          },
        },
      }),
    );
    return { ok: true };
  } catch (err) {
    if (isAlreadyExists(err)) return { ok: true };
    return { ok: false, reason: `CreateRestoreTestingPlan failed: ${(err as Error).message}` };
  }
}

async function ensureRestoreTestingSelectionExists(
  selectionName: string,
  protectedResourceType: string,
  restoreMetadataOverrides: Record<string, string>,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await backup.send(
      new CreateRestoreTestingSelectionCommand({
        RestoreTestingPlanName: RESTORE_TESTING_PLAN_NAME,
        RestoreTestingSelection: {
          RestoreTestingSelectionName: selectionName,
          ProtectedResourceType: protectedResourceType,
          ProtectedResourceArns: ['*'],
          IamRoleArn: RESTORE_TESTING_IAM_ROLE_ARN,
          RestoreMetadataOverrides: restoreMetadataOverrides,
        },
      }),
    );
    return { ok: true };
  } catch (err) {
    if (isAlreadyExists(err)) return { ok: true };
    return { ok: false, reason: `CreateRestoreTestingSelection(${selectionName}) failed: ${(err as Error).message}` };
  }
}

/**
 * Executes `BackupRestoreTesting_CreatePlan` — see the 3-step workflow in the file-level comment.
 */
export async function executeBackupRestoreTestingCreatePlan(): Promise<ActionExecutionResult> {
  const planResult = await ensureRestoreTestingPlanExists();
  if (!planResult.ok) {
    return { outcome: 'failure', reason: planResult.reason };
  }

  const createdSelectionNames: string[] = [];
  const failureReasons: string[] = [];

  const rdsResult = await ensureRestoreTestingSelectionExists(RDS_SELECTION_NAME, 'RDS', { dbInstanceClass: 'db.t3.micro' });
  if (rdsResult.ok) {
    createdSelectionNames.push(RDS_SELECTION_NAME);
  } else {
    failureReasons.push(rdsResult.reason);
  }

  const ec2Result = await ensureRestoreTestingSelectionExists(EC2_SELECTION_NAME, 'EC2', { instanceType: 't3.micro' });
  if (ec2Result.ok) {
    createdSelectionNames.push(EC2_SELECTION_NAME);
  } else {
    failureReasons.push(ec2Result.reason);
  }

  if (failureReasons.length > 0) {
    return {
      outcome: 'failure',
      reason: failureReasons.join(' | '),
      restoreTestingPlanName: RESTORE_TESTING_PLAN_NAME,
      createdRestoreTestingSelectionNames: createdSelectionNames,
    };
  }

  return {
    outcome: 'success',
    restoreTestingPlanName: RESTORE_TESTING_PLAN_NAME,
    createdRestoreTestingSelectionNames: createdSelectionNames,
  };
}
