import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.AWS_REGION = 'ap-southeast-1';

const ec2SendMock = vi.fn();
const guardDutySendMock = vi.fn();

vi.mock('@aws-sdk/client-ec2', () => ({
  EC2Client: vi.fn().mockImplementation(() => ({ send: ec2SendMock })),
  DescribeTagsCommand: vi.fn().mockImplementation((input: unknown) => ({ __cmd: 'DescribeTags', input })),
}));
vi.mock('@aws-sdk/client-guardduty', () => ({
  GuardDutyClient: vi.fn().mockImplementation(() => ({ send: guardDutySendMock })),
  ListDetectorsCommand: vi.fn().mockImplementation((input: unknown) => ({ __cmd: 'ListDetectors', input })),
  ArchiveFindingsCommand: vi.fn().mockImplementation((input: unknown) => ({ __cmd: 'ArchiveFindings', input })),
}));

const postDiscordEmbedsMock = vi.fn();
vi.mock('../alerting/discordWebhook.js', () => ({ postDiscordEmbeds: postDiscordEmbedsMock }));

const { handler } = await import('./security-guardduty-triage.js');

beforeEach(() => {
  ec2SendMock.mockReset();
  guardDutySendMock.mockReset();
  postDiscordEmbedsMock.mockReset();
});

function buildEvent(overrides: Partial<{ resourceType: string; instanceId: string }> = {}) {
  return {
    'detail-type': 'GuardDuty Finding',
    source: 'aws.guardduty',
    detail: {
      id: 'finding-1',
      type: 'DefenseEvasion:EC2/UnusualDoHActivity',
      title: 'Unusual DoH activity',
      severity: 5,
      resource: {
        resourceType: overrides.resourceType ?? 'Instance',
        instanceDetails: { instanceId: overrides.instanceId ?? 'i-0a1b2c3d4e5f60004' },
      },
    },
  };
}

describe('security-guardduty-triage handler', () => {
  it('auto-archives a finding when the affected EC2 instance carries a SecurityException tag', async () => {
    ec2SendMock.mockResolvedValue({ Tags: [{ Key: 'SecurityException', Value: 'dual-vpn-tailscale-netbird-test' }] });
    guardDutySendMock.mockImplementation((command: { __cmd: string }) => {
      if (command.__cmd === 'ListDetectors') return Promise.resolve({ DetectorIds: ['detector-1'] });
      return Promise.resolve({});
    });

    const result = await handler(buildEvent());

    expect(result).toEqual({ action: 'archived', exceptionTagValue: 'dual-vpn-tailscale-netbird-test' });
    const archiveCall = guardDutySendMock.mock.calls.find((c) => c[0].__cmd === 'ArchiveFindings');
    expect(archiveCall![0].input).toEqual({ DetectorId: 'detector-1', FindingIds: ['finding-1'] });
    expect(postDiscordEmbedsMock).toHaveBeenCalledTimes(1);
  });

  it('leaves the finding untouched when the instance has NO SecurityException tag', async () => {
    ec2SendMock.mockResolvedValue({ Tags: [] });

    const result = await handler(buildEvent());

    expect(result).toEqual({ action: 'left-for-review' });
    expect(guardDutySendMock).not.toHaveBeenCalled();
    expect(postDiscordEmbedsMock).not.toHaveBeenCalled();
  });

  it('leaves the finding untouched when the resource is not an EC2 instance', async () => {
    const result = await handler(buildEvent({ resourceType: 'S3Bucket' }));

    expect(result).toEqual({ action: 'left-for-review' });
    expect(ec2SendMock).not.toHaveBeenCalled();
  });

  it('leaves the finding for review (does not throw) when no GuardDuty detector is found', async () => {
    ec2SendMock.mockResolvedValue({ Tags: [{ Key: 'SecurityException', Value: 'x' }] });
    guardDutySendMock.mockResolvedValue({ DetectorIds: [] });

    const result = await handler(buildEvent());

    expect(result).toEqual({ action: 'left-for-review', exceptionTagValue: 'x' });
    expect(postDiscordEmbedsMock).not.toHaveBeenCalled();
  });

  it('treats a tag lookup failure as "no exception found" (fail-safe), never auto-archives on an unverified assumption', async () => {
    ec2SendMock.mockRejectedValue(new Error('AccessDenied'));

    const result = await handler(buildEvent());

    expect(result).toEqual({ action: 'left-for-review' });
    expect(guardDutySendMock).not.toHaveBeenCalled();
  });
});
