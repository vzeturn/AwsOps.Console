import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from 'aws-lambda';
import type { ExportableTab } from '@ops-dashboard/shared';
import { corsHeaders } from '../../config.js';
import { fail } from '../../shared-kernel/response.js';
import { notFound } from '../../shared-kernel/errors.js';
import { verifyEntraToken } from './auth.js';
import { resolveCorrelationId } from './correlationId.js';
import { setCorrelationId, logger } from '../../shared-kernel/logger.js';
import { handler as meHandler } from './me.js';
import { infraHandler } from '../infra/index.js';
import { complianceHandler } from '../compliance/index.js';
import { costHandler } from '../cost/index.js';
import { assessmentHandler } from '../assessment/index.js';
import { monitoringHandler, monitoringHistoryHandler } from '../monitoring/index.js';
import { getLogGroupsHandler as logGroupsHandler, getLogEventsHandler as logEventsHandler } from '../logs/index.js';
import { handler as exportCsvHandler } from '../export/index.js';
import {
  actionsPreviewHandler,
  actionsExecuteHandler,
  actionsLifecycleHandler,
  actionsAuditHandler,
  actionsRequestApprovalHandler,
  getApprovalsHandler,
  actionsDecideApprovalHandler,
  actionsExecuteApprovalHandler,
} from '../actions/index.js';
import { actionsSecurityGroupHandler, securityGroupsHandler } from '../security/index.js';
import {
  ec2ManagementHandler as actionsEc2ManagementHandler,
  runCommandHandler as actionsRunCommandHandler,
  runCommandStatusHandler,
  ec2InstanceTypesHandler,
} from '../ec2-management/index.js';
import { topologyHandler } from '../infra/index.js';
import { getScheduledActionsHandler, createScheduleHandler, deleteScheduleHandler } from '../scheduled-actions/index.js';
import { getIdleSchedulerHandler, createIdleSchedulerGroupHandler, deregisterIdleSchedulerGroupHandler } from '../idle-scheduler/index.js';

const EXPORTABLE_TABS: readonly ExportableTab[] = ['infra', 'compliance', 'cost'];

function readOrigin(event: LambdaFunctionURLEvent): string | undefined {
  return event.headers?.origin ?? event.headers?.Origin;
}

function splitPath(path: string): string[] {
  return path.split('/').filter((s) => s.length > 0);
}

/**
 * The single Lambda "router" exposed via Function URL (the "permanently $0" architecture —
 * NO API Gateway/Cognito). Verifies the Entra ID JWT itself, then routes itself. Most routes
 * are GET/read-only; the POST routes under `/actions/*` and `/scheduled-actions*` mutate
 * resources (EC2/RDS lifecycle, scheduled actions) and are each additionally gated by
 * `isOperatorMember()` inside their respective handler — verifyEntraToken() above only
 * authenticates login, it is not authorization for the mutating routes.
 */
export const handler = async (event: LambdaFunctionURLEvent): Promise<LambdaFunctionURLResult> => {
  const method = event.requestContext.http.method;
  const path = event.rawPath;

  if (method === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(readOrigin(event)) };
  }

  // Set once, for the WHOLE remainder of this invocation — every logger.* call below (including
  // ones made deep inside a handler/service) automatically carries this id (see
  // lib/logger.ts::setCorrelationId doc comment). Attached to the response as `x-correlation-id`
  // too, so a user reporting "it broke" can hand back the exact id to search logs by.
  const correlationId = resolveCorrelationId(event);
  setCorrelationId(correlationId);
  logger.info(`router: ${method} ${path}`);

  try {
    const result = await routeRequest(event, method, path);
    return withCorrelationHeader(result, correlationId);
  } catch (err) {
    return withCorrelationHeader(fail(err, event, correlationId), correlationId);
  }
};

/** Attaches `x-correlation-id` to every response (success and error alike) — merged in as the
 * last step so it can never be accidentally overwritten by a handler's own headers.
 *
 * `LambdaFunctionURLResult` is typed as `string | APIGatewayProxyStructuredResultV2` — every
 * handler in this codebase only ever returns the structured object form (never a bare string),
 * but the type itself doesn't guarantee that, so this narrows defensively rather than assuming it. */
function withCorrelationHeader(result: LambdaFunctionURLResult, correlationId: string): LambdaFunctionURLResult {
  if (typeof result === 'string') return result;
  return { ...result, headers: { ...result.headers, 'x-correlation-id': correlationId } };
}

async function routeRequest(event: LambdaFunctionURLEvent, method: string, path: string): Promise<LambdaFunctionURLResult> {
  const claims = await verifyEntraToken(event);
  const segments = splitPath(path);

  if (method === 'GET' && segments.length === 1 && segments[0] === 'me') {
    return await meHandler(event, claims);
  }
  if (method === 'GET' && segments.length === 1 && segments[0] === 'infra') {
    return await infraHandler(event);
  }
  if (method === 'GET' && segments.length === 1 && segments[0] === 'compliance') {
    return await complianceHandler(event);
  }
  if (method === 'GET' && segments.length === 1 && segments[0] === 'cost') {
    return await costHandler(event);
  }
  if (method === 'GET' && segments.length === 1 && segments[0] === 'assessment') {
    return await assessmentHandler(event);
  }
  if (method === 'GET' && segments.length === 1 && segments[0] === 'monitoring') {
    return await monitoringHandler(event);
  }
  if (method === 'GET' && segments.length === 2 && segments[0] === 'monitoring' && segments[1] === 'history') {
    return await monitoringHistoryHandler(event);
  }
  if (method === 'GET' && segments.length === 2 && segments[0] === 'logs' && segments[1] === 'groups') {
    return await logGroupsHandler(event);
  }
  if (method === 'GET' && segments.length === 2 && segments[0] === 'logs' && segments[1] === 'events') {
    return await logEventsHandler(event);
  }
  if (method === 'GET' && segments.length === 1 && segments[0] === 'topology') {
    return await topologyHandler(event);
  }
  if (method === 'GET' && segments.length === 1 && segments[0] === 'security-groups') {
    return await securityGroupsHandler(event);
  }
  if (method === 'GET' && segments.length === 1 && segments[0] === 'ec2-instance-types') {
    return await ec2InstanceTypesHandler(event);
  }
  if (method === 'GET' && segments.length === 2 && segments[0] === 'export') {
    const tab = segments[1] as ExportableTab;
    if (!EXPORTABLE_TABS.includes(tab)) throw notFound(`Unknown export tab: ${segments[1]}`);
    return await exportCsvHandler(event, tab);
  }
  if (method === 'GET' && segments.length === 2 && segments[0] === 'actions' && segments[1] === 'preview') {
    return await actionsPreviewHandler(event, claims);
  }
  if (method === 'POST' && segments.length === 2 && segments[0] === 'actions' && segments[1] === 'execute') {
    return await actionsExecuteHandler(event, claims);
  }
  if (method === 'POST' && segments.length === 2 && segments[0] === 'actions' && segments[1] === 'lifecycle') {
    return await actionsLifecycleHandler(event, claims);
  }
  if (method === 'POST' && segments.length === 2 && segments[0] === 'actions' && segments[1] === 'security-group') {
    return await actionsSecurityGroupHandler(event, claims);
  }
  if (method === 'POST' && segments.length === 2 && segments[0] === 'actions' && segments[1] === 'ec2-management') {
    return await actionsEc2ManagementHandler(event, claims);
  }
  if (method === 'POST' && segments.length === 2 && segments[0] === 'actions' && segments[1] === 'run-command') {
    return await actionsRunCommandHandler(event, claims);
  }
  // GET /actions/run-command/{commandId}/status — poll for the result (a Function URL can't
  // stream, so polling is the only option). Read-only: runs directly in the router, not via
  // action-execution-fn, see `ssm-run-command-status-service.ts`.
  if (
    method === 'GET' &&
    segments.length === 4 &&
    segments[0] === 'actions' &&
    segments[1] === 'run-command' &&
    segments[3] === 'status'
  ) {
    return await runCommandStatusHandler(event, claims, segments[2]);
  }
  if (method === 'GET' && segments.length === 2 && segments[0] === 'actions' && segments[1] === 'audit') {
    return await actionsAuditHandler(event);
  }
  // Maker-checker Approval workflow (Requirement: approval must be applied per best practice for
  // high-risk/operator-only actions — see shared/src/approval.ts). 4 routes: request (anyone
  // signed in may ask), list (read-only, serves the Approvals queue page), decide (operator-only,
  // maker!=checker enforced server-side), execute (requester OR approver only, once approved).
  if (method === 'POST' && segments.length === 2 && segments[0] === 'actions' && segments[1] === 'request-approval') {
    return await actionsRequestApprovalHandler(event, claims);
  }
  if (method === 'GET' && segments.length === 2 && segments[0] === 'actions' && segments[1] === 'approvals') {
    return await getApprovalsHandler(event);
  }
  if (method === 'POST' && segments.length === 2 && segments[0] === 'actions' && segments[1] === 'decide-approval') {
    return await actionsDecideApprovalHandler(event, claims);
  }
  if (method === 'POST' && segments.length === 2 && segments[0] === 'actions' && segments[1] === 'execute-approval') {
    return await actionsExecuteApprovalHandler(event, claims);
  }

  if (method === 'GET' && segments.length === 1 && segments[0] === 'scheduled-actions') {
    return await getScheduledActionsHandler(event);
  }
  if (method === 'POST' && segments.length === 1 && segments[0] === 'scheduled-actions') {
    return await createScheduleHandler(event);
  }
  if (method === 'POST' && segments.length === 3 && segments[0] === 'scheduled-actions' && segments[2] === 'delete') {
    return await deleteScheduleHandler(event, segments[1]);
  }

  if (method === 'GET' && segments.length === 1 && segments[0] === 'idle-scheduler') {
    return await getIdleSchedulerHandler(event);
  }
  if (method === 'POST' && segments.length === 1 && segments[0] === 'idle-scheduler') {
    return await createIdleSchedulerGroupHandler(event);
  }
  if (method === 'POST' && segments.length === 3 && segments[0] === 'idle-scheduler' && segments[2] === 'deregister') {
    return await deregisterIdleSchedulerGroupHandler(event, segments[1]);
  }

  throw notFound(`Route not found: ${method} ${path}`);
}
