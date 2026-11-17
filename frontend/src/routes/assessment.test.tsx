import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AssessmentReport } from '@ops-dashboard/shared';

window.__APP_CONFIG__ = {
  entraAuthority: 'https://login.microsoftonline.com/tenant/v2.0',
  entraClientId: 'client-id',
  apiBaseUrl: 'https://router.example.com',
  redirectUri: 'https://app.example.com',
  scope: 'openid profile email offline_access',
};

// `createFileRoute('/assessment')({ component: AssessmentPage })` normally registers the route
// with the file-based tree generated at build time (`routeTree.gen.ts`), and the `tanstackRouter`
// Vite plugin (autoCodeSplitting: true) rewrites that call into a `React.lazy`-style loader that
// needs a real Suspense/router context — neither of which this unit test wants to stand up just
// to exercise data-fetching/action-dialog wiring. `assessment.tsx` exports `AssessmentPage`
// directly (see its own doc comment) specifically so this test can import and render it plainly.
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>();
  return { ...actual, createFileRoute: () => () => ({ useParams: () => ({}) }) };
});

vi.mock('react-oidc-context', () => ({
  useAuth: () => ({ user: { id_token: 'test-token' } }),
}));

const { AssessmentPage } = await import('./assessment');

const fetchMock = vi.fn();

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

function makeReport(overrides: Partial<AssessmentReport> = {}): AssessmentReport {
  return {
    account: '123456789012',
    region: 'ap-southeast-1',
    periodStart: '2026-08-01',
    periodEnd: '2026-08-31',
    generatedAt: '2026-09-01T00:00:00.000Z',
    compute: { lambda: [] },
    database: {},
    networking: { natGateways: [] },
    storage: { s3Buckets: [], ebsVolumes: [] },
    savingsPlans: { coverageByService: [] },
    backup: { protectionGaps: [] },
    recommendations: [],
    ...overrides,
  };
}

function renderAssessmentPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AssessmentPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);
});

describe('AssessmentPage — recommendation execution flow', () => {
  it('shows "Manual only" (no button) for a finding with no matching Action_Catalog entry', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        makeReport({
          recommendations: [
            {
              id: 'rec-1',
              category: 'compute',
              resourceType: 'ec2-instance',
              resourceId: 'i-abc',
              resourceName: 'web-1',
              currentState: 'CPU 40% avg',
              recommendedAction: 'Investigate for underprovisioning',
              estimatedMonthlySavingsUsd: null,
              risk: 'low',
              priority: 'low',
              findingType: 'ec2Underprovisioned',
            },
          ],
        }),
      ),
    );

    renderAssessmentPage();

    await waitFor(() => expect(screen.getByText('web-1')).toBeInTheDocument());
    expect(screen.getByText('Manual only')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Execute' })).toBeNull();
  });

  it('shows an "Execute" button for a finding with a matching Action_Catalog entry, opens the preview, and executes on confirm', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        makeReport({
          recommendations: [
            {
              id: 'rec-2',
              category: 'storage',
              resourceType: 'ebs-volume',
              resourceId: 'vol-abc',
              resourceName: 'vol-abc',
              currentState: 'Unattached for 30+ days',
              recommendedAction: 'Snapshot and delete the unattached volume',
              estimatedMonthlySavingsUsd: 4.5,
              risk: 'low',
              priority: 'medium',
              findingType: 'ebsVolumeUnattached',
            },
          ],
        }),
      ),
    );

    renderAssessmentPage();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Execute' })).toBeInTheDocument());

    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        actionType: 'Snapshot_And_Delete_EBS_Volume',
        awsApiCall: 'ec2:CreateSnapshot + ec2:DeleteVolume',
        resource: { id: 'vol-abc', arn: 'arn:aws:ec2:ap-southeast-1:123456789012:volume/vol-abc', region: 'ap-southeast-1' },
        params: { volumeId: 'vol-abc' },
        reversibilityClass: 'irreversible',
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Execute' }));

    await waitFor(() => expect(screen.getByText('ec2:CreateSnapshot + ec2:DeleteVolume')).toBeInTheDocument());
    // Irreversible — Confirm must stay disabled until the resource id is typed exactly.
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeDisabled();

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'vol-abc' } });
    expect(screen.getByRole('button', { name: 'Confirm' })).not.toBeDisabled();

    fetchMock.mockResolvedValueOnce(jsonResponse({ outcome: 'success', createdSnapshotId: 'snap-xyz' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() => expect(screen.getByText('Outcome: success')).toBeInTheDocument());

    // Verify the actual execute request went to the general-gate endpoint with the preview's own
    // resource id/region/params (never re-derived client-side).
    const executeCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/actions/execute'));
    expect(executeCall).toBeDefined();
    const body = JSON.parse((executeCall![1] as RequestInit).body as string);
    expect(body).toMatchObject({
      actionType: 'Snapshot_And_Delete_EBS_Volume',
      resourceId: 'vol-abc',
      region: 'ap-southeast-1',
      params: { volumeId: 'vol-abc' },
    });
  });
});
