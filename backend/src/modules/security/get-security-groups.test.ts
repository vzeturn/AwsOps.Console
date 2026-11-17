import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../config.js', () => ({
  config: { allowedOrigins: [], awsRegion: 'ap-southeast-1' },
  corsHeaders: () => ({}),
}));

const listSecurityGroupsMock = vi.fn();
vi.mock('./security-group-service.js', () => ({
  listSecurityGroups: listSecurityGroupsMock,
}));

const { handler } = await import('./get-security-groups.js');

const EVENT = { headers: {}, rawPath: '/security-groups', requestContext: { http: { method: 'GET' } } } as any;

beforeEach(() => {
  listSecurityGroupsMock.mockReset();
});

describe('handler (GET /security-groups)', () => {
  it('returns the listSecurityGroups() result unchanged as a 200 JSON response', async () => {
    const payload = {
      groups: [{ groupId: 'sg-1', groupName: 'web', vpcId: 'vpc-1', description: '', ingressRules: [] }],
      truncated: false,
    };
    listSecurityGroupsMock.mockResolvedValue(payload);

    const res = (await handler(EVENT)) as { statusCode: number; body: string };

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual(payload);
    // READ route: calls the service with no parameters, and does NOT receive `claims` — any signed-in
    // user can view it (the operator gate applies only to mutate). Asserting arity locks in that decision.
    expect(listSecurityGroupsMock).toHaveBeenCalledWith();
    expect(handler.length).toBe(1);
  });
});
