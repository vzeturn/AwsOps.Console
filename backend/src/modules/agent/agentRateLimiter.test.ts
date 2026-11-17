import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  pruneTimestampsWithinWindow,
  computeRateLimitDecision,
  AGENT_RATE_LIMIT_MAX_EXECUTIONS,
  AGENT_RATE_LIMIT_WINDOW_MS,
} from './agentRateLimiter.js';

describe('pruneTimestampsWithinWindow (pure)', () => {
  it('keeps only timestamps strictly newer than now - windowMs', () => {
    const now = 1_000_000;
    const windowMs = 100;
    const timestamps = [now - 200, now - 101, now - 100, now - 99, now - 1, now];
    // cutoff = now - windowMs = 999_900. Kept: strictly > cutoff.
    expect(pruneTimestampsWithinWindow(timestamps, now, windowMs)).toEqual([now - 99, now - 1, now]);
  });

  it('returns an empty array when given an empty array', () => {
    expect(pruneTimestampsWithinWindow([], 1000, 100)).toEqual([]);
  });

  it('keeps everything when all timestamps are within the window', () => {
    const now = 5000;
    const timestamps = [4990, 4995, 5000];
    expect(pruneTimestampsWithinWindow(timestamps, now, AGENT_RATE_LIMIT_WINDOW_MS)).toEqual(timestamps);
  });
});

describe('computeRateLimitDecision (pure)', () => {
  it('allows the full requestedCount when well under budget', () => {
    const decision = computeRateLimitDecision(0, 2, 5);
    expect(decision).toEqual({ allowedCount: 2, budgetRemainingAfter: 3 });
  });

  it('caps allowedCount at the remaining budget when requesting more than available', () => {
    const decision = computeRateLimitDecision(3, 10, 5);
    expect(decision).toEqual({ allowedCount: 2, budgetRemainingAfter: 0 });
  });

  it('allows zero when the window is already fully consumed', () => {
    const decision = computeRateLimitDecision(5, 3, 5);
    expect(decision).toEqual({ allowedCount: 0, budgetRemainingAfter: 0 });
  });

  it('allows zero when currentCountInWindow exceeds maxExecutions (defensive floor at 0, never negative budget)', () => {
    const decision = computeRateLimitDecision(9, 3, 5);
    expect(decision).toEqual({ allowedCount: 0, budgetRemainingAfter: 0 });
  });

  it('requestedCount <= 0 always yields allowedCount 0 regardless of available budget', () => {
    expect(computeRateLimitDecision(0, 0, 5)).toEqual({ allowedCount: 0, budgetRemainingAfter: 5 });
    expect(computeRateLimitDecision(0, -3, 5)).toEqual({ allowedCount: 0, budgetRemainingAfter: 5 });
  });

  it('defaults maxExecutions to AGENT_RATE_LIMIT_MAX_EXECUTIONS when not passed', () => {
    const decision = computeRateLimitDecision(0, 100);
    expect(decision.allowedCount).toBe(AGENT_RATE_LIMIT_MAX_EXECUTIONS);
  });
});

const s3SendMock = vi.fn();

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({ send: s3SendMock })),
  GetObjectCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'GetObject', input })),
  PutObjectCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'PutObject', input })),
}));

beforeEach(() => {
  s3SendMock.mockReset();
  process.env.ASSESSMENT_BUCKET_NAME = 'test-assessment-bucket';
});

function jsonBody(value: unknown) {
  return { transformToString: async () => JSON.stringify(value) };
}

describe('reserveAgentExecutionBudget (S3-integrated)', () => {
  it('grants the full request and persists new timestamps when starting from an empty/nonexistent state', async () => {
    let putInput: { Key?: string; Body?: string } | undefined;
    s3SendMock.mockImplementation(async (command: { __type?: string; input?: unknown }) => {
      if (command.__type === 'GetObject') throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
      if (command.__type === 'PutObject') {
        putInput = command.input as typeof putInput;
        return {};
      }
      throw new Error('unexpected');
    });

    const { reserveAgentExecutionBudget } = await import('./agentRateLimiter.js');
    const decision = await reserveAgentExecutionBudget(3, 1_000_000);

    expect(decision).toEqual({ allowedCount: 3, budgetRemainingAfter: 2 });
    expect(putInput?.Key).toBe('agent-state/rate-limit.json');
    const written = JSON.parse(putInput!.Body!) as { executionTimestamps: number[] };
    expect(written.executionTimestamps).toEqual([1_000_000, 1_000_000, 1_000_000]);
  });

  it('caps the grant when prior in-window executions already consumed most of the budget', async () => {
    const now = 2_000_000;
    // 4 prior executions all within the window (AGENT_RATE_LIMIT_WINDOW_MS = 1 hour) -> only 1 left of 5.
    const priorTimestamps = [now - 1000, now - 2000, now - 3000, now - 4000];
    let putInput: { Body?: string } | undefined;
    s3SendMock.mockImplementation(async (command: { __type?: string; input?: unknown }) => {
      if (command.__type === 'GetObject') return { Body: jsonBody({ executionTimestamps: priorTimestamps }) };
      if (command.__type === 'PutObject') {
        putInput = command.input as typeof putInput;
        return {};
      }
      throw new Error('unexpected');
    });

    const { reserveAgentExecutionBudget } = await import('./agentRateLimiter.js');
    const decision = await reserveAgentExecutionBudget(5, now);

    expect(decision).toEqual({ allowedCount: 1, budgetRemainingAfter: 0 });
    const written = JSON.parse(putInput!.Body!) as { executionTimestamps: number[] };
    expect(written.executionTimestamps).toEqual([...priorTimestamps, now]);
  });

  it('excludes prior timestamps outside the rolling window when computing the budget', async () => {
    const now = 10_000_000;
    const longAgo = now - AGENT_RATE_LIMIT_WINDOW_MS - 1;
    let putInput: { Body?: string } | undefined;
    s3SendMock.mockImplementation(async (command: { __type?: string; input?: unknown }) => {
      if (command.__type === 'GetObject') {
        return { Body: jsonBody({ executionTimestamps: [longAgo, longAgo, longAgo, longAgo, longAgo] }) };
      }
      if (command.__type === 'PutObject') {
        putInput = command.input as typeof putInput;
        return {};
      }
      throw new Error('unexpected');
    });

    const { reserveAgentExecutionBudget } = await import('./agentRateLimiter.js');
    const decision = await reserveAgentExecutionBudget(2, now);

    // All 5 prior timestamps are outside the window -> full budget available again.
    expect(decision).toEqual({ allowedCount: 2, budgetRemainingAfter: 3 });
    const written = JSON.parse(putInput!.Body!) as { executionTimestamps: number[] };
    expect(written.executionTimestamps).toEqual([now, now]);
  });

  it('grants zero and still prunes expired entries on write when the window is fully consumed', async () => {
    const now = 5_000_000;
    const priorTimestamps = [now - 100, now - 200, now - 300, now - 400, now - 500];
    let putInput: { Body?: string } | undefined;
    s3SendMock.mockImplementation(async (command: { __type?: string; input?: unknown }) => {
      if (command.__type === 'GetObject') return { Body: jsonBody({ executionTimestamps: priorTimestamps }) };
      if (command.__type === 'PutObject') {
        putInput = command.input as typeof putInput;
        return {};
      }
      throw new Error('unexpected');
    });

    const { reserveAgentExecutionBudget } = await import('./agentRateLimiter.js');
    const decision = await reserveAgentExecutionBudget(3, now);

    expect(decision).toEqual({ allowedCount: 0, budgetRemainingAfter: 0 });
    // Nothing new added since allowedCount is 0, but no entries were expired either (all within window).
    expect(putInput).toBeUndefined();
  });

  it('treats an unreadable/corrupted state as empty rather than throwing', async () => {
    s3SendMock.mockImplementation(async (command: { __type?: string }) => {
      if (command.__type === 'GetObject') throw new Error('AccessDenied');
      if (command.__type === 'PutObject') return {};
      throw new Error('unexpected');
    });

    const { reserveAgentExecutionBudget } = await import('./agentRateLimiter.js');
    const decision = await reserveAgentExecutionBudget(2, Date.now());

    expect(decision.allowedCount).toBe(2);
  });

  it('does not throw when the S3 write fails — the decision is still returned', async () => {
    s3SendMock.mockImplementation(async (command: { __type?: string }) => {
      if (command.__type === 'GetObject') throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
      if (command.__type === 'PutObject') throw new Error('S3 unavailable');
      throw new Error('unexpected');
    });

    const { reserveAgentExecutionBudget } = await import('./agentRateLimiter.js');
    await expect(reserveAgentExecutionBudget(1, Date.now())).resolves.toEqual({ allowedCount: 1, budgetRemainingAfter: 4 });
  });
});
