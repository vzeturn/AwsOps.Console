import { ListBackupJobsCommand } from '@aws-sdk/client-backup';
import { GetLifecyclePoliciesCommand } from '@aws-sdk/client-dlm';
import { DescribeComplianceByConfigRuleCommand } from '@aws-sdk/client-config-service';
import type { ComplianceData } from '@ops-dashboard/shared';
import { logger } from '../../shared-kernel/logger.js';
import { getBackupClient, getDlmClient, getConfigServiceClient } from '../../core/aws-clients.js';

const backup = getBackupClient();
const dlm = getDlmClient();
const configService = getConfigServiceClient();

async function loadBackupJobs(): Promise<ComplianceData['recentBackupJobs']> {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const result: ComplianceData['recentBackupJobs'] = [];
  let nextToken: string | undefined;
  do {
    const { BackupJobs = [], NextToken } = await backup.send(
      new ListBackupJobsCommand({ ByCreatedAfter: since, MaxResults: 50, NextToken: nextToken }),
    );
    for (const job of BackupJobs) {
      const state = job.State ?? 'UNKNOWN';
      const isFailed = state === 'FAILED' || state === 'EXPIRED' || state === 'ABORTED';
      result.push({
        jobId: job.BackupJobId ?? '',
        resourceName: job.ResourceName || job.ResourceArn || '',
        state,
        creationDate: job.CreationDate?.toISOString() ?? '',
        threshold: isFailed
          ? { level: 'critical' as const, reason: `Backup job ${state}` }
          : state === 'RUNNING'
            ? { level: 'warn' as const, reason: 'Backup job in progress' }
            : { level: 'ok' as const, reason: 'Backup completed' },
      });
    }
    nextToken = NextToken;
  } while (nextToken);
  return result;
}

async function loadDlmPolicies(): Promise<ComplianceData['dlmPolicies']> {
  const { Policies = [] } = await dlm.send(new GetLifecyclePoliciesCommand({}));
  return Policies.map((p) => ({
    policyId: p.PolicyId ?? '',
    description: p.Description ?? '',
    state: p.State ?? 'UNKNOWN',
    targetVolumeCount: 0, // GetLifecyclePolicies doesn't return target count; getting the detail needs GetLifecyclePolicy per-id (YAGNI for an overview).
  }));
}

async function loadConfigCompliance(): Promise<{
  configRules: ComplianceData['configRules'];
  configStatus: ComplianceData['configStatus'];
}> {
  try {
    const { ComplianceByConfigRules = [] } = await configService.send(
      new DescribeComplianceByConfigRuleCommand({}),
    );
    const configRules = ComplianceByConfigRules.map((rule) => {
      const complianceType = rule.Compliance?.ComplianceType ?? 'NOT_APPLICABLE';
      return {
        ruleName: rule.ConfigRuleName ?? '',
        complianceType,
        threshold:
          complianceType === 'NON_COMPLIANT'
            ? { level: 'critical' as const, reason: 'Non-compliant' }
            : { level: 'ok' as const, reason: complianceType },
      };
    });
    return { configRules, configStatus: 'evaluated' };
  } catch (err) {
    // The AWS Config recorder may not be enabled in this account — don't fail the whole tab over
    // one source, but MUST mark 'unavailable' so the frontend doesn't wrongly show "fully compliant".
    logger.error('DescribeComplianceByConfigRule failed (Config may not be enabled)', err);
    return { configRules: [], configStatus: 'unavailable' };
  }
}

export async function getComplianceData(): Promise<ComplianceData> {
  const [recentBackupJobs, dlmPolicies, config] = await Promise.all([
    loadBackupJobs(),
    loadDlmPolicies(),
    loadConfigCompliance(),
  ]);
  const generatedAt = new Date().toISOString();
  return {
    recentBackupJobs,
    dlmPolicies,
    configRules: config.configRules,
    configStatus: config.configStatus,
    generatedAt,
    asOf: generatedAt,
  };
}
