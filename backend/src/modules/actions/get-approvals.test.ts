import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../config.js', () => ({
  config: { allowedOrigins: [] },
  corsHeaders: () => ({}),
}));

const listApprovalsMock = vi.fn();
vi.mock('./approval-service.js', () => ({
  listApprovals: (...args: unknown[]) => listApprovalsMock(...args),
}));

const { handler } = await import('./get-approvals.js');

function buildEvent(query?: Record<string, string>): any {
  return {
    headers: {},
    rawPath: '/actions/approvals',
    requestContext: { http: { method: 'GET' } },
    queryStringParameters: query,
  };
}

beforeEach(() => {
  listApprovalsMock.mockReset();
});

describe('handler (GET /actions/approvals)', () => {
  it('calls listApprovals with undefined status when no query param is given, returns its result', async () => {
    listApprovalsMock.mockResolvedValue([{ id: 'a1', status: 'pending' }]);

    const res = await handler(buildEvent());

    expect(listApprovalsMock).toHaveBeenCalledWith(undefined);
    const typedRes = res as { statusCode: number; body: string };
    expect(typedRes.statusCode).toBe(200);
    expect(JSON.parse(typedRes.body)).toEqual([{ id: 'a1', status: 'pending' }]);
  });

  it('passes a valid status filter through to listApprovals', async () => {
    listApprovalsMock.mockResolvedValue([]);

    await handler(buildEvent({ status: 'pending' }));

    expect(listApprovalsMock).toHaveBeenCalledWith('pending');
  });

  it('throws 400 for an invalid status value, without calling listApprovals', async () => {
    await expect(handler(buildEvent({ status: 'bogus' }))).rejects.toMatchObject({ statusCode: 400 });
    expect(listApprovalsMock).not.toHaveBeenCalled();
  });
});
