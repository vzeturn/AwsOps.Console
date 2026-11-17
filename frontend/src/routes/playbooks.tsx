import { useMemo, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Header from '@cloudscape-design/components/header';
import Table from '@cloudscape-design/components/table';
import Badge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import SpaceBetween from '@cloudscape-design/components/space-between';
import TextFilter from '@cloudscape-design/components/text-filter';
import Select from '@cloudscape-design/components/select';
import type { SelectProps } from '@cloudscape-design/components/select';
import type { RunbookEntry } from '@ops-dashboard/shared';
import { RUNBOOK_BY_FINDING, RUNBOOK_BY_METRIC } from '@ops-dashboard/shared';
import { useRunbookModal } from '../hooks/useRunbookModal';
import { RunbookModal } from '../components/RunbookModal';
import { KpiTile, KpiTileRow } from '../components/KpiTile';

export const Route = createFileRoute('/playbooks')({
  component: PlaybooksPage,
});

/**
 * `/playbooks` — the ONE page that browses the ENTIRE operational runbook catalog
 * (`RUNBOOK_BY_FINDING` + `RUNBOOK_BY_METRIC`, `shared/src/runbookCatalog.ts`) as a single,
 * searchable/filterable table, instead of only being reachable one entry at a time from a
 * "Runbook" button buried in the Assessment/Monitoring tables.
 *
 * WHY THIS EXISTS (user request: "so that we get a full-coverage set of runbooks/playbooks").
 * Every entry already existed in the catalog before this page — this page adds nothing to the
 * DATA, it is purely a new way to browse what was already there, mirroring how the CIS Benchmark
 * SEV-mudiness investigation (2026-09-22) needed to review all 12 CIS entries at once to check
 * coverage; there was no page that could do that without opening the source file directly.
 *
 * SOURCE badge distinguishes WHERE an entry is triggered from, since the same catalog backs three
 * different trigger paths that a reader should be able to tell apart at a glance:
 *   - "Finding" -> `RUNBOOK_BY_FINDING`, surfaced from the Assessment page's recommendations table.
 *   - "CIS Benchmark" -> the 12 `RUNBOOK_BY_METRIC` entries whose title cites a CIS control number
 *     (see `runbookCatalog.ts`'s CIS section) — these back the `CIS-*-Alarm` CloudWatch alarms,
 *     enriched with live CloudTrail detail by `discord-alarm-notifier.ts`'s `lookupCisBenchmarkEvent`.
 *   - "Metric" -> every other `RUNBOOK_BY_METRIC` entry, surfaced from the Monitoring page's alarm table.
 * Detected structurally (title matches `/CIS \d/`, exactly the same regex
 * `runbookCatalog.test.ts`'s own CIS coverage test already asserts on) rather than a second,
 * separately-maintained list of CIS metric names that could drift out of sync with the catalog.
 */
type PlaybookSource = 'finding' | 'cis' | 'metric';

interface PlaybookRow {
  key: string;
  source: PlaybookSource;
  triggerKey: string;
  entry: RunbookEntry;
}

const SOURCE_LABEL: Record<PlaybookSource, string> = {
  finding: 'Assessment finding',
  cis: 'CIS Benchmark',
  metric: 'Monitoring metric',
};

const SOURCE_BADGE_COLOR: Record<PlaybookSource, 'blue' | 'red' | 'grey'> = {
  finding: 'blue',
  cis: 'red',
  metric: 'grey',
};

const SEVERITY_BADGE_COLOR: Record<RunbookEntry['defaultSeverity'], 'red' | 'blue' | 'grey'> = {
  critical: 'red',
  warning: 'blue',
  info: 'grey',
};

const CIS_TITLE_PATTERN = /CIS \d/;

function buildPlaybookRows(): PlaybookRow[] {
  const findingRows: PlaybookRow[] = Object.entries(RUNBOOK_BY_FINDING).map(([triggerKey, entry]) => ({
    key: `finding:${triggerKey}`,
    source: 'finding',
    triggerKey,
    entry,
  }));
  const metricRows: PlaybookRow[] = Object.entries(RUNBOOK_BY_METRIC).map(([triggerKey, entry]) => ({
    key: `metric:${triggerKey}`,
    source: CIS_TITLE_PATTERN.test(entry.title) ? 'cis' : 'metric',
    triggerKey,
    entry,
  }));
  return [...findingRows, ...metricRows].sort((a, b) => a.entry.title.localeCompare(b.entry.title));
}

const SOURCE_FILTER_OPTIONS: SelectProps.Option[] = [
  { value: 'all', label: 'All sources' },
  { value: 'finding', label: SOURCE_LABEL.finding },
  { value: 'cis', label: SOURCE_LABEL.cis },
  { value: 'metric', label: SOURCE_LABEL.metric },
];

const SEVERITY_FILTER_OPTIONS: SelectProps.Option[] = [
  { value: 'all', label: 'All severities' },
  { value: 'critical', label: 'Critical' },
  { value: 'warning', label: 'Warning' },
  { value: 'info', label: 'Info' },
];

/** Exported directly (not just via `Route.component`) — same reason `AssessmentPage` already
 * documents: lets tests render it without the router's `autoCodeSplitting` transform. */
export function PlaybooksPage() {
  const allRows = useMemo(buildPlaybookRows, []);
  const [filterText, setFilterText] = useState('');
  const [sourceFilter, setSourceFilter] = useState<SelectProps.Option>(SOURCE_FILTER_OPTIONS[0]);
  const [severityFilter, setSeverityFilter] = useState<SelectProps.Option>(SEVERITY_FILTER_OPTIONS[0]);
  const runbook = useRunbookModal();

  const filteredRows = useMemo(() => {
    const needle = filterText.trim().toLowerCase();
    return allRows.filter((row) => {
      if (sourceFilter.value !== 'all' && row.source !== sourceFilter.value) return false;
      if (severityFilter.value !== 'all' && row.entry.defaultSeverity !== severityFilter.value) return false;
      if (!needle) return true;
      return (
        row.entry.title.toLowerCase().includes(needle) ||
        row.entry.symptom.toLowerCase().includes(needle) ||
        row.triggerKey.toLowerCase().includes(needle)
      );
    });
  }, [allRows, filterText, sourceFilter, severityFilter]);

  const summary = useMemo(() => {
    let critical = 0;
    let warning = 0;
    let info = 0;
    let cis = 0;
    for (const row of allRows) {
      if (row.entry.defaultSeverity === 'critical') critical += 1;
      else if (row.entry.defaultSeverity === 'warning') warning += 1;
      else info += 1;
      if (row.source === 'cis') cis += 1;
    }
    return { total: allRows.length, critical, warning, info, cis };
  }, [allRows]);

  return (
    <ContentLayout
      header={
        <Header variant="h1" description="Every operational runbook this dashboard knows about — symptom, diagnosis, remediation, rollback, and escalation guidance, in one searchable place.">
          Playbooks
        </Header>
      }
    >
      <SpaceBetween size="l">
        <Container disableContentPaddings>
          <Box padding="l">
            <KpiTileRow>
              <KpiTile label="Total playbooks" value={String(summary.total)} />
              <KpiTile label="Critical" value={String(summary.critical)} severity={summary.critical > 0 ? 'critical' : 'ok'} />
              <KpiTile label="Warning" value={String(summary.warning)} severity={summary.warning > 0 ? 'warning' : 'ok'} />
              <KpiTile label="Info" value={String(summary.info)} />
              <KpiTile label="CIS Benchmark" value={String(summary.cis)} caption="security/compliance controls" />
            </KpiTileRow>
          </Box>
        </Container>

        <Table<PlaybookRow>
          variant="container"
          items={filteredRows}
          trackBy="key"
          header={<Header counter={`(${filteredRows.length}/${allRows.length})`}>Runbook catalog</Header>}
          filter={
            <SpaceBetween direction="horizontal" size="s">
              <TextFilter
                filteringText={filterText}
                onChange={({ detail }) => setFilterText(detail.filteringText)}
                filteringPlaceholder="Search title, symptom, or trigger key"
                filteringAriaLabel="Filter playbooks"
              />
              <Select
                selectedOption={sourceFilter}
                onChange={({ detail }) => setSourceFilter(detail.selectedOption)}
                options={SOURCE_FILTER_OPTIONS}
                selectedAriaLabel="Selected source"
                ariaLabel="Filter by source"
              />
              <Select
                selectedOption={severityFilter}
                onChange={({ detail }) => setSeverityFilter(detail.selectedOption)}
                options={SEVERITY_FILTER_OPTIONS}
                selectedAriaLabel="Selected severity"
                ariaLabel="Filter by severity"
              />
            </SpaceBetween>
          }
          columnDefinitions={[
            {
              id: 'source',
              header: 'Source',
              width: 160,
              cell: (row) => <Badge color={SOURCE_BADGE_COLOR[row.source]}>{SOURCE_LABEL[row.source]}</Badge>,
            },
            {
              id: 'severity',
              header: 'Severity',
              width: 110,
              cell: (row) => <Badge color={SEVERITY_BADGE_COLOR[row.entry.defaultSeverity]}>{row.entry.defaultSeverity}</Badge>,
            },
            { id: 'title', header: 'Title', cell: (row) => row.entry.title },
            {
              id: 'triggerKey',
              header: 'Trigger key',
              cell: (row) => <Box variant="samp">{row.triggerKey}</Box>,
            },
            { id: 'symptom', header: 'Symptom', cell: (row) => <Box color="text-body-secondary">{row.entry.symptom}</Box> },
            {
              id: 'open',
              header: '',
              cell: (row) => (
                <Button variant="inline-link" iconName="status-info" onClick={() => runbook.open(row.entry, `${SOURCE_LABEL[row.source]} — ${row.triggerKey}`)}>
                  View
                </Button>
              ),
            },
          ]}
          empty={<Box textAlign="center">No playbooks match the current filters.</Box>}
        />
      </SpaceBetween>
      <RunbookModal {...runbook.modalProps} />
    </ContentLayout>
  );
}
