import type { BackupJobSummary } from '@ops-dashboard/shared';
import { attributeResource } from '../../attribution.js';
import { BACKUP_THRESHOLD_SEVERITY } from '../../defaults.js';
import { arnFor, arnKindForResourceType } from '../../finding-id.js';
import { recommendationCheck } from '../recommendation-check.js';
import { arnContext, makeDraft, type CheckDefinition } from '../types.js';

function latestJobPerResource(jobs: readonly BackupJobSummary[]): BackupJobSummary[] {
  const latest = new Map<string, BackupJobSummary>();
  for (const job of jobs) {
    const current = latest.get(job.resourceName);
    if (!current || Date.parse(job.creationDate) > Date.parse(current.creationDate)) latest.set(job.resourceName, job);
  }
  return [...latest.values()];
}

/** Adapter over compliance-cache.json recentBackupJobs (refreshed every 5 min by infra-collector).
 * Keyed per RESOURCE (latest job), not per job id, so a later successful job resolves it. */
export const BACKUP_JOB_FAILING: CheckDefinition = {
  checkId: 'res.backup-job-failing',
  source: 'backup',
  kpi: 'resilience',
  isoControls: ['A.8.13'],
  requires: ['topology', 'compliance'],
  title: 'Latest backup job failed',
  impact: 'The most recent restore point for this resource is missing; data loss window grows until a job succeeds.',
  remediation: ['Open the job in AWS Backup and read the failure status message.', 'Fix the cause (permissions, resource state, vault lock) and start an on-demand backup.'],
  run: (snapshot) =>
    latestJobPerResource(snapshot.compliance?.recentBackupJobs ?? []).flatMap((job) => {
      if (job.threshold.level === 'ok') return [];
      return [
        makeDraft(BACKUP_JOB_FAILING, {
          resourceType: 'backup-resource',
          resourceId: job.resourceName,
          resourceName: job.resourceName,
          resourceArn: arnFor('backup-resource', job.resourceName, arnContext(snapshot)),
          placement: attributeResource(snapshot.topologyIndex, job.resourceName),
          severity: BACKUP_THRESHOLD_SEVERITY[job.threshold.level],
          description: `Backup job ${job.jobId} is ${job.state}: ${job.threshold.reason}`,
          observedAt: snapshot.observedAt.compliance ?? snapshot.now,
          data: { jobId: job.jobId, state: job.state, creationDate: job.creationDate, reason: job.threshold.reason },
        }),
      ];
    }),
};

/** Adapter over assessment-report.json backup.protectionGaps (daily infra review). */
export const BACKUP_PROTECTION_GAP: CheckDefinition = {
  checkId: 'res.backup-protection-gap',
  source: 'backup',
  kpi: 'resilience',
  isoControls: ['A.8.13'],
  requires: ['topology', 'assessment'],
  title: 'Resource is not protected by a backup plan',
  impact: 'No restore point exists for this resource; its data cannot be recovered after deletion or corruption.',
  remediation: ['Add the resource to the backup plan matching its tier (tag-based selection).'],
  run: (snapshot) =>
    (snapshot.assessment?.backup.protectionGaps ?? []).map((gap) =>
      makeDraft(BACKUP_PROTECTION_GAP, {
        resourceType: gap.resourceType,
        resourceId: gap.resourceId,
        resourceName: gap.resourceName,
        resourceArn: arnFor(arnKindForResourceType(gap.resourceType), gap.resourceId, arnContext(snapshot)),
        placement: attributeResource(snapshot.topologyIndex, gap.resourceId),
        severity: 'medium',
        description: gap.reason,
        observedAt: snapshot.observedAt.assessment ?? snapshot.now,
        data: { resourceType: gap.resourceType, reason: gap.reason },
      }),
    ),
};

const RESILIENCE_BASE = { source: 'backup' as const, kpi: 'resilience' as const, requires: ['topology' as const, 'assessment' as const] };

export const RESILIENCE_RECOMMENDATION_CHECKS: CheckDefinition[] = [
  recommendationCheck(
    {
      ...RESILIENCE_BASE,
      checkId: 'res.backup-vault-not-protected',
      isoControls: ['A.8.13'],
      title: 'Backup vault has no vault lock/access policy protection',
      impact: 'Recovery points can be deleted by anyone with vault access, including an attacker or a mistaken cleanup.',
      remediation: ['Apply a vault access policy denying DeleteRecoveryPoint, or enable Vault Lock (governance mode).'],
    },
    'backupVaultNotProtected',
    () => 'medium',
  ),
  recommendationCheck(
    {
      ...RESILIENCE_BASE,
      checkId: 'res.restore-testing-not-configured',
      isoControls: ['A.8.13'],
      title: 'AWS Backup restore testing is not configured',
      impact: 'Backups are never proven restorable; a broken backup is discovered only during an incident.',
      remediation: ['Create an AWS Backup restore testing plan covering each backup tier.'],
    },
    'restoreTestingNotConfigured',
    () => 'low',
  ),
  recommendationCheck(
    {
      ...RESILIENCE_BASE,
      checkId: 'res.rds-single-az',
      isoControls: ['A.5.30', 'A.8.14'],
      title: 'RDS instance is single-AZ',
      impact: 'An AZ or host failure takes the database down until a manual restore completes.',
      remediation: ['Enable Multi-AZ during a maintenance window (brief I/O freeze on conversion).'],
    },
    'rdsMissingMultiAz',
    () => 'medium',
  ),
];
