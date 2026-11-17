import { describe, it, expect } from 'vitest';
import { COST_CHECKS, COST_RULES } from './cost-checks.js';
import { buildAssessment, buildRecommendation, buildSnapshot, VPC } from '../__fixtures__/snapshot.js';

describe('cost checks', () => {
  it.each(COST_RULES.map((r) => [r.checkId, r.findingType]))('%s: fail on %s, pass otherwise', (checkId, findingType) => {
    const check = COST_CHECKS.find((c) => c.checkId === checkId);
    expect(check).toBeDefined();
    const hit = buildSnapshot({ assessment: buildAssessment([buildRecommendation({ findingType })]) });
    const miss = buildSnapshot({ assessment: buildAssessment([buildRecommendation({ findingType: 'rdsMissingMultiAz' })]) });
    const [d] = check?.run(hit) ?? [];
    expect(d).toMatchObject({ kpi: 'cost', source: 'cost', severity: 'medium', vpcId: VPC });
    expect(d.remediation.steps[0]).toBe('Downsize to t3.small');
    expect(check?.run(miss)).toEqual([]);
  });

  it('maps priority to severity (low priority -> info) and places account-level services account-wide', () => {
    const check = COST_CHECKS.find((c) => c.checkId === 'cost.savings-plan-coverage-low');
    const [d] = check?.run(buildSnapshot({ assessment: buildAssessment([buildRecommendation({ findingType: 'savingsPlanCoverageLow', resourceType: 'service', resourceId: 'ec2', priority: 'low' })]) })) ?? [];
    expect(d).toMatchObject({ severity: 'info', vpcId: 'account' });
  });
});
