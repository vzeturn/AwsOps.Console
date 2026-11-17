import { createFileRoute } from '@tanstack/react-router';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Header from '@cloudscape-design/components/header';
import Table from '@cloudscape-design/components/table';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Container from '@cloudscape-design/components/container';
import Box from '@cloudscape-design/components/box';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Alert from '@cloudscape-design/components/alert';
import LineChart from '@cloudscape-design/components/line-chart';
import PieChart from '@cloudscape-design/components/pie-chart';
import Button from '@cloudscape-design/components/button';
import type { CostByService } from '@ops-dashboard/shared';
import { useCost, useExportCsv } from '../hooks/useApi';
import { KpiTile, KpiTileRow } from '../components/KpiTile';

export const Route = createFileRoute('/cost')({
  component: CostPage,
});

function usd(value: number): string {
  return value.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

/** Month-over-month delta as a KpiTile trend — cost going UP is always tone 'negative' (bad),
 * regardless of whether the arrow points up or down, per KpiTile's own doc comment on why `tone`
 * must be decided by the caller rather than inferred from the sign. */
function monthOverMonthTrend(monthToDateUsd: number, previousMonthUsd: number) {
  if (previousMonthUsd <= 0) return undefined;
  const deltaPercent = ((monthToDateUsd - previousMonthUsd) / previousMonthUsd) * 100;
  if (Math.abs(deltaPercent) < 0.5) {
    return { direction: 'flat' as const, tone: 'neutral' as const, label: 'Flat vs. previous month' };
  }
  const direction = deltaPercent > 0 ? ('up' as const) : ('down' as const);
  return {
    direction,
    tone: deltaPercent > 0 ? ('negative' as const) : ('positive' as const),
    label: `${Math.abs(deltaPercent).toFixed(1)}% ${direction === 'up' ? 'higher' : 'lower'} than previous month`,
  };
}

/** A fixed, high-contrast palette cycled across services — Cloudscape's `PieChart` already picks
 * reasonable default colors on its own, but pinning colors here keeps the SAME service the SAME
 * color between the pie chart and the table below it (Cloudscape doesn't do that pairing for you
 * across two separate chart/table components). */
const SERVICE_COLORS = ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd', '#8c564b', '#e377c2', '#7f7f7f'];

function CostPage() {
  const cost = useCost();
  const data = cost.data;
  const exportCsv = useExportCsv();

  const topServices = [...(data?.byService ?? [])].sort((a, b) => b.amountUsd - a.amountUsd);
  const trend = data ? monthOverMonthTrend(data.monthToDateUsd, data.previousMonthUsd) : undefined;

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          actions={
            <Button loading={exportCsv.isPending} onClick={() => exportCsv.mutate('cost')}>
              Export CSV
            </Button>
          }
        >
          Cost
        </Header>
      }
    >
      <SpaceBetween size="l">
        {cost.isError && (
          <Alert type="error" header="Failed to load cost data">
            {(cost.error as Error).message}
          </Alert>
        )}
        <Container disableContentPaddings>
          <Box padding="l">
            <KpiTileRow>
              <KpiTile label="Month to date" value={data ? usd(data.monthToDateUsd) : '—'} trend={trend} />
              <KpiTile
                label="Forecast (month)"
                value={data?.forecastAvailable ? usd(data.forecastMonthUsd) : '—'}
                caption={data?.forecastAvailable ? undefined : 'No forecast available'}
              />
              <KpiTile label="Previous month" value={data ? usd(data.previousMonthUsd) : '—'} />
              <KpiTile label="Services billed" value={data ? String(topServices.length) : '—'} />
            </KpiTileRow>
          </Box>
        </Container>

        <ColumnLayout columns={2}>
          <Container header={<Header variant="h2">Daily cost trend (30 days)</Header>}>
            <LineChart
              series={[
                {
                  title: 'Daily cost (USD)',
                  type: 'line',
                  data: (data?.dailyCostUsd ?? []).map((point) => ({
                    x: new Date(point.date),
                    y: point.amountUsd,
                  })),
                },
              ]}
              xDomain={
                data?.dailyCostUsd.length
                  ? [new Date(data.dailyCostUsd[0].date), new Date(data.dailyCostUsd[data.dailyCostUsd.length - 1].date)]
                  : undefined
              }
              xScaleType="time"
              height={260}
              xTitle="Date"
              yTitle="USD"
              hideFilter
              statusType={cost.isLoading ? 'loading' : 'finished'}
              empty={<Box textAlign="center">No cost history yet.</Box>}
            />
          </Container>

          <Container header={<Header variant="h2">Cost by service (month to date)</Header>}>
            <PieChart
              variant="donut"
              size="medium"
              data={topServices.map((item, index) => ({
                title: item.service,
                value: item.amountUsd,
                color: SERVICE_COLORS[index % SERVICE_COLORS.length],
              }))}
              innerMetricValue={data ? usd(data.monthToDateUsd) : undefined}
              innerMetricDescription="total"
              detailPopoverContent={(segment, sum) => [
                { key: 'Amount', value: usd(segment.value) },
                { key: 'Share', value: `${((segment.value / sum) * 100).toFixed(1)}%` },
              ]}
              hideFilter
              statusType={cost.isLoading ? 'loading' : 'finished'}
              empty={<Box textAlign="center">No cost data yet.</Box>}
              ariaLabel="Cost by service"
            />
          </Container>
        </ColumnLayout>

        <Table<CostByService>
          variant="container"
          loading={cost.isLoading}
          items={topServices}
          trackBy="service"
          header={<Header variant="h2">Cost by service — detail</Header>}
          columnDefinitions={[
            {
              id: 'service',
              header: 'Service',
              cell: (item) => {
                const index = topServices.indexOf(item);
                return (
                  <SpaceBetween direction="horizontal" size="xs" alignItems="center">
                    <span
                      aria-hidden
                      style={{
                        display: 'inline-block',
                        width: 10,
                        height: 10,
                        borderRadius: '50%',
                        background: SERVICE_COLORS[index % SERVICE_COLORS.length],
                      }}
                    />
                    <span>{item.service}</span>
                  </SpaceBetween>
                );
              },
            },
            { id: 'amount', header: 'Amount', cell: (item) => <Box variant="samp">{usd(item.amountUsd)}</Box> },
            {
              id: 'share',
              header: 'Share of total',
              cell: (item) => {
                const total = topServices.reduce((sum, s) => sum + s.amountUsd, 0);
                return total > 0 ? `${((item.amountUsd / total) * 100).toFixed(1)}%` : '—';
              },
            },
          ]}
          sortingColumn={{ sortingComparator: (a, b) => b.amountUsd - a.amountUsd }}
          empty={<Box textAlign="center">No cost data yet.</Box>}
        />
      </SpaceBetween>
    </ContentLayout>
  );
}
