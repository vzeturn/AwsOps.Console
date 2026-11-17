import { describe, it, expect, vi, beforeEach } from 'vitest';

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
  DescribeAddressesCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'DescribeAddresses', input })),
  ReleaseAddressCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'ReleaseAddress', input })),
}));

const { executeElasticIpRelease } = await import('./elastic-ip-release-action-service.js');

beforeEach(() => {
  ec2SendMock.mockReset();
});

describe('executeElasticIpRelease', () => {
  it('success: EIP not attached to any resource -> ReleaseAddress, returns outcome success + releasedPublicIp', async () => {
    ec2SendMock.mockImplementation(async (command: { __type?: string }) => {
      if (command.__type === 'DescribeAddresses') return { Addresses: [{ PublicIp: '1.2.3.4', AssociationId: undefined }] };
      if (command.__type === 'ReleaseAddress') return {};
      throw new Error('unexpected');
    });

    const result = await executeElasticIpRelease('eipalloc-1');

    expect(result).toEqual({ outcome: 'success', releasedPublicIp: '1.2.3.4' });
  });

  it('rejected: allocationId does not exist', async () => {
    ec2SendMock.mockResolvedValue({ Addresses: [] });

    const result = await executeElasticIpRelease('eipalloc-missing');

    expect(result.outcome).toBe('rejected');
  });

  it('rejected: EIP HAS been attached to a resource at execution time — ReleaseAddress is NOT called', async () => {
    ec2SendMock.mockResolvedValue({ Addresses: [{ PublicIp: '1.2.3.4', AssociationId: 'eipassoc-1' }] });

    const result = await executeElasticIpRelease('eipalloc-1');

    expect(result.outcome).toBe('rejected');
    expect(ec2SendMock).toHaveBeenCalledTimes(1); // only DescribeAddresses
  });

  it('failure: ReleaseAddress throw -> outcome failure', async () => {
    ec2SendMock.mockImplementation(async (command: { __type?: string }) => {
      if (command.__type === 'DescribeAddresses') return { Addresses: [{ PublicIp: '1.2.3.4', AssociationId: undefined }] };
      if (command.__type === 'ReleaseAddress') throw new Error('AWS throttled');
      throw new Error('unexpected');
    });

    const result = await executeElasticIpRelease('eipalloc-1');

    expect(result.outcome).toBe('failure');
    expect(result.reason).toContain('AWS throttled');
  });

  it('failure: DescribeAddresses throw -> outcome failure', async () => {
    ec2SendMock.mockRejectedValue(new Error('network error'));

    const result = await executeElasticIpRelease('eipalloc-1');

    expect(result.outcome).toBe('failure');
  });
});
