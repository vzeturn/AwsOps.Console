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

import { executeSecurityGroupCreate, executeSecurityGroupDelete } from './security-group-lifecycle-service.js';

describe('executeSecurityGroupCreate', () => {
  beforeEach(() => send.mockReset());

  it('rejects when required params are missing', async () => {
    const result = await executeSecurityGroupCreate({ groupName: 'x' });
    expect(result.outcome).toBe('failure');
    expect(send).not.toHaveBeenCalled();
  });

  it('creates and returns createdSecurityGroupId', async () => {
    send.mockResolvedValue({ GroupId: 'sg-newid' });
    const result = await executeSecurityGroupCreate({ groupName: 'web-tier', description: 'Web tier SG', vpcId: 'vpc-123' });
    expect(result).toEqual({ outcome: 'success', createdSecurityGroupId: 'sg-newid' });
  });
});

describe('executeSecurityGroupDelete', () => {
  beforeEach(() => send.mockReset());

  it('blocks deletion when the SG is still referenced by an instance', async () => {
    send.mockResolvedValueOnce({ Reservations: [{ Instances: [{ InstanceId: 'i-still-using' }] }] });
    const result = await executeSecurityGroupDelete('sg-inuse');
    expect(result.outcome).toBe('rejected');
    expect(result.reason).toContain('i-still-using');
  });

  it('deletes when no instance references the SG', async () => {
    send
      .mockResolvedValueOnce({ Reservations: [] }) // DescribeInstances filter by group-id -> none
      .mockResolvedValueOnce({}); // DeleteSecurityGroup
    const result = await executeSecurityGroupDelete('sg-unused');
    expect(result.outcome).toBe('success');
  });
});
