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
  DescribeVolumesCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'DescribeVolumes', input })),
  ModifyVolumeCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'ModifyVolume', input })),
}));

const { executeEbsModifyVolumeType } = await import('./ebs-modify-volume-type-action-service.js');

beforeEach(() => {
  ec2SendMock.mockReset();
});

describe('executeEbsModifyVolumeType', () => {
  it('success: volume is gp2 -> ModifyVolume to gp3, returns outcome success', async () => {
    ec2SendMock.mockImplementation(async (command: { __type?: string }) => {
      if (command.__type === 'DescribeVolumes') return { Volumes: [{ VolumeType: 'gp2' }] };
      if (command.__type === 'ModifyVolume') return {};
      throw new Error('unexpected');
    });

    const result = await executeEbsModifyVolumeType('vol-123');

    expect(result).toEqual({ outcome: 'success', newVolumeType: 'gp3' });
  });

  it('rejected: volume does not exist', async () => {
    ec2SendMock.mockResolvedValue({ Volumes: [] });

    const result = await executeEbsModifyVolumeType('vol-missing');

    expect(result.outcome).toBe('rejected');
  });

  it('rejected: volume is NO LONGER gp2 at execution time (already gp3 or io2) — ModifyVolume is NOT called', async () => {
    ec2SendMock.mockResolvedValue({ Volumes: [{ VolumeType: 'gp3' }] });

    const result = await executeEbsModifyVolumeType('vol-123');

    expect(result.outcome).toBe('rejected');
    expect(ec2SendMock).toHaveBeenCalledTimes(1); // only DescribeVolumes
  });

  it('failure: ModifyVolume throws -> outcome failure, does not throw outward', async () => {
    ec2SendMock.mockImplementation(async (command: { __type?: string }) => {
      if (command.__type === 'DescribeVolumes') return { Volumes: [{ VolumeType: 'gp2' }] };
      if (command.__type === 'ModifyVolume') throw new Error('AWS throttled');
      throw new Error('unexpected');
    });

    const result = await executeEbsModifyVolumeType('vol-123');

    expect(result.outcome).toBe('failure');
    expect(result.reason).toContain('AWS throttled');
  });

  it('failure: DescribeVolumes throw -> outcome failure', async () => {
    ec2SendMock.mockRejectedValue(new Error('network error'));

    const result = await executeEbsModifyVolumeType('vol-123');

    expect(result.outcome).toBe('failure');
  });
});
