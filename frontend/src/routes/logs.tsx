import { useMemo, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Header from '@cloudscape-design/components/header';
import Container from '@cloudscape-design/components/container';
import ExpandableSection from '@cloudscape-design/components/expandable-section';
import Table from '@cloudscape-design/components/table';
import Select from '@cloudscape-design/components/select';
import type { SelectProps } from '@cloudscape-design/components/select';
import DateRangePicker from '@cloudscape-design/components/date-range-picker';
import type { DateRangePickerProps } from '@cloudscape-design/components/date-range-picker';
import Input from '@cloudscape-design/components/input';
import Button from '@cloudscape-design/components/button';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import type { LogEventItem, LogGroupSummary } from '@ops-dashboard/shared';
import { useLogGroups, useLogEvents, useActionExecute } from '../hooks/useApi';
import { useActionDialog } from '../hooks/useActionDialog';
import { ConfirmationDialog } from '../components/ConfirmationDialog';
import { KpiTile, KpiTileRow } from '../components/KpiTile';

export const Route = createFileRoute('/logs')({
  component: LogsPage,
});

/** Total stored size + how many groups have no retention policy ("Never expire" — the finding
 * `cloudWatchLogGroupNoRetention` flags on Assessment) — the two numbers that answer "is log
 * storage under control" without expanding the retention table row by row. */
function useLogGroupsSummary(groups: LogGroupSummary[]) {
  return useMemo(() => {
    const totalBytes = groups.reduce((sum, g) => sum + g.storedBytes, 0);
    const neverExpireCount = groups.filter((g) => g.retentionInDays === null).length;
    return { total: groups.length, totalBytes, neverExpireCount };
  }, [groups]);
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}

const RELATIVE_OPTIONS: DateRangePickerProps.RelativeOption[] = [
  { key: 'last-15-minutes', amount: 15, unit: 'minute', type: 'relative' },
  { key: 'last-1-hour', amount: 1, unit: 'hour', type: 'relative' },
  { key: 'last-4-hours', amount: 4, unit: 'hour', type: 'relative' },
  { key: 'last-1-day', amount: 1, unit: 'day', type: 'relative' },
];

function resolveRangeMs(value: DateRangePickerProps.Value | null): { startTime: number; endTime: number } | undefined {
  if (!value) return undefined;
  if (value.type === 'absolute') {
    return { startTime: new Date(value.startDate).getTime(), endTime: new Date(value.endDate).getTime() };
  }
  const unitMs: Record<string, number> = {
    second: 1000,
    minute: 60_000,
    hour: 3_600_000,
    day: 86_400_000,
    week: 604_800_000,
    month: 2_592_000_000,
    year: 31_536_000_000,
  };
  const endTime = Date.now();
  return { startTime: endTime - value.amount * unitMs[value.unit], endTime };
}

function LogsPage() {
  const logGroups = useLogGroups();
  const logEvents = useLogEvents();
  const retentionExecute = useActionExecute();
  const retentionDialog = useActionDialog(retentionExecute);

  const [groupOption, setGroupOption] = useState<SelectProps.Option | null>(null);
  const [range, setRange] = useState<DateRangePickerProps.Value | null>(RELATIVE_OPTIONS[1]);
  const [filterPattern, setFilterPattern] = useState('');
  const [events, setEvents] = useState<LogEventItem[]>([]);
  const [nextToken, setNextToken] = useState<string | undefined>();
  const [truncatedCount, setTruncatedCount] = useState(0);

  const groupsSummary = useLogGroupsSummary(logGroups.data?.groups ?? []);

  const groupOptions: SelectProps.Option[] = (logGroups.data?.groups ?? []).map((g) => ({
    value: g.logGroupName,
    label: g.logGroupName,
    description: `${(g.storedBytes / 1024 / 1024).toFixed(1)} MiB · retention: ${g.retentionInDays ?? 'never expire'}`,
  }));

  function runQuery(loadMore = false) {
    if (!groupOption) return;
    const window = resolveRangeMs(range);
    if (!window) return;
    logEvents.mutate(
      {
        logGroupName: groupOption.value ?? '',
        startTime: window.startTime,
        endTime: window.endTime,
        ...(filterPattern ? { filterPattern } : {}),
        ...(loadMore && nextToken ? { nextToken } : {}),
      },
      {
        onSuccess: (page) => {
          setEvents((prev) => (loadMore ? [...prev, ...page.events] : page.events));
          setNextToken(page.nextToken);
          setTruncatedCount((prev) => (loadMore ? prev + page.truncatedMessageCount : page.truncatedMessageCount));
        },
      },
    );
  }

  return (
    <ContentLayout header={<Header variant="h1">Logs</Header>}>
      <SpaceBetween size="l">
        {logGroups.isError && (
          <Alert type="error" header="Failed to load log groups">
            {(logGroups.error as Error).message}
          </Alert>
        )}
        {logGroups.data?.truncated && (
          <Alert type="warning">The log group list is incomplete — the account has more groups than the listing cap.</Alert>
        )}
        {logEvents.isError && (
          <Alert type="error" header="Failed to query logs">
            {(logEvents.error as Error).message}
          </Alert>
        )}

        {!logGroups.isLoading && logGroups.data && (
          <Container disableContentPaddings>
            <Box padding="l">
              <KpiTileRow>
                <KpiTile label="Log groups" value={String(groupsSummary.total)} />
                <KpiTile label="Total stored" value={formatBytes(groupsSummary.totalBytes)} />
                <KpiTile
                  label="No retention policy set"
                  value={String(groupsSummary.neverExpireCount)}
                  severity={groupsSummary.neverExpireCount > 0 ? 'warning' : 'ok'}
                />
              </KpiTileRow>
            </Box>
          </Container>
        )}

        <ExpandableSection variant="container" headerText="Manage log group retention">
          <Table<LogGroupSummary>
            variant="embedded"
            loading={logGroups.isLoading}
            items={logGroups.data?.groups ?? []}
            trackBy="logGroupName"
            columnDefinitions={[
              { id: 'name', header: 'Log group', cell: (item) => <Box variant="samp">{item.logGroupName}</Box> },
              {
                id: 'retention',
                header: 'Retention',
                cell: (item) => (item.retentionInDays === null ? 'Never expire' : `${item.retentionInDays} days`),
              },
              { id: 'size', header: 'Stored size', cell: (item) => `${(item.storedBytes / 1024 / 1024).toFixed(1)} MiB` },
              {
                id: 'actions',
                header: '',
                cell: (item) =>
                  // CloudWatchLogGroup_SetRetention only applies once (see preview-service.ts's
                  // buildCloudWatchLogRetentionPreview — it rejects a group that already has a
                  // retention policy set, rather than letting the operator change it repeatedly).
                  item.retentionInDays === null ? (
                    <Button
                      variant="inline-link"
                      onClick={() =>
                        retentionDialog.open({
                          actionType: 'CloudWatchLogGroup_SetRetention',
                          resourceId: item.logGroupName,
                          title: `Set retention — ${item.logGroupName}`,
                        })
                      }
                    >
                      Set retention…
                    </Button>
                  ) : null,
              },
            ]}
            empty={<Box textAlign="center">No log groups.</Box>}
          />
        </ExpandableSection>

        <Container>
          <SpaceBetween size="m">
            <SpaceBetween direction="horizontal" size="m">
              <Box>
                <Select
                  selectedOption={groupOption}
                  options={groupOptions}
                  placeholder="Choose a log group"
                  filteringType="auto"
                  statusType={logGroups.isLoading ? 'loading' : 'finished'}
                  onChange={(event: { detail: SelectProps.ChangeDetail }) => setGroupOption(event.detail.selectedOption)}
                />
              </Box>
              <Box>
                <DateRangePicker
                  value={range}
                  onChange={(event: { detail: DateRangePickerProps.ChangeDetail }) => setRange(event.detail.value)}
                  relativeOptions={RELATIVE_OPTIONS}
                  rangeSelectorMode="default"
                  isValidRange={(value: DateRangePickerProps.Value | null) =>
                    value ? { valid: true } : { valid: false, errorMessage: 'Select a range' }
                  }
                  placeholder="Filter by time range"
                />
              </Box>
              <Box>
                <Input
                  placeholder="Filter pattern (optional)"
                  value={filterPattern}
                  onChange={(event: { detail: { value: string } }) => setFilterPattern(event.detail.value)}
                />
              </Box>
              <Button variant="primary" loading={logEvents.isPending} disabled={!groupOption} onClick={() => runQuery(false)}>
                Search
              </Button>
            </SpaceBetween>
          </SpaceBetween>
        </Container>

        {truncatedCount > 0 && (
          <Alert type="info">{truncatedCount} message(s) were truncated for exceeding the length cap.</Alert>
        )}

        <Table<LogEventItem>
          variant="container"
          loading={logEvents.isPending && events.length === 0}
          items={events}
          trackBy="eventId"
          header={<Header counter={`(${events.length})`}>Events</Header>}
          columnDefinitions={[
            { id: 'timestamp', header: 'Time', width: 200, cell: (item) => new Date(item.timestamp).toLocaleString() },
            { id: 'stream', header: 'Stream', cell: (item) => item.logStreamName },
            {
              id: 'message',
              header: 'Message',
              cell: (item) => (
                <Box variant="samp" fontSize="body-s">
                  {item.message}
                </Box>
              ),
            },
          ]}
          empty={<Box textAlign="center">Choose a log group and search to see events.</Box>}
        />

        {nextToken && (
          <Box textAlign="center">
            <Button loading={logEvents.isPending} onClick={() => runQuery(true)}>
              Load more
            </Button>
          </Box>
        )}
      </SpaceBetween>
      <ConfirmationDialog {...retentionDialog.dialogProps} />
    </ContentLayout>
  );
}
