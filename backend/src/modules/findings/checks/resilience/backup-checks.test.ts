import { describe, it, expect } from 'vitest';
import { BACKUP_JOB_FAILING, BACKUP_PROTECTION_GAP, RESILIENCE_RECOMMENDATION_CHECKS } from './backup-checks.js';
import { buildAssessment, buildCompliance, buildRecommendation, buildSnapshot, VPC } from '../__fixtures__/snapshot.js';

const job = (jobId: string, creationDate: string, level: 'ok' | 'warn' | 'critical') => ({
  jobId,
  resourceName: 'i-0web1',
  state: level === 'ok' ? 'COMPLETED' : 'FAILED',
  creationDate,
  threshold: { level, reason: level },
});

describe('res.backup-job-failing', () => {
  it('fail: latest job of a resource is critical -> high, placed on the resource', () => {
    const snapshot = buildSnapshot({ compliance: buildCompliance([job('j1', '2026-09-24T00:00:00Z', 'ok'), job('j2', '2026-09-25T00:00:00Z', 'critical')]) });
    expect(BACKUP_JOB_FAILING.run(snapshot)[0]).toMatchObject({ severity: 'high', vpcId: VPC, resourceId: 'i-0web1', kpi: 'resilience' });
  });

  it('pass: an older failure followed by a successful job resolves', () => {
    const snapshot = buildSnapshot({ compliance: buildCompliance([job('j1', '2026-09-24T00:00:00Z', 'critical'), job('j2', '2026-09-25T00:00:00Z', 'ok')]) });
    expect(BACKUP_JOB_FAILING.run(snapshot)).toEqual([]);
  });
});

describe('res.backup-protection-gap', () => {
  it('fail: every protection gap becomes a medium finding', () => {
    const gap = { resourceId: 'prod-db', resourceName: 'prod-db', resourceType: 'rds-instance', reason: 'not in any backup plan' };
    expect(BACKUP_PROTECTION_GAP.run(buildSnapshot({ assessment: buildAssessment([], [gap]) }))[0]).toMatchObject({ severity: 'medium', resourceId: 'prod-db', vpcId: VPC });
  });

  it('pass: no gaps', () => {
    expect(BACKUP_PROTECTION_GAP.run(buildSnapshot({ assessment: buildAssessment([]) }))).toEqual([]);
  });
});

describe('resilience recommendation checks', () => {
  it.each(RESILIENCE_RECOMMENDATION_CHECKS.map((c) => [c.checkId, c]))('%s: fail on its findingType, pass on others', (_id, check) => {
    const findingType = check.checkId === 'res.rds-single-az' ? 'rdsMissingMultiAz' : check.checkId === 'res.backup-vault-not-protected' ? 'backupVaultNotProtected' : 'restoreTestingNotConfigured';
    const hit = buildSnapshot({ assessment: buildAssessment([buildRecommendation({ findingType, resourceType: 'rds-instance', resourceId: 'prod-db' })]) });
    const miss = buildSnapshot({ assessment: buildAssessment([buildRecommendation({ findingType: 'ec2LowCpu' })]) });
    expect(check.run(hit)).toHaveLength(1);
    expect(check.run(miss)).toEqual([]);
  });
});
