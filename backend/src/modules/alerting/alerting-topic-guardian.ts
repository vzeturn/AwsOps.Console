import { ListTopicsCommand, ListSubscriptionsByTopicCommand } from '@aws-sdk/client-sns';
import { getSnsClient } from '../../core/aws-clients.js';
import { postDiscordEmbeds } from './discordWebhook.js';
import { buildOpsNotificationEmbed } from './opsNotification.js';
import { logger } from '../../shared-kernel/logger.js';

/**
 * `alerting-topic-guardian.ts` — a NEW Lambda, scheduled (EventBridge Scheduler `rate(1 day)`, see
 * `infra/ops-dashboard.yaml`) — turns a one-time manual finding into a recurring, automatic check.
 *
 * THE INCIDENT THIS PREVENTS FROM RECURRING SILENTLY
 *
 * A manual audit on 2026-09-17 found `abc-prod-security-alerts` (the SNS topic every CIS Benchmark
 * alarm — login failures, IAM policy changes, root account usage — publishes `AlarmActions` to)
 * had **0 confirmed subscriptions**. It had looked "configured" (the topic existed, alarms were
 * wired to it, `ActionsEnabled: true`) while silently delivering nothing — the exact failure mode
 * documented on `RdsEventSubscription` elsewhere in this stack: a subscription that is billed for
 * and LOOKS wired up, but reaches nobody. That gap was fixed by hand (subscribed
 * `alerting-notifier-fn` to it) — this Lambda makes sure the NEXT such gap (a new topic created
 * without a subscriber, or a subscription later removed) is caught within 24h instead of waiting
 * for another manual audit.
 *
 * SCOPE: every account SNS topic — NOT limited to topics this stack itself created. A topic
 * outside this stack (like `abc-prod-security-alerts`, owned by Security Hub/Config conformance
 * packs) is just as capable of silently going dark, and an operator relying on THIS dashboard for
 * alerting coverage needs to know about it regardless of which stack created the topic.
 *
 * WHAT "NEEDS A SUBSCRIBER" MEANS HERE: `SubscriptionsConfirmed` (from `ListSubscriptionsByTopic`,
 * not `GetTopicAttributes` — the per-subscription list is the ground truth; a topic's own
 * `SubscriptionsConfirmed` attribute is a fast aggregate that lags by design and isn't reliable
 * enough for a security check). A topic with 0 subscriptions listed (confirmed OR pending) is
 * flagged — a PENDING (not yet confirmed) subscription is also worth surfacing, since an email
 * subscription stuck in "pending confirmation" forever is functionally the same as having none.
 */

const sns = getSnsClient();

export interface TopicSubscriptionStatus {
  topicArn: string;
  subscriptionCount: number;
}

/** Lists every SNS topic in the account/region, paginating through `NextToken`. */
async function listAllTopics(): Promise<string[]> {
  const arns: string[] = [];
  let nextToken: string | undefined;
  do {
    const { Topics = [], NextToken } = await sns.send(new ListTopicsCommand({ NextToken: nextToken }));
    for (const topic of Topics) {
      if (topic.TopicArn) arns.push(topic.TopicArn);
    }
    nextToken = NextToken;
  } while (nextToken);
  return arns;
}

/** Counts subscriptions (confirmed or pending) for 1 topic — paginated, since a busy topic can
 * have more than 1 page of subscribers. A `NotFound`/`AuthorizationError` (e.g. the topic was
 * deleted between `ListTopics` and this call, or this Lambda's IAM permission doesn't cover a
 * topic outside this stack for some region-specific reason) is treated as "unknown, skip" rather
 * than "0 subscribers" — reporting a false positive on a topic this Lambda genuinely cannot see
 * into would be worse than staying silent about it. */
async function countSubscriptions(topicArn: string): Promise<number | undefined> {
  try {
    let count = 0;
    let nextToken: string | undefined;
    do {
      const { Subscriptions = [], NextToken } = await sns.send(
        new ListSubscriptionsByTopicCommand({ TopicArn: topicArn, NextToken: nextToken }),
      );
      count += Subscriptions.length;
      nextToken = NextToken;
    } while (nextToken);
    return count;
  } catch (err) {
    logger.error(`alerting-topic-guardian: failed to list subscriptions for ${topicArn} (skipping, treated as unknown)`, err);
    return undefined;
  }
}

/** Pure filter — separates the per-topic subscription counts already gathered into the ones
 * worth alerting on (0 subscribers) vs. healthy. Kept separate from `handler()` so it's testable
 * without mocking the AWS SDK. */
export function findOrphanedTopics(statuses: TopicSubscriptionStatus[]): TopicSubscriptionStatus[] {
  return statuses.filter((s) => s.subscriptionCount === 0);
}

export async function handler(): Promise<{ ok: true; checked: number; orphaned: number }> {
  const topicArns = await listAllTopics();

  const results = await Promise.all(
    topicArns.map(async (topicArn) => {
      const count = await countSubscriptions(topicArn);
      return count === undefined ? undefined : { topicArn, subscriptionCount: count };
    }),
  );
  const statuses = results.filter((r): r is TopicSubscriptionStatus => r !== undefined);
  const orphaned = findOrphanedTopics(statuses);

  logger.info(`alerting-topic-guardian: checked=${statuses.length}/${topicArns.length} orphaned=${orphaned.length}`);

  if (orphaned.length > 0) {
    const region = process.env.AWS_REGION;
    // SNS topic ARN shape: arn:aws:sns:<region>:<account>:<name> — build a direct console deep
    // link per topic rather than a generic "open SNS" link, matching this file's own "only link
    // when it takes the reader directly to the relevant view" convention. Capped at 5, same
    // reasoning as `health-report.ts`'s Links cap — the "Topics with 0 subscribers" field above
    // already lists every one by name; Links exists for one-click access to a few, not a
    // duplicate full list.
    const links = region
      ? orphaned.slice(0, 5).map((o) => {
          const topicName = o.topicArn.split(':').pop() ?? o.topicArn;
          return { label: topicName, url: `https://${region}.console.aws.amazon.com/sns/v3/home?region=${region}#/topic/${o.topicArn}` };
        })
      : undefined;

    const embed = buildOpsNotificationEmbed({
      what: `${orphaned.length} SNS topic(s) have NO subscribers`,
      severity: 'critical',
      who: 'system:alerting-topic-guardian',
      impact: `Every alarm/rule already pointed at ${orphaned.length === 1 ? 'this topic' : 'these topics'} is silently delivering nothing — a real incident on any of them will page NOBODY, while every dashboard/console view still shows the alerting as "configured".`,
      why: 'A topic with 0 subscriptions delivers nothing even though every alarm/rule pointed at it looks correctly configured — this is a silent alerting gap, not a benign misconfiguration.',
      how: 'Subscribe alerting-notifier-fn (or an appropriate endpoint) to each topic below, or delete the topic if it is genuinely unused.',
      links,
      region,
      extra: [
        {
          name: 'Topics with 0 subscribers',
          value: orphaned.map((o) => `\`${o.topicArn}\``).join('\n').slice(0, 1024),
          inline: false,
        },
      ],
    });
    await postDiscordEmbeds([embed]);
  }

  return { ok: true, checked: statuses.length, orphaned: orphaned.length };
}
