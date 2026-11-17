import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LambdaFunctionURLEvent } from 'aws-lambda';

vi.mock('../../config.js', () => ({
  config: { awsRegion: 'ap-southeast-1' },
  corsHeaders: () => ({}),
}));

const schedulerSendMock = vi.fn();
const eventBridgeSendMock = vi.fn();

vi.mock('@aws-sdk/client-scheduler', () => {
  class ListSchedulesCommand {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }
  class GetScheduleCommand {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }
  class SchedulerClient {
    send(cmd: unknown) {
      return schedulerSendMock(cmd);
    }
  }
  return { SchedulerClient, ListSchedulesCommand, GetScheduleCommand };
});

vi.mock('@aws-sdk/client-eventbridge', () => {
  class ListRulesCommand {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }
  class DescribeRuleCommand {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }
  class EventBridgeClient {
    send(cmd: unknown) {
      return eventBridgeSendMock(cmd);
    }
  }
  return { EventBridgeClient, ListRulesCommand, DescribeRuleCommand };
});

const { handler } = await import('./get-scheduled-actions.js');

function buildEvent(): LambdaFunctionURLEvent {
  return {
    headers: {},
    rawPath: '/scheduled-actions',
    requestContext: { http: { method: 'GET' } },
  } as unknown as LambdaFunctionURLEvent;
}

beforeEach(() => {
  schedulerSendMock.mockReset();
  eventBridgeSendMock.mockReset();
});

describe('get-scheduled-actions handler', () => {
  it('returns recurringRules + oneTimeSchedules with the correct shape from ListSchedules/GetSchedule + ListRules/DescribeRule', async () => {
    eventBridgeSendMock
      .mockResolvedValueOnce({ Rules: [{ Name: 'abc-ops-dashboard-prod-patch-scheduler-rule' }] })
      .mockResolvedValueOnce({
        ScheduleExpression: 'rate(5 minutes)',
        State: 'ENABLED',
        Description: 'Patch scheduler',
      });

    schedulerSendMock
      .mockResolvedValueOnce({ Schedules: [{ Name: 'abc-prod-downsize-20260820-0030-ab12' }] })
      .mockResolvedValueOnce({
        ScheduleExpression: 'at(2026-08-20T00:30:00)',
        ActionAfterCompletion: 'DELETE',
        Target: {
          Arn: 'arn:aws:lambda:ap-southeast-1:123456789012:function:abc-ops-dashboard-prod-downsize-scheduler-fn',
          Input: JSON.stringify({ rds: { instanceIdentifier: 'abc-prod-rds-postgres', targetClass: 'db.m7g.xlarge' } }),
        },
      });

    const result = await handler(buildEvent());
    const body = JSON.parse((result as { body: string }).body);

    expect(body.recurringRules).toEqual([
      {
        name: 'abc-ops-dashboard-prod-patch-scheduler-rule',
        scheduleExpression: 'rate(5 minutes)',
        state: 'ENABLED',
        targetFunctionName: '',
        description: 'Patch scheduler',
      },
    ]);
    expect(body.oneTimeSchedules).toEqual([
      {
        name: 'abc-prod-downsize-20260820-0030-ab12',
        runAtIso: '2026-08-20T00:30:00',
        actionAfterCompletion: 'DELETE',
        targetFunctionName: 'abc-ops-dashboard-prod-downsize-scheduler-fn',
        rds: { instanceIdentifier: 'abc-prod-rds-postgres', targetClass: 'db.m7g.xlarge' },
      },
    ]);
  });

  it('calls ListSchedulesCommand with NamePrefix abc-prod-downsize- (not the stack NAME_PREFIX)', async () => {
    eventBridgeSendMock.mockResolvedValueOnce({ Rules: [] });
    schedulerSendMock.mockResolvedValueOnce({ Schedules: [] });

    await handler(buildEvent());

    const listSchedulesCall = schedulerSendMock.mock.calls[0][0] as { input: { NamePrefix: string } };
    expect(listSchedulesCall.input).toEqual({ NamePrefix: 'abc-prod-downsize-' });

    const listRulesCall = eventBridgeSendMock.mock.calls[0][0] as { input: { NamePrefix: string } };
    expect(listRulesCall.input).toEqual({ NamePrefix: 'abc-ops-dashboard-prod' });
  });

  it('returns empty arrays when there are no schedules/rules', async () => {
    eventBridgeSendMock.mockResolvedValueOnce({ Rules: [] });
    schedulerSendMock.mockResolvedValueOnce({ Schedules: [] });

    const result = await handler(buildEvent());
    const body = JSON.parse((result as { body: string }).body);

    expect(body).toEqual({ recurringRules: [], oneTimeSchedules: [] });
  });
});
