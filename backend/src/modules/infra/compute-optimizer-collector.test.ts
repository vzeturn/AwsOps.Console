import { describe, it, expect, vi, beforeEach } from 'vitest';

// The collector reads the region directly from process.env.AWS_REGION (the Lambda runtime
// always sets this variable itself) — set it before importing the module, following the same
// pattern as ec2-collector.test.ts/rds-collector.test.ts.
process.env.AWS_REGION = 'ap-southeast-1';

const computeOptimizerSendMock = vi.fn();

vi.mock('@aws-sdk/client-compute-optimizer', () => ({
  ComputeOptimizerClient: vi.fn().mockImplementation(() => ({ send: computeOptimizerSendMock })),
  GetEnrollmentStatusCommand: vi.fn().mockImplementation((input: unknown) => ({ __cmd: 'GetEnrollmentStatus', input })),
  GetEC2InstanceRecommendationsCommand: vi
    .fn()
    .mockImplementation((input: unknown) => ({ __cmd: 'GetEC2InstanceRecommendations', input })),
  GetRDSDatabaseRecommendationsCommand: vi
    .fn()
    .mockImplementation((input: unknown) => ({ __cmd: 'GetRDSDatabaseRecommendations', input })),
}));

// Import after the mocks are declared (vi.mock is hoisted to the top by vitest).
const { collectComputeOptimizerData, fetchEc2RecommendationDetail } = await import('./compute-optimizer-collector.js');

beforeEach(() => {
  computeOptimizerSendMock.mockReset();
});

/** Routes the mock by the kind of command sent in (__cmd attached by the mock above) — simulates
 * the real behavior of ComputeOptimizerClient.send() receiving several different Command types. */
function routeMock(handlers: Record<string, (input: unknown) => unknown>): void {
  computeOptimizerSendMock.mockImplementation((command: { __cmd: string; input: unknown }) => {
    const handler = handlers[command.__cmd];
    if (!handler) throw new Error(`Unexpected command in test: ${command.__cmd}`);
    return Promise.resolve(handler(command.input));
  });
}

describe('collectComputeOptimizerData', () => {
  it('account not enrolled (status !== Active) -> enrolled=false, both maps empty, does NOT call GetEC2InstanceRecommendations/GetRDSDatabaseRecommendations', async () => {
    routeMock({
      GetEnrollmentStatus: () => ({ status: 'Inactive' }),
    });

    const result = await collectComputeOptimizerData();

    expect(result.enrolled).toBe(false);
    expect(result.ec2FindingByInstanceId.size).toBe(0);
    expect(result.rdsFindingByDbInstanceId.size).toBe(0);
    // Only 1 call (GetEnrollmentStatus) — no calls to either recommendation API since we already
    // know they would fail with OptInRequiredException.
    expect(computeOptimizerSendMock).toHaveBeenCalledTimes(1);
  });

  it('GetEnrollmentStatus throws -> treated as not enrolled (enrolled=false, returns empty, does not throw)', async () => {
    computeOptimizerSendMock.mockRejectedValue(new Error('AccessDenied: compute-optimizer:GetEnrollmentStatus'));

    const result = await collectComputeOptimizerData();

    expect(result.enrolled).toBe(false);
    expect(result.ec2FindingByInstanceId.size).toBe(0);
    expect(result.rdsFindingByDbInstanceId.size).toBe(0);
  });

  it('account enrolled (Active) -> correctly parses instanceId/dbInstanceIdentifier from the ARN, correctly maps the UNDER_PROVISIONED finding', async () => {
    routeMock({
      GetEnrollmentStatus: () => ({ status: 'Active' }),
      GetEC2InstanceRecommendations: () => ({
        instanceRecommendations: [
          {
            instanceArn: 'arn:aws:ec2:ap-southeast-1:123456789012:instance/i-0a1b2c3d4e5f60001',
            finding: 'Underprovisioned',
          },
          {
            instanceArn: 'arn:aws:ec2:ap-southeast-1:123456789012:instance/i-overprovisioned1',
            finding: 'Overprovisioned',
          },
        ],
        nextToken: undefined,
      }),
      GetRDSDatabaseRecommendations: () => ({
        rdsDBRecommendations: [
          {
            resourceArn: 'arn:aws:rds:ap-southeast-1:123456789012:db:acme-rds-production-env',
            instanceFinding: 'Optimized',
          },
        ],
        nextToken: undefined,
      }),
    });

    const result = await collectComputeOptimizerData();

    // Values are already NORMALIZED (normalizeFinding) — see the comment in
    // compute-optimizer-collector.ts: the EC2/RDS APIs are inconsistent in casing at real runtime
    // (directly verified), so the collector normalizes to SCREAMING_SNAKE_CASE with no
    // underscores before returning.
    expect(result.enrolled).toBe(true);
    expect(result.ec2FindingByInstanceId.get('i-0a1b2c3d4e5f60001')).toBe('UNDERPROVISIONED');
    expect(result.ec2FindingByInstanceId.get('i-overprovisioned1')).toBe('OVERPROVISIONED');
    expect(result.rdsFindingByDbInstanceId.get('acme-rds-production-env')).toBe('OPTIMIZED');
  });

  it('correctly normalizes BOTH real casing styles observed (EC2 returns SCREAMING_SNAKE_CASE, RDS returns PascalCase) to the SAME value', async () => {
    routeMock({
      GetEnrollmentStatus: () => ({ status: 'Active' }),
      GetEC2InstanceRecommendations: () => ({
        instanceRecommendations: [
          { instanceArn: 'arn:aws:ec2:ap-southeast-1:123456789012:instance/i-ec2-style', finding: 'UNDER_PROVISIONED' },
        ],
        nextToken: undefined,
      }),
      GetRDSDatabaseRecommendations: () => ({
        rdsDBRecommendations: [
          { resourceArn: 'arn:aws:rds:ap-southeast-1:123456789012:db:db-rds-style', instanceFinding: 'Underprovisioned' },
        ],
        nextToken: undefined,
      }),
    });

    const result = await collectComputeOptimizerData();

    expect(result.ec2FindingByInstanceId.get('i-ec2-style')).toBe('UNDERPROVISIONED');
    expect(result.rdsFindingByDbInstanceId.get('db-rds-style')).toBe('UNDERPROVISIONED');
  });

  it('paginates via nextToken for GetEC2InstanceRecommendations -> merges results from all pages', async () => {
    let callCount = 0;
    routeMock({
      GetEnrollmentStatus: () => ({ status: 'Active' }),
      GetEC2InstanceRecommendations: () => {
        callCount += 1;
        if (callCount === 1) {
          return {
            instanceRecommendations: [
              { instanceArn: 'arn:aws:ec2:ap-southeast-1:123456789012:instance/i-page1', finding: 'Underprovisioned' },
            ],
            nextToken: 'token-page-2',
          };
        }
        return {
          instanceRecommendations: [
            { instanceArn: 'arn:aws:ec2:ap-southeast-1:123456789012:instance/i-page2', finding: 'Optimized' },
          ],
          nextToken: undefined,
        };
      },
      GetRDSDatabaseRecommendations: () => ({ rdsDBRecommendations: [], nextToken: undefined }),
    });

    const result = await collectComputeOptimizerData();

    expect(result.ec2FindingByInstanceId.get('i-page1')).toBe('UNDERPROVISIONED');
    expect(result.ec2FindingByInstanceId.get('i-page2')).toBe('OPTIMIZED');
    expect(callCount).toBe(2);
  });

  it('GetEC2InstanceRecommendations throws after enrollment succeeds -> skips it, returns an empty EC2 map (does not throw, RDS still processes normally)', async () => {
    routeMock({
      GetEnrollmentStatus: () => ({ status: 'Active' }),
      GetEC2InstanceRecommendations: () => {
        throw new Error('Throttling: GetEC2InstanceRecommendations');
      },
      GetRDSDatabaseRecommendations: () => ({
        rdsDBRecommendations: [
          { resourceArn: 'arn:aws:rds:ap-southeast-1:123456789012:db:db-1', instanceFinding: 'Underprovisioned' },
        ],
        nextToken: undefined,
      }),
    });

    const result = await collectComputeOptimizerData();

    expect(result.enrolled).toBe(true);
    expect(result.ec2FindingByInstanceId.size).toBe(0);
    expect(result.rdsFindingByDbInstanceId.get('db-1')).toBe('UNDERPROVISIONED');
  });

  it('correctly parses the RAW (unnormalized) findingReasonCodes by instanceId -> used by the orchestrator to distinguish EBS-only reasons', async () => {
    routeMock({
      GetEnrollmentStatus: () => ({ status: 'Active' }),
      GetEC2InstanceRecommendations: () => ({
        instanceRecommendations: [
          {
            instanceArn: 'arn:aws:ec2:ap-southeast-1:123456789012:instance/i-ebsonly1',
            finding: 'Overprovisioned',
            findingReasonCodes: ['EBSThroughputOverprovisioned'],
          },
          {
            instanceArn: 'arn:aws:ec2:ap-southeast-1:123456789012:instance/i-nocpu1',
            finding: 'Underprovisioned',
            findingReasonCodes: ['CPUUnderprovisioned', 'MemoryUnderprovisioned'],
          },
        ],
        nextToken: undefined,
      }),
      GetRDSDatabaseRecommendations: () => ({ rdsDBRecommendations: [], nextToken: undefined }),
    });

    const result = await collectComputeOptimizerData();

    expect(result.ec2FindingReasonCodesByInstanceId.get('i-ebsonly1')).toEqual(['EBSThroughputOverprovisioned']);
    expect(result.ec2FindingReasonCodesByInstanceId.get('i-nocpu1')).toEqual(['CPUUnderprovisioned', 'MemoryUnderprovisioned']);
  });

  it('instanceRecommendation missing instanceArn or finding -> skips that entry, does not throw', async () => {
    routeMock({
      GetEnrollmentStatus: () => ({ status: 'Active' }),
      GetEC2InstanceRecommendations: () => ({
        instanceRecommendations: [
          { instanceArn: undefined, finding: 'Underprovisioned' },
          { instanceArn: 'arn:aws:ec2:ap-southeast-1:123456789012:instance/i-valid1', finding: undefined },
          { instanceArn: 'arn:aws:ec2:ap-southeast-1:123456789012:instance/i-valid2', finding: 'Optimized' },
        ],
        nextToken: undefined,
      }),
      GetRDSDatabaseRecommendations: () => ({ rdsDBRecommendations: [], nextToken: undefined }),
    });

    const result = await collectComputeOptimizerData();

    expect(result.ec2FindingByInstanceId.size).toBe(1);
    expect(result.ec2FindingByInstanceId.get('i-valid2')).toBe('OPTIMIZED');
  });
});

describe('fetchEc2RecommendationDetail', () => {
  it('calls GetEC2InstanceRecommendations with instanceArns=[arn], returns the normalized finding + the rank=1 recommendationOption', async () => {
    routeMock({
      GetEC2InstanceRecommendations: () => ({
        instanceRecommendations: [
          {
            instanceArn: 'arn:aws:ec2:ap-southeast-1:123456789012:instance/i-1',
            finding: 'Overprovisioned',
            findingReasonCodes: ['CPUOverprovisioned'],
            recommendationOptions: [
              { instanceType: 'm6i.large', rank: 2, migrationEffort: 'VeryLow', platformDifferences: [] },
              { instanceType: 'm5.large', rank: 1, migrationEffort: 'VeryLow', platformDifferences: [] },
            ],
          },
        ],
      }),
    });

    const result = await fetchEc2RecommendationDetail('arn:aws:ec2:ap-southeast-1:123456789012:instance/i-1');

    expect(result).toEqual({
      finding: 'OVERPROVISIONED',
      findingReasonCodes: ['CPUOverprovisioned'],
      topRecommendationOption: { instanceType: 'm5.large', migrationEffort: 'VeryLow', platformDifferences: [] },
    });
    const sentCommand = computeOptimizerSendMock.mock.calls[0][0] as { input: { instanceArns: string[] } };
    expect(sentCommand.input.instanceArns).toEqual(['arn:aws:ec2:ap-southeast-1:123456789012:instance/i-1']);
  });

  it('no rank=1 recommendationOptions at all -> topRecommendationOption=undefined', async () => {
    routeMock({
      GetEC2InstanceRecommendations: () => ({
        instanceRecommendations: [{ instanceArn: 'arn:...:instance/i-1', finding: 'Optimized', recommendationOptions: [] }],
      }),
    });

    const result = await fetchEc2RecommendationDetail('arn:...:instance/i-1');

    expect(result?.topRecommendationOption).toBeUndefined();
  });

  it('no instanceRecommendations found -> returns undefined', async () => {
    routeMock({ GetEC2InstanceRecommendations: () => ({ instanceRecommendations: [] }) });
    expect(await fetchEc2RecommendationDetail('arn:...:instance/i-missing')).toBeUndefined();
  });

  it('GetEC2InstanceRecommendations throws -> returns undefined, does not throw', async () => {
    computeOptimizerSendMock.mockRejectedValue(new Error('Throttling'));
    expect(await fetchEc2RecommendationDetail('arn:...:instance/i-1')).toBeUndefined();
  });
});
