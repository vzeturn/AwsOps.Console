import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LambdaFunctionURLEvent } from 'aws-lambda';

// Task 9.6: unit test for the GET /assessment route (and 404 fallback) in router.ts
//
// Mock config.js to avoid `readRequiredEnv` throwing (missing required environment variable) —
// router.ts statically imports ALL handlers (me/infra/compliance/cost/assessment/export-csv), and
// those handlers import services that create AWS SDK clients right at module scope (reading
// `config.awsRegion` etc.), so the `config.js` module must have valid values before `./router.js`
// is imported below.
vi.mock('../../config.js', () => ({
  config: {
    allowedOrigins: [],
    entraTenantId: 'test-tenant',
    entraClientId: 'test-client',
    allowedGroupIds: [],
    awsRegion: 'ap-southeast-1',
    costCacheParamName: 'test-cost-cache-param',
    assessmentBucketName: 'test-assessment-bucket',
    scheduledActionsMutateFunctionName: 'test-scheduled-actions-mutate-fn',
    approvalMutateFunctionName: 'test-approval-mutate-fn',
  },
  corsHeaders: () => ({}),
}));

// approval-service.ts (imported transitively via handlers/get-approvals.js) reads
// ASSESSMENT_BUCKET_NAME DIRECTLY from process.env, bypassing config.js entirely (same
// independent pattern as threshold-history-service.ts) — so mocking config.js above does NOT
// satisfy it; it needs the real env var set.
process.env.ASSESSMENT_BUCKET_NAME = 'test-assessment-bucket';

// Bypass the real Entra ID JWT verification — the router only needs a fake claims object to continue routing.
const verifyEntraTokenMock = vi.fn().mockResolvedValue({ sub: 'user-123', name: 'Test User' });
vi.mock('./auth.js', () => ({
  verifyEntraToken: verifyEntraTokenMock,
}));

// Mock handlers/get-assessment.js separately (the layer above assessment-service.js) — the
// /assessment route just needs to confirm the router calls this handler and returns the right
// response, no need to retest the S3 read logic (already covered in assessment-service.test.ts, Task 9.3).
const ASSESSMENT_RESPONSE = {
  statusCode: 200,
  headers: { 'content-type': 'application/json; charset=utf-8' },
  body: JSON.stringify({ account: 'fake-account', recommendations: [] }),
};
const assessmentHandlerMock = vi.fn().mockResolvedValue(ASSESSMENT_RESPONSE);
vi.mock('../assessment/index.js', () => ({
  assessmentHandler: assessmentHandlerMock,
}));

// Mock handlers/get-monitoring.js and get-monitoring-history.js separately (Task 7.1/7.2) — also to
// avoid router.ts dragging in the real static import of monitoring-service.ts/threshold-history-service.ts
// (which throws at module scope if the ASSESSMENT_BUCKET_NAME env var is missing), and so the
// /monitoring* routes just need to confirm the router calls the right handler + returns the right
// response (same as assessmentHandlerMock above), no need to retest the logic inside those 2 handlers.
const MONITORING_RESPONSE = {
  statusCode: 200,
  headers: { 'content-type': 'application/json; charset=utf-8' },
  body: JSON.stringify({ ec2: [], rds: [], alb: [], ebs: [], alerts: [] }),
};
const monitoringHandlerMock = vi.fn().mockResolvedValue(MONITORING_RESPONSE);

const MONITORING_HISTORY_RESPONSE = {
  statusCode: 200,
  headers: { 'content-type': 'application/json; charset=utf-8' },
  body: JSON.stringify([{ timestamp: '2024-01-01T00:00:00.000Z', level: 'ok' }]),
};
const monitoringHistoryHandlerMock = vi.fn().mockResolvedValue(MONITORING_HISTORY_RESPONSE);
vi.mock('../monitoring/index.js', () => ({
  monitoringHandler: monitoringHandlerMock,
  monitoringHistoryHandler: monitoringHistoryHandlerMock,
}));

// Mock the 2 logs viewer handlers separately — same reason as monitoring above: router.ts
// statically imports them, dragging in cloudwatch-logs-viewer-service.ts creating a
// CloudWatchLogsClient right at module scope. At the router layer, just need to confirm the right
// route is dispatched to the right handler with the right arguments; parameter validation is
// get-log-events.ts's own responsibility (already tested in get-log-events.test.ts).
const LOG_GROUPS_RESPONSE = {
  statusCode: 200,
  headers: { 'content-type': 'application/json; charset=utf-8' },
  body: JSON.stringify({ groups: [], truncated: false }),
};
const logGroupsHandlerMock = vi.fn().mockResolvedValue(LOG_GROUPS_RESPONSE);

const LOG_EVENTS_RESPONSE = {
  statusCode: 200,
  headers: { 'content-type': 'application/json; charset=utf-8' },
  body: JSON.stringify({ events: [], truncatedMessageCount: 0 }),
};
const logEventsHandlerMock = vi.fn().mockResolvedValue(LOG_EVENTS_RESPONSE);
vi.mock('../logs/index.js', () => ({
  getLogGroupsHandler: logGroupsHandlerMock,
  getLogEventsHandler: logEventsHandlerMock,
}));

// Mock handlers/actions-preview.js separately (Task 7.1) — the /actions/preview route just needs
// to confirm the router calls this handler with the full 2 args `(event, claims)` — `claims` is
// REQUIRED because preview of the 4 lifecycle actions must be gated by `isOperatorMember()` (see
// `actions-preview.ts`) — and returns the right response, no need to retest the logic reading
// assessment-report.json/matchActionCatalog() (already covered in preview-service.property4.test.ts, Task 3.2).
const ACTIONS_PREVIEW_RESPONSE = {
  statusCode: 200,
  headers: { 'content-type': 'application/json; charset=utf-8' },
  body: JSON.stringify({
    actionType: 'EC2_Start',
    awsApiCall: 'ec2:StartInstances',
    resource: { resourceId: 'i-fake123', region: 'ap-southeast-1' },
    params: {},
    reversibilityClass: 'reversible',
  }),
};
const actionsPreviewHandlerMock = vi.fn().mockResolvedValue(ACTIONS_PREVIEW_RESPONSE);

// Mock handlers/actions-execute.js separately (Task 7.2) — the /actions/execute route just needs
// to confirm the router calls this handler with the exact 2 args `(event, claims)` (see
// `router.ts`'s exact call `actionsExecuteHandler(event, claims)`) and returns the right response,
// no need to retest the lambda:InvokeFunction/body-validation logic (already covered in
// action-execution-handler.ts's own test).
const ACTIONS_EXECUTE_RESPONSE = {
  statusCode: 200,
  headers: { 'content-type': 'application/json; charset=utf-8' },
  body: JSON.stringify({ outcome: 'success' }),
};
const actionsExecuteHandlerMock = vi.fn().mockResolvedValue(ACTIONS_EXECUTE_RESPONSE);

// Mock handlers/actions-audit.js separately (Task 7.3) — the /actions/audit route just needs to
// confirm the router calls this handler (1 arg) and returns the right response, no need to retest
// the listAuditRecordsForResource() logic (already covered in action-audit-service.property11.test.ts, Task 4.10).
const ACTIONS_AUDIT_RESPONSE = {
  statusCode: 200,
  headers: { 'content-type': 'application/json; charset=utf-8' },
  body: JSON.stringify([]),
};
const actionsAuditHandlerMock = vi.fn().mockResolvedValue(ACTIONS_AUDIT_RESPONSE);
// Router.ts imports actionsPreviewHandler/actionsExecuteHandler/actionsLifecycleHandler/
// actionsAuditHandler/actionsRequestApprovalHandler/getApprovalsHandler/
// actionsDecideApprovalHandler/actionsExecuteApprovalHandler all from the SAME barrel
// (`../actions/index.js`, Requirement 6.4) — 1 single vi.mock() covers all 8. The router never
// calls actions-lifecycle/actions-request-approval/get-approvals/actions-decide-approval/
// actions-execute-approval in THIS test file's own test cases, but they still need a defined
// (unused) mock value here since vi.mock() replaces the WHOLE module — any exported name router.ts
// destructures from this module must exist on the mock object, or router.ts's own import
// destructuring would get `undefined` and crash at import-time before any test runs.
const actionsLifecycleHandlerMock = vi.fn();
const actionsRequestApprovalHandlerMock = vi.fn();
const getApprovalsHandlerMock = vi.fn();
const actionsDecideApprovalHandlerMock = vi.fn();
const actionsExecuteApprovalHandlerMock = vi.fn();
vi.mock('../actions/index.js', () => ({
  actionsPreviewHandler: actionsPreviewHandlerMock,
  actionsExecuteHandler: actionsExecuteHandlerMock,
  actionsLifecycleHandler: actionsLifecycleHandlerMock,
  actionsAuditHandler: actionsAuditHandlerMock,
  actionsRequestApprovalHandler: actionsRequestApprovalHandlerMock,
  getApprovalsHandler: getApprovalsHandlerMock,
  actionsDecideApprovalHandler: actionsDecideApprovalHandlerMock,
  actionsExecuteApprovalHandler: actionsExecuteApprovalHandlerMock,
}));

const SCHEDULED_ACTIONS_GET_RESPONSE = {
  statusCode: 200,
  headers: { 'content-type': 'application/json; charset=utf-8' },
  body: JSON.stringify({ recurringRules: [], oneTimeSchedules: [] }),
};
const getScheduledActionsHandlerMock = vi.fn().mockResolvedValue(SCHEDULED_ACTIONS_GET_RESPONSE);

const SCHEDULED_ACTIONS_CREATE_RESPONSE = {
  statusCode: 200,
  headers: { 'content-type': 'application/json; charset=utf-8' },
  body: JSON.stringify({ ok: true, scheduleName: 'abc-prod-downsize-20260820-0030-ab12' }),
};
const SCHEDULED_ACTIONS_DELETE_RESPONSE = {
  statusCode: 200,
  headers: { 'content-type': 'application/json; charset=utf-8' },
  body: JSON.stringify({ ok: true, scheduleName: 'abc-prod-downsize-20260820-0030-ab12' }),
};
// Mock the 2 Security Group handlers separately — same reason as the other handlers above: at the
// router layer, just need to confirm the RIGHT route dispatches to the RIGHT handler with the
// RIGHT arguments. The arguments are the security-critical point: GET /security-groups (read)
// receives 1 arg `event`, while POST /actions/security-group (mutate) MUST receive `claims` too —
// without `claims` the handler cannot run `isOperatorMember()`.
const SECURITY_GROUPS_RESPONSE = {
  statusCode: 200,
  headers: { 'content-type': 'application/json; charset=utf-8' },
  body: JSON.stringify({ groups: [], truncated: false }),
};
const securityGroupsHandlerMock = vi.fn().mockResolvedValue(SECURITY_GROUPS_RESPONSE);

const ACTIONS_SECURITY_GROUP_RESPONSE = {
  statusCode: 200,
  headers: { 'content-type': 'application/json; charset=utf-8' },
  body: JSON.stringify({ outcome: 'success' }),
};
const actionsSecurityGroupHandlerMock = vi.fn().mockResolvedValue(ACTIONS_SECURITY_GROUP_RESPONSE);
vi.mock('../security/index.js', () => ({
  securityGroupsHandler: securityGroupsHandlerMock,
  actionsSecurityGroupHandler: actionsSecurityGroupHandlerMock,
  // executeSecurityGroupIngress/Egress/Create/Delete are also exported from this barrel but not
  // exercised by router.test.ts (router.ts never imports them, only action-execution-handler.ts
  // does) — no mock value needed for symbols router.ts doesn't destructure.
}));

const createScheduleHandlerMock = vi.fn().mockResolvedValue(SCHEDULED_ACTIONS_CREATE_RESPONSE);
const deleteScheduleHandlerMock = vi.fn().mockResolvedValue(SCHEDULED_ACTIONS_DELETE_RESPONSE);
vi.mock('../scheduled-actions/index.js', () => ({
  getScheduledActionsHandler: getScheduledActionsHandlerMock,
  createScheduleHandler: createScheduleHandlerMock,
  deleteScheduleHandler: deleteScheduleHandlerMock,
}));

// Import the router AFTER the mocks are declared (vi.mock is hoisted above by vitest).
const { handler: routerHandler } = await import('./router.js');

/** A minimal fake LambdaFunctionURLEvent — fills in only the fields router.ts/handler actually use. */
function buildEvent(method: string, rawPath: string): LambdaFunctionURLEvent {
  return {
    headers: { authorization: 'Bearer fake-token' },
    rawPath,
    requestContext: { http: { method } },
  } as unknown as LambdaFunctionURLEvent;
}

/**
 * Compares a router response to the mocked handler response WITHOUT the `x-correlation-id`
 * header router.ts now attaches to every response (see lib/correlationId.ts) — a per-request
 * random UUID by design, so it can never be asserted as a fixed literal. This only verifies the
 * header IS present as a non-empty string, then compares everything else exactly like `toEqual`
 * did before that header existed.
 */
function expectRouterResponseToEqual(actual: unknown, expected: { statusCode: number; headers: Record<string, string>; body: string }): void {
  const response = actual as { statusCode: number; headers: Record<string, string>; body: string };
  expect(typeof response.headers['x-correlation-id']).toBe('string');
  expect(response.headers['x-correlation-id'].length).toBeGreaterThan(0);
  const { 'x-correlation-id': _omit, ...restHeaders } = response.headers;
  expect({ ...response, headers: restHeaders }).toEqual(expected);
}

beforeEach(() => {
  verifyEntraTokenMock.mockClear();
  assessmentHandlerMock.mockClear();
  monitoringHandlerMock.mockClear();
  monitoringHistoryHandlerMock.mockClear();
  logGroupsHandlerMock.mockClear();
  logEventsHandlerMock.mockClear();
  actionsPreviewHandlerMock.mockClear();
  actionsExecuteHandlerMock.mockClear();
  actionsAuditHandlerMock.mockClear();
  securityGroupsHandlerMock.mockClear();
  actionsSecurityGroupHandlerMock.mockClear();
  getScheduledActionsHandlerMock.mockClear();
  createScheduleHandlerMock.mockClear();
  deleteScheduleHandlerMock.mockClear();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('router - GET /assessment', () => {
  it('verifies the token then calls the right assessmentHandler, returns the right response from that handler', async () => {
    const event = buildEvent('GET', '/assessment');

    const result = await routerHandler(event);

    expect(verifyEntraTokenMock).toHaveBeenCalledTimes(1);
    expect(assessmentHandlerMock).toHaveBeenCalledTimes(1);
    expect(assessmentHandlerMock).toHaveBeenCalledWith(event);
    expectRouterResponseToEqual(result, ASSESSMENT_RESPONSE);
  });
});

describe('router - GET /monitoring', () => {
  it('verifies the token then calls the right monitoringHandler, returns the right response from that handler', async () => {
    const event = buildEvent('GET', '/monitoring');

    const result = await routerHandler(event);

    expect(verifyEntraTokenMock).toHaveBeenCalledTimes(1);
    expect(monitoringHandlerMock).toHaveBeenCalledTimes(1);
    expect(monitoringHandlerMock).toHaveBeenCalledWith(event);
    expectRouterResponseToEqual(result, MONITORING_RESPONSE);
  });
});

describe('router - GET /logs/groups and GET /logs/events', () => {
  it('GET /logs/groups → calls the right logGroupsHandler with 1 event argument', async () => {
    const event = buildEvent('GET', '/logs/groups');

    const result = await routerHandler(event);

    expect(verifyEntraTokenMock).toHaveBeenCalledTimes(1);
    expect(logGroupsHandlerMock).toHaveBeenCalledTimes(1);
    expect(logGroupsHandlerMock).toHaveBeenCalledWith(event);
    expect(logEventsHandlerMock).not.toHaveBeenCalled();
    expectRouterResponseToEqual(result, LOG_GROUPS_RESPONSE);
  });

  it('GET /logs/events → calls the right logEventsHandler with 1 event argument', async () => {
    const event = buildEvent('GET', '/logs/events');

    const result = await routerHandler(event);

    expect(logEventsHandlerMock).toHaveBeenCalledTimes(1);
    expect(logEventsHandlerMock).toHaveBeenCalledWith(event);
    expect(logGroupsHandlerMock).not.toHaveBeenCalled();
    expectRouterResponseToEqual(result, LOG_EVENTS_RESPONSE);
  });

  // The 2 logs routes are READ-ONLY: the router does NOT pass `claims` down (unlike POST
  // /actions/lifecycle) — the operator gate is reserved for mutate actions, see spec 2026-08-25
  // RBAC section. The argument assertions in the 2 tests above are exactly the safeguard for that decision.
  it('POST /logs/events (wrong method) → 404, does not call any handler', async () => {
    const result = (await routerHandler(buildEvent('POST', '/logs/events'))) as { statusCode: number };

    expect(result.statusCode).toBe(404);
    expect(logEventsHandlerMock).not.toHaveBeenCalled();
  });
});

describe('router - GET /monitoring/history', () => {
  it('verifies the token then calls the right monitoringHistoryHandler, returns the right response from that handler', async () => {
    const event = buildEvent('GET', '/monitoring/history');

    const result = await routerHandler(event);

    expect(verifyEntraTokenMock).toHaveBeenCalledTimes(1);
    expect(monitoringHistoryHandlerMock).toHaveBeenCalledTimes(1);
    expect(monitoringHistoryHandlerMock).toHaveBeenCalledWith(event);
    expectRouterResponseToEqual(result, MONITORING_HISTORY_RESPONSE);
  });

  // Required-parameter validation (400 when resourceType/resourceId/metric is missing) is
  // get-monitoring-history.ts's own handler's responsibility (badRequest() is thrown inside the
  // handler, not router.ts — the router only dispatches). At the router layer, the handler is
  // mocked so that logic can't be meaningfully reproduced; it's fully tested in
  // handlers/get-monitoring-history.test.ts (per the existing convention: detailed business logic
  // lives in that module's own test, like assessment-service.test.ts, while router.test.ts only
  // verifies "calls the right handler + returns the right response").
});

describe('router - GET /actions/preview', () => {
  it('verifies the token then calls the right actionsPreviewHandler with (event, claims), returns the right response from that handler', async () => {
    // The query string (`?recommendationId=...`) does not affect router.ts's route-matching (it
    // relies only on `method`/`segments` from `rawPath`) — the handler is mocked so
    // `queryStringParameters` doesn't need to be passed at this router test layer (reading/validating
    // `recommendationId` is actions-preview.ts's own responsibility, outside router.test.ts's scope).
    const event = buildEvent('GET', '/actions/preview');

    const result = await routerHandler(event);

    expect(verifyEntraTokenMock).toHaveBeenCalledTimes(1);
    expect(actionsPreviewHandlerMock).toHaveBeenCalledTimes(1);
    expect(actionsPreviewHandlerMock).toHaveBeenCalledWith(
      event,
      expect.objectContaining({ sub: 'user-123' }),
    );
    expectRouterResponseToEqual(result, ACTIONS_PREVIEW_RESPONSE);
  });
});

describe('router - POST /actions/execute', () => {
  it('verifies the token then calls the right actionsExecuteHandler with (event, claims), returns the right response from that handler', async () => {
    const event = buildEvent('POST', '/actions/execute');

    const result = await routerHandler(event);

    expect(verifyEntraTokenMock).toHaveBeenCalledTimes(1);
    expect(actionsExecuteHandlerMock).toHaveBeenCalledTimes(1);
    expect(actionsExecuteHandlerMock).toHaveBeenCalledWith(
      event,
      expect.objectContaining({ sub: 'user-123' }),
    );
    expectRouterResponseToEqual(result, ACTIONS_EXECUTE_RESPONSE);
  });
});

describe('router - GET /actions/audit', () => {
  it('verifies the token then calls the right actionsAuditHandler, returns the right response from that handler', async () => {
    const event = buildEvent('GET', '/actions/audit');

    const result = await routerHandler(event);

    expect(verifyEntraTokenMock).toHaveBeenCalledTimes(1);
    expect(actionsAuditHandlerMock).toHaveBeenCalledTimes(1);
    expect(actionsAuditHandlerMock).toHaveBeenCalledWith(event);
    expectRouterResponseToEqual(result, ACTIONS_AUDIT_RESPONSE);
  });
});

describe('router - Security Group', () => {
  it('GET /security-groups → calls securityGroupsHandler with EXACTLY 1 event argument (a read route, no claims needed)', async () => {
    const event = buildEvent('GET', '/security-groups');

    const result = await routerHandler(event);

    expect(verifyEntraTokenMock).toHaveBeenCalledTimes(1);
    expect(securityGroupsHandlerMock).toHaveBeenCalledTimes(1);
    expect(securityGroupsHandlerMock).toHaveBeenCalledWith(event);
    expectRouterResponseToEqual(result, SECURITY_GROUPS_RESPONSE);
  });

  it('POST /actions/security-group → calls actionsSecurityGroupHandler with (event, claims)', async () => {
    const event = buildEvent('POST', '/actions/security-group');

    const result = await routerHandler(event);

    expect(verifyEntraTokenMock).toHaveBeenCalledTimes(1);
    expect(actionsSecurityGroupHandlerMock).toHaveBeenCalledTimes(1);
    // `claims` MUST be passed down — this is the only thing that lets the handler run the
    // `isOperatorMember()` gate; if the router forgets this argument, any rule could be opened by a regular user.
    expect(actionsSecurityGroupHandlerMock).toHaveBeenCalledWith(event, expect.objectContaining({ sub: 'user-123' }));
    expectRouterResponseToEqual(result, ACTIONS_SECURITY_GROUP_RESPONSE);
  });

  it('GET /actions/security-group (wrong method for a mutate route) → 404, does not call the mutate handler', async () => {
    const result = (await routerHandler(buildEvent('GET', '/actions/security-group'))) as { statusCode: number };

    expect(result.statusCode).toBe(404);
    expect(actionsSecurityGroupHandlerMock).not.toHaveBeenCalled();
  });
});

describe('router - GET /scheduled-actions', () => {
  it('verifies the token then calls the right getScheduledActionsHandler, returns the right response from that handler', async () => {
    const event = buildEvent('GET', '/scheduled-actions');

    const result = await routerHandler(event);

    expect(verifyEntraTokenMock).toHaveBeenCalledTimes(1);
    expect(getScheduledActionsHandlerMock).toHaveBeenCalledTimes(1);
    expect(getScheduledActionsHandlerMock).toHaveBeenCalledWith(event);
    expectRouterResponseToEqual(result, SCHEDULED_ACTIONS_GET_RESPONSE);
  });
});

describe('router - POST /scheduled-actions', () => {
  it('verifies the token then calls the right createScheduleHandler, returns the right response from that handler', async () => {
    const event = buildEvent('POST', '/scheduled-actions');

    const result = await routerHandler(event);

    expect(verifyEntraTokenMock).toHaveBeenCalledTimes(1);
    expect(createScheduleHandlerMock).toHaveBeenCalledTimes(1);
    expect(createScheduleHandlerMock).toHaveBeenCalledWith(event);
    expectRouterResponseToEqual(result, SCHEDULED_ACTIONS_CREATE_RESPONSE);
  });
});

describe('router - POST /scheduled-actions/{name}/delete', () => {
  it('verifies the token then calls the right deleteScheduleHandler with (event, name), returns the right response from that handler', async () => {
    const event = buildEvent('POST', '/scheduled-actions/abc-prod-downsize-20260820-0030-ab12/delete');

    const result = await routerHandler(event);

    expect(verifyEntraTokenMock).toHaveBeenCalledTimes(1);
    expect(deleteScheduleHandlerMock).toHaveBeenCalledTimes(1);
    expect(deleteScheduleHandlerMock).toHaveBeenCalledWith(event, 'abc-prod-downsize-20260820-0030-ab12');
    expectRouterResponseToEqual(result, SCHEDULED_ACTIONS_DELETE_RESPONSE);
  });
});

describe('router - nonexistent route', () => {
  it('returns 404 like other routes (using notFound() from lib/errors.js)', async () => {
    const event = buildEvent('GET', '/route-does-not-exist');

    const result = await routerHandler(event);

    // LambdaFunctionURLResult (= APIGatewayProxyResultV2) allows the body to be a raw string, but
    // router.ts always returns the object { statusCode, headers, body } via lib/response.ts —
    // explicitly cast the type to access `statusCode` without relaxing '@typescript-eslint' for the whole file.
    expect((result as { statusCode: number }).statusCode).toBe(404);
    expect(assessmentHandlerMock).not.toHaveBeenCalled();
  });
});
