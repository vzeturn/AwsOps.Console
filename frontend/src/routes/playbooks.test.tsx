import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

// Same reason `assessment.test.tsx` documents: `createFileRoute` normally needs the generated
// route tree + a real router context, which this unit test does not want to stand up just to
// render the page's own markup/filtering behavior — `PlaybooksPage` is exported directly so this
// mock is enough.
import { vi } from 'vitest';
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>();
  return { ...actual, createFileRoute: () => () => ({ useParams: () => ({}) }) };
});

const { PlaybooksPage } = await import('./playbooks');

describe('PlaybooksPage', () => {
  it('renders every entry from both RUNBOOK_BY_FINDING and RUNBOOK_BY_METRIC, with a total count matching the combined catalog size', async () => {
    const { RUNBOOK_BY_FINDING, RUNBOOK_BY_METRIC } = await import('@ops-dashboard/shared');
    const expectedTotal = Object.keys(RUNBOOK_BY_FINDING).length + Object.keys(RUNBOOK_BY_METRIC).length;

    render(<PlaybooksPage />);

    expect(screen.getByText('Total playbooks')).toBeInTheDocument();
    expect(screen.getByText(String(expectedTotal))).toBeInTheDocument();

    // The table's own counter in the header mirrors the same total when unfiltered.
    expect(screen.getByText(`(${expectedTotal}/${expectedTotal})`)).toBeInTheDocument();
  });

  it('shows the CIS Benchmark KPI count matching exactly the 12 CIS-titled entries', async () => {
    render(<PlaybooksPage />);
    // "CIS Benchmark" also appears once per CIS row's source badge — scope to the KPI label's own
    // tile (its next sibling holds the number) to avoid ambiguity with those badges.
    const cisLabel = screen.getByText('CIS Benchmark', { selector: 'div' });
    const cisTile = cisLabel.parentElement?.parentElement;
    expect(within(cisTile!).getByText('12')).toBeInTheDocument();
  });

  it('a CIS Benchmark entry (e.g. "SecurityGroupChangesCount") is tagged with the "CIS Benchmark" source badge, not "Monitoring metric"', () => {
    render(<PlaybooksPage />);
    const row = screen.getByText('SecurityGroupChangesCount').closest('tr');
    expect(row).not.toBeNull();
    expect(within(row!).getByText('CIS Benchmark')).toBeInTheDocument();
  });

  it('a regular monitoring metric (e.g. "CPUUtilization") is tagged as "Monitoring metric", not "CIS Benchmark"', () => {
    render(<PlaybooksPage />);
    const row = screen.getByText('CPUUtilization').closest('tr');
    expect(row).not.toBeNull();
    expect(within(row!).getByText('Monitoring metric')).toBeInTheDocument();
  });

  it('an assessment finding (e.g. "ec2LowCpu") is tagged as "Assessment finding"', () => {
    render(<PlaybooksPage />);
    const row = screen.getByText('ec2LowCpu').closest('tr');
    expect(row).not.toBeNull();
    expect(within(row!).getByText('Assessment finding')).toBeInTheDocument();
  });

  it('typing in the search filter narrows the table to only matching rows', () => {
    render(<PlaybooksPage />);
    const searchBox = screen.getByPlaceholderText('Search title, symptom, or trigger key');

    fireEvent.change(searchBox, { target: { value: 'RootAccountUsage' } });

    expect(screen.getByText('RootAccountUsageCount')).toBeInTheDocument();
    expect(screen.queryByText('CPUUtilization')).toBeNull();
    expect(screen.getByText('(1/38)')).toBeInTheDocument();
  });

  it('clicking "View" on a row opens the RunbookModal with that entry\'s content', () => {
    render(<PlaybooksPage />);
    const row = screen.getByText('RootAccountUsageCount').closest('tr');
    fireEvent.click(within(row!).getByRole('button', { name: 'View' }));

    // The modal header is the runbook's own title (see RunbookModal.tsx).
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(within(screen.getByRole('dialog')).getByText(/CIS 1\.7.*root account used/i)).toBeInTheDocument();
  });

  it('no results for a nonsense filter -> shows the empty state, not an error', () => {
    render(<PlaybooksPage />);
    fireEvent.change(screen.getByPlaceholderText('Search title, symptom, or trigger key'), {
      target: { value: 'this-matches-absolutely-nothing-xyz' },
    });
    expect(screen.getByText('No playbooks match the current filters.')).toBeInTheDocument();
  });
});
