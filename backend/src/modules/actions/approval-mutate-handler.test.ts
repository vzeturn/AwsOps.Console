import { describe, it, expect, vi, beforeEach } from 'vitest';

const createApprovalRequestMock = vi.fn();
const decideApprovalMock = vi.fn();
const markApprovalExecutedMock = vi.fn();

vi.mock('./approval-service.js', () => ({
  createApprovalRequest: (...args: unknown[]) => createApprovalRequestMock(...args),
  decideApproval: (...args: unknown[]) => decideApprovalMock(...args),
  markApprovalExecuted: (...args: unknown[]) => markApprovalExecutedMock(...args),
}));

const { handler } = await import('./approval-mutate-handler.js');

beforeEach(() => {
  createApprovalRequestMock.mockReset();
  decideApprovalMock.mockReset();
  markApprovalExecutedMock.mockReset();
});

/**
 * `approval-mutate-fn`'s own handler is a thin `switch` dispatching to `approval-service.ts` — the
 * business logic itself is already covered by `approval-service.test.ts`. What THIS file needs to
 * verify is the dispatch/wiring itself (right event kind -> right service function, with the right
 * arguments) plus the catch-all fail-safe for a bug the service layer didn't itself catch.
 */
describe('approval-mutate-handler', () => {
  it("dispatches kind='create' to createApprovalRequest with the event's fields", async () => {
    createApprovalRequestMock.mockResolvedValue({ ok: true, approval: { id: 'a1' } });

    const result = await handler({
      kind: 'create',
      actionType: 'ElasticIp_Release',
      resourceId: 'eipalloc-1',
      region: 'ap-southeast-1',
      params: {},
      requestedReason: 'unused',
      requestedBy: 'user@example.com',
    });

    // The handler forwards the WHOLE event object (including its own `kind` discriminant) to
    // `createApprovalRequest` rather than destructuring it — `CreateApprovalInput` doesn't declare
    // a `kind` field, but TS structural typing allows the extra property to ride along at runtime.
    expect(createApprovalRequestMock).toHaveBeenCalledWith({
      kind: 'create',
      actionType: 'ElasticIp_Release',
      resourceId: 'eipalloc-1',
      region: 'ap-southeast-1',
      params: {},
      requestedReason: 'unused',
      requestedBy: 'user@example.com',
    });
    expect(result).toEqual({ ok: true, approval: { id: 'a1' } });
    expect(decideApprovalMock).not.toHaveBeenCalled();
    expect(markApprovalExecutedMock).not.toHaveBeenCalled();
  });

  it("dispatches kind='decide' to decideApproval with (id, decidedBy, decision, decisionReason)", async () => {
    decideApprovalMock.mockResolvedValue({ ok: true, approval: { id: 'a1', status: 'approved' } });

    const result = await handler({
      kind: 'decide',
      id: 'a1',
      decidedBy: 'approver@example.com',
      decision: 'approved',
    });

    expect(decideApprovalMock).toHaveBeenCalledWith('a1', 'approver@example.com', 'approved', undefined);
    expect(result).toEqual({ ok: true, approval: { id: 'a1', status: 'approved' } });
  });

  it("dispatches kind='mark-executed' to markApprovalExecuted with the id", async () => {
    markApprovalExecutedMock.mockResolvedValue({ ok: true, approval: { id: 'a1', status: 'executed' } });

    const result = await handler({ kind: 'mark-executed', id: 'a1' });

    expect(markApprovalExecutedMock).toHaveBeenCalledWith('a1');
    expect(result).toEqual({ ok: true, approval: { id: 'a1', status: 'executed' } });
  });

  it('returns { ok: false } (never throws) when the underlying service function throws unexpectedly', async () => {
    createApprovalRequestMock.mockRejectedValue(new Error('boom'));

    const result = await handler({
      kind: 'create',
      actionType: 'ElasticIp_Release',
      resourceId: 'eipalloc-1',
      region: 'ap-southeast-1',
      params: {},
      requestedReason: 'unused',
      requestedBy: 'user@example.com',
    });

    expect(result).toEqual({ ok: false, error: 'Internal error' });
  });
});
