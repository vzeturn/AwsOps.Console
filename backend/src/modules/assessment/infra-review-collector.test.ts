import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AssessmentReport } from '@ops-dashboard/shared';

// Task 7.2: unit test for infra-review-collector.ts (Lambda entrypoint).
// The module no longer imports config.ts — it reads process.env.AWS_REGION directly (the Lambda
// runtime always sets this) and process.env.ASSESSMENT_BUCKET_NAME (fails loud separately if
// missing). Set these 2 variables before importing the module. Mocks @aws-sdk/client-s3 (captures
// the payload sent to PutObjectCommand to assert the AssessmentReport structure) and all 7
// collectors — each collector mocked separately so one collector can be forced to reject without
// affecting the others (test case 2).
process.env.AWS_REGION = 'ap-southeast-1';
process.env.AWS_ACCOUNT_ID = '123456789012';
process.env.ASSESSMENT_BUCKET_NAME = 'test-assessment-bucket';

const s3SendMock = vi.fn();
const ec2SendMock = vi.fn();
const postAlertEmbedsMock = vi.fn();

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({ send: s3SendMock })),
  PutObjectCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'putObject', input })),
  GetObjectCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'getObject', input })),
}));

vi.mock('@aws-sdk/client-ec2', () => ({
  EC2Client: vi.fn().mockImplementation(() => ({ send: ec2SendMock })),
  CreateTagsCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'createTags', input })),
  DeleteTagsCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'deleteTags', input })),
  // fetchFamilySizes (used by Time-of-Day Sizing) calls ec2.send(new DescribeInstanceTypesCommand(...)).
  DescribeInstanceTypesCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'describeInstanceTypes', input })),
}));

vi.mock('../alerting/alertHook.js', () => ({
  postAlertEmbeds: postAlertEmbedsMock,
}));

const collectEc2Mock = vi.fn();
const collectRdsMock = vi.fn();
const collectNetworkingDataMock = vi.fn();
const getStorageDataMock = vi.fn();
const collectServerlessMock = vi.fn();
const collectSavingsPlansCoverageMock = vi.fn();
const collectBackupDataMock = vi.fn();
const collectComputeOptimizerDataMock = vi.fn();

vi.mock('../infra/ec2-collector.js', () => ({ collectEc2: collectEc2Mock }));
vi.mock('../infra/rds-collector.js', () => ({ collectRds: collectRdsMock }));
vi.mock('../infra/networking-collector.js', () => ({ collectNetworkingData: collectNetworkingDataMock }));
vi.mock('../infra/storage-collector.js', () => ({ getStorageData: getStorageDataMock }));
vi.mock('../infra/serverless-collector.js', () => ({ collectServerless: collectServerlessMock }));
vi.mock('../cost/savings-plans-collector.js', () => ({
  collectSavingsPlansCoverage: collectSavingsPlansCoverageMock,
}));
vi.mock('../compliance/backup-collector.js', () => ({ collectBackupData: collectBackupDataMock }));

const putComputedScheduleMock = vi.fn();
const getTeamOverrideMock = vi.fn();
const collectHourlyMetricsMock = vi.fn();
const getComputedScheduleMock = vi.fn();

vi.mock('../governance/s3PolicyStore.js', () => ({
  s3PolicyStore: {
    getComputedSchedule: getComputedScheduleMock,
    putComputedSchedule: putComputedScheduleMock,
    getTeamOverride: getTeamOverrideMock,
  },
}));
vi.mock('../../collectors/time-of-day-collector.js', () => ({
  collectHourlyMetrics: collectHourlyMetricsMock,
}));
vi.mock('../infra/compute-optimizer-collector.js', () => ({
  collectComputeOptimizerData: collectComputeOptimizerDataMock,
  // NORMALIZED_FINDING is a PURE constant (calls no AWS) — mocked back with the REAL value
  // matching the original file, since `infra-review-collector.ts` (`decideRightsizing`) compares
  // directly against this constant.
  NORMALIZED_FINDING: {
    UNDERPROVISIONED: 'UNDERPROVISIONED',
    OVERPROVISIONED: 'OVERPROVISIONED',
    OPTIMIZED: 'OPTIMIZED',
    NOT_OPTIMIZED: 'NOTOPTIMIZED',
  },
}));

// Import after the mocks are declared (vi.mock is hoisted to the top by vitest).
const { handler } = await import('./infra-review-collector.js');

const EMPTY_NETWORKING = { natGateways: [], albs: [] };
const EMPTY_STORAGE = { s3Buckets: [], ebsVolumes: [] };
/** Account not yet enrolled in Compute Optimizer -> all rightsizing uses the fallback heuristic (avg+max CPU). */
const NOT_ENROLLED_COMPUTE_OPTIMIZER_DATA = {
  enrolled: false,
  ec2FindingByInstanceId: new Map<string, string>(),
  rdsFindingByDbInstanceId: new Map<string, string>(),
  ec2FindingReasonCodesByInstanceId: new Map<string, string[]>(),
};
const EMPTY_BACKUP_DATA = {
  backupPlans: [],
  recentBackupJobs: [],
  dlmPolicies: [],
  resourceArnsWithBackupPlan: [] as string[],
  resourceArnsWithDlmPolicy: [] as string[],
  backupVaults: [] as { vaultName: string; vaultArn: string; numberOfRecoveryPoints: number; locked: boolean; hasDeletionProtection: boolean }[],
  restoreTestingPlans: [] as { planName: string; planArn: string; scheduleExpression: string; lastExecutionTime: string | null }[],
};

/** EC2 with average AND max CPU both low (below threshold) -> generates a rightsizing
 * RecommendationItem via the fallback heuristic (Compute Optimizer not enrolled in the default test). */
const EC2_LOW_CPU_ITEM = {
  instanceId: 'i-lowcpu1',
  name: 'web-1',
  region: 'ap-southeast-1',
  state: 'running',
  instanceType: 't3.micro',
  avgCpuPercent: 5,
  maxCpuPercent: 8, // below the 40% fallback threshold -> still a valid rightsizing candidate
  avgNetworkInBytes: 1000,
  avgNetworkOutBytes: 1000,
};

/** Production RDS missing Multi-AZ -> generates an availability risk RecommendationItem (high risk). */
const RDS_PROD_NO_MULTI_AZ_ITEM = {
  dbInstanceIdentifier: 'db-prod-1',
  region: 'ap-southeast-1',
  engine: 'postgres',
  dbInstanceClass: 'db.t3.micro',
  multiAz: false,
  allocatedStorageGb: 20,
  avgCpuPercent: 50, // above the rightsizing threshold -> doesn't generate an additional CPU recommendation
  maxCpuPercent: 80,
  avgConnections: 10, // above the rightsizing threshold -> doesn't generate an additional connections recommendation
  isProduction: true,
};

function mockAllCollectorsWithValidData(): void {
  collectEc2Mock.mockResolvedValue([EC2_LOW_CPU_ITEM]);
  collectRdsMock.mockResolvedValue([RDS_PROD_NO_MULTI_AZ_ITEM]);
  collectNetworkingDataMock.mockResolvedValue(EMPTY_NETWORKING);
  getStorageDataMock.mockResolvedValue(EMPTY_STORAGE);
  collectServerlessMock.mockResolvedValue([]);
  collectSavingsPlansCoverageMock.mockResolvedValue([]);
  collectBackupDataMock.mockResolvedValue(EMPTY_BACKUP_DATA);
  collectComputeOptimizerDataMock.mockResolvedValue(NOT_ENROLLED_COMPUTE_OPTIMIZER_DATA);
  s3SendMock.mockResolvedValue({});
  // Default: no clear peak pattern (empty metrics) + no team override -> time-of-day
  // sizing action:'none' for every eligible instance (hasScheduleTag + running), keeps the existing
  // EC2_AutoRightsize tests' behavior unchanged (only asserts ec2SendMock/postAlertEmbedsMock).
  collectHourlyMetricsMock.mockResolvedValue([]);
  getTeamOverrideMock.mockResolvedValue({ scaleMarginPercent: 0, minInstanceType: undefined, maxInstanceType: undefined, optOut: false });
  putComputedScheduleMock.mockResolvedValue(undefined);
}

beforeEach(() => {
  collectEc2Mock.mockReset();
  collectRdsMock.mockReset();
  collectNetworkingDataMock.mockReset();
  getStorageDataMock.mockReset();
  collectServerlessMock.mockReset();
  collectSavingsPlansCoverageMock.mockReset();
  collectBackupDataMock.mockReset();
  collectComputeOptimizerDataMock.mockReset();
  s3SendMock.mockReset();
  ec2SendMock.mockReset();
  ec2SendMock.mockResolvedValue({});
  postAlertEmbedsMock.mockReset();
  postAlertEmbedsMock.mockResolvedValue(undefined);
  collectHourlyMetricsMock.mockReset();
  getTeamOverrideMock.mockReset();
  putComputedScheduleMock.mockReset();
  getComputedScheduleMock.mockReset();
  getComputedScheduleMock.mockResolvedValue(undefined); // Default: no previous schedule exists yet (first run).
});

const PRIORITY_SCORE: Record<string, number> = { low: 0, medium: 1, high: 2 };

/** Finds the PutObjectCommand call (the NEW report being written) in `s3SendMock.mock.calls` — does
 * NOT use `calls[0]` because the handler now also calls GetObjectCommand (reads the OLD report to
 * diff new findings, see `readPreviousRecommendations`) BEFORE PutObjectCommand, so the index order
 * is no longer fixed. */
function getPutCommand(): { __type: string; input: { Bucket: string; Key: string; Body: string; ContentType: string } } {
  const call = s3SendMock.mock.calls.find((c) => (c[0] as { __type: string }).__type === 'putObject');
  if (!call) throw new Error('No PutObjectCommand call found in s3SendMock.mock.calls');
  return call[0] as { __type: string; input: { Bucket: string; Key: string; Body: string; ContentType: string } };
}

describe('infra-review-collector handler', () => {
  it('writes a fully-structured AssessmentReport to S3, recommendations sorted by descending priority', async () => {
    mockAllCollectorsWithValidData();

    const result = await handler();

    expect(result).toEqual({ ok: true });
    // 2 calls: GetObjectCommand (reads the old report to diff new findings, returns {} empty here
    // -> treated as no old report existing) + PutObjectCommand (writes the new report) — see `readPreviousRecommendations`.
    expect(s3SendMock).toHaveBeenCalledTimes(2);

    const putCommand = getPutCommand() as unknown as {
      __type: string;
      input: { Bucket: string; Key: string; Body: string; ContentType: string };
    };
    expect(putCommand.__type).toBe('putObject');
    expect(putCommand.input.Bucket).toBe('test-assessment-bucket');
    expect(putCommand.input.Key).toBe('assessment-report.json');
    expect(putCommand.input.ContentType).toBe('application/json');

    const report = JSON.parse(putCommand.input.Body) as AssessmentReport;

    // Has all the AssessmentReport structure fields (Requirement 7.1, 7.2).
    expect(report).toHaveProperty('account');
    expect(report).toHaveProperty('region');
    expect(report).toHaveProperty('periodStart');
    expect(report).toHaveProperty('periodEnd');
    expect(report).toHaveProperty('generatedAt');
    expect(report).toHaveProperty('compute.lambda');
    expect(report).toHaveProperty('database');
    expect(report).toHaveProperty('networking.natGateways');
    expect(report).toHaveProperty('storage.s3Buckets');
    expect(report).toHaveProperty('storage.ebsVolumes');
    expect(report).toHaveProperty('savingsPlans.coverageByService');
    expect(report).toHaveProperty('backup.protectionGaps');
    expect(report).toHaveProperty('recommendations');

    expect(report.region).toBe('ap-southeast-1');
    expect(typeof report.generatedAt).toBe('string');
    expect(report.generatedAt.length).toBeGreaterThan(0);

    // At least 2 recommendations with different risks: low EC2 CPU (risk low) and RDS missing
    // Multi-AZ on production (risk high) — Requirement 7.1, 7.2.
    expect(report.recommendations.length).toBeGreaterThanOrEqual(2);
    const risks = report.recommendations.map((r) => r.risk);
    expect(risks).toContain('low');
    expect(risks).toContain('high');

    // recommendations are sorted by descending priority: every adjacent pair's priorityScore does
    // not decrease (Requirement 7.4).
    for (let i = 0; i < report.recommendations.length - 1; i++) {
      const currentScore = PRIORITY_SCORE[report.recommendations[i].priority];
      const nextScore = PRIORITY_SCORE[report.recommendations[i + 1].priority];
      expect(currentScore).toBeGreaterThanOrEqual(nextScore);
    }

    // Protection gap for the production RDS missing a backup plan (resourceArnsWithBackupPlan is empty).
    expect(report.backup.protectionGaps.length).toBeGreaterThanOrEqual(1);

    // EMPTY_BACKUP_DATA.restoreTestingPlans=[] -> always generates a restoreTestingNotConfigured
    // finding (ISO 27001 A.17) — there are no backupVaults, so there is NO backupVaultNotProtected
    // finding (an empty/nonexistent vault doesn't need a warning, avoids meaningless noise).
    const findingTypes = report.recommendations.map((r) => r.findingType);
    expect(findingTypes).toContain('restoreTestingNotConfigured');
    expect(findingTypes).not.toContain('backupVaultNotProtected');
  });

  it('backup vault has recovery points but no deletion protection -> generates finding backupVaultNotProtected (ISO 27001 A.12.3)', async () => {
    mockAllCollectorsWithValidData();
    collectBackupDataMock.mockResolvedValue({
      ...EMPTY_BACKUP_DATA,
      backupVaults: [
        {
          vaultName: 'ACME_Vault',
          vaultArn: 'arn:aws:backup:ap-southeast-1:123456789012:backup-vault:ACME_Vault',
          numberOfRecoveryPoints: 122,
          locked: false,
          hasDeletionProtection: false,
        },
      ],
      restoreTestingPlans: [
        {
          planName: 'abc_prod_restore_testing_plan',
          planArn: 'arn:aws:backup:ap-southeast-1:123456789012:restore-testing-plan:abc_prod_restore_testing_plan-abc',
          scheduleExpression: 'cron(0 21 ? * SUN *)',
          lastExecutionTime: null,
        },
      ],
    });

    const result = await handler();
    expect(result).toEqual({ ok: true });

    const putCommand = getPutCommand() as unknown as { input: { Body: string } };
    const report = JSON.parse(putCommand.input.Body) as AssessmentReport;

    const vaultRec = report.recommendations.find((r) => r.findingType === 'backupVaultNotProtected');
    expect(vaultRec).toBeDefined();
    expect(vaultRec?.resourceId).toBe('ACME_Vault');
    expect(vaultRec?.risk).toBe('high');

    // A restore testing plan already exists -> does NOT generate finding restoreTestingNotConfigured.
    const findingTypes = report.recommendations.map((r) => r.findingType);
    expect(findingTypes).not.toContain('restoreTestingNotConfigured');
  });

  it('empty backup vault (0 recovery points) with no deletion protection -> does NOT generate a finding (avoids noise)', async () => {
    mockAllCollectorsWithValidData();
    collectBackupDataMock.mockResolvedValue({
      ...EMPTY_BACKUP_DATA,
      backupVaults: [
        {
          vaultName: 'Default',
          vaultArn: 'arn:aws:backup:ap-southeast-1:123456789012:backup-vault:Default',
          numberOfRecoveryPoints: 0,
          locked: false,
          hasDeletionProtection: false,
        },
      ],
    });

    const result = await handler();
    expect(result).toEqual({ ok: true });

    const putCommand = getPutCommand() as unknown as { input: { Body: string } };
    const report = JSON.parse(putCommand.input.Body) as AssessmentReport;

    const findingTypes = report.recommendations.map((r) => r.findingType);
    expect(findingTypes).not.toContain('backupVaultNotProtected');
  });

  it('1 collector (collectEc2) rejecting still completes the report — no throw, other parts remain complete', async () => {
    mockAllCollectorsWithValidData();
    collectEc2Mock.mockRejectedValue(new Error('AccessDenied: ec2:DescribeInstances'));

    const result = await handler();

    expect(result).toEqual({ ok: true });
    expect(s3SendMock).toHaveBeenCalledTimes(2);

    const putCommand = getPutCommand() as unknown as { input: { Body: string } };
    const report = JSON.parse(putCommand.input.Body) as AssessmentReport;

    // The RDS part (collected successfully) remains complete: Multi-AZ recommendation + protection gap.
    const risks = report.recommendations.map((r) => r.risk);
    expect(risks).toContain('high');
    expect(report.backup.protectionGaps.length).toBeGreaterThanOrEqual(1);

    // The EC2-related part (rejected) does not appear: no recommendation has
    // resourceType 'ec2-instance' (the report is still written, only the failed data section is empty).
    const ec2Recommendations = report.recommendations.filter((r) => r.resourceType === 'ec2-instance');
    expect(ec2Recommendations).toEqual([]);
  });

  describe('rightsizing EC2/RDS — prioritizes AWS Compute Optimizer, fallback heuristic when no data', () => {
    it('Compute Optimizer confirms Underprovisioned for a low average-CPU EC2 -> generates finding ec2Underprovisioned (risk high), does NOT generate ec2LowCpu', async () => {
      mockAllCollectorsWithValidData();
      // Low average CPU (5%) BUT Compute Optimizer confirms Underprovisioned -> must trust
      // Compute Optimizer, do NOT recommend rightsizing to reduce size — this is the real
      // case i-0a1b2c3d4e5f60001 discovered in production.
      collectComputeOptimizerDataMock.mockResolvedValue({
        enrolled: true,
        // The mocked value must EXACTLY match the NORMALIZED form the real collector returns (see
        // NORMALIZED_FINDING/normalizeFinding in compute-optimizer-collector.ts).
        ec2FindingByInstanceId: new Map([['i-lowcpu1', 'UNDERPROVISIONED']]),
        rdsFindingByDbInstanceId: new Map<string, string>(),
      });

      const result = await handler();
      expect(result).toEqual({ ok: true });

      const putCommand = getPutCommand() as unknown as { input: { Body: string } };
      const report = JSON.parse(putCommand.input.Body) as AssessmentReport;

      const findingTypes = report.recommendations.map((r) => r.findingType);
      expect(findingTypes).toContain('ec2Underprovisioned');
      expect(findingTypes).not.toContain('ec2LowCpu');

      const underprovisionedRec = report.recommendations.find((r) => r.findingType === 'ec2Underprovisioned');
      expect(underprovisionedRec?.risk).toBe('high');
      expect(underprovisionedRec?.resourceId).toBe('i-lowcpu1');
    });

    it('Compute Optimizer confirms Overprovisioned for EC2 -> generates finding ec2LowCpu even when average/max CPU is unclear (trusts Compute Optimizer, no fallback needed)', async () => {
      mockAllCollectorsWithValidData();
      collectComputeOptimizerDataMock.mockResolvedValue({
        enrolled: true,
        ec2FindingByInstanceId: new Map([['i-lowcpu1', 'OVERPROVISIONED']]),
        rdsFindingByDbInstanceId: new Map<string, string>(),
      });

      const result = await handler();
      const putCommand = getPutCommand() as unknown as { input: { Body: string } };
      const report = JSON.parse(putCommand.input.Body) as AssessmentReport;

      expect(result).toEqual({ ok: true });
      const rec = report.recommendations.find((r) => r.findingType === 'ec2LowCpu');
      expect(rec).toBeDefined();
      expect(rec?.currentState).toContain('Compute Optimizer');
    });

    it('Compute Optimizer confirms Optimized for a low average-CPU EC2 -> does NOT generate ec2LowCpu (trusts Compute Optimizer over the heuristic)', async () => {
      mockAllCollectorsWithValidData();
      collectComputeOptimizerDataMock.mockResolvedValue({
        enrolled: true,
        ec2FindingByInstanceId: new Map([['i-lowcpu1', 'OPTIMIZED']]),
        rdsFindingByDbInstanceId: new Map<string, string>(),
      });

      const result = await handler();
      const putCommand = getPutCommand() as unknown as { input: { Body: string } };
      const report = JSON.parse(putCommand.input.Body) as AssessmentReport;

      expect(result).toEqual({ ok: true });
      const findingTypes = report.recommendations.map((r) => r.findingType);
      expect(findingTypes).not.toContain('ec2LowCpu');
      expect(findingTypes).not.toContain('ec2Underprovisioned');
    });

    it('Compute Optimizer not enrolled (fallback heuristic) + EC2 low average CPU BUT high max (burst workload) -> does NOT generate ec2LowCpu (avoids a false positive like i-0a1b2c3d4e5f60001)', async () => {
      mockAllCollectorsWithValidData();
      collectEc2Mock.mockResolvedValue([
        { ...EC2_LOW_CPU_ITEM, instanceId: 'i-burst1', avgCpuPercent: 3, maxCpuPercent: 100 },
      ]);
      // collectComputeOptimizerDataMock already mocks NOT_ENROLLED in mockAllCollectorsWithValidData()

      const result = await handler();
      const putCommand = getPutCommand() as unknown as { input: { Body: string } };
      const report = JSON.parse(putCommand.input.Body) as AssessmentReport;

      expect(result).toEqual({ ok: true });
      const ec2Recs = report.recommendations.filter((r) => r.resourceId === 'i-burst1');
      expect(ec2Recs.map((r) => r.findingType)).not.toContain('ec2LowCpu');
      expect(ec2Recs.map((r) => r.findingType)).not.toContain('ec2Underprovisioned');
    });

    it('Compute Optimizer not enrolled (fallback heuristic) + EC2 average AND max CPU both low -> generates ec2LowCpu via the fallback (lower confidence, stated explicitly in currentState)', async () => {
      mockAllCollectorsWithValidData();

      const result = await handler();
      const putCommand = getPutCommand() as unknown as { input: { Body: string } };
      const report = JSON.parse(putCommand.input.Body) as AssessmentReport;

      expect(result).toEqual({ ok: true });
      const rec = report.recommendations.find((r) => r.findingType === 'ec2LowCpu');
      expect(rec).toBeDefined();
      expect(rec?.resourceId).toBe('i-lowcpu1');
      expect(rec?.currentState).toContain('fallback heuristic');
    });

    it('Compute Optimizer confirms Underprovisioned for RDS -> generates finding rdsUnderprovisioned (risk high), does NOT generate rdsLowCpu', async () => {
      mockAllCollectorsWithValidData();
      collectRdsMock.mockResolvedValue([{ ...RDS_PROD_NO_MULTI_AZ_ITEM, avgCpuPercent: 5, maxCpuPercent: 6 }]);
      collectComputeOptimizerDataMock.mockResolvedValue({
        enrolled: true,
        ec2FindingByInstanceId: new Map<string, string>(),
        rdsFindingByDbInstanceId: new Map([['db-prod-1', 'UNDERPROVISIONED']]),
      });

      const result = await handler();
      const putCommand = getPutCommand() as unknown as { input: { Body: string } };
      const report = JSON.parse(putCommand.input.Body) as AssessmentReport;

      expect(result).toEqual({ ok: true });
      const findingTypes = report.recommendations.map((r) => r.findingType);
      expect(findingTypes).toContain('rdsUnderprovisioned');
      expect(findingTypes).not.toContain('rdsLowCpu');
    });

    it('Compute Optimizer confirms Overprovisioned for EC2 but findingReasonCodes is ONLY an EBS reason (not CPU/Memory) -> does NOT produce ec2LowCpu via Compute Optimizer, falls back to the fallback heuristic (real case i-0a1b2c3d4e5f60003)', async () => {
      mockAllCollectorsWithValidData();
      // EC2_LOW_CPU_ITEM has avg=5/max=8 (below the fallback threshold) -> the fallback heuristic
      // still treats it as a valid rightsizing candidate, BUT currentState must clearly state it
      // used the fallback (not a direct Compute Optimizer verdict), because the original
      // OVERPROVISIONED reason has nothing to do with compute size.
      collectComputeOptimizerDataMock.mockResolvedValue({
        enrolled: true,
        ec2FindingByInstanceId: new Map([['i-lowcpu1', 'OVERPROVISIONED']]),
        rdsFindingByDbInstanceId: new Map<string, string>(),
        ec2FindingReasonCodesByInstanceId: new Map([['i-lowcpu1', ['EBSThroughputOverprovisioned']]]),
      });

      const result = await handler();
      const putCommand = getPutCommand() as unknown as { input: { Body: string } };
      const report = JSON.parse(putCommand.input.Body) as AssessmentReport;

      expect(result).toEqual({ ok: true });
      const rec = report.recommendations.find((r) => r.findingType === 'ec2LowCpu' && r.resourceId === 'i-lowcpu1');
      expect(rec).toBeDefined();
      // Must be the fallback message (contains "fallback heuristic"), NOT the direct Compute
      // Optimizer verdict (contains "OVERPROVISIONED").
      expect(rec?.currentState).toContain('fallback heuristic');
      expect(rec?.currentState).not.toContain('OVERPROVISIONED');
    });

    it('Compute Optimizer confirms Overprovisioned for EC2 with findingReasonCodes including BOTH EBS AND CPU -> still trusts Compute Optimizer (not excluded, since a real CPU code is present)', async () => {
      mockAllCollectorsWithValidData();
      collectComputeOptimizerDataMock.mockResolvedValue({
        enrolled: true,
        ec2FindingByInstanceId: new Map([['i-lowcpu1', 'OVERPROVISIONED']]),
        rdsFindingByDbInstanceId: new Map<string, string>(),
        ec2FindingReasonCodesByInstanceId: new Map([['i-lowcpu1', ['EBSThroughputOverprovisioned', 'CPUOverprovisioned']]]),
      });

      const result = await handler();
      const putCommand = getPutCommand() as unknown as { input: { Body: string } };
      const report = JSON.parse(putCommand.input.Body) as AssessmentReport;

      expect(result).toEqual({ ok: true });
      const rec = report.recommendations.find((r) => r.findingType === 'ec2LowCpu' && r.resourceId === 'i-lowcpu1');
      expect(rec).toBeDefined();
      expect(rec?.currentState).toContain('OVERPROVISIONED');
    });

    it('collectComputeOptimizerData rejects -> treated as not enrolled (fallback heuristic applies to everything), does not throw', async () => {
      mockAllCollectorsWithValidData();
      collectComputeOptimizerDataMock.mockRejectedValue(new Error('AccessDenied: compute-optimizer:GetEnrollmentStatus'));

      const result = await handler();
      const putCommand = getPutCommand() as unknown as { input: { Body: string } };
      const report = JSON.parse(putCommand.input.Body) as AssessmentReport;

      expect(result).toEqual({ ok: true });
      // EC2_LOW_CPU_ITEM has avg=5/max=8, both below the fallback threshold -> still produces ec2LowCpu via fallback.
      const findingTypes = report.recommendations.map((r) => r.findingType);
      expect(findingTypes).toContain('ec2LowCpu');
    });
  });

  describe('EC2_AutoRightsize (evaluator) — relies only on a real Compute Optimizer confirmation, adds/removes a tag via ec2:CreateTags/DeleteTags', () => {
    /** EC2 with an on/off schedule tag, NOT exempt, NO pending/cooldown — instance is in scope
     * and ready for the evaluator to assess. */
    const SCHEDULED_ITEM = {
      ...EC2_LOW_CPU_ITEM,
      instanceId: 'i-scheduled1',
      hasScheduleTag: true,
      autoRightsizeExempt: false,
      pendingAutoRightsizeDirection: undefined,
      lastAutoRightsizeDate: undefined,
    };

    it('Compute Optimizer confirms Overprovisioned for an instance with a schedule tag -> CreateTags pending-auto-rightsize=down + alert hub notify', async () => {
      mockAllCollectorsWithValidData();
      collectEc2Mock.mockResolvedValue([SCHEDULED_ITEM]);
      collectComputeOptimizerDataMock.mockResolvedValue({
        enrolled: true,
        ec2FindingByInstanceId: new Map([['i-scheduled1', 'OVERPROVISIONED']]),
        rdsFindingByDbInstanceId: new Map<string, string>(),
        ec2FindingReasonCodesByInstanceId: new Map<string, string[]>(),
      });

      const result = await handler();

      expect(result).toEqual({ ok: true });
      const createTagsCall = ec2SendMock.mock.calls.find((c) => (c[0] as { __type: string }).__type === 'createTags');
      expect(createTagsCall).toBeDefined();
      const input = (createTagsCall![0] as { input: { Resources: string[]; Tags: { Key: string; Value: string }[] } }).input;
      expect(input.Resources).toEqual(['i-scheduled1']);
      expect(input.Tags).toEqual([{ Key: 'OpsDashboard:PendingAutoRightsize', Value: 'down' }]);
      expect(postAlertEmbedsMock).toHaveBeenCalledTimes(1);
    });

    it('Compute Optimizer confirms Underprovisioned -> CreateTags pending-auto-rightsize=up', async () => {
      mockAllCollectorsWithValidData();
      collectEc2Mock.mockResolvedValue([SCHEDULED_ITEM]);
      collectComputeOptimizerDataMock.mockResolvedValue({
        enrolled: true,
        ec2FindingByInstanceId: new Map([['i-scheduled1', 'UNDERPROVISIONED']]),
        rdsFindingByDbInstanceId: new Map<string, string>(),
        ec2FindingReasonCodesByInstanceId: new Map<string, string[]>(),
      });

      await handler();

      const createTagsCall = ec2SendMock.mock.calls.find((c) => (c[0] as { __type: string }).__type === 'createTags');
      const input = (createTagsCall![0] as { input: { Tags: { Key: string; Value: string }[] } }).input;
      expect(input.Tags).toEqual([{ Key: 'OpsDashboard:PendingAutoRightsize', Value: 'up' }]);
    });

    it('instance without a schedule:start tag -> does NOT CreateTags even if Compute Optimizer confirms Overprovisioned', async () => {
      mockAllCollectorsWithValidData();
      collectEc2Mock.mockResolvedValue([{ ...SCHEDULED_ITEM, hasScheduleTag: false }]);
      collectComputeOptimizerDataMock.mockResolvedValue({
        enrolled: true,
        ec2FindingByInstanceId: new Map([['i-scheduled1', 'OVERPROVISIONED']]),
        rdsFindingByDbInstanceId: new Map<string, string>(),
        ec2FindingReasonCodesByInstanceId: new Map<string, string[]>(),
      });

      await handler();

      expect(ec2SendMock.mock.calls.some((c) => (c[0] as { __type: string }).__type === 'createTags')).toBe(false);
      expect(postAlertEmbedsMock).not.toHaveBeenCalled();
    });

    it('instance with an exempt tag -> does NOT CreateTags', async () => {
      mockAllCollectorsWithValidData();
      collectEc2Mock.mockResolvedValue([{ ...SCHEDULED_ITEM, autoRightsizeExempt: true }]);
      collectComputeOptimizerDataMock.mockResolvedValue({
        enrolled: true,
        ec2FindingByInstanceId: new Map([['i-scheduled1', 'OVERPROVISIONED']]),
        rdsFindingByDbInstanceId: new Map<string, string>(),
        ec2FindingReasonCodesByInstanceId: new Map<string, string[]>(),
      });

      await handler();

      expect(ec2SendMock.mock.calls.some((c) => (c[0] as { __type: string }).__type === 'createTags')).toBe(false);
    });

    it('Compute Optimizer confirms nothing (OPTIMIZED) but the instance currently has a pending tag -> DeleteTags (CO changed its mind)', async () => {
      mockAllCollectorsWithValidData();
      collectEc2Mock.mockResolvedValue([{ ...SCHEDULED_ITEM, pendingAutoRightsizeDirection: 'down' as const }]);
      collectComputeOptimizerDataMock.mockResolvedValue({
        enrolled: true,
        ec2FindingByInstanceId: new Map([['i-scheduled1', 'OPTIMIZED']]),
        rdsFindingByDbInstanceId: new Map<string, string>(),
        ec2FindingReasonCodesByInstanceId: new Map<string, string[]>(),
      });

      await handler();

      const deleteTagsCall = ec2SendMock.mock.calls.find((c) => (c[0] as { __type: string }).__type === 'deleteTags');
      expect(deleteTagsCall).toBeDefined();
      expect((deleteTagsCall![0] as { input: { Resources: string[] } }).input.Resources).toEqual(['i-scheduled1']);
      // clearPending does NOT send an alert hub notify (only setPending notifies — see buildAutoRightsizeQueuedEmbed).
      expect(postAlertEmbedsMock).not.toHaveBeenCalled();
    });

    it('already has a pending in the CURRENT correct direction -> does NOT CreateTags/DeleteTags again (idempotent), does NOT notify again', async () => {
      mockAllCollectorsWithValidData();
      collectEc2Mock.mockResolvedValue([{ ...SCHEDULED_ITEM, pendingAutoRightsizeDirection: 'down' as const }]);
      collectComputeOptimizerDataMock.mockResolvedValue({
        enrolled: true,
        ec2FindingByInstanceId: new Map([['i-scheduled1', 'OVERPROVISIONED']]),
        rdsFindingByDbInstanceId: new Map<string, string>(),
        ec2FindingReasonCodesByInstanceId: new Map<string, string[]>(),
      });

      await handler();

      expect(ec2SendMock).not.toHaveBeenCalled();
      expect(postAlertEmbedsMock).not.toHaveBeenCalled();
    });

    it('within the cooldown period -> does NOT CreateTags even if Compute Optimizer confirms a new direction', async () => {
      mockAllCollectorsWithValidData();
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      collectEc2Mock.mockResolvedValue([{ ...SCHEDULED_ITEM, lastAutoRightsizeDate: yesterday }]);
      collectComputeOptimizerDataMock.mockResolvedValue({
        enrolled: true,
        ec2FindingByInstanceId: new Map([['i-scheduled1', 'OVERPROVISIONED']]),
        rdsFindingByDbInstanceId: new Map<string, string>(),
        ec2FindingReasonCodesByInstanceId: new Map<string, string[]>(),
      });

      await handler();

      expect(ec2SendMock.mock.calls.some((c) => (c[0] as { __type: string }).__type === 'createTags')).toBe(false);
    });

    it('CreateTags throws an error -> does not throw out to the handler, report still writes successfully', async () => {
      mockAllCollectorsWithValidData();
      collectEc2Mock.mockResolvedValue([SCHEDULED_ITEM]);
      collectComputeOptimizerDataMock.mockResolvedValue({
        enrolled: true,
        ec2FindingByInstanceId: new Map([['i-scheduled1', 'OVERPROVISIONED']]),
        rdsFindingByDbInstanceId: new Map<string, string>(),
        ec2FindingReasonCodesByInstanceId: new Map<string, string[]>(),
      });
      ec2SendMock.mockImplementation((command: { __type: string }) => {
        if (command.__type === 'createTags') return Promise.reject(new Error('AccessDenied'));
        return Promise.resolve({});
      });

      const result = await handler();

      expect(result).toEqual({ ok: true });
    });
  });

  describe('Time-of-Day Sizing — only acts when Compute Optimizer has NO opinion (coDirection=none)', () => {
    const TIME_OF_DAY_ITEM = {
      ...EC2_LOW_CPU_ITEM,
      instanceId: 'i-tod1',
      hasScheduleTag: true,
      autoRightsizeExempt: false,
      pendingAutoRightsizeDirection: undefined,
      lastAutoRightsizeDate: undefined,
      tagsRaw: [],
    };

    it('coDirection=none, no clear peak pattern -> putComputedSchedule({action:"none"}), does not call fetchFamilySizes', async () => {
      mockAllCollectorsWithValidData();
      collectEc2Mock.mockResolvedValue([TIME_OF_DAY_ITEM]);
      collectHourlyMetricsMock.mockResolvedValueOnce([]); // empty metrics -> analyzePeakWindows returns empty -> action:'none'

      await handler();

      expect(putComputedScheduleMock).toHaveBeenCalledWith('i-tod1', { action: 'none' });
      // fetchFamilySizes calls ec2.send(DescribeInstanceTypesCommand) — no such command should
      // appear in ec2SendMock when action is 'none' (only createTags/deleteTags from EC2_AutoRightsize).
      expect(ec2SendMock.mock.calls.every((c) => (c[0] as { __type?: string }).__type !== 'describeInstanceTypes')).toBe(true);
    });

    it('Compute Optimizer already has an opinion (coDirection != none) for the instance -> does NOT call collectHourlyMetrics (skips early)', async () => {
      mockAllCollectorsWithValidData();
      collectEc2Mock.mockResolvedValue([TIME_OF_DAY_ITEM]);
      collectComputeOptimizerDataMock.mockResolvedValue({
        enrolled: true,
        ec2FindingByInstanceId: new Map([['i-tod1', 'OVERPROVISIONED']]),
        rdsFindingByDbInstanceId: new Map<string, string>(),
        ec2FindingReasonCodesByInstanceId: new Map<string, string[]>(),
      });

      await handler();

      expect(collectHourlyMetricsMock).not.toHaveBeenCalled();
      expect(putComputedScheduleMock).not.toHaveBeenCalled();
    });

    it('teamOverride.optOut=true -> does NOT write a schedule (skips entirely, neither putComputedSchedule({action:"none"}) nor schedulePeak)', async () => {
      mockAllCollectorsWithValidData();
      collectEc2Mock.mockResolvedValue([TIME_OF_DAY_ITEM]);
      getTeamOverrideMock.mockResolvedValue({ scaleMarginPercent: 0, minInstanceType: undefined, maxInstanceType: undefined, optOut: true });

      await handler();

      expect(putComputedScheduleMock).not.toHaveBeenCalled();
    });

    it('instance without a schedule tag (hasScheduleTag=false) -> does NOT call collectHourlyMetrics/putComputedSchedule', async () => {
      mockAllCollectorsWithValidData();
      collectEc2Mock.mockResolvedValue([{ ...TIME_OF_DAY_ITEM, hasScheduleTag: false }]);

      await handler();

      expect(collectHourlyMetricsMock).not.toHaveBeenCalled();
      expect(putComputedScheduleMock).not.toHaveBeenCalled();
    });

    it('clear peak pattern -> computes REAL peakType/offPeakType from fetchFamilySizes (NOT the placeholder currentType), writes putComputedSchedule({action:"schedulePeak", peakType, offPeakType, windows})', async () => {
      mockAllCollectorsWithValidData();
      collectEc2Mock.mockResolvedValue([{ ...TIME_OF_DAY_ITEM, instanceType: 't3.large' }]);
      // 2 data points on the same day, with a large enough p75 gap (>= MIN_PEAK_OFFPEAK_RATIO=2.0)
      // -> analyzePeakWindows returns 1 valid PeakWindow -> decideTimeOfDaySizing returns action:'schedulePeak'.
      collectHourlyMetricsMock.mockResolvedValueOnce([
        { dayOfWeek: 1, hour: 9, p75CpuPercent: 80 },
        { dayOfWeek: 1, hour: 2, p75CpuPercent: 10 },
      ]);
      // fetchFamilySizes calls ec2.send(DescribeInstanceTypesCommand) — the mock EC2Client returns
      // real family sizes for family "t3" (smaller: t3.medium, current: t3.large, larger: t3.xlarge).
      ec2SendMock.mockImplementation((command: { __type?: string }) => {
        if (command.__type === 'createTags' || command.__type === 'deleteTags') return Promise.resolve({});
        return Promise.resolve({
          InstanceTypes: [
            { InstanceType: 't3.medium', VCpuInfo: { DefaultVCpus: 2 }, MemoryInfo: { SizeInMiB: 4096 }, ProcessorInfo: { SupportedArchitectures: ['x86_64'] } },
            { InstanceType: 't3.large', VCpuInfo: { DefaultVCpus: 2 }, MemoryInfo: { SizeInMiB: 8192 }, ProcessorInfo: { SupportedArchitectures: ['x86_64'] } },
            { InstanceType: 't3.xlarge', VCpuInfo: { DefaultVCpus: 4 }, MemoryInfo: { SizeInMiB: 16384 }, ProcessorInfo: { SupportedArchitectures: ['x86_64'] } },
          ],
        });
      });

      await handler();

      expect(putComputedScheduleMock).toHaveBeenCalledWith(
        'i-tod1',
        expect.objectContaining({
          action: 'schedulePeak',
          peakType: 't3.xlarge',
          offPeakType: 't3.medium',
        }),
      );
      // Confirms it is NO LONGER the placeholder (currentType='t3.large') — this is exactly the
      // risk flagged by reviewer Task 3: peakType/offPeakType MUST be overwritten with real values.
      const call = putComputedScheduleMock.mock.calls.find((c) => c[0] === 'i-tod1');
      expect(call?.[1].peakType).not.toBe('t3.large');
      expect(call?.[1].offPeakType).not.toBe('t3.large');
    });

    it('1 instance failing (collectHourlyMetrics rejects) does not block processing other instances — per-instance error isolation', async () => {
      mockAllCollectorsWithValidData();
      const OTHER_ITEM = { ...TIME_OF_DAY_ITEM, instanceId: 'i-tod2' };
      collectEc2Mock.mockResolvedValue([TIME_OF_DAY_ITEM, OTHER_ITEM]);
      collectHourlyMetricsMock.mockImplementation((_cw: unknown, instanceId: string) => {
        if (instanceId === 'i-tod1') return Promise.reject(new Error('CloudWatch throttled'));
        return Promise.resolve([]);
      });

      const result = await handler();

      expect(result).toEqual({ ok: true });
      // i-tod1 fails -> no putComputedSchedule for it; i-tod2 still processes normally -> action:'none'.
      expect(putComputedScheduleMock).toHaveBeenCalledWith('i-tod2', { action: 'none' });
      expect(putComputedScheduleMock.mock.calls.some((c) => c[0] === 'i-tod1')).toBe(false);
    });

    it('Fix round 2: instance is CURRENTLY at peakType (t3.xlarge) from a previous resize, the old schedule has a saved baselineType=t3.large -> re-reads baselineType directly INSTEAD OF inferring it back from offPeakType/peakType, yields offPeak=t3.medium/peak=t3.xlarge same as the first run (no ratcheting UP OR down)', async () => {
      mockAllCollectorsWithValidData();
      // item.instanceType = t3.xlarge (the ACTUAL current size, currently at peakType because it was
      // just resized up before this job ran - 2 independent schedules running out of sync). If
      // instanceType were used as the baseline like the old B3 code, computePeakType('t3.xlarge', ...)
      // would yield one tier higher (t3.2xlarge) -> ratchets UP.
      collectEc2Mock.mockResolvedValue([{ ...TIME_OF_DAY_ITEM, instanceType: 't3.xlarge' }]);
      collectHourlyMetricsMock.mockResolvedValueOnce([
        { dayOfWeek: 1, hour: 9, p75CpuPercent: 80 },
        { dayOfWeek: 1, hour: 2, p75CpuPercent: 10 },
      ]);
      // Schedule ALREADY COMPUTED in the previous run: the ORIGINAL baseline = t3.large (already
      // saved in the baselineType field, no need to infer it back). offPeakType/peakType saved with
      // that same schedule are the result computed from that baseline (t3.medium/t3.xlarge).
      getComputedScheduleMock.mockResolvedValueOnce({
        action: 'schedulePeak',
        windows: [{ dayOfWeek: 1, startHour: 8, endHour: 9 }],
        peakType: 't3.xlarge',
        offPeakType: 't3.medium',
        baselineType: 't3.large',
      });
      // fetchFamilySizes will be called for the "t3" family of the BASELINE (t3.large, read from
      // baselineType) - needs both a smaller and larger size than t3.large (t3.medium and t3.xlarge)
      // so computeOffPeakType/computePeakType return the same values as when this schedule was
      // first computed.
      ec2SendMock.mockImplementation((command: { __type?: string }) => {
        if (command.__type === 'createTags' || command.__type === 'deleteTags') return Promise.resolve({});
        return Promise.resolve({
          InstanceTypes: [
            { InstanceType: 't3.medium', VCpuInfo: { DefaultVCpus: 2 }, MemoryInfo: { SizeInMiB: 4096 }, ProcessorInfo: { SupportedArchitectures: ['x86_64'] } },
            { InstanceType: 't3.large', VCpuInfo: { DefaultVCpus: 2 }, MemoryInfo: { SizeInMiB: 8192 }, ProcessorInfo: { SupportedArchitectures: ['x86_64'] } },
            { InstanceType: 't3.xlarge', VCpuInfo: { DefaultVCpus: 4 }, MemoryInfo: { SizeInMiB: 16384 }, ProcessorInfo: { SupportedArchitectures: ['x86_64'] } },
          ],
        });
      });

      await handler();

      // Reading baselineType=t3.large directly -> offPeak/peak are recomputed identically to the
      // first run (t3.medium/t3.xlarge), NEITHER ratcheting up (t3.2xlarge, from the REAL
      // instanceType) NOR ratcheting down (t3.small, from inferring offPeakType back like the
      // round 1 bug).
      expect(putComputedScheduleMock).toHaveBeenCalledWith(
        'i-tod1',
        expect.objectContaining({ action: 'schedulePeak', peakType: 't3.xlarge', offPeakType: 't3.medium', baselineType: 't3.large' }),
      );
    });

    it('Fix round 2: the previous schedule is an OLD record saved before the baselineType field existed (JSON.parse -> baselineType undefined) -> falls back to item.instanceType like the very first run (no crash, no using a wrong value)', async () => {
      mockAllCollectorsWithValidData();
      collectEc2Mock.mockResolvedValue([{ ...TIME_OF_DAY_ITEM, instanceType: 't3.large' }]);
      collectHourlyMetricsMock.mockResolvedValueOnce([
        { dayOfWeek: 1, hour: 9, p75CpuPercent: 80 },
        { dayOfWeek: 1, hour: 2, p75CpuPercent: 10 },
      ]);
      // Old record (before Fix round 2) has no baselineType.
      getComputedScheduleMock.mockResolvedValueOnce({
        action: 'schedulePeak',
        windows: [{ dayOfWeek: 1, startHour: 8, endHour: 9 }],
        peakType: 't3.xlarge',
        offPeakType: 't3.medium',
      });
      ec2SendMock.mockImplementation((command: { __type?: string }) => {
        if (command.__type === 'createTags' || command.__type === 'deleteTags') return Promise.resolve({});
        return Promise.resolve({
          InstanceTypes: [
            { InstanceType: 't3.medium', VCpuInfo: { DefaultVCpus: 2 }, MemoryInfo: { SizeInMiB: 4096 }, ProcessorInfo: { SupportedArchitectures: ['x86_64'] } },
            { InstanceType: 't3.large', VCpuInfo: { DefaultVCpus: 2 }, MemoryInfo: { SizeInMiB: 8192 }, ProcessorInfo: { SupportedArchitectures: ['x86_64'] } },
            { InstanceType: 't3.xlarge', VCpuInfo: { DefaultVCpus: 4 }, MemoryInfo: { SizeInMiB: 16384 }, ProcessorInfo: { SupportedArchitectures: ['x86_64'] } },
          ],
        });
      });

      await handler();

      // Falls back to item.instanceType (t3.large) like the first run -> offPeak=t3.medium, peak=t3.xlarge.
      expect(putComputedScheduleMock).toHaveBeenCalledWith(
        'i-tod1',
        expect.objectContaining({ action: 'schedulePeak', peakType: 't3.xlarge', offPeakType: 't3.medium', baselineType: 't3.large' }),
      );
    });

    it('Fix round 2 — idempotency across 3 CONSECUTIVE runs: peakType/offPeakType CONVERGE and STAY THE SAME from run 2 onward (no drift up or down)', async () => {
      // Simulates 3 consecutive recomputation runs, each reading back the previousSchedule from
      // the prior run (using run N's putComputedSchedule as run N+1's getComputedSchedule) - this
      // matches exactly how this job works in production (runs daily, reads S3 from the prior run).
      mockAllCollectorsWithValidData();
      const familySizesResponse = {
        InstanceTypes: [
          { InstanceType: 't3.medium', VCpuInfo: { DefaultVCpus: 2 }, MemoryInfo: { SizeInMiB: 4096 }, ProcessorInfo: { SupportedArchitectures: ['x86_64'] } },
          { InstanceType: 't3.large', VCpuInfo: { DefaultVCpus: 2 }, MemoryInfo: { SizeInMiB: 8192 }, ProcessorInfo: { SupportedArchitectures: ['x86_64'] } },
          { InstanceType: 't3.xlarge', VCpuInfo: { DefaultVCpus: 4 }, MemoryInfo: { SizeInMiB: 16384 }, ProcessorInfo: { SupportedArchitectures: ['x86_64'] } },
        ],
      };
      ec2SendMock.mockImplementation((command: { __type?: string }) => {
        if (command.__type === 'createTags' || command.__type === 'deleteTags') return Promise.resolve({});
        return Promise.resolve(familySizesResponse);
      });
      collectHourlyMetricsMock.mockResolvedValue([
        { dayOfWeek: 1, hour: 9, p75CpuPercent: 80 },
        { dayOfWeek: 1, hour: 2, p75CpuPercent: 10 },
      ]);

      // --- Run 1: no previous schedule yet (first run), item.instanceType = t3.large. ---
      collectEc2Mock.mockResolvedValue([{ ...TIME_OF_DAY_ITEM, instanceType: 't3.large' }]);
      getComputedScheduleMock.mockResolvedValueOnce(undefined);
      await handler();
      const run1 = putComputedScheduleMock.mock.calls.find((c) => c[0] === 'i-tod1')?.[1];
      expect(run1).toEqual(
        expect.objectContaining({ action: 'schedulePeak', peakType: 't3.xlarge', offPeakType: 't3.medium', baselineType: 't3.large' }),
      );

      // --- Run 2: reads back run 1's output as previousSchedule. Assumes the instance is
      // CURRENTLY at peakType (t3.xlarge, just resized up before this job ran) - exactly the
      // scenario that caused the original B3 bug if instanceType were used as the baseline. ---
      putComputedScheduleMock.mockClear();
      collectEc2Mock.mockResolvedValue([{ ...TIME_OF_DAY_ITEM, instanceType: 't3.xlarge' }]);
      getComputedScheduleMock.mockResolvedValueOnce(run1);
      await handler();
      const run2 = putComputedScheduleMock.mock.calls.find((c) => c[0] === 'i-tod1')?.[1];
      expect(run2).toEqual(
        expect.objectContaining({ action: 'schedulePeak', peakType: 't3.xlarge', offPeakType: 't3.medium', baselineType: 't3.large' }),
      );

      // --- Run 3: reads back run 2's output. Assumes the instance is at offPeakType (t3.medium). ---
      putComputedScheduleMock.mockClear();
      collectEc2Mock.mockResolvedValue([{ ...TIME_OF_DAY_ITEM, instanceType: 't3.medium' }]);
      getComputedScheduleMock.mockResolvedValueOnce(run2);
      await handler();
      const run3 = putComputedScheduleMock.mock.calls.find((c) => c[0] === 'i-tod1')?.[1];

      // Core assertion of this test: run2 and run3 are IDENTICAL (converged, no drift up or down
      // even though the REAL item.instanceType changes between runs).
      expect(run3).toEqual(run2);
      expect(run3).toEqual(
        expect.objectContaining({ action: 'schedulePeak', peakType: 't3.xlarge', offPeakType: 't3.medium', baselineType: 't3.large' }),
      );
    });
  });
});
