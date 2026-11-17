import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from 'react-oidc-context';
import type { ActionExecutionRequest, ApprovalStatus, CreateScheduleRequest } from '@ops-dashboard/shared';
import { api } from '../api/client';

/**
 * Every hook below follows the same shape: read the current token from `react-oidc-context`,
 * pass it to the matching `api.*` call, key the query by a short readable string. Kept as thin,
 * one-line wrappers (no shared factory) so each hook's TanStack Query options — staleTime overrides,
 * `enabled` guards — stay visible at the call site instead of hidden behind an abstraction.
 *
 * Sends the ID token, NOT the access token — this was already tried and reverted once
 * (commit 1543fe9, reverted in 9598b38) after it broke every request in production. Re-reading
 * this comment before "fixing" it again by switching back to `access_token`:
 *
 * The OIDC scope configured in `infra/static-server/index.ts::configJs()` is
 * `openid profile email offline_access` — deliberately WITHOUT `api://<clientId>/access_as_user`.
 * Combining that API scope into the same signin request asks Entra ID for tokens for TWO
 * different resources in one call; the Microsoft identity platform only issues an access token
 * for ONE resource and silently picks Microsoft Graph, dropping the API scope. The resulting
 * access token has `aud = 00000003-0000-0000-c000-000000000000` (Graph) and `iss` in the v1
 * format — the backend's JWKS can never verify it (`ERR_JWS_SIGNATURE_VERIFICATION_FAILED`),
 * permanently, not intermittently.
 *
 * The ID token's `aud` claim is the app's own `clientId`, which is exactly what
 * `backend/src/lib/auth.ts::verifyEntraToken`'s `audience` allowlist expects
 * (`[clientId, api://clientId]`). Switching to a real, separately-requested access token for
 * the API resource is possible (see `infra/entra-expose-api.json` and the revert commit's notes)
 * but requires a SEPARATE token request (e.g. a second `UserManager`/`signinSilent({ scope })`
 * call) that has been verified against a real browser session — not just swapping this field.
 */
function useToken(): string {
  const auth = useAuth();
  return auth.user?.id_token ?? '';
}

export function useMe() {
  const token = useToken();
  return useQuery({
    queryKey: ['me'],
    queryFn: () => api.me(token),
    enabled: token.length > 0,
    staleTime: Infinity,
  });
}

export function useInfra() {
  const token = useToken();
  return useQuery({
    queryKey: ['infra'],
    queryFn: () => api.infra(token),
    enabled: token.length > 0,
    refetchInterval: 5 * 60_000,
  });
}

export function useTopology() {
  const token = useToken();
  return useQuery({
    queryKey: ['topology'],
    queryFn: () => api.topology(token),
    enabled: token.length > 0,
    refetchInterval: 5 * 60_000,
  });
}

export function useCompliance() {
  const token = useToken();
  return useQuery({
    queryKey: ['compliance'],
    queryFn: () => api.compliance(token),
    enabled: token.length > 0,
    refetchInterval: 5 * 60_000,
  });
}

export function useCost() {
  const token = useToken();
  return useQuery({
    queryKey: ['cost'],
    queryFn: () => api.cost(token),
    enabled: token.length > 0,
  });
}

export function useAssessment() {
  const token = useToken();
  return useQuery({
    queryKey: ['assessment'],
    queryFn: () => api.assessment(token),
    enabled: token.length > 0,
  });
}

export function useMonitoring() {
  const token = useToken();
  return useQuery({
    queryKey: ['monitoring'],
    queryFn: () => api.monitoring(token),
    enabled: token.length > 0,
    refetchInterval: 60_000,
  });
}

export function useSecurityGroups() {
  const token = useToken();
  return useQuery({
    queryKey: ['security-groups'],
    queryFn: () => api.securityGroups(token),
    enabled: token.length > 0,
  });
}

export function useScheduledActions() {
  const token = useToken();
  return useQuery({
    queryKey: ['scheduled-actions'],
    queryFn: () => api.scheduledActions(token),
    enabled: token.length > 0,
  });
}

export function useMonitoringHistory(params: { resourceType: string; resourceId: string; metric: string } | undefined) {
  const token = useToken();
  return useQuery({
    queryKey: ['monitoring-history', params?.resourceType, params?.resourceId, params?.metric],
    queryFn: () => api.monitoringHistory(token, params as { resourceType: string; resourceId: string; metric: string }),
    enabled: token.length > 0 && Boolean(params),
  });
}

export function useActionsAudit(resourceType: string | undefined, resourceId: string | undefined) {
  const token = useToken();
  return useQuery({
    queryKey: ['actions-audit', resourceType, resourceId],
    queryFn: () => api.actionsAudit(token, resourceType as string, resourceId as string),
    enabled: token.length > 0 && Boolean(resourceType) && Boolean(resourceId),
  });
}

/** `GET /actions/preview?recommendationId=...` — the Assessment-driven preview. */
export function useActionPreview(recommendationId: string | undefined) {
  const token = useToken();
  return useQuery({
    queryKey: ['action-preview', 'recommendation', recommendationId],
    queryFn: () => api.actionsPreview(token, recommendationId as string),
    enabled: token.length > 0 && Boolean(recommendationId),
    // Preview re-reads LIVE AWS state (see preview-service.ts) — never cache across opens, a
    // stale preview showing "safe to delete" for a volume that got attached seconds ago is exactly
    // the kind of staleness a Confirmation_Dialog must never show.
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
}

/** `GET /actions/preview?actionType=...&resourceId=...` — the "direct" preview variant, used by
 * every action reached from a resource table rather than an Assessment recommendation. Exposed as
 * a mutation (not a query) because it's fetched imperatively right when a Confirmation_Dialog
 * opens, with parameters that change per dialog instance (SG rule fields, target instance type,
 * tag edits...) — a `useQuery` keyed on all of that would thrash the cache for no benefit, since
 * this data is single-use and never stale-refetched. */
export function useActionPreviewDirect() {
  const { token } = useApiToken();
  return useMutation({
    mutationFn: ({ actionType, resourceId, params }: { actionType: string; resourceId: string; params?: Record<string, string> }) =>
      api.actionsPreviewDirect(token, actionType, resourceId, params),
  });
}

/** `POST /actions/execute` — the general-gate endpoint covering every `ActionType` NOT in one of
 * the 4 operator-only families (lifecycle/security-group/ec2-management/run-command). Invalidates
 * broadly on success: an action here can touch EC2/RDS/EBS/S3/CloudWatch/Backup state that several
 * pages read from (`/infra`, `/monitoring`, `/assessment`, `/compliance`), and each is cheap to
 * refetch compared to the cost of showing stale state after a real infrastructure change. */
export function useActionExecute() {
  const { token, invalidateAll } = useApiToken();
  return useMutation({
    mutationFn: (body: ExecuteBody) => api.actionsExecute(token, body),
    onSuccess: () => invalidateAll(),
  });
}

/** `POST /actions/lifecycle` — EC2_Reboot / RDS_Start / RDS_Stop / RDS_Reboot. Operator-gated. */
export function useActionLifecycle() {
  const { token, invalidateAll } = useApiToken();
  return useMutation({
    mutationFn: (body: ExecuteBody) => api.actionsLifecycle(token, body),
    onSuccess: () => invalidateAll(),
  });
}

/** `POST /actions/ec2-management` — Ec2_ChangeInstanceType. Operator-gated. (`Ec2_UpdateTags` uses
 * `useActionUpdateTags` below — same endpoint, different wire shape, see `api.actionsUpdateTags`.) */
export function useActionEc2Management() {
  const { token, invalidateAll } = useApiToken();
  return useMutation({
    mutationFn: (body: ExecuteBody) => api.actionsEc2Management(token, body),
    onSuccess: () => invalidateAll(),
  });
}

/** `Ec2_UpdateTags` via `POST /actions/ec2-management` — separate from `useActionEc2Management`
 * because the request body shape genuinely differs (see `api.actionsUpdateTags`'s doc comment). */
export function useActionUpdateTags() {
  const { token, invalidateAll } = useApiToken();
  return useMutation({
    mutationFn: (body: { resourceId: string; region: string; set: Record<string, string>; remove: string[] }) =>
      api.actionsUpdateTags(token, body),
    onSuccess: () => invalidateAll(),
  });
}

/** Compatible EC2 instance types for `Ec2_ChangeInstanceType`'s picker (`GET
 * /ec2-instance-types?instanceId=...`) — only fetched once the target instance is known, and only
 * while the picker is actually open (`enabled`), since it costs a live `DescribeInstanceTypes` scan. */
export function useEc2InstanceTypes(instanceId: string | undefined) {
  const token = useToken();
  return useQuery({
    queryKey: ['ec2-instance-types', instanceId],
    queryFn: () => api.ec2InstanceTypes(token, instanceId as string),
    enabled: token.length > 0 && Boolean(instanceId),
    staleTime: 5 * 60_000,
  });
}

/** `GET /export/{tab}` — triggers a browser download of the returned CSV Blob. Not a `useQuery`:
 * downloading a file is a one-shot side effect (create an object URL, click a synthetic anchor,
 * revoke the URL), not cacheable state a component re-renders from. */
export function useExportCsv() {
  const { token } = useApiToken();
  return useMutation({
    mutationFn: async (tab: 'infra' | 'compliance' | 'cost') => {
      const blob = await api.exportCsv(tab, token);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${tab}-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(url);
    },
  });
}

export function useLogGroups() {
  const token = useToken();
  return useQuery({
    queryKey: ['log-groups'],
    queryFn: () => api.logGroups(token),
    enabled: token.length > 0,
  });
}

/** Exposes the token + a query-invalidation helper for mutation-style call sites (action execute
 * handlers) that don't fit the read-only `useQuery` shape above. */
export function useApiToken(): { token: string; invalidateAll: () => void } {
  const token = useToken();
  const queryClient = useQueryClient();
  return { token, invalidateAll: () => void queryClient.invalidateQueries() };
}

type ExecuteBody = Omit<ActionExecutionRequest, 'executedBy' | 'correlationId'>;

/** `POST /actions/security-group` — invalidates the `security-groups` query on success so the
 * rule table reflects the change immediately, instead of waiting for the next 5-minute refetch. */
export function useSecurityGroupAction() {
  const { token } = useApiToken();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: ExecuteBody) => api.actionsSecurityGroup(token, body),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['security-groups'] }),
  });
}

/** `POST /actions/run-command` — one preset, one instance. Does NOT invalidate anything: the
 * result is a `commandId` to poll via `useRunCommandStatus`, not a change to cached resource data. */
export function useRunCommandAction() {
  const { token } = useApiToken();
  return useMutation({ mutationFn: (body: ExecuteBody) => api.actionsRunCommand(token, body) });
}

/** `GET /actions/run-command/{commandId}/status` — polled at a fixed interval until the backend's
 * own `isTerminal` flag says so (never enumerated client-side, see `RunCommandStatus` doc comment). */
export function useRunCommandStatus(commandId: string | undefined) {
  const token = useToken();
  return useQuery({
    queryKey: ['run-command-status', commandId],
    queryFn: () => api.runCommandStatus(token, commandId as string),
    enabled: token.length > 0 && Boolean(commandId),
    refetchInterval: (query) => (query.state.data?.isTerminal ? false : 3_000),
  });
}

/** `POST /scheduled-actions` — invalidates the list on success. */
export function useCreateSchedule() {
  const { token } = useApiToken();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateScheduleRequest) => api.createSchedule(token, body),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['scheduled-actions'] }),
  });
}

/** `POST /scheduled-actions/{name}/delete` — invalidates the list on success. */
export function useDeleteSchedule() {
  const { token } = useApiToken();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.deleteSchedule(token, name),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['scheduled-actions'] }),
  });
}

/** `GET /actions/approvals` — the maker-checker Approvals queue (see shared/src/approval.ts).
 * `status` undefined returns every request regardless of status (used by the history view);
 * `'pending'` is what the queue badge/count and the main queue table filter to. Short poll
 * interval (not a one-shot query) since a SECOND person deciding on this same request is exactly
 * the kind of change this page exists to surface promptly, without a manual refresh. */
export function useApprovals(status?: ApprovalStatus) {
  const token = useToken();
  return useQuery({
    queryKey: ['approvals', status ?? 'all'],
    queryFn: () => api.approvalsList(token, status),
    enabled: token.length > 0,
    refetchInterval: 30_000,
  });
}

/** `POST /actions/request-approval` — invalidates every `approvals` query on success (regardless
 * of status filter) so the queue/history views pick up the new `pending` request immediately. */
export function useRequestApproval() {
  const { token } = useApiToken();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { actionType: string; resourceId: string; region?: string; params?: Record<string, string | number>; requestedReason: string }) =>
      api.approvalsRequest(token, body),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['approvals'] }),
  });
}

/** `POST /actions/decide-approval` — operator-only (server-enforced via `isOperatorMember`, see
 * `actions-decide-approval.ts`); the frontend additionally hides the Decide buttons for a
 * non-operator via `Me.isOperator` (`useMe()`), but the real gate is server-side. */
export function useDecideApproval() {
  const { token } = useApiToken();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { id: string; decision: 'approved' | 'rejected'; decisionReason?: string }) => api.approvalsDecide(token, body),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['approvals'] }),
  });
}

/** `POST /actions/execute-approval` — invalidates broadly (same as `useActionExecute`) since the
 * underlying action can touch state several other pages read from, PLUS the `approvals` queries
 * so the executed request moves out of the pending queue immediately. */
export function useExecuteApproval() {
  const { token, invalidateAll } = useApiToken();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.approvalsExecute(token, id),
    onSuccess: () => {
      invalidateAll();
      void queryClient.invalidateQueries({ queryKey: ['approvals'] });
    },
  });
}

/** `GET /logs/events` — a single page fetch (not `useInfiniteQuery`): the logs page manages its
 * own accumulated event list explicitly, because a fresh time-range/filter selection must RESET
 * the list rather than append to it, which `useInfiniteQuery`'s cache key model makes awkward. */
export function useLogEvents() {
  const { token } = useApiToken();
  return useMutation({
    mutationFn: (query: Parameters<typeof api.logEvents>[1]) => api.logEvents(token, query),
  });
}
