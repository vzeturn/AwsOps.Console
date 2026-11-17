import { useEffect, useMemo, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Header from '@cloudscape-design/components/header';
import Table from '@cloudscape-design/components/table';
import Badge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Alert from '@cloudscape-design/components/alert';
import type { RecommendationItem, RecommendationPriority } from '@ops-dashboard/shared';
import { matchActionCatalogForFinding, getRunbookForFinding } from '@ops-dashboard/shared';
import { useAssessment } from '../hooks/useApi';
import { useRecommendationActionDialog } from '../hooks/useRecommendationActionDialog';
import { useRunbookModal } from '../hooks/useRunbookModal';
import { ConfirmationDialog } from '../components/ConfirmationDialog';
import { RunbookModal } from '../components/RunbookModal';
import { KpiTile, KpiTileRow } from '../components/KpiTile';

export const Route = createFileRoute('/assessment')({
  component: AssessmentPage,
});

const PRIORITY_COLOR: Record<RecommendationPriority, 'severity-high' | 'severity-medium' | 'severity-low'> = {
  high: 'severity-high',
  medium: 'severity-medium',
  low: 'severity-low',
};

/** Total potential savings + counts by priority — the "how much is on the table, and how urgent
 * is it" summary that used to require scanning the whole recommendations table to compute by eye. */
function useAssessmentSummary(items: RecommendationItem[]) {
  return useMemo(() => {
    let totalSavingsUsd = 0;
    let high = 0;
    let medium = 0;
    let low = 0;
    for (const item of items) {
      if (item.estimatedMonthlySavingsUsd != null) totalSavingsUsd += item.estimatedMonthlySavingsUsd;
      if (item.priority === 'high') high += 1;
      else if (item.priority === 'medium') medium += 1;
      else low += 1;
    }
    return { totalSavingsUsd, high, medium, low, total: items.length };
  }, [items]);
}

/** Exported directly (not just via `Route.component`) so tests can render it without going
 * through the `tanstackRouter` Vite plugin's `autoCodeSplitting` transform, which rewrites
 * `Route.component` into a `React.lazy`-style loader requiring a real Suspense/router context. */
export function AssessmentPage() {
  const assessment = useAssessment();
  // `RecommendationItem.executed` is a client-side-only, optimistic supplementary field (see its
  // doc comment in shared/src/index.ts) — the collector never sets it. Tracked here per session so
  // a just-executed row visibly updates without waiting for tomorrow's infra-review-collector run.
  const [executedIds, setExecutedIds] = useState<Set<string>>(new Set());
  const items = (assessment.data?.recommendations ?? []).map((item) =>
    executedIds.has(item.id) ? { ...item, executed: true } : item,
  );
  const { open, dialogProps, lastExecutedId } = useRecommendationActionDialog();
  const runbook = useRunbookModal();
  const summary = useAssessmentSummary(items);

  useEffect(() => {
    if (lastExecutedId) setExecutedIds((prev) => new Set(prev).add(lastExecutedId));
  }, [lastExecutedId]);

  return (
    <ContentLayout header={<Header variant="h1">Assessment</Header>}>
      <SpaceBetween size="l">
        {assessment.isError && (
          <Alert type="error" header="Failed to load assessment data">
            {(assessment.error as Error).message}
          </Alert>
        )}
        {!assessment.isLoading && assessment.data && (
          <Container disableContentPaddings>
            <Box padding="l">
              <KpiTileRow>
                <KpiTile
                  label="Potential monthly savings"
                  value={`$${summary.totalSavingsUsd.toFixed(2)}`}
                  severity={summary.totalSavingsUsd > 0 ? 'warning' : 'ok'}
                />
                <KpiTile label="High priority" value={String(summary.high)} severity={summary.high > 0 ? 'critical' : 'ok'} />
                <KpiTile label="Medium priority" value={String(summary.medium)} />
                <KpiTile label="Low priority" value={String(summary.low)} />
                <KpiTile label="Total recommendations" value={String(summary.total)} />
              </KpiTileRow>
            </Box>
          </Container>
        )}
        <Table<RecommendationItem>
          variant="container"
          loading={assessment.isLoading}
          items={items}
          trackBy="id"
          header={<Header counter={`(${items.length})`}>Recommendations</Header>}
          columnDefinitions={[
            {
              id: 'priority',
              header: 'Priority',
              width: 110,
              cell: (item) => <Badge color={PRIORITY_COLOR[item.priority]}>{item.priority}</Badge>,
            },
            { id: 'resource', header: 'Resource', cell: (item) => <Box variant="samp">{item.resourceName}</Box> },
            { id: 'category', header: 'Category', cell: (item) => item.category },
            { id: 'currentState', header: 'Current state', cell: (item) => item.currentState },
            { id: 'recommendedAction', header: 'Recommended action', cell: (item) => item.recommendedAction },
            {
              id: 'savings',
              header: 'Est. monthly savings',
              cell: (item) =>
                item.estimatedMonthlySavingsUsd != null
                  ? `$${item.estimatedMonthlySavingsUsd.toFixed(2)}`
                  : '—',
            },
            {
              id: 'runbook',
              header: '',
              // Every RecommendationFindingType has a runbook (RUNBOOK_BY_FINDING is a Record over
              // the full union — see shared/src/runbookCatalog.ts), so this button always shows,
              // unlike the Execute/Manual-only column which depends on whether automation exists.
              cell: (item) => (
                <Button
                  variant="inline-link"
                  iconName="status-info"
                  onClick={() => runbook.open(getRunbookForFinding(item.findingType), `${item.resourceName} — ${item.category}`)}
                >
                  Runbook
                </Button>
              ),
            },
            {
              id: 'actions',
              header: '',
              // A finding with no matching Action_Catalog entry (matchActionCatalogForFinding
              // returns undefined) is manual-only BY DESIGN (shared/src/action-catalog.ts) — no
              // button is shown rather than a button that would always 400.
              cell: (item) =>
                matchActionCatalogForFinding(item.findingType) ? (
                  <Button
                    variant="inline-link"
                    disabled={item.executed}
                    onClick={() => open(item.id, `${item.recommendedAction} — ${item.resourceName}`)}
                  >
                    {item.executed ? 'Executed' : 'Execute'}
                  </Button>
                ) : (
                  <Box color="text-body-secondary" fontSize="body-s">
                    Manual only
                  </Box>
                ),
            },
          ]}
          empty={<Box textAlign="center">No recommendations — the account looks clean.</Box>}
        />
      </SpaceBetween>
      <ConfirmationDialog {...dialogProps} />
      <RunbookModal {...runbook.modalProps} />
    </ContentLayout>
  );
}
