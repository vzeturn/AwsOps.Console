import { describe, it, expect, vi, beforeEach } from 'vitest';

// Unit test for `buildActionPreviewDirect('EC2_Rightsize', ...)` — follows the same pattern as
// preview-service.ecsRds.test.ts/preview-service.costOptimization.test.ts.
process.env.AWS_REGION = 'ap-southeast-1';
process.env.ASSESSMENT_BUCKET_NAME = 'test-assessment-bucket';
// preview-service.ts imports from `../governance/index.js`, whose barrel also evaluates
// `s3PolicyStore.ts` -> `assessment/infra-review-collector/clients.ts`, which reads
// AWS_ACCOUNT_ID directly from process.env at module scope and throws if missing.
process.env.AWS_ACCOUNT_ID = '123456789012';

vi.mock('../../config.js', () => ({
  config: {
    allowedOrigins: [],
    entraTenantId: 'test-tenant',
    entraClientId: 'test-client',
    allowedGroupIds: [],
    awsRegion: 'ap-southeast-1',
    costCacheParamName: 'test-cost-cache-param',
    assessmentBucketName: 'test-assessment-bucket',
    ec2StateManagerServiceTokenParamName: 'test-service-token-param',
    ec2StateManagerFunctionUrl: 'https://example.invalid/',
    actionExecutionFunctionName: 'test-action-execution-fn',
  },
  corsHeaders: () => ({}),
}));

const ec2SendMock = vi.fn();

vi.mock('@aws-sdk/client-ec2', () => ({
  EC2Client: vi.fn().mockImplementation(() => ({ send: ec2SendMock })),
  DescribeVolumesCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'DescribeVolumes', input })),
  DescribeAddressesCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'DescribeAddresses', input })),
  DescribeInstancesCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'DescribeInstances', input })),
  DescribeInstanceTypesCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'DescribeInstanceTypes', input })),
}));

const { buildActionPreviewDirect } = await import('./preview-service.js');

beforeEach(() => {
  ec2SendMock.mockReset();
});

/**
 * `computeEc2RightsizeTarget()` (lib/ec2Rightsizing.ts) calls `DescribeInstanceTypes` with
 * `Filters: [{Name:'instance-type', Values:['<family>.*']}]` — returning ALL sizes in the family,
 * not using `InstanceTypes: [...]`. The test `instanceType` always uses the `<family>.large`
 * form, target always `<family>.medium` (2 consecutive sizes in the real size ladder of family
 * t3/m5/...).
 */
function setupEc2Mock(instanceType: string, currentArch: string[], targetArch: string[]) {
  const [family] = instanceType.split('.');
  ec2SendMock.mockImplementation(async (command: { __type?: string }) => {
    if (command.__type === 'DescribeInstances') {
      return { Reservations: [{ Instances: [{ InstanceType: instanceType }] }] };
    }
    if (command.__type === 'DescribeInstanceTypes') {
      return {
        InstanceTypes: [
          {
            InstanceType: `${family}.medium`,
            VCpuInfo: { DefaultVCpus: 2 },
            MemoryInfo: { SizeInMiB: 4096 },
            ProcessorInfo: { SupportedArchitectures: targetArch },
          },
          {
            InstanceType: instanceType,
            VCpuInfo: { DefaultVCpus: 2 },
            MemoryInfo: { SizeInMiB: 8192 },
            ProcessorInfo: { SupportedArchitectures: currentArch },
          },
        ],
      };
    }
    throw new Error(`Unexpected EC2 command in test mock: ${command.__type}`);
  });
}

describe('buildActionPreviewDirect — EC2_Rightsize', () => {
  it('returns the correct preview when the instance type is valid and architectures are compatible', async () => {
    setupEc2Mock('t3.large', ['x86_64'], ['x86_64']);

    const preview = await buildActionPreviewDirect('EC2_Rightsize', 'i-abc123');

    expect(preview.actionType).toBe('EC2_Rightsize');
    expect(preview.reversibilityClass).toBe('reversible');
    expect(preview.resource.id).toBe('i-abc123');
    expect(preview.params.currentInstanceType).toBe('t3.large');
    expect(preview.params.newInstanceType).toBe('t3.medium');
  });

  it('throws badRequest when the instance does not exist', async () => {
    ec2SendMock.mockResolvedValue({ Reservations: [] });

    await expect(buildActionPreviewDirect('EC2_Rightsize', 'i-missing')).rejects.toMatchObject({ statusCode: 400 });
  });

  it('throws badRequest when the instance is already at the smallest size (nano)', async () => {
    ec2SendMock.mockResolvedValue({ Reservations: [{ Instances: [{ InstanceType: 't4g.nano' }] }] });

    await expect(buildActionPreviewDirect('EC2_Rightsize', 'i-nano')).rejects.toMatchObject({ statusCode: 400 });
  });

  it('throws badRequest when current/target CPU architectures are incompatible', async () => {
    setupEc2Mock('t3.large', ['x86_64'], ['arm64']);

    await expect(buildActionPreviewDirect('EC2_Rightsize', 'i-abc123')).rejects.toMatchObject({ statusCode: 400 });
  });

  it('still throws badRequest (fail-safe) when DescribeInstanceTypes errors — never assumes compatibility', async () => {
    ec2SendMock.mockImplementation(async (command: { __type?: string }) => {
      if (command.__type === 'DescribeInstances') {
        return { Reservations: [{ Instances: [{ InstanceType: 't3.large' }] }] };
      }
      if (command.__type === 'DescribeInstanceTypes') {
        throw new Error('boom');
      }
      throw new Error('unexpected');
    });

    await expect(buildActionPreviewDirect('EC2_Rightsize', 'i-abc123')).rejects.toMatchObject({ statusCode: 400 });
  });
});
