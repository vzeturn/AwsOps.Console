import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.AWS_REGION = 'ap-southeast-1';

const snsSendMock = vi.fn();

vi.mock('@aws-sdk/client-sns', () => ({
  SNSClient: vi.fn().mockImplementation(() => ({ send: snsSendMock })),
  ListTopicsCommand: vi.fn().mockImplementation((input: unknown) => ({ __cmd: 'ListTopics', input })),
  ListSubscriptionsByTopicCommand: vi.fn().mockImplementation((input: unknown) => ({ __cmd: 'ListSubscriptionsByTopic', input })),
}));

const postDiscordEmbedsMock = vi.fn();
vi.mock('./discordWebhook.js', () => ({ postDiscordEmbeds: postDiscordEmbedsMock }));

const { handler, findOrphanedTopics } = await import('./alerting-topic-guardian.js');

beforeEach(() => {
  snsSendMock.mockReset();
  postDiscordEmbedsMock.mockReset();
});

describe('findOrphanedTopics', () => {
  it('flags only topics with exactly 0 subscriptions', () => {
    const result = findOrphanedTopics([
      { topicArn: 'arn:topic-a', subscriptionCount: 0 },
      { topicArn: 'arn:topic-b', subscriptionCount: 1 },
      { topicArn: 'arn:topic-c', subscriptionCount: 5 },
    ]);
    expect(result).toEqual([{ topicArn: 'arn:topic-a', subscriptionCount: 0 }]);
  });

  it('returns empty when every topic has at least 1 subscriber', () => {
    expect(findOrphanedTopics([{ topicArn: 'arn:topic-a', subscriptionCount: 3 }])).toEqual([]);
  });
});

describe('handler', () => {
  it('posts a Discord embed listing every topic with 0 subscribers, leaves healthy topics out', async () => {
    snsSendMock.mockImplementation((command: { __cmd: string; input?: { TopicArn?: string } }) => {
      if (command.__cmd === 'ListTopics') {
        return Promise.resolve({ Topics: [{ TopicArn: 'arn:aws:sns:ap-southeast-1:1:orphaned' }, { TopicArn: 'arn:aws:sns:ap-southeast-1:1:healthy' }] });
      }
      if (command.__cmd === 'ListSubscriptionsByTopic') {
        if (command.input?.TopicArn === 'arn:aws:sns:ap-southeast-1:1:orphaned') return Promise.resolve({ Subscriptions: [] });
        return Promise.resolve({ Subscriptions: [{ SubscriptionArn: 'sub-1' }] });
      }
      return Promise.resolve({});
    });

    const result = await handler();

    expect(result).toEqual({ ok: true, checked: 2, orphaned: 1 });
    expect(postDiscordEmbedsMock).toHaveBeenCalledTimes(1);
    const embeds = postDiscordEmbedsMock.mock.calls[0][0];
    expect(embeds[0].title).toContain('1 SNS topic');
    expect(JSON.stringify(embeds[0].fields)).toContain('arn:aws:sns:ap-southeast-1:1:orphaned');
    expect(JSON.stringify(embeds[0].fields)).not.toContain('arn:aws:sns:ap-southeast-1:1:healthy');
  });

  it('does not post anything when every topic has a subscriber', async () => {
    snsSendMock.mockImplementation((command: { __cmd: string }) => {
      if (command.__cmd === 'ListTopics') return Promise.resolve({ Topics: [{ TopicArn: 'arn:t1' }] });
      if (command.__cmd === 'ListSubscriptionsByTopic') return Promise.resolve({ Subscriptions: [{ SubscriptionArn: 's1' }] });
      return Promise.resolve({});
    });

    const result = await handler();

    expect(result).toEqual({ ok: true, checked: 1, orphaned: 0 });
    expect(postDiscordEmbedsMock).not.toHaveBeenCalled();
  });

  it('paginates ListTopics/ListSubscriptionsByTopic via NextToken', async () => {
    let listTopicsCalls = 0;
    let listSubsCalls = 0;
    snsSendMock.mockImplementation((command: { __cmd: string }) => {
      if (command.__cmd === 'ListTopics') {
        listTopicsCalls += 1;
        if (listTopicsCalls === 1) return Promise.resolve({ Topics: [{ TopicArn: 'arn:t1' }], NextToken: 'page2' });
        return Promise.resolve({ Topics: [{ TopicArn: 'arn:t2' }] });
      }
      if (command.__cmd === 'ListSubscriptionsByTopic') {
        listSubsCalls += 1;
        return Promise.resolve({ Subscriptions: [] });
      }
      return Promise.resolve({});
    });

    const result = await handler();

    expect(result.checked).toBe(2);
    expect(listSubsCalls).toBe(2);
  });

  it('treats a ListSubscriptionsByTopic failure as unknown (skipped), not as 0 subscribers', async () => {
    snsSendMock.mockImplementation((command: { __cmd: string; input?: { TopicArn?: string } }) => {
      if (command.__cmd === 'ListTopics') return Promise.resolve({ Topics: [{ TopicArn: 'arn:broken' }, { TopicArn: 'arn:fine' }] });
      if (command.__cmd === 'ListSubscriptionsByTopic') {
        if (command.input?.TopicArn === 'arn:broken') return Promise.reject(new Error('AccessDenied'));
        return Promise.resolve({ Subscriptions: [{ SubscriptionArn: 's1' }] });
      }
      return Promise.resolve({});
    });

    const result = await handler();

    // The broken topic is excluded from `checked` entirely — never counted as orphaned.
    expect(result).toEqual({ ok: true, checked: 1, orphaned: 0 });
    expect(postDiscordEmbedsMock).not.toHaveBeenCalled();
  });
});
