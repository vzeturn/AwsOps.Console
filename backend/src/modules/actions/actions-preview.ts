import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from 'aws-lambda';
import { isOperatorOnlyActionType } from '@ops-dashboard/shared';
import { ok } from '../../shared-kernel/response.js';
import { badRequest, forbidden } from '../../shared-kernel/errors.js';
import { isOperatorMember } from '../web/index.js';
import { buildActionPreview, buildActionPreviewDirect } from './preview-service.js';

/**
 * Preview for operator-only actions (resource lifecycle + Security Group) must go through the EXACT
 * SAME `operatorGroupIds` gate as their execution endpoint — otherwise a non-operator could still
 * open the Confirmation_Dialog "Reboot RDS ..." / "OPEN tcp 22 to 0.0.0.0/0" with all the real
 * parameters (AWS API call, ARN, Security Group name, VPC id) and only get blocked at the confirm
 * click: that both leaks resource information — reconnaissance for the very bypass the gate is
 * blocking — and is bad UX.
 *
 * `isOperatorOnlyActionType` (shared) is used by `actions-execute.ts` (blocks), `actions-lifecycle.ts`
 * and `actions-security-group.ts` (accepts + gates) alike, so these checks CANNOT drift apart when a
 * new family of operator-only actions is added.
 */
function assertOperatorForRestrictedAction(actionType: string, claims: Record<string, unknown>): void {
  if (isOperatorOnlyActionType(actionType) && !isOperatorMember(claims)) {
    throw forbidden('Account is not a member of the operator group required to perform this action');
  }
}

/**
 * `GET /actions/preview?recommendationId=...` — returns an `ActionPreview` (the AWS API call to be
 * made, resource, params, reversibility class, cost impact warning) to display in the
 * Confirmation_Dialog before the user confirms execution (Requirement 3.1, 3.5).
 *
 * `GET /actions/preview?actionType=...&resourceId=...` — the "direct" variant, used by the
 * quick-action opened FROM Monitoring_Page (a 1-click runbook, e.g. "high CPU" → `ECS_ScaleOut`) —
 * where the problem was detected from a real-time CloudWatch metric/alarm, with NO corresponding
 * `RecommendationItem` in `assessment-report.json` (that report is only regenerated once a day via
 * `infra-review-collector`).
 *
 * `buildActionPreview`/`buildActionPreviewDirect` throw `notFound`/`badRequest` themselves for the
 * matching error cases — the router's outer catch (`fail`) converts these into the correct HTTP
 * status.
 */
export async function handler(
  event: LambdaFunctionURLEvent,
  claims: Record<string, unknown>,
): Promise<LambdaFunctionURLResult> {
  const recommendationId = event.queryStringParameters?.recommendationId;
  const actionType = event.queryStringParameters?.actionType;
  const resourceId = event.queryStringParameters?.resourceId;

  if (recommendationId) {
    const preview = await buildActionPreview(recommendationId);
    // This branch does NOT know the actionType in advance (it's derived from the recommendation),
    // so it must gate after building.
    assertOperatorForRestrictedAction(preview.actionType, claims);
    return ok(event, preview);
  }

  if (actionType && resourceId) {
    assertOperatorForRestrictedAction(actionType, claims);
    // Every query param OTHER THAN the 3 routing params is an action parameter (protocol/fromPort/
    // toPort/cidrIp/description for Security Group). Filtered by exclusion rather than by naming
    // them: adding an action with a new parameter doesn't require a change here, and
    // `preview-service` validates the part it needs itself and ignores the rest.
    const {
      recommendationId: _recommendationId,
      actionType: _actionType,
      resourceId: _resourceId,
      ...actionParams
    } = event.queryStringParameters ?? {};
    const preview = await buildActionPreviewDirect(actionType, resourceId, actionParams as Record<string, string>);
    return ok(event, preview);
  }

  throw badRequest('Missing required parameter: recommendationId, or both actionType and resourceId');
}
