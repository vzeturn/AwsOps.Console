import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from 'aws-lambda';
import { ListSchedulesCommand, GetScheduleCommand } from '@aws-sdk/client-scheduler';
import { ListRulesCommand, DescribeRuleCommand } from '@aws-sdk/client-eventbridge';
import { getSchedulerClient, getEventBridgeClient } from '../../core/aws-clients.js';
import type { OneTimeSchedule, RecurringRule, ScheduledActionsResponse } from '@ops-dashboard/shared';
import { ok } from '../../shared-kernel/response.js';

/**
 * `GET /scheduled-actions` — reads DIRECTLY (not through the mutate Lambda) EventBridge Scheduler
 * one-time schedules + recurring EventBridge Rules, filtered by the `${Org}-${Project}-${Environment}`
 * prefix so resources outside the stack aren't mixed in. Follows the principle that the router
 * only Describes/Lists/Gets.
 */

const RULE_NAME_PREFIX = 'abc-ops-dashboard-prod';
// One-time schedules are named per `buildScheduleName()` in scheduled-actions-mutate-handler.ts
// (prefix `abc-prod-downsize-`, a convention inherited from the standalone downsize-scheduler.ts)
// — this does NOT share a prefix with the recurring EventBridge Rule above.
const ONE_TIME_SCHEDULE_NAME_PREFIX = 'abc-prod-downsize-';

const scheduler = getSchedulerClient();
const eventBridge = getEventBridgeClient();

function functionNameFromArn(arn: string | undefined): string {
  if (!arn) return '';
  const parts = arn.split(':');
  return parts[parts.length - 1] ?? '';
}

async function listOneTimeSchedules(): Promise<OneTimeSchedule[]> {
  const { Schedules = [] } = await scheduler.send(new ListSchedulesCommand({ NamePrefix: ONE_TIME_SCHEDULE_NAME_PREFIX }));
  const results: OneTimeSchedule[] = [];

  for (const summary of Schedules) {
    if (!summary.Name) continue;
    const detail = await scheduler.send(new GetScheduleCommand({ Name: summary.Name }));
    const expr = detail.ScheduleExpression ?? '';
    const match = /^at\((.+)\)$/.exec(expr);
    if (!match) continue;

    let rds: OneTimeSchedule['rds'];
    let ec2: OneTimeSchedule['ec2'];
    try {
      const parsedInput = JSON.parse(detail.Target?.Input ?? '{}') as { rds?: OneTimeSchedule['rds']; ec2?: OneTimeSchedule['ec2'] };
      rds = parsedInput.rds;
      ec2 = parsedInput.ec2;
    } catch {
      rds = undefined;
      ec2 = undefined;
    }

    results.push({
      name: summary.Name,
      runAtIso: match[1] ?? '',
      actionAfterCompletion: detail.ActionAfterCompletion === 'NONE' ? 'NONE' : 'DELETE',
      targetFunctionName: functionNameFromArn(detail.Target?.Arn),
      ...(rds ? { rds } : {}),
      ...(ec2 ? { ec2 } : {}),
    });
  }

  return results;
}

async function listRecurringRules(): Promise<RecurringRule[]> {
  const { Rules = [] } = await eventBridge.send(new ListRulesCommand({ NamePrefix: RULE_NAME_PREFIX }));
  const results: RecurringRule[] = [];

  for (const rule of Rules) {
    if (!rule.Name) continue;
    const detail = await eventBridge.send(new DescribeRuleCommand({ Name: rule.Name }));

    results.push({
      name: rule.Name,
      scheduleExpression: detail.ScheduleExpression ?? '',
      state: detail.State === 'DISABLED' ? 'DISABLED' : 'ENABLED',
      targetFunctionName: '',
      ...(detail.Description ? { description: detail.Description } : {}),
    });
  }

  return results;
}

export async function handler(event: LambdaFunctionURLEvent): Promise<LambdaFunctionURLResult> {
  const [recurringRules, oneTimeSchedules] = await Promise.all([listRecurringRules(), listOneTimeSchedules()]);
  const response: ScheduledActionsResponse = { recurringRules, oneTimeSchedules };
  return ok(event, response);
}
