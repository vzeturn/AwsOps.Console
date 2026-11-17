import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.AWS_REGION = 'ap-southeast-1';

const ec2SendMock = vi.fn();

vi.mock('@aws-sdk/client-ec2', () => ({
  EC2Client: vi.fn().mockImplementation(() => ({ send: ec2SendMock })),
  DescribeAddressesCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
}));

const { collectElasticIps } = await import('./elastic-ip-collector.js');

beforeEach(() => {
  ec2SendMock.mockReset();
});

describe('collectElasticIps', () => {
  it('associated=false for an EIP with no AssociationId (not attached to any resource)', async () => {
    ec2SendMock.mockResolvedValue({
      Addresses: [
        { AllocationId: 'eipalloc-1', PublicIp: '1.2.3.4' },
        { AllocationId: 'eipalloc-2', PublicIp: '5.6.7.8', AssociationId: 'eipassoc-1' },
      ],
    });

    const result = await collectElasticIps();

    expect(result).toHaveLength(2);
    expect(result).toContainEqual({ allocationId: 'eipalloc-1', publicIp: '1.2.3.4', region: 'ap-southeast-1', associated: false });
    expect(result).toContainEqual({ allocationId: 'eipalloc-2', publicIp: '5.6.7.8', region: 'ap-southeast-1', associated: true });
  });

  it('skips an address missing AllocationId or PublicIp', async () => {
    ec2SendMock.mockResolvedValue({
      Addresses: [{ AllocationId: undefined, PublicIp: '1.2.3.4' }, { AllocationId: 'eipalloc-3', PublicIp: undefined }],
    });

    const result = await collectElasticIps();

    expect(result).toEqual([]);
  });

  it('DescribeAddresses fails -> returns empty, does not throw', async () => {
    ec2SendMock.mockRejectedValue(new Error('AccessDenied'));

    const result = await collectElasticIps();

    expect(result).toEqual([]);
  });
});
