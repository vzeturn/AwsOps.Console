import type { Page, Route } from '@playwright/test';
import {
  ME_OPERATOR,
  INFRA_DATA,
  TOPOLOGY_DATA,
  COMPLIANCE_DATA,
  COST_DATA,
  ASSESSMENT_REPORT,
  MONITORING_DATA,
  SECURITY_GROUPS_DATA,
  LOG_GROUPS_DATA,
  LOG_EVENTS_PAGE,
  SCHEDULED_ACTIONS_DATA,
  ACTION_AUDIT_RECORDS,
} from './data';

/** Matches `public/config.js`'s `apiBaseUrl` — every `fetch()` the SPA makes goes to this origin
 * (see `src/api/client.ts`'s `request()`), so intercepting `${API_BASE_URL}/**` catches every call. */
export const API_BASE_URL = 'https://api.e2e.test';

const EC2_RUNNING_INSTANCE_ID = INFRA_DATA.ec2[0].instanceId;

function json(route: Route, body: unknown, status = 200): Promise<void> {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

/** A plausible `ActionPreview` for ANY (actionType, resourceId) pair — good enough for every spec
 * that only needs the Confirmation_Dialog to render and gate correctly, without needing the real
 * per-actionType `awsApiCall`/params shape the backend computes. Specs that assert exact preview
 * content override this via `MockApiOptions.previewOverrides`. */
function buildGenericPreview(actionType: string, resourceId: string, params: Record<string, string> = {}) {
  const irreversibleActions = new Set([
    'Snapshot_And_Delete_EBS_Volume',
    'RDS_IncreaseStorage',
    'ElasticIp_Release',
    'SecurityGroup_Delete',
  ]);
  const securityActions = new Set([
    'SecurityGroup_AuthorizeIngress',
    'SecurityGroup_AuthorizeEgress',
    'Ec2_ModifySecurityGroups',
  ]);
  return {
    actionType,
    awsApiCall: `mock:${actionType}`,
    resource: { id: resourceId, arn: `arn:aws:ec2:ap-southeast-1:123456789012:instance/${resourceId}`, region: 'ap-southeast-1' },
    params,
    reversibilityClass: irreversibleActions.has(actionType) ? ('irreversible' as const) : ('reversible' as const),
    costImpactWarning: actionType === 'EC2_Stop' ? undefined : 'This action may affect operating cost — please confirm you understand the impact before continuing.',
    securityImpactWarning: securityActions.has(actionType) ? 'This opens network access — review carefully before confirming.' : undefined,
  };
}

/** A plausible `ActionExecutionResult` — `outcome: 'success'` with a few commonly-asserted fields
 * populated based on actionType, matching the shapes documented on `ActionExecutionResult` in
 * shared/src/index.ts. */
function buildGenericExecutionResult(actionType: string) {
  const base = { outcome: 'success' as const, reason: 'Mocked execution completed successfully.' };
  switch (actionType) {
    case 'EC2_Start':
      return { ...base, newState: 'pending' };
    case 'EC2_Stop':
    case 'EC2_Reboot':
      return { ...base, newState: 'stopping' };
    case 'ECS_ScaleOut':
      return { ...base, newDesiredCount: 2 };
    case 'RDS_IncreaseStorage':
      return { ...base, newAllocatedStorageGb: 150 };
    case 'CloudWatchLogGroup_SetRetention':
      return { ...base, newRetentionDays: 30 };
    case 'SSM_RunPreset':
      return { ...base, commandId: 'e2e-command-0001' };
    case 'Ec2_UpdateTags':
      return { ...base, newTags: { Name: 'e2e-web-01' } };
    case 'Ec2_ModifySecurityGroups':
      return { ...base, newSecurityGroupIds: ['sg-0e2eweb0001'] };
    case 'SecurityGroup_Create':
      return { ...base, createdSecurityGroupId: 'sg-0e2enew0099' };
    default:
      return base;
  }
}

export interface MockApiOptions {
  /** Marks the signed-in user as NOT an operator (read-only) — exercises the disabled-operator-action paths. */
  readOnly?: boolean;
}

/**
 * Registers a full set of route interceptors covering every endpoint `src/api/client.ts` calls.
 * Call this AFTER `mockSignedInUser()` and BEFORE `page.goto('/')` in each spec's setup.
 */
export async function mockApi(page: Page, options: MockApiOptions = {}): Promise<void> {
  const me = options.readOnly ? { ...ME_OPERATOR, isOperator: false } : ME_OPERATOR;

  await page.route(`${API_BASE_URL}/me`, (route) => json(route, me));
  await page.route(`${API_BASE_URL}/infra`, (route) => json(route, INFRA_DATA));
  await page.route(`${API_BASE_URL}/topology`, (route) => json(route, TOPOLOGY_DATA));
  await page.route(`${API_BASE_URL}/compliance`, (route) => json(route, COMPLIANCE_DATA));
  await page.route(`${API_BASE_URL}/cost`, (route) => json(route, COST_DATA));
  await page.route(`${API_BASE_URL}/assessment`, (route) => json(route, ASSESSMENT_REPORT));
  await page.route(`${API_BASE_URL}/monitoring`, (route) => json(route, MONITORING_DATA));
  await page.route(new RegExp(`${API_BASE_URL}/monitoring/history.*`), (route) => json(route, []));
  await page.route(`${API_BASE_URL}/security-groups`, (route) => json(route, SECURITY_GROUPS_DATA));
  await page.route(`${API_BASE_URL}/logs/groups`, (route) => json(route, LOG_GROUPS_DATA));
  await page.route(new RegExp(`${API_BASE_URL}/logs/events.*`), (route) => json(route, LOG_EVENTS_PAGE));
  await page.route(`${API_BASE_URL}/scheduled-actions`, (route) => {
    if (route.request().method() === 'POST') {
      return json(route, { ok: true, scheduleName: 'e2e-one-time-0002' });
    }
    return json(route, SCHEDULED_ACTIONS_DATA);
  });
  await page.route(new RegExp(`${API_BASE_URL}/scheduled-actions/.*/delete`), (route) => route.fulfill({ status: 204, body: '' }));
  await page.route(new RegExp(`${API_BASE_URL}/actions/audit.*`), (route) => json(route, ACTION_AUDIT_RECORDS));
  await page.route(new RegExp(`${API_BASE_URL}/ec2-instance-types.*`), (route) =>
    json(route, { compatibleTypes: ['t3.small', 't3.medium', 't3.large'] }),
  );

  // `GET /actions/preview` — two variants (recommendationId= vs actionType=&resourceId=), see
  // `api/client.ts`'s `actionsPreview` vs `actionsPreviewDirect`.
  await page.route(new RegExp(`${API_BASE_URL}/actions/preview.*`), (route) => {
    const url = new URL(route.request().url());
    const recommendationId = url.searchParams.get('recommendationId');
    if (recommendationId) {
      const rec = ASSESSMENT_REPORT.recommendations.find((r) => r.id === recommendationId);
      if (!rec) return json(route, { detail: 'Recommendation not found' }, 404);
      const actionType = rec.findingType === 'ebsVolumeUnattached' ? 'Snapshot_And_Delete_EBS_Volume' : 'RDS_ApplyResourceGovernance';
      return json(route, buildGenericPreview(actionType, rec.resourceId));
    }
    const actionType = url.searchParams.get('actionType') ?? '';
    const resourceId = url.searchParams.get('resourceId') ?? '';
    const params: Record<string, string> = {};
    for (const [key, value] of url.searchParams.entries()) {
      if (key !== 'actionType' && key !== 'resourceId') params[key] = value;
    }
    return json(route, buildGenericPreview(actionType, resourceId, params));
  });

  // POST execute-family endpoints — the request body always carries `actionType`.
  const executeEndpoints = ['/actions/execute', '/actions/lifecycle', '/actions/security-group', '/actions/ec2-management', '/actions/run-command'];
  for (const path of executeEndpoints) {
    await page.route(`${API_BASE_URL}${path}`, async (route) => {
      const body = route.request().postDataJSON() as { actionType: string };
      return json(route, buildGenericExecutionResult(body.actionType));
    });
  }

  await page.route(new RegExp(`${API_BASE_URL}/actions/run-command/([^/]+)/status`), (route) => {
    const match = /\/actions\/run-command\/([^/]+)\/status/.exec(route.request().url());
    return json(route, {
      commandId: match?.[1] ?? 'e2e-command-0001',
      instanceId: EC2_RUNNING_INSTANCE_ID,
      status: 'Success',
      statusDetails: 'Success',
      isTerminal: true,
      responseCode: 0,
      stdout: 'e2e mocked stdout',
      stderr: '',
      truncated: false,
    });
  });

  await page.route(new RegExp(`${API_BASE_URL}/export/.*`), (route) =>
    route.fulfill({ status: 200, contentType: 'text/csv', body: 'header1,header2\nvalue1,value2\n' }),
  );
}
