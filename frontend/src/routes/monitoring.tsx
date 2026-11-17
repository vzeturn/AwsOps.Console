import { useMemo } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Header from '@cloudscape-design/components/header';
import Container from '@cloudscape-design/components/container';
import Table from '@cloudscape-design/components/table';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import type { AlarmSummary, MonitoringResource, RealtimeMetric, ThresholdLevel } from '@ops-dashboard/shared';
import { getRunbookForMetric } from '@ops-dashboard/shared';
import { useMonitoring, useActionExecute } from '../hooks/useApi';
import { useActionDialog } from '../hooks/useActionDialog';
import { useRunbookModal } from '../hooks/useRunbookModal';
import { ConfirmationDialog } from '../components/ConfirmationDialog';
import { RunbookModal } from '../components/RunbookModal';
import { statusIndicatorType } from '../lib/thresholdStatus';
import { KpiTile, KpiTileRow } from '../components/KpiTile';
import { SeverityStatusBar } from '../components/SeverityStatusBar';

export const Route = createFileRoute('/monitoring')({
  component: MonitoringPage,
});

/** The worst (highest-severity) threshold among a resource's metrics — used to sort/flag the
 * resource row as a whole, since `MonitoringResource` itself carries no single aggregate level. */
function worstMetric(metrics: RealtimeMetric[]): RealtimeMetric | undefined {
  const withThreshold = metrics.filter((m) => m.threshold);
  const critical = withThreshold.find((m) => m.threshold?.level === 'critical');
  if (critical) return critical;
  return withThreshold.find((m) => m.threshold?.level === 'warn') ?? withThreshold[0];
}

const LEVEL_RANK: Record<ThresholdLevel, number> = { critical: 2, warn: 1, ok: 0 };

/** One metric rendered as a small colored value chip — replaces the old crammed
 * `name: value unit` plain-text list with a per-metric status color, so a page full of resources
 * reads like a Datadog metric grid (glance down the column, red/yellow pops out) instead of
 * requiring the reader to parse text to find the number that matters. */
function MetricChip({ metric }: { metric: RealtimeMetric }) {
  const color = metric.threshold
    ? metric.threshold.level === 'critical'
      ? 'text-status-error'
      : metric.threshold.level === 'warn'
        ? 'text-status-warning'
        : 'text-status-success'
    : 'text-body-secondary';
  return (
    <Box fontSize="body-s" display="inline">
      <Box color="text-body-secondary" display="inline">
        {metric.name}:
      </Box>{' '}
      <Box variant="samp" color={color} fontWeight="bold" display="inline">
        {metric.value.toFixed(1)}
        {metric.unit}
      </Box>
    </Box>
  );
}

/** Severity counts across every online resource (by its OWN worst metric) plus the active alarm
 * list — the "how healthy is the fleet right now" summary shown above the two tables. */
function useMonitoringSummary(data: ReturnType<typeof useMonitoring>['data']) {
  return useMemo(() => {
    const resources = data?.resources ?? [];
    const alerts = data?.alerts ?? [];
    const counts = { critical: 0, warn: 0, ok: 0, unmonitored: 0 };
    for (const resource of resources) {
      const level = worstMetric(resource.metrics)?.threshold?.level;
      if (level === 'critical') counts.critical += 1;
      else if (level === 'warn') counts.warn += 1;
      else if (level === 'ok') counts.ok += 1;
      else counts.unmonitored += 1;
    }
    const alarmsInAlarm = alerts.filter((a) => a.state === 'ALARM').length;
    return { counts, resourceCount: resources.length, alarmCount: alerts.length, alarmsInAlarm };
  }, [data]);
}

function MonitoringPage() {
  const monitoring = useMonitoring();
  const execute = useActionExecute();
  const dialog = useActionDialog(execute);
  const runbook = useRunbookModal();
  const summary = useMonitoringSummary(monitoring.data);

  // Worst-first: a critical resource should never be scrolled past a screenful of healthy ones.
  const sortedResources = useMemo(() => {
    const items = monitoring.data?.resources ?? [];
    return [...items].sort((a, b) => {
      const levelA = worstMetric(a.metrics)?.threshold?.level;
      const levelB = worstMetric(b.metrics)?.threshold?.level;
      return (levelB ? LEVEL_RANK[levelB] : -1) - (levelA ? LEVEL_RANK[levelA] : -1);
    });
  }, [monitoring.data]);

  return (
    <ContentLayout header={<Header variant="h1">Monitoring</Header>}>
      <SpaceBetween size="l">
        {monitoring.isError && (
          <Alert type="error" header="Failed to load monitoring data">
            {(monitoring.error as Error).message}
          </Alert>
        )}
        {!monitoring.isLoading && monitoring.data && (
          <Container disableContentPaddings>
            <Box padding="l">
              <SpaceBetween size="m">
                <SeverityStatusBar counts={summary.counts} />
                <KpiTileRow>
                  <KpiTile label="Online resources" value={String(summary.resourceCount)} />
                  <KpiTile
                    label="Alarms in ALARM state"
                    value={String(summary.alarmsInAlarm)}
                    severity={summary.alarmsInAlarm > 0 ? 'critical' : 'ok'}
                  />
                  <KpiTile label="Total alarms tracked" value={String(summary.alarmCount)} />
                </KpiTileRow>
              </SpaceBetween>
            </Box>
          </Container>
        )}
        <Table<MonitoringResource>
          variant="container"
          loading={monitoring.isLoading}
          loadingText="Loading real-time metrics…"
          items={sortedResources}
          trackBy={(item) => `${item.resourceType}:${item.resourceId}`}
          header={
            <Header
              counter={monitoring.data ? `(${monitoring.data.resources.length})` : undefined}
              description="Real-time metrics for every online resource, refreshed every 60 seconds."
            >
              Resources
            </Header>
          }
          columnDefinitions={[
            {
              id: 'status',
              header: 'Status',
              width: 120,
              cell: (item) => {
                const metric = worstMetric(item.metrics);
                if (!metric?.threshold) return <StatusIndicator type="info">n/a</StatusIndicator>;
                return (
                  <StatusIndicator type={statusIndicatorType(metric.threshold.level)}>
                    {metric.threshold.level}
                  </StatusIndicator>
                );
              },
            },
            {
              id: 'resource',
              header: 'Resource',
              cell: (item) => (
                <Box variant="samp" fontSize="body-s">
                  {item.resourceName}
                </Box>
              ),
            },
            { id: 'type', header: 'Type', cell: (item) => item.resourceType.toUpperCase() },
            { id: 'region', header: 'Region', cell: (item) => item.region },
            {
              id: 'metrics',
              header: 'Metrics',
              cell: (item) => (
                <SpaceBetween direction="horizontal" size="s">
                  {item.metrics.map((metric) => (
                    <MetricChip key={metric.name} metric={metric} />
                  ))}
                </SpaceBetween>
              ),
            },
            {
              id: 'runbook',
              header: '',
              // Uses the resource's WORST metric to pick the runbook — the same metric already
              // driving the Status column, so "why is this row red" and "what do I do about it"
              // point at the same signal. Not every metric name has a dedicated runbook yet
              // (RUNBOOK_BY_METRIC is a curated subset, not exhaustive) — the button still shows
              // so a click always gives an answer, even if that answer is "no runbook available yet".
              cell: (item) => {
                const metric = worstMetric(item.metrics);
                if (!metric) return null;
                return (
                  <Button
                    variant="inline-link"
                    iconName="status-info"
                    onClick={() => runbook.open(getRunbookForMetric(metric.name), `${item.resourceName} — ${metric.name}`)}
                  >
                    Runbook
                  </Button>
                );
              },
            },
            {
              id: 'actions',
              header: '',
              // ECS_ScaleOut is the ONLY ACTION_CATALOG entry targeting resourceType 'ecs-service'
              // — this table is the only place an ECS service with runningCount > 0 is ever listed
              // (see online-resources.ts's loadOnlineEcsServices), so it is where this 1-click
              // action lives. A scaled-to-zero service has no row here at all — see the doc comment
              // on OnlineEcsService for why (CloudWatch never emits metrics for 0 running tasks).
              cell: (item) =>
                item.resourceType === 'ecs' ? (
                  <Button
                    variant="inline-link"
                    onClick={() =>
                      dialog.open({
                        actionType: 'ECS_ScaleOut',
                        resourceId: item.resourceId,
                        region: item.region,
                        title: `Scale out ${item.resourceName}`,
                      })
                    }
                  >
                    Scale out
                  </Button>
                ) : null,
            },
          ]}
          empty={
            <Box textAlign="center" color="inherit">
              No online resources reported.
            </Box>
          }
        />
        <ConfirmationDialog {...dialog.dialogProps} />
        <Table<AlarmSummary>
          variant="container"
          loading={monitoring.isLoading}
          items={monitoring.data?.alerts ?? []}
          trackBy="alarmName"
          header={
            <Header counter={monitoring.data ? `(${monitoring.data.alerts.length})` : undefined}>Active alarms</Header>
          }
          columnDefinitions={[
            {
              id: 'state',
              header: 'State',
              width: 120,
              cell: (item) => <StatusIndicator type={statusIndicatorType(item.threshold.level)}>{item.state}</StatusIndicator>,
            },
            { id: 'name', header: 'Alarm', cell: (item) => item.alarmName },
            { id: 'namespace', header: 'Namespace', cell: (item) => item.namespace },
            { id: 'region', header: 'Region', cell: (item) => item.region },
            {
              id: 'runbook',
              header: '',
              cell: (item) =>
                item.metricName ? (
                  <Button
                    variant="inline-link"
                    iconName="status-info"
                    onClick={() => runbook.open(getRunbookForMetric(item.metricName as string), `${item.alarmName} — ${item.metricName}`)}
                  >
                    Runbook
                  </Button>
                ) : null,
            },
          ]}
          empty={
            <Box textAlign="center" color="inherit">
              No active alarms.
            </Box>
          }
        />
      </SpaceBetween>
      <RunbookModal {...runbook.modalProps} />
    </ContentLayout>
  );
}
