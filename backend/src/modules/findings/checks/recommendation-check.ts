import type { RecommendationFindingType, RecommendationItem, Severity } from '@ops-dashboard/shared';
import { attributeResource } from '../attribution.js';
import { arnFor, arnKindForResourceType } from '../finding-id.js';
import { arnContext, makeDraft, type CheckDefinition, type CheckMeta } from './types.js';

/** Adapter: one check per infra-review recommendation type (assessment-report.json, daily). */
export function recommendationCheck(
  meta: CheckMeta,
  findingType: RecommendationFindingType,
  severityOf: (rec: RecommendationItem) => Severity,
): CheckDefinition {
  return {
    ...meta,
    run: (snapshot) =>
      (snapshot.assessment?.recommendations ?? [])
        .filter((rec) => rec.findingType === findingType)
        .map((rec) =>
          makeDraft(meta, {
            resourceType: rec.resourceType,
            resourceId: rec.resourceId,
            resourceName: rec.resourceName,
            resourceArn: arnFor(arnKindForResourceType(rec.resourceType), rec.resourceId, arnContext(snapshot)),
            placement: attributeResource(snapshot.topologyIndex, rec.resourceId),
            severity: severityOf(rec),
            description: rec.currentState,
            remediationSteps: [rec.recommendedAction, ...meta.remediation],
            observedAt: snapshot.observedAt.assessment ?? snapshot.now,
            data: {
              recommendationId: rec.id,
              findingType: rec.findingType,
              currentState: rec.currentState,
              recommendedAction: rec.recommendedAction,
              estimatedMonthlySavingsUsd: rec.estimatedMonthlySavingsUsd,
              risk: rec.risk,
              priority: rec.priority,
            },
          }),
        ),
  };
}
