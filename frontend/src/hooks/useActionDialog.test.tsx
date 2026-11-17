import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useMutation } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { ActionExecutionRequest, ActionExecutionResult } from '@ops-dashboard/shared';

type ExecuteBody = Omit<ActionExecutionRequest, 'executedBy' | 'correlationId'>;

window.__APP_CONFIG__ = {
  entraAuthority: 'https://login.microsoftonline.com/tenant/v2.0',
  entraClientId: 'client-id',
  apiBaseUrl: 'https://router.example.com',
  redirectUri: 'https://app.example.com',
  scope: 'openid profile email offline_access',
};

const previewDirectMock = vi.fn();
vi.mock('../api/client', () => ({
  api: {
    actionsPreviewDirect: (...args: unknown[]) => previewDirectMock(...args),
  },
  ApiError: class ApiError extends Error {},
}));

// `useActionPreviewDirect`/`useApiToken` (useApi.ts) both call `useToken()`, which reads
// `react-oidc-context`'s `useAuth().user.id_token` — stubbed here since this test exercises
// `useActionDialog`'s own open/close/confirm wiring, not the auth flow.
vi.mock('react-oidc-context', () => ({
  useAuth: () => ({ user: { id_token: 'test-token' } }),
}));

const { useActionDialog } = await import('./useActionDialog');

function makeWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

/** A stand-in for a real `useActionExecute`/`useActionLifecycle` mutation — `useActionDialog`
 * only needs the `UseMutationResult` shape, not a specific endpoint, so a fake mutationFn the test
 * controls directly is enough to exercise the hook's own logic (open/close/confirm wiring) without
 * depending on `useApi.ts`'s token/invalidation plumbing. Typed against `ActionExecutionResult`/
 * `ExecuteBody` to match exactly what `useActionDialog` expects from a real execute mutation. */
function useFakeExecute(mutationFn: (body: ExecuteBody) => Promise<ActionExecutionResult>) {
  return useMutation({ mutationFn });
}

describe('useActionDialog', () => {
  beforeEach(() => {
    previewDirectMock.mockReset();
  });

  it('open() triggers the direct preview fetch with the given actionType/resourceId/params', async () => {
    previewDirectMock.mockResolvedValue({
      actionType: 'EC2_Stop',
      awsApiCall: 'StateManager: POST /instances/{region}/{id}/stop',
      resource: { id: 'i-abc', arn: 'arn:aws:ec2:ap-southeast-1:1:instance/i-abc', region: 'ap-southeast-1' },
      params: {},
      reversibilityClass: 'reversible',
    });

    const execute = vi.fn<(body: ExecuteBody) => Promise<ActionExecutionResult>>().mockResolvedValue({ outcome: 'success' });
    const { result } = renderHook(
      () => {
        const executeMutation = useFakeExecute(execute);
        return useActionDialog(executeMutation);
      },
      { wrapper: makeWrapper() },
    );

    act(() => {
      result.current.open({ actionType: 'EC2_Stop', resourceId: 'i-abc', region: 'ap-southeast-1', title: 'Stop i-abc' });
    });

    expect(result.current.dialogProps.visible).toBe(true);
    expect(result.current.dialogProps.title).toBe('Stop i-abc');
    await waitFor(() => expect(result.current.dialogProps.preview?.resource.id).toBe('i-abc'));
    // `api.actionsPreviewDirect(token, actionType, resourceId, params)` — token is the mocked
    // access token from `react-oidc-context`.
    expect(previewDirectMock).toHaveBeenCalledWith('test-token', 'EC2_Stop', 'i-abc', {});
  });

  it('confirm (via dialogProps.onConfirm) calls the execute mutation with the pending action', async () => {
    previewDirectMock.mockResolvedValue({
      actionType: 'EC2_Stop',
      awsApiCall: 'x',
      resource: { id: 'i-abc', arn: 'arn', region: 'ap-southeast-1' },
      params: {},
      reversibilityClass: 'reversible',
    });
    const execute = vi.fn<(body: ExecuteBody) => Promise<ActionExecutionResult>>().mockResolvedValue({ outcome: 'success' });

    const { result } = renderHook(
      () => {
        const executeMutation = useFakeExecute(execute);
        return useActionDialog(executeMutation);
      },
      { wrapper: makeWrapper() },
    );

    act(() => {
      result.current.open({ actionType: 'EC2_Stop', resourceId: 'i-abc', region: 'ap-southeast-1', title: 'Stop i-abc' });
    });
    await waitFor(() => expect(result.current.dialogProps.preview).toBeDefined());

    act(() => {
      result.current.dialogProps.onConfirm();
    });

    // TanStack Query's mutationFn is called with a second "context" argument (the mutation's own
    // metadata) — only the first argument (the actual request body) matters here.
    await waitFor(() =>
      expect(execute.mock.calls[0]?.[0]).toEqual({
        actionType: 'EC2_Stop',
        resourceId: 'i-abc',
        region: 'ap-southeast-1',
        params: {},
      }),
    );
  });

  it('close() resets pending/preview/execute state so the dialog reports not visible', async () => {
    previewDirectMock.mockResolvedValue({
      actionType: 'EC2_Stop',
      awsApiCall: 'x',
      resource: { id: 'i-abc', arn: 'arn', region: 'ap-southeast-1' },
      params: {},
      reversibilityClass: 'reversible',
    });
    const execute = vi.fn<(body: ExecuteBody) => Promise<ActionExecutionResult>>().mockResolvedValue({ outcome: 'success' });

    const { result } = renderHook(
      () => {
        const executeMutation = useFakeExecute(execute);
        return useActionDialog(executeMutation);
      },
      { wrapper: makeWrapper() },
    );

    act(() => {
      result.current.open({ actionType: 'EC2_Stop', resourceId: 'i-abc', region: 'ap-southeast-1', title: 'Stop i-abc' });
    });
    await waitFor(() => expect(result.current.dialogProps.visible).toBe(true));

    act(() => {
      result.current.close();
    });

    expect(result.current.dialogProps.visible).toBe(false);
  });

  it('exposes the preview error message when the direct preview call rejects', async () => {
    previewDirectMock.mockRejectedValue(new Error('Instance not found'));
    const execute = vi.fn<(body: ExecuteBody) => Promise<ActionExecutionResult>>();

    const { result } = renderHook(
      () => {
        const executeMutation = useFakeExecute(execute);
        return useActionDialog(executeMutation);
      },
      { wrapper: makeWrapper() },
    );

    act(() => {
      result.current.open({ actionType: 'EC2_Stop', resourceId: 'i-missing', title: 'Stop i-missing' });
    });

    await waitFor(() => expect(result.current.dialogProps.previewError).toBe('Instance not found'));
  });
});
