import type {
  ActionAuditRecord,
  ActionExecutionRequest,
  ActionExecutionResult,
  ActionPreview,
  ApprovalRequest,
  ApprovalStatus,
  AssessmentReport,
  ComplianceData,
  CostData,
  CreateScheduleRequest,
  ExportableTab,
  InfraData,
  LogEventsPage,
  LogEventsQuery,
  LogGroupsResponse,
  Me,
  MonitoringData,
  RunCommandStatus,
  ScheduledActionsResponse,
  SecurityGroupsResponse,
  ThresholdHistoryEntry,
  TopologyData,
} from '@ops-dashboard/shared';
import { appConfig } from '../config';

/**
 * Thrown for any non-2xx response from the router. Carries the raw HTTP status so callers (e.g.
 * `useUnauthorizedRecovery`) can distinguish 401 from every other failure without parsing the
 * message string.
 */
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Router now returns RFC 9457 `application/problem+json` (see backend/src/lib/response.ts::fail)
 * — `detail` is the human-readable message, `type`/`title`/`status`/`instance` are also present
 * but not yet surfaced in the UI. `error` is checked as a fallback for backward compatibility
 * with any response that predates the RFC 9457 change; `message` for anything else.
 */
interface ErrorBody {
  detail?: unknown;
  error?: unknown;
  message?: unknown;
}

async function request<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${appConfig.apiBaseUrl}${path}`, {
    ...init,
    headers: { ...init.headers, authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as ErrorBody;
    const detail = body.detail ?? body.error ?? body.message;
    throw new ApiError(res.status, typeof detail === 'string' && detail.length > 0 ? detail : res.statusText);
  }
  return res.json() as Promise<T>;
}

async function requestVoid(path: string, token: string, init: RequestInit = {}): Promise<void> {
  const res = await fetch(`${appConfig.apiBaseUrl}${path}`, {
    ...init,
    headers: { ...init.headers, authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as ErrorBody;
    const detail = body.detail ?? body.error ?? body.message;
    throw new ApiError(res.status, typeof detail === 'string' && detail.length > 0 ? detail : res.statusText);
  }
}

/**
 * One entry per route declared in `backend/src/router.ts` — kept as a flat object (not a class)
 * matching the previous frontend's convention, so every call site reads `api.<name>(token, ...)`.
 */
export const api = {
  me: (token: string) => request<Me>('/me', token),
  infra: (token: string) => request<InfraData>('/infra', token),
  topology: (token: string) => request<TopologyData>('/topology', token),
  compliance: (token: string) => request<ComplianceData>('/compliance', token),
  cost: (token: string) => request<CostData>('/cost', token),
  assessment: (token: string) => request<AssessmentReport>('/assessment', token),
  monitoring: (token: string) => request<MonitoringData>('/monitoring', token),
  monitoringHistory: (token: string, params: { resourceType: string; resourceId: string; metric: string }) => {
    const qs = new URLSearchParams(params);
    return request<ThresholdHistoryEntry[]>(`/monitoring/history?${qs}`, token);
  },
  logGroups: (token: string) => request<LogGroupsResponse>('/logs/groups', token),
  logEvents: (token: string, query: LogEventsQuery & { nextToken?: string }) => {
    const qs = new URLSearchParams({
      logGroupName: query.logGroupName,
      startTime: String(query.startTime),
      endTime: String(query.endTime),
      ...(query.filterPattern ? { filterPattern: query.filterPattern } : {}),
      ...(query.nextToken ? { nextToken: query.nextToken } : {}),
    });
    return request<LogEventsPage>(`/logs/events?${qs}`, token);
  },
  securityGroups: (token: string) => request<SecurityGroupsResponse>('/security-groups', token),
  // `GET /ec2-instance-types?instanceId=...` (see backend/src/handlers/get-ec2-instance-types.ts) —
  // returns types compatible with the instance's CURRENT architecture/virtualization/AZ, for the
  // Ec2_ChangeInstanceType picker. NOT `currentType` as a query param — the backend re-derives
  // architecture/virtualization/AZ itself from a fresh DescribeInstances call, it does not trust a
  // client-supplied "current type" string.
  ec2InstanceTypes: (token: string, instanceId: string) =>
    request<{ compatibleTypes: string[] }>(`/ec2-instance-types?instanceId=${encodeURIComponent(instanceId)}`, token),
  exportCsv: async (tab: ExportableTab, token: string): Promise<Blob> => {
    const res = await fetch(`${appConfig.apiBaseUrl}/export/${tab}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new ApiError(res.status, res.statusText);
    return res.blob();
  },
  actionsPreview: (token: string, recommendationId: string) =>
    request<ActionPreview>(`/actions/preview?recommendationId=${encodeURIComponent(recommendationId)}`, token),
  /** The "direct" preview variant (`GET /actions/preview?actionType=...&resourceId=...`) — used
   * for every action NOT reached from an Assessment recommendation (lifecycle, Security Group,
   * EC2 management, storage/network/backup 1-click actions triggered directly from a resource
   * table). `params` becomes extra query-string keys (protocol/fromPort/toPort/cidrIp/... for
   * Security Group rules, `presetId` for SSM, `targetInstanceType` for Ec2_ChangeInstanceType). */
  actionsPreviewDirect: (token: string, actionType: string, resourceId: string, params: Record<string, string> = {}) => {
    const qs = new URLSearchParams({ actionType, resourceId, ...params });
    return request<ActionPreview>(`/actions/preview?${qs}`, token);
  },
  actionsExecute: (token: string, body: Omit<ActionExecutionRequest, 'executedBy' | 'correlationId'>) =>
    request<ActionExecutionResult>('/actions/execute', token, { method: 'POST', body: JSON.stringify(body) }),
  actionsLifecycle: (token: string, body: Omit<ActionExecutionRequest, 'executedBy' | 'correlationId'>) =>
    request<ActionExecutionResult>('/actions/lifecycle', token, { method: 'POST', body: JSON.stringify(body) }),
  actionsSecurityGroup: (token: string, body: Omit<ActionExecutionRequest, 'executedBy' | 'correlationId'>) =>
    request<ActionExecutionResult>('/actions/security-group', token, { method: 'POST', body: JSON.stringify(body) }),
  actionsEc2Management: (token: string, body: Omit<ActionExecutionRequest, 'executedBy' | 'correlationId'>) =>
    request<ActionExecutionResult>('/actions/ec2-management', token, { method: 'POST', body: JSON.stringify(body) }),
  /**
   * `Ec2_UpdateTags` — a SEPARATE method rather than reusing `actionsEc2Management` because its wire
   * shape genuinely differs: `actions-ec2-management.ts` expects `params.set`/`params.remove` to be
   * REAL JSON values (an object and an array) that IT stringifies into the payload forwarded to
   * action-execution-fn — sending pre-stringified strings here would make the router double-encode
   * them. `ActionExecutionRequest.params` is typed `Record<string, string | number>` specifically
   * because every OTHER action's params are flat; this one call site is the deliberate exception.
   */
  actionsUpdateTags: (
    token: string,
    body: { resourceId: string; region: string; set: Record<string, string>; remove: string[] },
  ) =>
    request<ActionExecutionResult>('/actions/ec2-management', token, {
      method: 'POST',
      body: JSON.stringify({
        actionType: 'Ec2_UpdateTags',
        resourceId: body.resourceId,
        region: body.region,
        params: { set: body.set, remove: body.remove },
      }),
    }),
  actionsRunCommand: (token: string, body: Omit<ActionExecutionRequest, 'executedBy' | 'correlationId'>) =>
    request<ActionExecutionResult>('/actions/run-command', token, { method: 'POST', body: JSON.stringify(body) }),
  runCommandStatus: (token: string, commandId: string) =>
    request<RunCommandStatus>(`/actions/run-command/${encodeURIComponent(commandId)}/status`, token),
  actionsAudit: (token: string, resourceType: string, resourceId: string) =>
    request<ActionAuditRecord[]>(
      `/actions/audit?resourceType=${encodeURIComponent(resourceType)}&resourceId=${encodeURIComponent(resourceId)}`,
      token,
    ),
  scheduledActions: (token: string) => request<ScheduledActionsResponse>('/scheduled-actions', token),
  createSchedule: (token: string, body: CreateScheduleRequest) =>
    request<{ ok: boolean; scheduleName: string }>('/scheduled-actions', token, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  deleteSchedule: (token: string, name: string) =>
    requestVoid(`/scheduled-actions/${encodeURIComponent(name)}/delete`, token, { method: 'POST' }),
  // Maker-checker Approval workflow (see shared/src/approval.ts) — 4 routes mirroring
  // backend/src/router.ts exactly: request (anyone signed in), list (read-only, the Approvals
  // queue page), decide (operator-only, maker != checker enforced server-side), execute
  // (requester OR approver only, once approved).
  approvalsList: (token: string, status?: ApprovalStatus) =>
    request<ApprovalRequest[]>(`/actions/approvals${status ? `?status=${encodeURIComponent(status)}` : ''}`, token),
  approvalsRequest: (
    token: string,
    body: { actionType: string; resourceId: string; region?: string; params?: Record<string, string | number>; requestedReason: string },
  ) => request<ApprovalRequest>('/actions/request-approval', token, { method: 'POST', body: JSON.stringify(body) }),
  approvalsDecide: (token: string, body: { id: string; decision: 'approved' | 'rejected'; decisionReason?: string }) =>
    request<ApprovalRequest>('/actions/decide-approval', token, { method: 'POST', body: JSON.stringify(body) }),
  approvalsExecute: (token: string, id: string) =>
    request<ActionExecutionResult>('/actions/execute-approval', token, { method: 'POST', body: JSON.stringify({ id }) }),
};
