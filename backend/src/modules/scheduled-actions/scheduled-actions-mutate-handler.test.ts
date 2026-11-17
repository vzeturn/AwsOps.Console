import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const sendMock = vi.fn();
vi.mock('@aws-sdk/client-scheduler', () => {
  class CreateScheduleCommand {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }
  class DeleteScheduleCommand {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }
  class SchedulerClient {
    send(cmd: unknown) {
      return sendMock(cmd);
    }
  }
  return { SchedulerClient, CreateScheduleCommand, DeleteScheduleCommand };
});

const { handler } = await import('./scheduled-actions-mutate-handler.js');

beforeEach(() => {
  sendMock.mockReset();
  process.env.DOWNSIZE_SCHEDULER_FUNCTION_ARN = 'arn:aws:lambda:ap-southeast-1:123456789012:function:abc-ops-dashboard-prod-downsize-scheduler-fn';
  process.env.DOWNSIZE_SCHEDULER_INVOKE_ROLE_ARN = 'arn:aws:iam::123456789012:role:abc-ops-dashboard-prod-downsize-scheduler-invoke-role';
});

// Only ONE test below freezes the clock (see its comment). Restoring real timers here rather than
// inside that test keeps the other tests — which build `runAtIso` relative to a real `Date.now()` —
// from silently inheriting a frozen clock if that test ever throws before restoring.
afterEach(() => {
  vi.useRealTimers();
});

describe('scheduled-actions-mutate-handler — create', () => {
  it('creates a schedule successfully when rds is present and the time is in the future', async () => {
    sendMock.mockResolvedValue({});
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    const result = await handler({
      kind: 'create',
      runAtIso: future,
      rds: { instanceIdentifier: 'abc-prod-rds-postgres', targetClass: 'db.m7g.xlarge' },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.scheduleName).toMatch(/^abc-prod-downsize-\d{8}-\d{4}-[a-z0-9]{4}$/);
    }
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('returns ok:false when both rds and ec2 are missing', async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    const result = await handler({ kind: 'create', runAtIso: future });

    expect(result).toEqual({ ok: false, error: 'Need at least one of: rds or ec2' });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('returns ok:false when runAtIso is in the past', async () => {
    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    const result = await handler({
      kind: 'create',
      runAtIso: past,
      ec2: { instanceId: 'i-0a1b2c3d4e5f60002', targetType: 't3.xlarge' },
    });

    expect(result).toEqual({ ok: false, error: 'runAtIso must be in the future' });
    expect(sendMock).not.toHaveBeenCalled();
  });

  /**
   * The clock is FROZEN for this test. It asserts an exact, timezone-sensitive output string, so
   * `runAtIso` has to be a hardcoded literal — but the handler also rejects any `runAtIso` in the
   * past, which made the literal a TIME BOMB: written while 2026-09-01 was still ahead, it started
   * failing for everyone on 2026-09-01 with a misleading `expected false to be true`, and because
   * `infra/deploy.sh` runs the test suite as a mandatory gate, it blocked every deploy from that
   * date on — a test failure caused purely by the calendar, in code that had not changed.
   *
   * Freezing the clock just before the literal keeps the assertion deterministic forever. Do NOT
   * "fix" this by making the date relative to `Date.now()`: the expected `at(...)` string would then
   * have to be computed the same way the implementation computes it, and the test would no longer
   * detect a timezone-conversion bug (it would reproduce it on both sides).
   */
  it('sends the correct ScheduleExpression/ScheduleExpressionTimezone/Target for CreateScheduleCommand (guards against timezone drift)', async () => {
    sendMock.mockResolvedValue({});
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-31T00:00:00.000Z'));

    const result = await handler({
      kind: 'create',
      runAtIso: '2026-09-01T03:15:00.000Z',
      rds: { instanceIdentifier: 'abc-prod-rds-postgres', targetClass: 'db.m7g.xlarge' },
    });

    expect(result.ok).toBe(true);
    expect(sendMock).toHaveBeenCalledTimes(1);
    const sentCommand = sendMock.mock.calls[0][0] as { input: Record<string, unknown> };
    expect(sentCommand.input).toMatchObject({
      ScheduleExpression: 'at(2026-09-01T03:15:00)',
      ScheduleExpressionTimezone: 'UTC',
      ActionAfterCompletion: 'DELETE',
      Target: {
        Arn: process.env.DOWNSIZE_SCHEDULER_FUNCTION_ARN,
        RoleArn: process.env.DOWNSIZE_SCHEDULER_INVOKE_ROLE_ARN,
      },
    });
  });

  it('returns ok:false when CreateScheduleCommand throws', async () => {
    sendMock.mockRejectedValue(new Error('AccessDenied'));
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    const result = await handler({
      kind: 'create',
      runAtIso: future,
      rds: { instanceIdentifier: 'abc-prod-rds-postgres', targetClass: 'db.m7g.xlarge' },
    });

    expect(result).toEqual({ ok: false, error: 'AccessDenied' });
  });
});

describe('scheduled-actions-mutate-handler — delete', () => {
  it('deletes a schedule successfully', async () => {
    sendMock.mockResolvedValue({});

    const result = await handler({ kind: 'delete', scheduleName: 'abc-prod-downsize-20260820-0030' });

    expect(result).toEqual({ ok: true, scheduleName: 'abc-prod-downsize-20260820-0030' });
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('returns ok:false when DeleteScheduleCommand throws', async () => {
    sendMock.mockRejectedValue(new Error('ResourceNotFoundException'));

    const result = await handler({ kind: 'delete', scheduleName: 'abc-prod-downsize-not-exist' });

    expect(result).toEqual({ ok: false, error: 'ResourceNotFoundException' });
  });
});
