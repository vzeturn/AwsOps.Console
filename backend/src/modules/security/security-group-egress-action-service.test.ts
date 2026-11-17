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

import { executeSecurityGroupEgress } from './security-group-egress-action-service.js';

const validParams = { protocol: 'tcp', fromPort: '443', toPort: '443', cidrIp: '0.0.0.0/0' };

describe('executeSecurityGroupEgress', () => {
  beforeEach(() => send.mockReset());

  it('rejects invalid rule params without calling AWS', async () => {
    const result = await executeSecurityGroupEgress('SecurityGroup_AuthorizeEgress', 'sg-123', { protocol: 'bogus' });
    expect(result.outcome).toBe('failure');
    expect(send).not.toHaveBeenCalled();
  });

  it('authorizes a valid egress rule', async () => {
    send.mockResolvedValue({});
    const result = await executeSecurityGroupEgress('SecurityGroup_AuthorizeEgress', 'sg-123', validParams);
    expect(result.outcome).toBe('success');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('maps InvalidPermission.Duplicate to rejected, not failure', async () => {
    // mockRejectedValueOnce (not mockRejectedValue) — using a persistent reject on Node v26 +
    // Vitest 3.2.7 causes the promise to be flagged as a false unhandledRejection even though it is
    // properly awaited/caught inside the service (verified via debug isolation); this is a test
    // environment quirk, not a source bug. Each test calls `send` exactly once, so `Once` is
    // behaviorally equivalent.
    send.mockRejectedValueOnce(Object.assign(new Error('dup'), { name: 'InvalidPermission.Duplicate' }));
    const result = await executeSecurityGroupEgress('SecurityGroup_AuthorizeEgress', 'sg-123', validParams);
    expect(result.outcome).toBe('rejected');
  });

  it('maps InvalidPermission.NotFound (revoke) to rejected, not failure', async () => {
    send.mockRejectedValueOnce(Object.assign(new Error('nf'), { name: 'InvalidPermission.NotFound' }));
    const result = await executeSecurityGroupEgress('SecurityGroup_RevokeEgress', 'sg-123', validParams);
    expect(result.outcome).toBe('rejected');
  });
});
