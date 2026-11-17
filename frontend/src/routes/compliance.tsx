import { useMemo } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Header from '@cloudscape-design/components/header';
import Table from '@cloudscape-design/components/table';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Container from '@cloudscape-design/components/container';
import Tabs from '@cloudscape-design/components/tabs';
import Link from '@cloudscape-design/components/link';
import Button from '@cloudscape-design/components/button';
import type { BackupJobSummary, ConfigComplianceSummary, DlmPolicySummary } from '@ops-dashboard/shared';
import { useCompliance, useExportCsv } from '../hooks/useApi';
import { statusIndicatorType } from '../lib/thresholdStatus';
import { KpiTile, KpiTileRow } from '../components/KpiTile';
import { SeverityStatusBar } from '../components/SeverityStatusBar';

export const Route = createFileRoute('/compliance')({
  component: CompliancePage,
});

/** Rolls backup jobs + Config rules into one severity count (DLM policies carry no
 * `ThresholdMeta` — they're a configuration list, not a pass/fail check) plus a compliance
 * percentage — the single number that answers "how compliant is this account right now" without
 * reading three separate tabs. */
function useComplianceSummary(data: ReturnType<typeof useCompliance>['data']) {
  return useMemo(() => {
    const checks = [...(data?.recentBackupJobs ?? []), ...(data?.configRules ?? [])];
    let critical = 0;
    let warn = 0;
    let ok = 0;
    for (const check of checks) {
      if (check.threshold.level === 'critical') critical += 1;
      else if (check.threshold.level === 'warn') warn += 1;
      else ok += 1;
    }
    const total = checks.length;
    const compliancePercent = total > 0 ? (ok / total) * 100 : null;
    return { counts: { critical, warn, ok }, total, compliancePercent };
  }, [data]);
}

function CompliancePage() {
  const compliance = useCompliance();
  const data = compliance.data;
  const navigate = useNavigate();
  const exportCsv = useExportCsv();
  const summary = useComplianceSummary(data);

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          actions={
            <Button loading={exportCsv.isPending} onClick={() => exportCsv.mutate('compliance')}>
              Export CSV
            </Button>
          }
        >
          Backup &amp; Compliance
        </Header>
      }
    >
      <SpaceBetween size="l">
        {compliance.isError && (
          <Alert type="error" header="Failed to load compliance data">
            {(compliance.error as Error).message}
          </Alert>
        )}
        {data?.configStatus === 'unavailable' && (
          <Alert type="warning" header="AWS Config data unavailable">
            Config rule results could not be fetched — this is NOT the same as "compliant", treat it as unknown.
          </Alert>
        )}
        {!compliance.isLoading && data && (
          <Container disableContentPaddings>
            <Box padding="l">
              <SpaceBetween size="m">
                <SeverityStatusBar counts={summary.counts} />
                <KpiTileRow>
                  <KpiTile
                    label="Compliance score"
                    value={summary.compliancePercent != null ? `${summary.compliancePercent.toFixed(0)}%` : '—'}
                    severity={
                      summary.compliancePercent == null
                        ? 'neutral'
                        : summary.compliancePercent >= 95
                          ? 'ok'
                          : summary.compliancePercent >= 80
                            ? 'warning'
                            : 'critical'
                    }
                  />
                  <KpiTile label="Checks evaluated" value={String(summary.total)} />
                  <KpiTile label="DLM policies" value={String(data.dlmPolicies.length)} />
                </KpiTileRow>
              </SpaceBetween>
            </Box>
          </Container>
        )}
        {/* Backup remediation (protect a vault, configure restore testing, retry a failed job) is
            executed from the Assessment tab, not here: `ComplianceData` (this page's data source)
            carries no vault name or full resource ARN for a backup job — only `infra-review-collector`'s
            AssessmentReport recommendations (backupVaultNotProtected/restoreTestingNotConfigured/
            backupJobFailed findings) carry the identifiers `BackupVault_ApplyProtectionPolicy`/
            `BackupRestoreTesting_CreatePlan`/`Backup_RetryJob` actually need to execute. */}
        <Alert type="info" header="Backup remediation actions">
          Applying a vault protection policy, configuring restore testing, or retrying a failed backup job
          is done from the{' '}
          <Link
            onFollow={(e) => {
              e.preventDefault();
              void navigate({ to: '/assessment' });
            }}
            href="/assessment"
          >
            Assessment
          </Link>{' '}
          tab, where each finding carries the exact resource identifier the action needs.
        </Alert>
        <Tabs
          tabs={[
            {
              id: 'backup-jobs',
              label: `Recent backup jobs${data ? ` (${data.recentBackupJobs.length})` : ''}`,
              content: (
                <Table<BackupJobSummary>
                  variant="borderless"
                  loading={compliance.isLoading}
                  items={data?.recentBackupJobs ?? []}
                  trackBy="jobId"
                  columnDefinitions={[
                    {
                      id: 'state',
                      header: 'State',
                      width: 120,
                      cell: (item) => (
                        <StatusIndicator type={statusIndicatorType(item.threshold.level)}>{item.state}</StatusIndicator>
                      ),
                    },
                    { id: 'resource', header: 'Resource', cell: (item) => item.resourceName },
                    { id: 'date', header: 'Created', cell: (item) => new Date(item.creationDate).toLocaleString() },
                  ]}
                  empty={<Box textAlign="center">No recent backup jobs.</Box>}
                />
              ),
            },
            {
              id: 'dlm',
              label: `DLM policies${data ? ` (${data.dlmPolicies.length})` : ''}`,
              content: (
                <Table<DlmPolicySummary>
                  variant="borderless"
                  loading={compliance.isLoading}
                  items={data?.dlmPolicies ?? []}
                  trackBy="policyId"
                  columnDefinitions={[
                    { id: 'description', header: 'Description', cell: (item) => item.description },
                    { id: 'state', header: 'State', cell: (item) => item.state },
                    { id: 'volumes', header: 'Target volumes', cell: (item) => item.targetVolumeCount },
                  ]}
                  empty={<Box textAlign="center">No DLM policies.</Box>}
                />
              ),
            },
            {
              id: 'config',
              label: `Config rules${data ? ` (${data.configRules.length})` : ''}`,
              content: (
                <Table<ConfigComplianceSummary>
                  variant="borderless"
                  loading={compliance.isLoading}
                  items={data?.configRules ?? []}
                  trackBy="ruleName"
                  columnDefinitions={[
                    {
                      id: 'status',
                      header: 'Status',
                      width: 120,
                      cell: (item) => (
                        <StatusIndicator type={statusIndicatorType(item.threshold.level)}>{item.complianceType}</StatusIndicator>
                      ),
                    },
                    { id: 'rule', header: 'Rule', cell: (item) => item.ruleName },
                  ]}
                  empty={<Box textAlign="center">No Config rules evaluated.</Box>}
                />
              ),
            },
          ]}
        />
      </SpaceBetween>
    </ContentLayout>
  );
}
