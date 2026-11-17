import {
  ListBackupJobsCommand,
  ListBackupPlansCommand,
  ListBackupSelectionsCommand,
  GetBackupSelectionCommand,
  ListBackupVaultsCommand,
  GetBackupVaultAccessPolicyCommand,
  ListRestoreTestingPlansCommand,
} from '@aws-sdk/client-backup';
import { GetLifecyclePoliciesCommand, GetLifecyclePolicyCommand } from '@aws-sdk/client-dlm';
import { DescribeVolumesCommand } from '@aws-sdk/client-ec2';
import { policyHasDeletionProtection } from './backupVaultPolicy.js';
import { logger } from '../../shared-kernel/logger.js';
import { getBackupClient, getDlmClient, getEc2Client } from '../../core/aws-clients.js';

/**
 * Raw collector for backup/DR data, used by `infra-review-collector` (Requirement 6.1). Extends
 * the logic already in `compliance-service.ts` (sibling module file — `loadBackupJobs`/
 * `loadDlmPolicies`) with `ListBackupPlansCommand` (the list of current AWS Backup plans) and a
 * reconciliation step to determine which resources are currently covered by a backup plan/DLM
 * policy — but it does NOT decide the final `hasProtection` for a specific resource or generate a
 * `ProtectionGap`/`RecommendationItem`: that is the orchestrator's job
 * (`infra-review-collector.ts`, task 7.1) via `buildProtectionGapFinding` in
 * `lib/recommendations.ts`, after cross-referencing the list of production resources collected by
 * other collectors (EC2/RDS...).
 *
 * `compliance-service.ts` is left UNCHANGED — it still independently serves the current
 * Compliance tab (some data overlap between the two is intentional, to avoid one source serving
 * two callers with different purposes/refresh cadences).
 *
 * Each data source (backup plans, backup jobs, DLM policies, resource reconciliation) wraps its
 * own errors — one source failing logs and returns empty for that part, WITHOUT breaking the
 * rest (following the same pattern as `DescribeComplianceByConfigRule` in
 * `compliance-service.ts`).
 */

/** Backup job survey window — AWS Backup `ListBackupJobs` only retains up to 30 days of history. */
const BACKUP_JOB_SURVEY_PERIOD_DAYS = 30;

/**
 * Raw data for one AWS Backup plan. The collector ONLY gathers raw data — the orchestrator
 * (task 7.1) cross-references `resourceArnsWithBackupPlan` with production resources to determine
 * the protection gap (Requirement 6.2).
 */
export interface BackupPlanRaw {
  backupPlanId: string;
  backupPlanArn: string;
  backupPlanName: string;
  creationDate: string; // ISO datetime, '' if AWS doesn't return CreationDate
  lastExecutionDate: string | null;
}

/**
 * Raw data for one backup job. Extends `BackupJobSummary` (`@ops-dashboard/shared`, used by the
 * Compliance tab) with `resourceArn`/`resourceType` so the orchestrator can match FAILED/EXPIRED/
 * ABORTED jobs (Requirement 6.3) to the correct resource. Has NO `threshold` field — classifying
 * risk level by job state is the job of `lib/recommendations.ts` (`classifyByState`), not this
 * collector.
 */
export interface BackupJobRaw {
  jobId: string;
  resourceArn: string;
  resourceName: string;
  resourceType: string;
  state: string;
  creationDate: string; // ISO datetime
}

/**
 * Raw data for one DLM lifecycle policy, including the resource selector
 * (`resourceTypes`/`targetTags`) fetched via `GetLifecyclePolicyCommand` —
 * `GetLifecyclePoliciesCommand` (used in `compliance-service.ts`) only returns a summary with no
 * selector, which isn't enough to determine which resources the policy applies to.
 */
export interface DlmPolicyRaw {
  policyId: string;
  policyArn: string;
  description: string;
  state: string;
  resourceTypes: string[];
  targetTags: { key: string; value: string }[];
}

/**
 * Raw data for one AWS Backup vault, along with an assessment of "is it already protected
 * against manual deletion/lifecycle changes" (ISO 27001 A.12.3 — requires backups to be protected
 * against unauthorized deletion/modification, equivalent to the AWS Config managed rule
 * `BACKUP_RECOVERY_POINT_MANUAL_DELETION_DISABLED`). The collector ONLY reads data and performs a
 * simple boolean assessment (not a "recommendation") — the orchestrator decides whether to
 * generate a `RecommendationItem`.
 */
export interface BackupVaultRaw {
  vaultName: string;
  vaultArn: string;
  numberOfRecoveryPoints: number;
  /** `true` when AWS Backup Vault Lock (`PutBackupVaultLockConfiguration`) is enabled — absolute
   * WORM, which no one (not even root) can remove. Informational only, NOT used to decide
   * `hasDeletionProtection` (see that field) — a vault can be sufficiently protected without
   * Vault Lock. */
  locked: boolean;
  /**
   * `true` when the vault has an access policy (resource-based policy) containing AT LEAST 1
   * `Deny` statement that blocks BOTH `backup:DeleteRecoveryPoint` AND
   * `backup:UpdateRecoveryPointLifecycle` — the minimum condition to pass the AWS Config managed
   * rule `BACKUP_RECOVERY_POINT_MANUAL_DELETION_DISABLED`. Checked explicitly (parses the JSON,
   * looks for a `Deny` statement with matching actions), NOT inferred from `locked` — a vault can
   * achieve this protection with just an access policy, without needing Vault Lock.
   */
  hasDeletionProtection: boolean;
}

/**
 * Raw data for one AWS Backup Restore Testing Plan (ISO 27001 A.17 — requires periodic restore
 * capability testing, not just creating backups and never confirming they can actually be
 * restored). The collector only reads the list of existing plans — it does NOT read
 * selection/resource test details (enough for the orchestrator to know whether "at least one
 * restore testing plan is running").
 */
export interface RestoreTestingPlanRaw {
  planName: string;
  planArn: string;
  scheduleExpression: string;
  lastExecutionTime: string | null;
}

export interface BackupCollectorResult {
  backupPlans: BackupPlanRaw[];
  recentBackupJobs: BackupJobRaw[];
  dlmPolicies: DlmPolicyRaw[];
  /**
   * ARNs of resources directly covered by AT LEAST 1 AWS Backup plan, determined via
   * `BackupSelection.Resources` (a selection that names specific ARNs). Selections that choose
   * resources by tag/condition (`ListOfTags`/`Conditions`) are NOT resolved to specific ARNs
   * here — that requires matching each resource's tags, which is the orchestrator's
   * responsibility (task 7.1), which already has resource tags available from other collectors
   * (e.g. `isProduction` in `rds-collector.ts`).
   */
  resourceArnsWithBackupPlan: string[];
  /**
   * EBS volume IDs (in the form `vol-xxxx`, NOT a full ARN — matches directly against the
   * `volumeId` field of `EbsVolumeRaw` in `storage-collector.ts` for easy cross-referencing by the
   * orchestrator) covered by AT LEAST 1 DLM policy in ENABLED state, determined by matching that
   * policy's tags (`tag:<Key>=<Value>`) via `EC2 DescribeVolumesCommand` with `Filters`.
   */
  resourceArnsWithDlmPolicy: string[];
  /** Every backup vault in the account, along with the `hasDeletionProtection` assessment — used
   * to generate the `backupVaultNotProtected` finding for a vault that has recovery points but is
   * not yet protected. */
  backupVaults: BackupVaultRaw[];
  /** Every existing AWS Backup Restore Testing Plan — empty means no restore testing has been
   * configured, used to generate the `restoreTestingNotConfigured` finding (ISO 27001 A.17). */
  restoreTestingPlans: RestoreTestingPlanRaw[];
}

async function loadBackupPlans(): Promise<BackupPlanRaw[]> {
  const plans: BackupPlanRaw[] = [];
  let nextToken: string | undefined;

  do {
    const { BackupPlansList = [], NextToken } = await getBackupClient().send(
      new ListBackupPlansCommand({ NextToken: nextToken }),
    );
    for (const plan of BackupPlansList) {
      plans.push({
        backupPlanId: plan.BackupPlanId ?? '',
        backupPlanArn: plan.BackupPlanArn ?? '',
        backupPlanName: plan.BackupPlanName ?? '',
        creationDate: plan.CreationDate?.toISOString() ?? '',
        lastExecutionDate: plan.LastExecutionDate?.toISOString() ?? null,
      });
    }
    nextToken = NextToken;
  } while (nextToken);

  return plans;
}

async function loadRecentBackupJobs(): Promise<BackupJobRaw[]> {
  const since = new Date(Date.now() - BACKUP_JOB_SURVEY_PERIOD_DAYS * 24 * 60 * 60 * 1000);
  const jobs: BackupJobRaw[] = [];
  let nextToken: string | undefined;
  do {
    const { BackupJobs = [], NextToken } = await getBackupClient().send(
      new ListBackupJobsCommand({ ByCreatedAfter: since, MaxResults: 100, NextToken: nextToken })
    );
    for (const job of BackupJobs) {
      jobs.push({
        jobId: job.BackupJobId ?? '',
        resourceArn: job.ResourceArn ?? '',
        resourceName: job.ResourceName || job.ResourceArn || '',
        resourceType: job.ResourceType ?? '',
        state: job.State ?? 'UNKNOWN',
        creationDate: job.CreationDate?.toISOString() ?? '',
      });
    }
    nextToken = NextToken;
  } while (nextToken);
  return jobs;
}

/**
 * Cross-references each backup plan against `BackupSelection.Resources` (directly specified
 * ARNs) to find resources covered by a backup plan. Wraps errors per plan — one plan failing
 * (e.g. no selections left, missing permissions) does not break the results for other plans.
 */
async function loadResourceArnsWithBackupPlan(plans: BackupPlanRaw[]): Promise<string[]> {
  const resourceArns = new Set<string>();

  await Promise.all(
    plans
      .filter((plan) => plan.backupPlanId !== '')
      .map(async (plan) => {
        try {
          let nextToken: string | undefined;
          const selectionIds: string[] = [];
          do {
            const { BackupSelectionsList = [], NextToken } = await getBackupClient().send(
              new ListBackupSelectionsCommand({ BackupPlanId: plan.backupPlanId, NextToken: nextToken }),
            );
            for (const selection of BackupSelectionsList) {
              if (selection.SelectionId) selectionIds.push(selection.SelectionId);
            }
            nextToken = NextToken;
          } while (nextToken);

          for (const selectionId of selectionIds) {
            try {
              const { BackupSelection } = await getBackupClient().send(
                new GetBackupSelectionCommand({ BackupPlanId: plan.backupPlanId, SelectionId: selectionId }),
              );
              for (const arn of BackupSelection?.Resources ?? []) {
                resourceArns.add(arn);
              }
            } catch (err) {
              logger.error(
                `backup-collector: GetBackupSelection failed for plan ${plan.backupPlanId}/selection ${selectionId} (skipping)`,
                err,
              );
            }
          }
        } catch (err) {
          logger.error(
            `backup-collector: ListBackupSelections failed for plan ${plan.backupPlanId} (skipping)`,
            err,
          );
        }
      }),
  );

  return Array.from(resourceArns);
}

async function loadDlmPolicies(): Promise<DlmPolicyRaw[]> {
  const { Policies = [] } = await getDlmClient().send(new GetLifecyclePoliciesCommand({}));

  const detailed = await Promise.all(
    Policies.map(async (summary): Promise<DlmPolicyRaw> => {
      const base: DlmPolicyRaw = {
        policyId: summary.PolicyId ?? '',
        policyArn: '',
        description: summary.Description ?? '',
        state: summary.State ?? 'UNKNOWN',
        resourceTypes: [],
        targetTags: [],
      };
      if (!summary.PolicyId) return base;

      try {
        const { Policy } = await getDlmClient().send(new GetLifecyclePolicyCommand({ PolicyId: summary.PolicyId }));
        return {
          ...base,
          policyArn: Policy?.PolicyArn ?? '',
          resourceTypes: Policy?.PolicyDetails?.ResourceTypes ?? [],
          targetTags: (Policy?.PolicyDetails?.TargetTags ?? [])
            .filter((tag) => tag.Key && tag.Value)
            .map((tag) => ({ key: tag.Key ?? '', value: tag.Value ?? '' })),
        };
      } catch (err) {
        // GetLifecyclePolicy failing for one policy (missing permissions, policy just deleted...)
        // — still keep the summary info already available, just missing the resource selector
        // for this policy.
        logger.error(
          `backup-collector: GetLifecyclePolicy failed for policy ${summary.PolicyId} (skipping, resourceTypes/targetTags empty)`,
          err,
        );
        return base;
      }
    }),
  );

  return detailed;
}

/**
 * Cross-references ENABLED DLM policies covering EBS volumes (`ResourceTypes` contains `VOLUME`)
 * against that policy's `targetTags`, via `EC2 DescribeVolumesCommand` filtered by tag — a DLM
 * `TargetTags` policy applies to any volume matching AT LEAST ONE tag (an OR relationship across
 * the tag list, matching DLM's actual semantics). Wraps errors per policy/tag — one query failing
 * does not break the results for other policies/tags.
 */
async function loadResourceArnsWithDlmPolicy(policies: DlmPolicyRaw[]): Promise<string[]> {
  const volumeIds = new Set<string>();

  const enabledVolumePolicies = policies.filter(
    (policy) => policy.state === 'ENABLED' && policy.resourceTypes.includes('VOLUME') && policy.targetTags.length > 0,
  );

  await Promise.all(
    enabledVolumePolicies.flatMap((policy) =>
      policy.targetTags.map(async (tag) => {
        try {
          let nextToken: string | undefined;
          do {
            const { Volumes = [], NextToken } = await getEc2Client().send(
              new DescribeVolumesCommand({
                Filters: [{ Name: `tag:${tag.key}`, Values: [tag.value] }],
                NextToken: nextToken,
              }),
            );
            for (const volume of Volumes) {
              if (volume.VolumeId) volumeIds.add(volume.VolumeId);
            }
            nextToken = NextToken;
          } while (nextToken);
        } catch (err) {
          logger.error(
            `backup-collector: DescribeVolumes (tag:${tag.key}=${tag.value}, policy ${policy.policyId}) failed (skipping)`,
            err,
          );
        }
      }),
    ),
  );

  return Array.from(volumeIds);
}

/**
 * Collects every backup vault in the account, along with the `hasDeletionProtection` assessment
 * via `GetBackupVaultAccessPolicy` (wraps errors SEPARATELY per vault — one vault failing to read
 * its policy does not break the results for other vaults; that vault is treated as unprotected,
 * fail-safe).
 */
async function loadBackupVaults(): Promise<BackupVaultRaw[]> {
  const vaults: BackupVaultRaw[] = [];
  let nextToken: string | undefined;

  do {
    const { BackupVaultList = [], NextToken } = await getBackupClient().send(
      new ListBackupVaultsCommand({ NextToken: nextToken }),
    );
    for (const vault of BackupVaultList) {
      if (!vault.BackupVaultName) continue;
      vaults.push({
        vaultName: vault.BackupVaultName,
        vaultArn: vault.BackupVaultArn ?? '',
        numberOfRecoveryPoints: vault.NumberOfRecoveryPoints ?? 0,
        locked: vault.Locked ?? false,
        hasDeletionProtection: false, // filled in below, after a separate GetBackupVaultAccessPolicy call.
      });
    }
    nextToken = NextToken;
  } while (nextToken);

  await Promise.all(
    vaults.map(async (vault) => {
      try {
        const { Policy } = await getBackupClient().send(
          new GetBackupVaultAccessPolicyCommand({ BackupVaultName: vault.vaultName }),
        );
        vault.hasDeletionProtection = policyHasDeletionProtection(Policy);
      } catch (err) {
        // ResourceNotFoundException is a NORMAL result when the vault has no access policy at all
        // (AWS returns this error instead of an empty Policy) — treat it as unprotected, not an
        // error worth logging.
        const errorName = (err as { name?: string }).name;
        if (errorName !== 'ResourceNotFoundException') {
          logger.error(
            `backup-collector: GetBackupVaultAccessPolicy(${vault.vaultName}) failed (skipping, treating as unprotected)`,
            err,
          );
        }
        vault.hasDeletionProtection = false;
      }
    }),
  );

  return vaults;
}

async function loadRestoreTestingPlans(): Promise<RestoreTestingPlanRaw[]> {
  const plans: RestoreTestingPlanRaw[] = [];
  let nextToken: string | undefined;

  do {
    const { RestoreTestingPlans = [], NextToken } = await getBackupClient().send(
      new ListRestoreTestingPlansCommand({ NextToken: nextToken }),
    );
    for (const plan of RestoreTestingPlans) {
      plans.push({
        planName: plan.RestoreTestingPlanName ?? '',
        planArn: plan.RestoreTestingPlanArn ?? '',
        scheduleExpression: plan.ScheduleExpression ?? '',
        lastExecutionTime: plan.LastExecutionTime?.toISOString() ?? null,
      });
    }
    nextToken = NextToken;
  } while (nextToken);

  return plans;
}

/**
 * Collects raw backup/DLM data for `infra-review-collector` (Requirement 6.1). Each source
 * (backup plans, backup jobs, DLM policies, backup vaults, restore testing plans) wraps its own
 * errors — one source failing returns empty for that part, WITHOUT breaking the whole result.
 * Returns raw data only — determining the protection gap (Requirement 6.2) / risk from failed
 * backup jobs (Requirement 6.3) / unprotected vaults / missing restore testing (ISO 27001
 * A.12.3/A.17) is the orchestrator's decision via `buildProtectionGapFinding`/`classifyByState` in
 * `lib/recommendations.ts`.
 */
export async function collectBackupData(): Promise<BackupCollectorResult> {
  const [backupPlans, recentBackupJobs, dlmPolicies, backupVaults, restoreTestingPlans] = await Promise.all([
    loadBackupPlans().catch((err) => {
      logger.error('backup-collector: ListBackupPlans failed (skipping, backupPlans=[])', err);
      return [] as BackupPlanRaw[];
    }),
    loadRecentBackupJobs().catch((err) => {
      logger.error('backup-collector: ListBackupJobs failed (skipping, recentBackupJobs=[])', err);
      return [] as BackupJobRaw[];
    }),
    loadDlmPolicies().catch((err) => {
      logger.error('backup-collector: GetLifecyclePolicies failed (skipping, dlmPolicies=[])', err);
      return [] as DlmPolicyRaw[];
    }),
    loadBackupVaults().catch((err) => {
      logger.error('backup-collector: ListBackupVaults failed (skipping, backupVaults=[])', err);
      return [] as BackupVaultRaw[];
    }),
    loadRestoreTestingPlans().catch((err) => {
      logger.error('backup-collector: ListRestoreTestingPlans failed (skipping, restoreTestingPlans=[])', err);
      return [] as RestoreTestingPlanRaw[];
    }),
  ]);

  const [resourceArnsWithBackupPlan, resourceArnsWithDlmPolicy] = await Promise.all([
    loadResourceArnsWithBackupPlan(backupPlans).catch((err) => {
      logger.error(
        'backup-collector: cross-referencing resourceArnsWithBackupPlan failed (skipping, returning empty)',
        err,
      );
      return [] as string[];
    }),
    loadResourceArnsWithDlmPolicy(dlmPolicies).catch((err) => {
      logger.error(
        'backup-collector: cross-referencing resourceArnsWithDlmPolicy failed (skipping, returning empty)',
        err,
      );
      return [] as string[];
    }),
  ]);

  return {
    backupPlans,
    recentBackupJobs,
    dlmPolicies,
    resourceArnsWithBackupPlan,
    resourceArnsWithDlmPolicy,
    backupVaults,
    restoreTestingPlans,
  };
}
