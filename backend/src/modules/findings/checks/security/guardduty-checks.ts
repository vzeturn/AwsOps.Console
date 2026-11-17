import { attributeResource } from '../../attribution.js';
import { guardDutySeverity } from '../../defaults.js';
import { makeDraft, type CheckDefinition } from '../types.js';

/** Adapter over GuardDuty (same detector security-guardduty-triage uses). resourceArn = the
 * GuardDuty finding ARN: GuardDuty itself dedupes repeats into one finding (Service.Count). */
export const GUARDDUTY_FINDING: CheckDefinition = {
  checkId: 'sec.guardduty-finding',
  source: 'guardduty',
  kpi: 'security',
  isoControls: ['A.5.25', 'A.5.26'],
  requires: ['topology', 'guardduty'],
  title: 'Open GuardDuty finding',
  impact: 'GuardDuty observed activity consistent with reconnaissance, compromise or data exfiltration.',
  remediation: ['Triage the finding in the GuardDuty console (see the Security page).', 'Contain the affected resource if the activity is not expected, then archive the finding.'],
  run: (snapshot) =>
    (snapshot.guardDuty ?? []).flatMap((gd) => {
      const severity = guardDutySeverity(gd.severity);
      if (!severity) return [];
      return [
        makeDraft(GUARDDUTY_FINDING, {
          resourceType: 'guardduty-finding',
          resourceId: gd.id,
          resourceName: gd.instanceId ?? gd.type,
          resourceArn: gd.arn,
          placement: attributeResource(snapshot.topologyIndex, gd.instanceId ?? '', { vpcId: gd.vpcId }),
          severity,
          title: `GuardDuty: ${gd.title}`,
          description: `${gd.type} (GuardDuty severity ${gd.severity})`,
          observedAt: gd.updatedAt ?? snapshot.observedAt.guardduty ?? snapshot.now,
          data: { type: gd.type, severity: gd.severity, count: gd.count, instanceId: gd.instanceId, resourceType: gd.resourceType, updatedAt: gd.updatedAt },
        }),
      ];
    }),
};
