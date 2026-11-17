import { useMemo } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Header from '@cloudscape-design/components/header';
import Container from '@cloudscape-design/components/container';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import LineChart from '@cloudscape-design/components/line-chart';
import Table from '@cloudscape-design/components/table';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Link from '@cloudscape-design/components/link';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import ButtonDropdown from '@cloudscape-design/components/button-dropdown';
import Button from '@cloudscape-design/components/button';
import { chooseEc2Action, rdsLifecycleActionsForStatus, getRunbookForMetric } from '@ops-dashboard/shared';
import type { ActionAuditRecord, ActionType, MonitoringResourceType, RealtimeMetric } from '@ops-dashboard/shared';
import { useMonitoring, useActionsAudit, useInfra, useMe, useActionExecute, useActionLifecycle } from '../hooks/useApi';
import { useActionDialog } from '../hooks/useActionDialog';
import { useRunbookModal } from '../hooks/useRunbookModal';
import { ConfirmationDialog } from '../components/ConfirmationDialog';
import { RunbookModal } from '../components/RunbookModal';
import { statusIndicatorType } from '../lib/thresholdStatus';
import { SeverityStatusBar } from '../components/SeverityStatusBar';

/**
 * Replaces the previous frontend's modal-via-state resource detail with a real, deep-linkable URL
 * — `/resource/:resourceType/:resourceId`. Reuses `/monitoring` (already fetched/cached by the
 * Monitoring tab) rather than adding a per-resource endpoint: `MonitoringResource` already carries
 * every metric + trend + console link this page needs.
 */
export const Route = createFileRoute('/resource/$resourceType/$resourceId')({
  component: ResourceDetailPage,
});

const METRIC_VALUE_COLOR = {
  critical: 'text-status-error',
  warn: 'text-status-warning',
  ok: 'text-status-success',
} as const;

function MetricPanel({ metric, onOpenRunbook }: { metric: RealtimeMetric; onOpenRunbook: () => void }) {
  const valueColor = metric.threshold ? METRIC_VALUE_COLOR[metric.threshold.level] : 'inherit';
  return (
    <Container
      header={
        <Header
          variant="h3"
          actions={
            <Button variant="inline-link" iconName="status-info" onClick={onOpenRunbook}>
              Runbook
            </Button>
          }
        >
          {metric.name}
        </Header>
      }
    >
      <SpaceBetween size="s">
        <ColumnLayout columns={2}>
          <div>
            <Box variant="awsui-key-label">Current value</Box>
            <Box variant="samp" fontSize="display-l" fontWeight="bold" color={valueColor}>
              {metric.value.toFixed(2)} {metric.unit}
            </Box>
          </div>
          <div>
            <Box variant="awsui-key-label">Threshold</Box>
            {metric.threshold ? (
              <StatusIndicator type={statusIndicatorType(metric.threshold.level)}>{metric.threshold.reason}</StatusIndicator>
            ) : (
              <StatusIndicator type="info">no threshold defined</StatusIndicator>
            )}
          </div>
        </ColumnLayout>
        <LineChart
          height={200}
          series={[
            {
              title: metric.name,
              type: 'line',
              data: metric.trend.map((point) => ({ x: new Date(point.timestamp), y: point.value })),
            },
          ]}
          xScaleType="time"
          hideFilter
          yTitle={metric.unit}
          xTitle="Time"
          empty={<Box textAlign="center">No trend data yet.</Box>}
        />
        <Link href={metric.consoleLink} external>
          Open in CloudWatch console
        </Link>
      </SpaceBetween>
    </Container>
  );
}

function ResourceDetailPage() {
  const { resourceType, resourceId } = Route.useParams();
  const monitoring = useMonitoring();
  const audit = useActionsAudit(resourceType, resourceId);
  const infra = useInfra();
  const me = useMe();
  const isOperator = me.data?.isOperator ?? false;

  const generalExecute = useActionExecute();
  const lifecycle = useActionLifecycle();
  const generalDialog = useActionDialog(generalExecute);
  const lifecycleDialog = useActionDialog(lifecycle);
  const runbook = useRunbookModal();

  const resource = monitoring.data?.resources.find(
    (r) => r.resourceType === (resourceType as MonitoringResourceType) && r.resourceId === resourceId,
  );

  const metricSeverityCounts = useMemo(() => {
    const counts = { critical: 0, warn: 0, ok: 0, unmonitored: 0 };
    for (const metric of resource?.metrics ?? []) {
      if (metric.threshold?.level === 'critical') counts.critical += 1;
      else if (metric.threshold?.level === 'warn') counts.warn += 1;
      else if (metric.threshold?.level === 'ok') counts.ok += 1;
      else counts.unmonitored += 1;
    }
    return counts;
  }, [resource]);
  const ec2Instance = infra.data?.ec2.find((i) => i.instanceId === resourceId);
  const rdsInstance = infra.data?.rds.find((i) => i.dbInstanceIdentifier === resourceId);
  const region = resource?.region ?? ec2Instance?.region ?? rdsInstance?.region ?? '';

  function runAction(actionType: ActionType, useLifecycleGate: boolean, title: string) {
    (useLifecycleGate ? lifecycleDialog : generalDialog).open({ actionType, resourceId, region, title });
  }

  const actionsMenu =
    resourceType === 'ec2' && ec2Instance ? (
      <ButtonDropdown
        items={[
          { id: chooseEc2Action(ec2Instance.state), text: chooseEc2Action(ec2Instance.state) === 'EC2_Start' ? 'Start' : 'Stop' },
          ...(ec2Instance.state === 'running' ? [{ id: 'EC2_Rightsize', text: 'Rightsize (downsize one step)' }] : []),
          { id: 'EC2_Reboot', text: 'Reboot', disabled: !isOperator || ec2Instance.state !== 'running' },
        ]}
        onItemClick={({ detail }) => {
          if (detail.id === 'EC2_Reboot') runAction('EC2_Reboot', true, `Reboot ${ec2Instance.name}`);
          else runAction(detail.id as ActionType, false, `${detail.id.replace('EC2_', '')} ${ec2Instance.name}`);
        }}
      >
        Actions
      </ButtonDropdown>
    ) : resourceType === 'rds' && rdsInstance ? (
      (() => {
        const lifecycleActions = rdsLifecycleActionsForStatus(rdsInstance.status);
        return (
          <ButtonDropdown
            items={[
              { id: 'RDS_IncreaseStorage', text: 'Increase storage' },
              { id: 'RDS_ApplyResourceGovernance', text: 'Apply resource governance' },
              { id: 'RDS_Start', text: 'Start', disabled: !isOperator || !lifecycleActions.canStart },
              { id: 'RDS_Stop', text: 'Stop', disabled: !isOperator || !lifecycleActions.canStop },
              { id: 'RDS_Reboot', text: 'Reboot', disabled: !isOperator || !lifecycleActions.canReboot },
            ]}
            onItemClick={({ detail }) => {
              const isLifecycle = detail.id.startsWith('RDS_') && ['RDS_Start', 'RDS_Stop', 'RDS_Reboot'].includes(detail.id);
              runAction(detail.id as ActionType, isLifecycle, `${detail.id.replace('RDS_', '')} ${rdsInstance.dbInstanceIdentifier}`);
            }}
          >
            Actions
          </ButtonDropdown>
        );
      })()
    ) : undefined;

  return (
    <ContentLayout header={<Header variant="h1" actions={actionsMenu}>{resource?.resourceName ?? resourceId}</Header>}>
      <SpaceBetween size="l">
        {monitoring.isError && (
          <Alert type="error" header="Failed to load monitoring data">
            {(monitoring.error as Error).message}
          </Alert>
        )}
        {!monitoring.isLoading && !resource && (
          <Alert type="warning" header="No real-time data for this resource">
            This resource has no entry in the current monitoring snapshot — it may be offline, or
            outside this dashboard's monitored resource types.
          </Alert>
        )}

        <Container disableContentPaddings>
          <Box padding="l">
            <SpaceBetween size="m">
              <ColumnLayout columns={3} variant="text-grid">
                <div>
                  <Box variant="awsui-key-label">Resource ID</Box>
                  <Box variant="samp">{resourceId}</Box>
                </div>
                <div>
                  <Box variant="awsui-key-label">Type</Box>
                  <Box>{resourceType.toUpperCase()}</Box>
                </div>
                <div>
                  <Box variant="awsui-key-label">Region</Box>
                  <Box>{resource?.region ?? '—'}</Box>
                </div>
              </ColumnLayout>
              {resource && <SeverityStatusBar counts={metricSeverityCounts} />}
            </SpaceBetween>
          </Box>
        </Container>

        {resource?.metrics.map((metric) => (
          <MetricPanel
            key={metric.name}
            metric={metric}
            onOpenRunbook={() => runbook.open(getRunbookForMetric(metric.name), `${resource.resourceName} — ${metric.name}`)}
          />
        ))}

        {resource?.targetGroupHealth && resource.targetGroupHealth.length > 0 && (
          <Container header={<Header variant="h2">Target group health</Header>}>
            <SpaceBetween size="s">
              {resource.targetGroupHealth.map((tg) => (
                <Box key={tg.targetGroupName}>
                  {tg.targetGroupName}: {tg.totalTargets - tg.unhealthyTargets} / {tg.totalTargets} healthy
                </Box>
              ))}
            </SpaceBetween>
          </Container>
        )}

        <Table<ActionAuditRecord>
          variant="container"
          loading={audit.isLoading}
          items={audit.data ?? []}
          trackBy={(item) => `${item.executedAt}-${item.actionType}`}
          header={<Header variant="h2" counter={audit.data ? `(${audit.data.length})` : undefined}>Action history</Header>}
          columnDefinitions={[
            { id: 'time', header: 'When', cell: (item) => new Date(item.executedAt).toLocaleString() },
            { id: 'action', header: 'Action', cell: (item) => item.actionType },
            { id: 'by', header: 'By', cell: (item) => item.executedBy },
            {
              id: 'outcome',
              header: 'Outcome',
              cell: (item) => (
                <StatusIndicator type={item.outcome === 'success' ? 'success' : item.outcome === 'partial' ? 'warning' : 'error'}>
                  {item.outcome}
                </StatusIndicator>
              ),
            },
          ]}
          empty={<Box textAlign="center">No recorded actions for this resource.</Box>}
        />
      </SpaceBetween>
      <ConfirmationDialog {...generalDialog.dialogProps} />
      <ConfirmationDialog {...lifecycleDialog.dialogProps} />
      <RunbookModal {...runbook.modalProps} />
    </ContentLayout>
  );
}
