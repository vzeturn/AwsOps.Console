/**
 * `rds-nightly-scheduler-fn` — standalone Lambda, invoked by TWO EventBridge Scheduler cron rules
 * (`Asia/Ho_Chi_Minh` timezone, see `infra/ops-dashboard.yaml`): one at 00:00 with
 * `{"action":"stop"}`, one at 06:30 with `{"action":"start"}`. Discovers every RDS instance
 * tagged `rds-nightly-scheduler:managed=true` and stops/starts each one.
 *
 * Built to replace Idle-to-Zero traffic-based stop/wake for `abc-stg-rds-postgres`: that
 * instance's traffic is sparse and bursty enough (roughly one request every ~20 minutes some
 * hours) that a traffic-based idle window kept flapping it stopped/woken — each cycle is a full
 * RDS restart, which was the root cause of an abnormal Network/disk spike investigated
 * 2026-09-24. A fixed nightly schedule has no traffic dependency, so it cannot flap. EC2 in the
 * same resource-group keeps using Idle-to-Zero as before (see the `ManagedAlb.rdsInstanceId`
 * comment in `idle-scheduler-tick.ts` — RDS is simply no longer tagged on the ALB).
 *
 * Lean_Lambda_Exception (Requirement 6.4a — same reasoning as `idle-scheduler-tick.ts`): imports
 * `discordWebhook.ts`/`opsNotification.ts` directly, not via `../alerting/index.js`.
 */
import { DescribeDBInstancesCommand, ListTagsForResourceCommand, StartDBInstanceCommand, StopDBInstanceCommand } from '@aws-sdk/client-rds';
import { getRdsClient } from '../../core/aws-clients.js';
import { tagsToMap } from '../../core/awsTags.js';
import { fetchAllPages } from '../../core/pagination.js';
import { RDS_NIGHTLY_SCHEDULER_MANAGED_TAG_KEY } from '@ops-dashboard/shared';
import { postDiscordEmbeds } from '../alerting/discordWebhook.js';
import { buildOpsNotificationEmbed } from '../alerting/opsNotification.js';
import { logger } from '../../shared-kernel/logger.js';

const rds = getRdsClient();

export interface RdsNightlySchedulerEvent {
  action: 'stop' | 'start';
}

async function discoverManagedInstanceIds(): Promise<string[]> {
  const allInstances = await fetchAllPages(async (marker) => {
    const { DBInstances = [], Marker } = await rds.send(new DescribeDBInstancesCommand({ Marker: marker }));
    return { items: DBInstances, nextToken: Marker };
  });

  const managed: string[] = [];
  for (const db of allInstances) {
    if (!db.DBInstanceArn || !db.DBInstanceIdentifier) continue;
    const { TagList = [] } = await rds.send(new ListTagsForResourceCommand({ ResourceName: db.DBInstanceArn }));
    if (tagsToMap(TagList)[RDS_NIGHTLY_SCHEDULER_MANAGED_TAG_KEY] === 'true') managed.push(db.DBInstanceIdentifier);
  }
  return managed;
}

async function applyAction(dbInstanceIdentifier: string, action: 'stop' | 'start'): Promise<string> {
  const { DBInstances = [] } = await rds.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: dbInstanceIdentifier }));
  const status = DBInstances[0]?.DBInstanceStatus ?? 'unknown';

  if (action === 'stop') {
    if (status !== 'available') return `skipped (status=${status})`;
    await rds.send(new StopDBInstanceCommand({ DBInstanceIdentifier: dbInstanceIdentifier }));
    return `stop requested (was ${status})`;
  }
  if (status !== 'stopped') return `skipped (status=${status})`;
  await rds.send(new StartDBInstanceCommand({ DBInstanceIdentifier: dbInstanceIdentifier }));
  return `start requested (was ${status})`;
}

export interface RdsNightlySchedulerResult {
  ok: true;
  action: 'stop' | 'start';
  results: Record<string, string>;
}

export async function handler(event: RdsNightlySchedulerEvent): Promise<RdsNightlySchedulerResult> {
  const action = event?.action;
  if (action !== 'stop' && action !== 'start') {
    throw new Error(`rds-nightly-scheduler: invalid action '${String(action)}' (expected 'stop' or 'start')`);
  }

  const instanceIds = await discoverManagedInstanceIds();
  const results: Record<string, string> = {};
  for (const id of instanceIds) {
    try {
      results[id] = await applyAction(id, action);
    } catch (err) {
      results[id] = `error: ${(err as Error).message}`;
    }
  }

  logger.info(`rds-nightly-scheduler: action=${action} instances=${instanceIds.length} results=${JSON.stringify(results)}`);

  const failed = Object.entries(results).filter(([, v]) => v.startsWith('error:'));
  if (failed.length > 0) {
    try {
      const embed = buildOpsNotificationEmbed({
        what: `rds-nightly-scheduler: failed to ${action} ${failed.length} RDS instance(s)`,
        severity: 'critical',
        who: 'system:rds-nightly-scheduler',
        impact:
          action === 'stop'
            ? 'The instance stayed running overnight — no cost-saving happened for it this cycle, investigate the error below.'
            : 'The instance stayed stopped this morning — it will be unreachable until manually started or the next cycle fixes itself.',
        why: failed.map(([id, v]) => `${id}: ${v}`).join('\n').slice(0, 1024),
        how: `Check CloudWatch Logs for /aws/lambda/*-rds-nightly-scheduler-fn, and manually ${action} the instance if needed.`,
      });
      await postDiscordEmbeds([embed]);
    } catch (err) {
      // The action was already invoked (or genuinely failed) before this point — never throw here,
      // otherwise the EventBridge Scheduler retry would re-run the whole handler.
      logger.error('rds-nightly-scheduler: postDiscordEmbeds failed', err);
    }
  }

  return { ok: true, action, results };
}
