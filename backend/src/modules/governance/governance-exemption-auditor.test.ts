import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.AWS_REGION = 'ap-southeast-1';

const ec2SendMock = vi.fn();
const elbSendMock = vi.fn();

vi.mock('@aws-sdk/client-ec2', () => ({
  EC2Client: vi.fn().mockImplementation(() => ({ send: ec2SendMock })),
  DescribeInstancesCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
}));
vi.mock('@aws-sdk/client-elastic-load-balancing-v2', () => ({
  ElasticLoadBalancingV2Client: vi.fn().mockImplementation(() => ({ send: elbSendMock })),
  DescribeLoadBalancersCommand: vi.fn().mockImplementation((input: unknown) => ({ __cmd: 'DescribeLoadBalancers', input })),
  DescribeTagsCommand: vi.fn().mockImplementation((input: unknown) => ({ __cmd: 'DescribeTags', input })),
}));

const postDiscordEmbedsMock = vi.fn();
vi.mock('../alerting/discordWebhook.js', () => ({ postDiscordEmbeds: postDiscordEmbedsMock }));

const { handler, isReviewOverdue, findOverdueExemptions } = await import('./governance-exemption-auditor.js');

beforeEach(() => {
  ec2SendMock.mockReset();
  elbSendMock.mockReset();
  postDiscordEmbedsMock.mockReset();
});

describe('isReviewOverdue', () => {
  const now = new Date('2026-10-20T00:00:00Z');

  it('is overdue when the review date is in the past', () => {
    expect(isReviewOverdue('2026-10-17', now)).toBe(true);
  });

  it('is not overdue when the review date is in the future', () => {
    expect(isReviewOverdue('2026-11-01', now)).toBe(false);
  });

  it('is not overdue when there is no review date at all', () => {
    expect(isReviewOverdue(undefined, now)).toBe(false);
  });

  it('is not overdue (fail-safe) when the date is unparseable', () => {
    expect(isReviewOverdue('not-a-date', now)).toBe(false);
  });
});

describe('findOverdueExemptions', () => {
  it('filters to only resources whose review date has passed', () => {
    const now = new Date('2026-10-20T00:00:00Z');
    const resources = [
      { resourceId: 'i-overdue', resourceType: 'ec2' as const, monitoringExempt: false, securityException: 'x', securityExceptionOwner: undefined, reviewDate: '2026-10-17' },
      { resourceId: 'i-fine', resourceType: 'ec2' as const, monitoringExempt: false, securityException: 'y', securityExceptionOwner: undefined, reviewDate: '2026-12-01' },
      { resourceId: 'i-no-review', resourceType: 'ec2' as const, monitoringExempt: true, securityException: undefined, securityExceptionOwner: undefined, reviewDate: undefined },
    ];
    expect(findOverdueExemptions(resources, now).map((r) => r.resourceId)).toEqual(['i-overdue']);
  });
});

describe('handler', () => {
  it('reports EC2 instances whose SecurityExceptionReviewDate has passed', async () => {
    ec2SendMock.mockResolvedValue({
      Reservations: [
        {
          Instances: [
            {
              InstanceId: 'i-overdue',
              Tags: [
                { Key: 'SecurityException', Value: 'dual-vpn-test' },
                { Key: 'SecurityExceptionOwner', Value: 'vi.nguyen.avn' },
                { Key: 'SecurityExceptionReviewDate', Value: '2020-01-01' },
              ],
            },
            {
              InstanceId: 'i-fine',
              Tags: [{ Key: 'SecurityException', Value: 'other' }, { Key: 'SecurityExceptionReviewDate', Value: '2099-01-01' }],
            },
            { InstanceId: 'i-untagged', Tags: [] },
          ],
        },
      ],
    });
    elbSendMock.mockResolvedValue({ LoadBalancers: [] });

    const result = await handler();

    expect(result).toEqual({ ok: true, exempted: 2, overdue: 1 });
    expect(postDiscordEmbedsMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(postDiscordEmbedsMock.mock.calls[0][0])).toContain('i-overdue');
    expect(JSON.stringify(postDiscordEmbedsMock.mock.calls[0][0])).not.toContain('i-fine');
  });

  it('an ops-dashboard:monitoring-exempt tag with NO review date is never flagged', async () => {
    ec2SendMock.mockResolvedValue({
      Reservations: [{ Instances: [{ InstanceId: 'i-seasonal', Tags: [{ Key: 'OpsDashboard:MonitoringExempt', Value: 'true' }] }] }],
    });
    elbSendMock.mockResolvedValue({ LoadBalancers: [] });

    const result = await handler();

    expect(result).toEqual({ ok: true, exempted: 1, overdue: 0 });
    expect(postDiscordEmbedsMock).not.toHaveBeenCalled();
  });

  it('reports an overdue ALB exception too', async () => {
    ec2SendMock.mockResolvedValue({ Reservations: [] });
    elbSendMock.mockImplementation((command: { __cmd: string }) => {
      if (command.__cmd === 'DescribeLoadBalancers') {
        return Promise.resolve({ LoadBalancers: [{ LoadBalancerName: 'abc-stg-alb', LoadBalancerArn: 'arn:elb:abc-stg-alb' }] });
      }
      if (command.__cmd === 'DescribeTags') {
        return Promise.resolve({ TagDescriptions: [{ Tags: [{ Key: 'OpsDashboard:MonitoringExempt', Value: 'true' }, { Key: 'SecurityExceptionReviewDate', Value: '2000-01-01' }] }] });
      }
      return Promise.resolve({});
    });

    const result = await handler();

    expect(result).toEqual({ ok: true, exempted: 1, overdue: 1 });
    expect(JSON.stringify(postDiscordEmbedsMock.mock.calls[0][0])).toContain('abc-stg-alb');
  });

  it('a resource with neither exemption tag is skipped entirely (not counted, not flagged)', async () => {
    ec2SendMock.mockResolvedValue({ Reservations: [{ Instances: [{ InstanceId: 'i-plain', Tags: [{ Key: 'Name', Value: 'plain' }] }] }] });
    elbSendMock.mockResolvedValue({ LoadBalancers: [] });

    const result = await handler();

    expect(result).toEqual({ ok: true, exempted: 0, overdue: 0 });
  });
});
