import { describe, it, expect } from 'vitest';
import type { RecommendationItem } from '@ops-dashboard/shared';
import { buildNewFindingsEmbed, buildAutoRightsizeQueuedEmbed } from './discord-embeds.js';

function makeFinding(overrides: Partial<RecommendationItem> = {}): RecommendationItem {
  return {
    id: 'compute:ec2-instance:i-abc:rightsize',
    category: 'compute',
    resourceType: 'ec2-instance',
    resourceId: 'i-abc',
    resourceName: 'abc-prod-ec2-webapp',
    currentState: 'Average CPU 3% over 30 days',
    recommendedAction: 'Consider rightsizing (reduce instance size) due to excess capacity',
    estimatedMonthlySavingsUsd: 12.5,
    risk: 'low',
    priority: 'high',
    findingType: 'ec2LowCpu',
    ...overrides,
  };
}

/** `buildOpsNotificationEmbed` always emits Who (and, when set, Where/When/How) BEFORE the
 * `extra` fields — these helpers grab the per-item field by name/prefix instead of assuming index
 * 0, so these tests don't silently break if the 5W1H field ordering ever changes. */
function findItemField(fields: { name: string; value: string }[], namePrefix: string) {
  const field = fields.find((f) => f.name.startsWith(namePrefix));
  if (!field) throw new Error(`no field found with name starting with "${namePrefix}" (fields: ${fields.map((f) => f.name).join(', ')})`);
  return field;
}

describe('buildNewFindingsEmbed', () => {
  it('includes the runbook title and first diagnosis step for each finding', () => {
    const embed = buildNewFindingsEmbed([makeFinding()]);
    const field = findItemField(embed.fields, 'abc-prod-ec2-webapp');
    expect(field.value).toContain('Runbook (EC2 instance running well below its provisioned CPU)');
    expect(field.value).toContain('Check the CPU trend over the full 30 days');
  });

  it('still includes the recommendation and estimated savings text', () => {
    const embed = buildNewFindingsEmbed([makeFinding()]);
    const field = findItemField(embed.fields, 'abc-prod-ec2-webapp');
    expect(field.value).toContain('Consider rightsizing');
    expect(field.value).toContain('$12.50/month');
  });

  it('uses the correct runbook per findingType (e.g. albAllTargetsUnhealthy)', () => {
    const embed = buildNewFindingsEmbed([
      makeFinding({ findingType: 'albAllTargetsUnhealthy', resourceName: 'abc-prod-alb', category: 'networking' }),
    ]);
    const field = findItemField(embed.fields, 'abc-prod-alb');
    expect(field.value).toContain('ALL targets behind a load balancer');
  });
});

describe('buildAutoRightsizeQueuedEmbed', () => {
  it("direction 'down' cites the ec2LowCpu runbook's first escalation condition", () => {
    const embed = buildAutoRightsizeQueuedEmbed([{ instanceId: 'i-abc', name: 'abc-prod-ec2-webapp', direction: 'down' }]);
    const field = findItemField(embed.fields, 'abc-prod-ec2-webapp');
    expect(field.value).toContain('OVER-provisioned');
    expect(field.value).toContain('Escalate if:');
    expect(field.value).toContain('no maintenance window is scheduled');
  });

  it("direction 'up' cites the ec2Underprovisioned runbook's first escalation condition", () => {
    const embed = buildAutoRightsizeQueuedEmbed([{ instanceId: 'i-abc', name: 'abc-prod-ec2-webapp', direction: 'up' }]);
    const field = findItemField(embed.fields, 'abc-prod-ec2-webapp');
    expect(field.value).toContain('UNDER-provisioned');
    expect(field.value).toContain('customer-facing');
  });

  it('falls back to the raw instanceId when there is no usable Name tag', () => {
    const embed = buildAutoRightsizeQueuedEmbed([{ instanceId: 'i-abc', name: '(no Name tag)', direction: 'down' }]);
    expect(() => findItemField(embed.fields, 'i-abc')).not.toThrow();
  });
});
