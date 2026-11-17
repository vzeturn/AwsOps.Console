import { ACTION_CATALOG, type ActionAuditRecord, type ActionExecutionRequest, type ActionExecutionResult } from '@ops-dashboard/shared';
import { logger, setCorrelationId } from '../../shared-kernel/logger.js';
import { executeSnapshotAndDeleteEbsVolume } from './ebs-action-service.js';
import { executeApplyS3LifecyclePolicy } from './s3-lifecycle-action-service.js';
import { callEc2StateManager } from './ec2-state-manager-client.js';
import { writeAuditRecord } from './action-audit-service.js';
import { executeEcsScaleOut } from './ecs-scale-action-service.js';
import { executeRdsIncreaseStorage } from './rds-storage-action-service.js';
import { executeEbsModifyVolumeType } from './ebs-modify-volume-type-action-service.js';
import { executeCloudWatchLogRetention } from './cloudwatch-log-retention-action-service.js';
import { executeElasticIpRelease } from './elastic-ip-release-action-service.js';
import { executeEc2Rightsize } from './ec2-rightsize-action-service.js';
import { executeBackupVaultApplyProtectionPolicy } from './backup-vault-protection-action-service.js';
import { executeBackupRestoreTestingCreatePlan } from './backup-restore-testing-action-service.js';
import { executeBackupRetryJob } from './backup-retry-job-action-service.js';
import { executeRdsApplyResourceGovernance } from './rds-resource-governance-action-service.js';
import { executeEc2Reboot } from './ec2-reboot-action-service.js';
import { executeRdsStart, executeRdsStop, executeRdsReboot } from './rds-lifecycle-action-service.js';
import { executeEc2ChangeInstanceType } from './ec2-instance-type-change-service.js';
import { executeEc2UpdateTags } from './ec2-tags-action-service.js';
import { executeEc2ModifySecurityGroups } from './ec2-modify-security-groups-service.js';
import {
  executeSecurityGroupIngress,
  executeSecurityGroupEgress,
  executeSecurityGroupCreate,
  executeSecurityGroupDelete,
} from '../security/index.js';
import { runSsmPreset } from '../ec2-management/index.js';

/**
 * `action-execution-handler.ts` — entrypoint for the new `action-execution-fn` Lambda (Requirement
 * 6.1, 6.4, 9.4). Does NOT go through a Function URL/API Gateway — it only receives a direct
 * `lambda:InvokeFunction` from the `router` (Task 7.2), so `event` is already a typed
 * `ActionExecutionRequest`; no HTTP event parsing needed.
 *
 * See design.md, "Components and Interfaces" > `backend/src/action-execution-handler.ts`, and
 * Correctness Property 12 ("Audit write failure never blocks or alters the execution result").
 */

/**
 * Builds the ARN for the audit trail (Requirement 6.1) — for audit display/traceability purposes
 * ONLY, NOT for IAM. `ActionExecutionRequest` carries no account id, so `*` is used
 * (account-agnostic ARN), following the same ARN pattern spirit used in `preview-service.ts` but
 * without a real account.
 */
function buildResourceArn(actionType: ActionExecutionRequest['actionType'] | undefined, resourceId: string, region: string): string {
  switch (actionType) {
    case 'Snapshot_And_Delete_EBS_Volume':
      return `arn:aws:ec2:${region}:*:volume/${resourceId}`;
    case 'EC2_Start':
    case 'EC2_Stop':
      return `arn:aws:ec2:${region}:*:instance/${resourceId}`;
    case 'Apply_S3_Lifecycle_Policy':
      return `arn:aws:s3:::${resourceId}`;
    case 'ECS_ScaleOut':
      return `arn:aws:ecs:${region}:*:service/${resourceId}`;
    case 'RDS_IncreaseStorage':
      return `arn:aws:rds:${region}:*:db:${resourceId}`;
    case 'EBS_ModifyVolumeType':
      return `arn:aws:ec2:${region}:*:volume/${resourceId}`;
    case 'CloudWatchLogGroup_SetRetention':
      return `arn:aws:logs:${region}:*:log-group:${resourceId}`;
    case 'ElasticIp_Release':
      return `arn:aws:ec2:${region}:*:elastic-ip/${resourceId}`;
    case 'EC2_Rightsize':
      return `arn:aws:ec2:${region}:*:instance/${resourceId}`;
    case 'BackupVault_ApplyProtectionPolicy':
      return `arn:aws:backup:${region}:*:backup-vault:${resourceId}`;
    case 'BackupRestoreTesting_CreatePlan':
      // The restoreTestingNotConfigured finding is account-wide (resourceId is always
      // 'account-wide') — there's no real AWS ARN representing "the whole account", so use a plain
      // account-agnostic ARN for audit display purposes, same as the `default` branch below.
      return `arn:aws:backup:${region}:*:restore-testing-plan/${resourceId}`;
    case 'Backup_RetryJob':
      // The backupJobFailed finding's resourceId IS the full resourceArn (arn:aws:<service>:...) —
      // used directly, without wrapping in another ARN prefix (unlike the cases above, where
      // resourceId is just a short name/id that needs to be composed into an ARN).
      return resourceId;
    case 'RDS_ApplyResourceGovernance':
      return `arn:aws:rds:${region}:*:db:${resourceId}`;
    case 'EC2_Reboot':
      return `arn:aws:ec2:${region}:*:instance/${resourceId}`;

    case 'RDS_Start':
    case 'RDS_Stop':
    case 'RDS_Reboot':
      return `arn:aws:rds:${region}:*:db:${resourceId}`;
    case 'SecurityGroup_AuthorizeIngress':
    case 'SecurityGroup_RevokeIngress':
      return `arn:aws:ec2:${region}:*:security-group/${resourceId}`;
    case 'SSM_RunPreset':
      // The resource actually affected is the EC2 instance itself (not the SSM document) — the
      // audit must point to what the operator cares about, "which machine did the command run on",
      // same as EC2_Reboot.
      return `arn:aws:ec2:${region}:*:instance/${resourceId}`;
    case 'Ec2_ChangeInstanceType':
      return `arn:aws:ec2:${region}:*:instance/${resourceId}`;
    case 'Ec2_UpdateTags':
      return `arn:aws:ec2:${region}:*:instance/${resourceId}`;
    case 'SecurityGroup_AuthorizeEgress':
    case 'SecurityGroup_RevokeEgress':
    case 'SecurityGroup_Create':
    case 'SecurityGroup_Delete':
      return `arn:aws:ec2:${region}:*:security-group/${resourceId}`;
    case 'Ec2_ModifySecurityGroups':
      // Conceptually, the resource being affected is the EC2 instance (changing the SGs attached
      // to the machine), not the Security Group — even though this actionType is classified as
      // resourceType: 'security-group' in ACTION_CATALOG (spec Section 5). The audit ARN must
      // reflect what the operator actually cares about ("which instance had its SGs changed"), not
      // a meaningless security-group/<instanceId> ARN.
      return `arn:aws:ec2:${region}:*:instance/${resourceId}`;
    default:
      // Invalid actionType (internal error branch) — still needs an account-agnostic ARN for audit.
      return `arn:aws:unknown:${region}:*:resource/${resourceId}`;
  }
}

/**
 * Dispatches to the one execution function matching `event.actionType` (each `ActionType` in
 * `ACTION_CATALOG` has EXACTLY one dedicated execution function). Does NOT throw for expected
 * "business" outcomes (rejected/failure) — the service functions already return those results
 * themselves. Throwing here only happens for a real, unexpected system error, caught in
 * `handler()`.
 */
async function dispatch(event: ActionExecutionRequest): Promise<ActionExecutionResult> {
  const catalogEntry = ACTION_CATALOG.find((entry) => entry.actionType === event.actionType);
  if (!catalogEntry) {
    // actionType doesn't match any entry in Action_Catalog — the router should have validated this
    // before invoking, so this is abnormal input from an untrusted caller or a real bug.
    return { outcome: 'failure', reason: 'Internal error' };
  }

  switch (event.actionType) {
    case 'Snapshot_And_Delete_EBS_Volume':
      return executeSnapshotAndDeleteEbsVolume(event.resourceId);

    case 'Apply_S3_Lifecycle_Policy': {
      const { days, storageClass } = event.params;
      if (typeof days !== 'number' || Number.isNaN(days) || typeof storageClass !== 'string') {
        return { outcome: 'failure', reason: 'Invalid params for Apply_S3_Lifecycle_Policy' };
      }
      return executeApplyS3LifecyclePolicy(event.resourceId, days, storageClass);
    }

    case 'EC2_Start': {
      const result = await callEc2StateManager(event.resourceId, event.region, 'start');
      return result.success ? { outcome: 'success', newState: result.state } : { outcome: 'failure', reason: result.error };
    }

    case 'EC2_Stop': {
      const result = await callEc2StateManager(event.resourceId, event.region, 'stop');
      return result.success ? { outcome: 'success', newState: result.state } : { outcome: 'failure', reason: result.error };
    }

    case 'ECS_ScaleOut':
      return executeEcsScaleOut(event.resourceId);

    case 'RDS_IncreaseStorage':
      return executeRdsIncreaseStorage(event.resourceId);

    case 'EBS_ModifyVolumeType':
      return executeEbsModifyVolumeType(event.resourceId);

    case 'CloudWatchLogGroup_SetRetention':
      return executeCloudWatchLogRetention(event.resourceId);

    case 'ElasticIp_Release':
      return executeElasticIpRelease(event.resourceId);

    case 'EC2_Rightsize':
      return executeEc2Rightsize(event.resourceId);

    case 'BackupVault_ApplyProtectionPolicy':
      return executeBackupVaultApplyProtectionPolicy(event.resourceId);

    case 'BackupRestoreTesting_CreatePlan':
      return executeBackupRestoreTestingCreatePlan();

    case 'Backup_RetryJob':
      return executeBackupRetryJob(event.resourceId);

    case 'RDS_ApplyResourceGovernance':
      return executeRdsApplyResourceGovernance(event.resourceId);

    case 'EC2_Reboot':
      return executeEc2Reboot(event.resourceId);

    case 'RDS_Start':
      return executeRdsStart(event.resourceId);

    case 'RDS_Stop':
      return executeRdsStop(event.resourceId);

    case 'RDS_Reboot':
      return executeRdsReboot(event.resourceId);

    case 'SecurityGroup_AuthorizeIngress':
    case 'SecurityGroup_RevokeIngress':
      return executeSecurityGroupIngress(event.actionType, event.resourceId, event.params);

    case 'SSM_RunPreset':
      return runSsmPreset(event);

    case 'Ec2_ChangeInstanceType':
      return executeEc2ChangeInstanceType(event.resourceId, event.params);

    case 'Ec2_UpdateTags':
      return executeEc2UpdateTags(event.resourceId, event.params);

    case 'SecurityGroup_AuthorizeEgress':
    case 'SecurityGroup_RevokeEgress':
      // TS doesn't narrow `event.actionType` down to these 2 literals inside the shared function
      // for the outer switch case — the case already guarantees the correct value, so cast
      // explicitly to match the signature.
      return executeSecurityGroupEgress(
        event.actionType as 'SecurityGroup_AuthorizeEgress' | 'SecurityGroup_RevokeEgress',
        event.resourceId,
        event.params,
      );

    case 'Ec2_ModifySecurityGroups':
      return executeEc2ModifySecurityGroups(event.resourceId, event.params);

    case 'SecurityGroup_Create':
      return executeSecurityGroupCreate(event.params);

    case 'SecurityGroup_Delete':
      return executeSecurityGroupDelete(event.resourceId);

    case 'EC2_AutoRightsize':
      // NOT executed via `action-execution-fn`/router — `EC2_AutoRightsize` is self-executed by the
      // dedicated `ec2-rightsize-applier.ts` Lambda when an instance transitions to `stopped`
      // (triggered by an EventBridge Rule, not via `router`), and it writes its own
      // `Action_Audit_Record` directly (reusing `writeAuditRecord()`), never going through
      // `dispatch()`/`handler()` in this file. This branch exists only to satisfy the `switch`
      // exhaustiveness check — if a stray request carrying this actionType somehow reaches here
      // (outside the intended design flow), reject it explicitly.
      return { outcome: 'rejected', reason: 'EC2_AutoRightsize is not executed via action-execution-fn.' };

    default: {
      // Exhaustiveness guard — Action_Catalog currently has 9 values; if shared adds a new
      // actionType that the handler hasn't handled yet, fail loud with Internal error instead of
      // silently ignoring it.
      const _exhaustive: never = event.actionType;
      return { outcome: 'failure', reason: `Internal error: unhandled actionType ${_exhaustive as string}` };
    }
  }
}

export async function handler(event: ActionExecutionRequest): Promise<ActionExecutionResult> {
  // Set for the WHOLE invocation, same convention as router.ts — every logger.* call below
  // (including ones inside the individual `execute*` service functions) automatically carries
  // the id the router generated for the HTTP request that led here.
  setCorrelationId(event.correlationId);

  let result: ActionExecutionResult;

  try {
    result = await dispatch(event);
  } catch (err) {
    // Any exception NOT caught by the 4 execution functions (a real bug, not an expected business
    // outcome) — log full detail to CloudWatch, but do NOT leak the stack trace/AWS error detail
    // into the `reason` returned to the caller (design.md, "Error Handling" >
    // "action-execution-fn internal").
    logger.error(
      `action-execution-handler: unexpected error executing actionType=${event.actionType} resourceId=${event.resourceId}`,
      err,
    );
    result = { outcome: 'failure', reason: 'Internal error' };
  }

  // SecurityGroup_Create: the real id is ONLY known AFTER AWS responds (the request can't know it
  // in advance) — use the id from the execution result for the audit ARN, not the request's
  // placeholder resourceId.
  const auditResourceId =
    event.actionType === 'SecurityGroup_Create' && result.outcome === 'success' && result.createdSecurityGroupId
      ? result.createdSecurityGroupId
      : event.resourceId;

  const auditRecord: ActionAuditRecord = {
    executedBy: event.executedBy,
    executedAt: new Date().toISOString(),
    actionType: event.actionType,
    resource: {
      id: auditResourceId,
      arn: buildResourceArn(event.actionType, auditResourceId, event.region),
      region: event.region,
    },
    params: event.params,
    outcome: result.outcome,
    ...(result.reason !== undefined ? { reason: result.reason } : {}),
    ...(event.correlationId !== undefined ? { correlationId: event.correlationId } : {}),
    ...(event.approvalId !== undefined ? { approvalId: event.approvalId } : {}),
    ...(event.requestedBy !== undefined ? { requestedBy: event.requestedBy } : {}),
  };

  // Requirement 6.4 / Property 12: writing the audit record must NOT block or alter the returned
  // result. `writeAuditRecord` already catches all internal errors itself (never throws) —
  // `.catch()` here is just a 2nd line of defense, in case the promise unexpectedly rejects, to
  // avoid an unhandled rejection warning.
  void writeAuditRecord(auditRecord).catch(() => {});

  return result;
}
