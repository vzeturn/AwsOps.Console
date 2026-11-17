import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LambdaFunctionURLEvent } from 'aws-lambda';

vi.mock('../../config.js', () => ({
  config: {
    awsRegion: 'ap-southeast-1',
    scheduledActionsMutateFunctionName: 'abc-ops-dashboard-prod-scheduled-actions-mutate-fn',
  },
  corsHeaders: () => ({}),
}));

const invokeSendMock = vi.fn();
vi.mock('@aws-sdk/client-lambda', () => {
  class InvokeCommand {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }
  class LambdaClient {
    send(cmd: unknown) {
      return invokeSendMock(cmd);
    }
  }
  return { LambdaClient, InvokeCommand };
});

const { createHandler, deleteHandler } = await import('./scheduled-actions-execute.js');

function buildEvent(body: unknown): LambdaFunctionURLEvent {
  return {
    headers: {},
    rawPath: '/scheduled-actions',
    requestContext: { http: { method: 'POST' } },
    body: JSON.stringify(body),
  } as unknown as LambdaFunctionURLEvent;
}

function mockInvokeResult(payload: unknown, functionError?: string) {
  invokeSendMock.mockResolvedValue({
    Payload: Buffer.from(JSON.stringify(payload)),
    FunctionError: functionError,
  });
}

beforeEach(() => {
  invokeSendMock.mockReset();
});

describe('scheduled-actions-execute — createHandler', () => {
  it('calls InvokeCommand with kind create + rds, returns the result from the mutate fn', async () => {
    mockInvokeResult({ ok: true, scheduleName: 'abc-prod-downsize-20260820-0030-ab12' });
    const event = buildEvent({
      runAtIso: '2026-08-20T00:30:00.000Z',
      rds: { instanceIdentifier: 'abc-prod-rds-postgres', targetClass: 'db.m7g.xlarge' },
    });

    const result = await createHandler(event);
    const body = JSON.parse((result as { body: string }).body);

    expect(body).toEqual({ ok: true, scheduleName: 'abc-prod-downsize-20260820-0030-ab12' });
    expect(invokeSendMock).toHaveBeenCalledTimes(1);
    const sentCommand = invokeSendMock.mock.calls[0][0] as { input: { Payload: Buffer } };
    const sentPayload = JSON.parse(sentCommand.input.Payload.toString('utf-8'));
    expect(sentPayload).toEqual({
      kind: 'create',
      runAtIso: '2026-08-20T00:30:00.000Z',
      rds: { instanceIdentifier: 'abc-prod-rds-postgres', targetClass: 'db.m7g.xlarge' },
    });
  });

  it('throws badRequest (400) when runAtIso is missing', async () => {
    const event = buildEvent({ rds: { instanceIdentifier: 'x', targetClass: 'db.m7g.xlarge' } });

    await expect(createHandler(event)).rejects.toMatchObject({ statusCode: 400 });
    expect(invokeSendMock).not.toHaveBeenCalled();
  });

  it('throws badRequest (400) when both rds and ec2 are missing', async () => {
    const event = buildEvent({ runAtIso: '2026-08-20T00:30:00.000Z' });

    await expect(createHandler(event)).rejects.toMatchObject({ statusCode: 400 });
    expect(invokeSendMock).not.toHaveBeenCalled();
  });

  it('throws badGateway (502) when InvokeCommand returns FunctionError', async () => {
    mockInvokeResult({}, 'Unhandled');
    const event = buildEvent({
      runAtIso: '2026-08-20T00:30:00.000Z',
      ec2: { instanceId: 'i-0a1b2c3d4e5f60002', targetType: 't3.xlarge' },
    });

    await expect(createHandler(event)).rejects.toMatchObject({ statusCode: 502 });
  });
});

describe('scheduled-actions-execute — deleteHandler', () => {
  it('calls InvokeCommand with kind delete + scheduleName, returns the result from the mutate fn', async () => {
    mockInvokeResult({ ok: true, scheduleName: 'abc-prod-downsize-20260820-0030-ab12' });
    const event = buildEvent({});

    const result = await deleteHandler(event, 'abc-prod-downsize-20260820-0030-ab12');
    const body = JSON.parse((result as { body: string }).body);

    expect(body).toEqual({ ok: true, scheduleName: 'abc-prod-downsize-20260820-0030-ab12' });
    const sentCommand = invokeSendMock.mock.calls[0][0] as { input: { Payload: Buffer } };
    const sentPayload = JSON.parse(sentCommand.input.Payload.toString('utf-8'));
    expect(sentPayload).toEqual({ kind: 'delete', scheduleName: 'abc-prod-downsize-20260820-0030-ab12' });
  });

  it('throws badRequest (400) when scheduleName is empty', async () => {
    const event = buildEvent({});

    await expect(deleteHandler(event, '')).rejects.toMatchObject({ statusCode: 400 });
    expect(invokeSendMock).not.toHaveBeenCalled();
  });

  it('throws badRequest (400) when scheduleName does not match the pattern (blocks deleting arbitrary schedules)', async () => {
    const event = buildEvent({});

    await expect(deleteHandler(event, 'some-other-important-schedule')).rejects.toMatchObject({ statusCode: 400 });
    expect(invokeSendMock).not.toHaveBeenCalled();
  });

  it('accepts a scheduleName matching the pattern abc-prod-downsize-YYYYMMDD-HHMM-xxxx', async () => {
    mockInvokeResult({ ok: true, scheduleName: 'abc-prod-downsize-20260901-0315-ab12' });
    const event = buildEvent({});

    const result = await deleteHandler(event, 'abc-prod-downsize-20260901-0315-ab12');
    const body = JSON.parse((result as { body: string }).body);

    expect(body).toEqual({ ok: true, scheduleName: 'abc-prod-downsize-20260901-0315-ab12' });
    expect(invokeSendMock).toHaveBeenCalledTimes(1);
  });
});

describe('scheduled-actions-execute — createHandler validation of rds/ec2 target format', () => {
  it('accepts a valid instanceIdentifier, rejects an invalid format', async () => {
    mockInvokeResult({ ok: true, scheduleName: 'x' });

    const validEvent = buildEvent({
      runAtIso: '2026-08-20T00:30:00.000Z',
      rds: { instanceIdentifier: 'abc-prod-rds-postgres', targetClass: 'db.m7g.xlarge' },
    });
    await createHandler(validEvent);
    expect(invokeSendMock).toHaveBeenCalledTimes(1);

    invokeSendMock.mockClear();
    const invalidEvent = buildEvent({
      runAtIso: '2026-08-20T00:30:00.000Z',
      rds: { instanceIdentifier: 'DROP TABLE;--', targetClass: 'db.m7g.xlarge' },
    });
    await expect(createHandler(invalidEvent)).rejects.toMatchObject({ statusCode: 400 });
    expect(invokeSendMock).not.toHaveBeenCalled();
  });

  it('accepts a valid targetClass, rejects an invalid format', async () => {
    mockInvokeResult({ ok: true, scheduleName: 'x' });

    const validEvent = buildEvent({
      runAtIso: '2026-08-20T00:30:00.000Z',
      rds: { instanceIdentifier: 'abc-prod-rds-postgres', targetClass: 'db.m7g.xlarge' },
    });
    await createHandler(validEvent);
    expect(invokeSendMock).toHaveBeenCalledTimes(1);

    invokeSendMock.mockClear();
    const invalidEvent = buildEvent({
      runAtIso: '2026-08-20T00:30:00.000Z',
      rds: { instanceIdentifier: 'abc-prod-rds-postgres', targetClass: 'not-a-class' },
    });
    await expect(createHandler(invalidEvent)).rejects.toMatchObject({ statusCode: 400 });
    expect(invokeSendMock).not.toHaveBeenCalled();
  });

  it('accepts a valid instanceId, rejects an invalid format', async () => {
    mockInvokeResult({ ok: true, scheduleName: 'x' });

    const validEvent = buildEvent({
      runAtIso: '2026-08-20T00:30:00.000Z',
      ec2: { instanceId: 'i-0a1b2c3d4e5f60002', targetType: 't3.xlarge' },
    });
    await createHandler(validEvent);
    expect(invokeSendMock).toHaveBeenCalledTimes(1);

    invokeSendMock.mockClear();
    const invalidEvent = buildEvent({
      runAtIso: '2026-08-20T00:30:00.000Z',
      ec2: { instanceId: 'not-an-instance-id', targetType: 't3.xlarge' },
    });
    await expect(createHandler(invalidEvent)).rejects.toMatchObject({ statusCode: 400 });
    expect(invokeSendMock).not.toHaveBeenCalled();
  });

  it('accepts a valid targetType, rejects an invalid format', async () => {
    mockInvokeResult({ ok: true, scheduleName: 'x' });

    const validEvent = buildEvent({
      runAtIso: '2026-08-20T00:30:00.000Z',
      ec2: { instanceId: 'i-0a1b2c3d4e5f60002', targetType: 't3.xlarge' },
    });
    await createHandler(validEvent);
    expect(invokeSendMock).toHaveBeenCalledTimes(1);

    invokeSendMock.mockClear();
    const invalidEvent = buildEvent({
      runAtIso: '2026-08-20T00:30:00.000Z',
      ec2: { instanceId: 'i-0a1b2c3d4e5f60002', targetType: 'NOT_A_TYPE' },
    });
    await expect(createHandler(invalidEvent)).rejects.toMatchObject({ statusCode: 400 });
    expect(invokeSendMock).not.toHaveBeenCalled();
  });
});

describe('scheduled-actions-execute — invokeMutate guard JSON.parse', () => {
  it('throws badGateway (502) when the returned payload is not valid JSON', async () => {
    invokeSendMock.mockResolvedValue({ Payload: Buffer.from('not json'), FunctionError: undefined });
    const event = buildEvent({
      runAtIso: '2026-08-20T00:30:00.000Z',
      ec2: { instanceId: 'i-0a1b2c3d4e5f60002', targetType: 't3.xlarge' },
    });

    await expect(createHandler(event)).rejects.toMatchObject({ statusCode: 502 });
  });
});
