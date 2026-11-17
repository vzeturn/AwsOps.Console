import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../config.js', () => ({
  config: { allowedOrigins: [], awsRegion: 'ap-southeast-1' },
  corsHeaders: () => ({}),
}));

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('@aws-sdk/client-ec2', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-ec2')>('@aws-sdk/client-ec2');
  return {
    ...actual,
    EC2Client: vi.fn(() => ({ send })),
  };
});

import { executeEc2ChangeInstanceType } from './ec2-instance-type-change-service.js';

describe('executeEc2ChangeInstanceType', () => {
  beforeEach(() => {
    send.mockReset();
  });

  it('rejects when targetInstanceType param is missing', async () => {
    const result = await executeEc2ChangeInstanceType('i-abc123', {});
    expect(result.outcome).toBe('failure');
    expect(result.reason).toMatch(/targetInstanceType/);
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects when instance is not stopped', async () => {
    send.mockResolvedValueOnce({
      Reservations: [{ Instances: [{ State: { Name: 'running' } }] }],
    });
    const result = await executeEc2ChangeInstanceType('i-abc123', { targetInstanceType: 't3.large' });
    expect(result.outcome).toBe('rejected');
    expect(result.reason).toMatch(/stopped/);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('succeeds when instance is stopped', async () => {
    send
      .mockResolvedValueOnce({ Reservations: [{ Instances: [{ State: { Name: 'stopped' } }] }] })
      .mockResolvedValueOnce({});
    const result = await executeEc2ChangeInstanceType('i-abc123', { targetInstanceType: 't3.large' });
    expect(result).toEqual({ outcome: 'success', newInstanceType: 't3.large' });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('returns failure when ModifyInstanceAttribute throws', async () => {
    send
      .mockResolvedValueOnce({ Reservations: [{ Instances: [{ State: { Name: 'stopped' } }] }] })
      .mockRejectedValueOnce(Object.assign(new Error('boom'), { name: 'UnsupportedOperation' }));
    const result = await executeEc2ChangeInstanceType('i-abc123', { targetInstanceType: 't3.large' });
    expect(result.outcome).toBe('failure');
  });
});
