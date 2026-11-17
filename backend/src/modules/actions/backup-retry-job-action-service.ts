import { ListBackupJobsCommand, StartBackupJobCommand } from '@aws-sdk/client-backup';
import type { ActionExecutionResult } from '@ops-dashboard/shared';
import { getBackupClient } from '../../core/aws-clients.js';

/**
 * `backup-retry-job-action-service.ts` runs inside `action-execution-fn` (a separate mutating
 * Lambda, role `ActionExecutionRole`). Executes Resource_Action `Backup_RetryJob` — the user
 * clicks it from the `backupJobFailed` finding (the most recent backup job is in state
 * FAILED/EXPIRED/ABORTED, see `infra-review-collector.ts`) to address the missing recovery point
 * for that resource.
 *
 * The `resourceId` of the `backupJobFailed` finding IS the full `resourceArn` (not a short name —
 * see `infra-review-collector.ts`, the loop that generates this finding uses
 * `job.resourceArn || job.jobId` as the `resourceId`).
 *
 * Do NOT hardcode `BackupVaultName`/`IamRoleArn` — read them back from the MOST RECENT backup job
 * of that same `resourceArn` via `ListBackupJobs({ ByResourceArn })` (regardless of state, we only
 * need to know WHICH vault/role has been/is being used for this resource), then use THAT EXACT
 * vault/role for `StartBackupJob` — ensuring the new backup lands in the CORRECT vault that has
 * the protective access policy applied (ISO 27001 A.12.3) and uses the CORRECT role granted
 * permissions for that resource type, rather than guessing.
 *
 * `StartBackupJob` is async — it returns as soon as the job is CREATED (state CREATED/PENDING),
 * it does NOT wait for the job to finish (which can take several minutes depending on the
 * resource) — this is the correct behavior for a 1-click "retry", with the user tracking progress
 * via the AWS Backup console or the next collector survey.
 */
const backup = getBackupClient();

/** Number of recent backup jobs to read to find the vault/role that was used — 1 would be enough
 * if the API reliably returned the newest first, but we read a few more (per the docs, not
 * guaranteed sorted) and pick the largest CreationDate ourselves so we don't depend on AWS's
 * unordered response. */
const RECENT_JOBS_TO_SCAN = 10;

/**
 * Executes `Backup_RetryJob`:
 * 1. `ListBackupJobs({ ByResourceArn: resourceArn })` — read up to `RECENT_JOBS_TO_SCAN` recent
 *    jobs for this resource (regardless of state), pick the job with the MOST RECENT
 *    `CreationDate` to get the `BackupVaultName`/`IamRoleArn` that was used.
 * 2. No job found (this resource has never had a backup job through AWS Backup) → `'rejected'`
 *    — not enough data to safely determine the vault/role, don't guess.
 * 3. `StartBackupJob({ ResourceArn, BackupVaultName, IamRoleArn })` — kicks off a new on-demand
 *    job.
 */
export async function executeBackupRetryJob(resourceArn: string): Promise<ActionExecutionResult> {
  let recentJobs: { BackupVaultName?: string; IamRoleArn?: string; CreationDate?: Date }[];
  try {
    const { BackupJobs = [] } = await backup.send(
      new ListBackupJobsCommand({ ByResourceArn: resourceArn, MaxResults: RECENT_JOBS_TO_SCAN }),
    );
    recentJobs = BackupJobs;
  } catch (err) {
    return { outcome: 'failure', reason: `Could not read the backup job history for ${resourceArn}: ${(err as Error).message}` };
  }

  if (recentJobs.length === 0) {
    return {
      outcome: 'rejected',
      reason: `No prior backup job found for ${resourceArn} — cannot determine the backup vault/IAM role that was used to safely retry.`,
    };
  }

  const mostRecentJob = recentJobs.reduce((latest, job) => {
    if (!job.CreationDate) return latest;
    if (!latest.CreationDate || job.CreationDate > latest.CreationDate) return job;
    return latest;
  }, recentJobs[0]);

  const backupVaultName = mostRecentJob.BackupVaultName;
  const iamRoleArn = mostRecentJob.IamRoleArn;

  if (!backupVaultName || !iamRoleArn) {
    return {
      outcome: 'rejected',
      reason: `The most recent backup job for ${resourceArn} is missing BackupVaultName/IamRoleArn — cannot determine a safe target to retry.`,
    };
  }

  try {
    const { BackupJobId } = await backup.send(
      new StartBackupJobCommand({
        ResourceArn: resourceArn,
        BackupVaultName: backupVaultName,
        IamRoleArn: iamRoleArn,
      }),
    );
    return { outcome: 'success', newBackupJobId: BackupJobId };
  } catch (err) {
    return { outcome: 'failure', reason: `StartBackupJob failed for ${resourceArn}: ${(err as Error).message}` };
  }
}
