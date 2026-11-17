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

import { executeEc2UpdateTags, RESERVED_TAG_KEYS } from './ec2-tags-action-service.js';

describe('executeEc2UpdateTags', () => {
  beforeEach(() => send.mockReset());

  it('rejects when a reserved key is in set', async () => {
    const params = { set: JSON.stringify({ [RESERVED_TAG_KEYS[0]]: 'x' }), remove: JSON.stringify([]) };
    const result = await executeEc2UpdateTags('i-abc123', params);
    expect(result.outcome).toBe('rejected');
    expect(result.reason).toContain(RESERVED_TAG_KEYS[0]);
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects when a reserved key is in remove', async () => {
    const params = { set: JSON.stringify({}), remove: JSON.stringify([RESERVED_TAG_KEYS[1]]) };
    const result = await executeEc2UpdateTags('i-abc123', params);
    expect(result.outcome).toBe('rejected');
    expect(send).not.toHaveBeenCalled();
  });

  it('deletes then sets, in that order, and reports success', async () => {
    send.mockResolvedValue({});
    const params = { set: JSON.stringify({ team: 'ops' }), remove: JSON.stringify(['old-key']) };
    const result = await executeEc2UpdateTags('i-abc123', params);
    expect(result).toEqual({ outcome: 'success', newTags: { team: 'ops' } });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('returns partial outcome when DeleteTags succeeds but CreateTags fails', async () => {
    send
      .mockResolvedValueOnce({}) // DeleteTags ok
      .mockRejectedValueOnce(new Error('CreateTags boom')); // CreateTags fails
    const params = { set: JSON.stringify({ team: 'ops' }), remove: JSON.stringify(['old-key']) };
    const result = await executeEc2UpdateTags('i-abc123', params);
    expect(result.outcome).toBe('partial');
    expect(result.partialTagFailures).toEqual(['team']);
    expect(result.reason).toBeDefined();
  });

  it('returns failure (not partial) when DeleteTags itself fails — CreateTags never attempted', async () => {
    send.mockRejectedValueOnce(new Error('DeleteTags boom'));
    const params = { set: JSON.stringify({ team: 'ops' }), remove: JSON.stringify(['old-key']) };
    const result = await executeEc2UpdateTags('i-abc123', params);
    expect(result.outcome).toBe('failure');
    expect(send).toHaveBeenCalledTimes(1);
  });
});
