import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../config.js', () => ({
  config: { allowedOrigins: [], awsRegion: 'ap-southeast-1' },
  corsHeaders: () => ({}),
}));

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('@aws-sdk/client-ec2', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-ec2')>('@aws-sdk/client-ec2');
  return { ...actual, EC2Client: vi.fn(() => ({ send })) };
});

import { executeEc2ModifySecurityGroups } from './ec2-modify-security-groups-service.js';

describe('executeEc2ModifySecurityGroups', () => {
  beforeEach(() => send.mockReset());

  it('rejects an empty group list (AWS itself disallows this)', async () => {
    const result = await executeEc2ModifySecurityGroups('i-abc', { groupIds: JSON.stringify([]) });
    expect(result.outcome).toBe('rejected');
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects malformed groupIds param', async () => {
    const result = await executeEc2ModifySecurityGroups('i-abc', { groupIds: 'not-json' });
    expect(result.outcome).toBe('failure');
    expect(send).not.toHaveBeenCalled();
  });

  it('applies the full replacement list on success', async () => {
    send
      .mockResolvedValueOnce({ Reservations: [{ Instances: [{ InstanceId: 'i-abc' }] }] })
      .mockResolvedValueOnce({});
    const result = await executeEc2ModifySecurityGroups('i-abc', { groupIds: JSON.stringify(['sg-1', 'sg-2']) });
    expect(result).toEqual({ outcome: 'success', newSecurityGroupIds: ['sg-1', 'sg-2'] });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('rejects when the instance no longer exists at execution time (re-read live state before mutating)', async () => {
    send.mockResolvedValueOnce({ Reservations: [] });
    const result = await executeEc2ModifySecurityGroups('i-abc', { groupIds: JSON.stringify(['sg-1']) });
    expect(result.outcome).toBe('rejected');
    expect(result.reason).toMatch(/not found/);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('returns failure when DescribeInstances (re-read) throws', async () => {
    send.mockRejectedValueOnce(new Error('boom'));
    const result = await executeEc2ModifySecurityGroups('i-abc', { groupIds: JSON.stringify(['sg-1']) });
    expect(result.outcome).toBe('failure');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('returns failure when ModifyInstanceAttribute throws', async () => {
    send
      .mockResolvedValueOnce({ Reservations: [{ Instances: [{ InstanceId: 'i-abc' }] }] })
      .mockRejectedValueOnce(new Error('boom'));
    const result = await executeEc2ModifySecurityGroups('i-abc', { groupIds: JSON.stringify(['sg-1']) });
    expect(result.outcome).toBe('failure');
  });
});
