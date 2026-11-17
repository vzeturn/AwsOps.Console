import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AlarmSummary } from '@ops-dashboard/shared';

process.env.AWS_REGION = 'ap-southeast-1';
process.env.DISCORD_WEBHOOK_URL_PARAM_NAME = '/abc/ops-dashboard/prod/discord-webhook-url';

const getAlertsMock = vi.fn();
vi.mock('./alert-service.js', () => ({ getAlerts: () => getAlertsMock() }));

const postDiscordEmbedsMock = vi.fn();
vi.mock('./discordWebhook.js', () => ({ postDiscordEmbeds: (embeds: unknown) => postDiscordEmbedsMock(embeds) }));

const ec2SendMock = vi.fn();
vi.mock('@aws-sdk/client-ec2', () => ({
  EC2Client: vi.fn().mockImplementation(() => ({ send: ec2SendMock })),
  DescribeInstancesCommand: vi.fn().mockImplementation((input: unknown) => ({ __cmd: 'DescribeInstances', input })),
}));

const { handler, buildHealthReportEmbed } = await import('./health-report.js');

function makeAlarm(overrides: Partial<AlarmSummary> = {}): AlarmSummary {
  return {
    alarmName: 'test-alarm',
    state: 'OK',
    threshold: { level: 'ok', reason: 'OK' },
    namespace: 'AWS/EC2',
    region: 'ap-southeast-1',
    consoleLink: 'https://console.aws.amazon.com/x',
    ...overrides,
  };
}

beforeEach(() => {
  getAlertsMock.mockReset();
  postDiscordEmbedsMock.mockReset();
  ec2SendMock.mockReset();
  ec2SendMock.mockResolvedValue({ Reservations: [] });
});

describe('buildHealthReportEmbed', () => {
  it('no alarms need attention -> green embed, no problem-listing field', () => {
    const embed = buildHealthReportEmbed([makeAlarm(), makeAlarm({ alarmName: 'alarm-2' })]);

    expect(embed.title).toBe('🟢 Health Report — All systems normal');
    expect(embed.color).toBe(0x57f287);
    expect(embed.fields.find((f) => f.name.startsWith('Alarms needing attention'))).toBeUndefined();
  });

  it('has an ALARM (critical) -> red embed, lists name + resource', () => {
    const embed = buildHealthReportEmbed([
      makeAlarm(),
      makeAlarm({
        alarmName: 'ec2-cpu-high',
        state: 'ALARM',
        threshold: { level: 'critical', reason: 'ALARM' },
        relatedResourceId: 'i-0abc123',
      }),
    ]);

    expect(embed.title).toContain('🔴');
    expect(embed.title).toContain('1 systems need attention');
    expect(embed.color).toBe(0xed4245);
    const field = embed.fields.find((f) => f.name.startsWith('Alarms needing attention'));
    expect(field?.value).toContain('ec2-cpu-high');
    expect(field?.value).toContain('i-0abc123');
  });

  it('only INSUFFICIENT_DATA (warn) alarms, no ALARM -> orange embed, not red', () => {
    const embed = buildHealthReportEmbed([
      makeAlarm({
        alarmName: 'rds-freeable-memory',
        state: 'INSUFFICIENT_DATA',
        threshold: { level: 'warn', reason: 'INSUFFICIENT_DATA' },
      }),
    ]);

    expect(embed.color).toBe(0xfaa61a);
    expect(embed.title).toContain('🟠');
  });

  it('an ALARM with a metricName that has a runbook entry -> appends a "Next step" line', () => {
    const embed = buildHealthReportEmbed([
      makeAlarm({
        alarmName: 'ec2-cpu-low',
        state: 'ALARM',
        threshold: { level: 'critical', reason: 'ALARM' },
        metricName: 'CPUUtilization',
      }),
    ]);

    const field = embed.fields.find((f) => f.name.startsWith('Alarms needing attention'));
    expect(field?.value).toContain('↳');
  });

  it('an ALARM with no metricName (composite alarm) -> no "Next step" line, no crash', () => {
    const embed = buildHealthReportEmbed([
      makeAlarm({ alarmName: 'composite-alarm', state: 'ALARM', threshold: { level: 'critical', reason: 'ALARM' } }),
    ]);

    const field = embed.fields.find((f) => f.name.startsWith('Alarms needing attention'));
    expect(field?.value).not.toContain('↳');
  });

  it('an ALARM with a metricName that has NO catalog entry -> no "Next step" line, no crash', () => {
    const embed = buildHealthReportEmbed([
      makeAlarm({
        alarmName: 'some-unknown-metric-alarm',
        state: 'ALARM',
        threshold: { level: 'critical', reason: 'ALARM' },
        metricName: 'SomeMetricWithNoRunbookEntry',
      }),
    ]);

    const field = embed.fields.find((f) => f.name.startsWith('Alarms needing attention'));
    expect(field?.value).not.toContain('↳');
  });

  it('an INSUFFICIENT_DATA alarm never gets a "Next step" line even with a known metricName', () => {
    const embed = buildHealthReportEmbed([
      makeAlarm({
        alarmName: 'ec2-cpu-insufficient-data',
        state: 'INSUFFICIENT_DATA',
        threshold: { level: 'warn', reason: 'INSUFFICIENT_DATA' },
        metricName: 'CPUUtilization',
      }),
    ]);

    const field = embed.fields.find((f) => f.name.startsWith('Alarms needing attention'));
    expect(field?.value).not.toContain('↳');
  });

  it('more than 15 alarms need attention -> lists only 15, states "and N more alarms" for the rest', () => {
    const problems = Array.from({ length: 18 }, (_, i) =>
      makeAlarm({ alarmName: `alarm-${i}`, state: 'ALARM', threshold: { level: 'critical', reason: 'ALARM' } }),
    );

    const embed = buildHealthReportEmbed(problems);

    const field = embed.fields.find((f) => f.name.startsWith('Alarms needing attention'));
    expect(field?.value).toContain('… and 3 more alarms');
    expect(field?.value.split('\n')).toHaveLength(16); // 15 alarms + 1 "and N more" line
  });
});

describe('buildHealthReportEmbed — resourceNames', () => {
  it('shows the resolved Name tag instead of the raw InstanceId when one is provided', () => {
    const embed = buildHealthReportEmbed(
      [makeAlarm({ alarmName: 'ec2-cpu-high', state: 'ALARM', threshold: { level: 'critical', reason: 'ALARM' }, relatedResourceId: 'i-0abc123' })],
      new Map([['i-0abc123', 'abc-prod-ec2-gateway']]),
    );
    const field = embed.fields.find((f) => f.name.startsWith('Alarms needing attention'));
    expect(field?.value).toContain('abc-prod-ec2-gateway');
    expect(field?.value).not.toContain('i-0abc123');
  });

  it('falls back to the raw resourceId when no resolved name is available', () => {
    const embed = buildHealthReportEmbed([
      makeAlarm({ alarmName: 'ec2-cpu-high', state: 'ALARM', threshold: { level: 'critical', reason: 'ALARM' }, relatedResourceId: 'i-0abc123' }),
    ]);
    const field = embed.fields.find((f) => f.name.startsWith('Alarms needing attention'));
    expect(field?.value).toContain('i-0abc123');
  });
});

describe('buildHealthReportEmbed — Impact and Links', () => {
  it('an ALARM (critical) states the Impact (count of resources actively breaching) and links to each alarm', () => {
    const embed = buildHealthReportEmbed([
      makeAlarm({ alarmName: 'ec2-cpu-high', state: 'ALARM', threshold: { level: 'critical', reason: 'ALARM' }, consoleLink: 'https://console.aws.amazon.com/alarm-1' }),
    ]);

    const impactField = embed.fields.find((f) => f.name === '🎯 Impact');
    expect(impactField?.value).toContain('1 resource(s)');
    const linksField = embed.fields.find((f) => f.name === '🔗 Links');
    expect(linksField?.value).toContain('ec2-cpu-high');
    expect(linksField?.value).toContain('https://console.aws.amazon.com/alarm-1');
  });

  it('INSUFFICIENT_DATA only (no ALARM) -> no Impact field (nothing confirmed breaching)', () => {
    const embed = buildHealthReportEmbed([
      makeAlarm({ alarmName: 'rds-freeable-memory', state: 'INSUFFICIENT_DATA', threshold: { level: 'warn', reason: 'INSUFFICIENT_DATA' } }),
    ]);
    expect(embed.fields.find((f) => f.name === '🎯 Impact')).toBeUndefined();
  });

  it('all systems normal -> no Impact field, no Links field', () => {
    const embed = buildHealthReportEmbed([makeAlarm()]);
    expect(embed.fields.find((f) => f.name === '🎯 Impact')).toBeUndefined();
    expect(embed.fields.find((f) => f.name === '🔗 Links')).toBeUndefined();
  });

  it('caps Links at 5 entries even with more problem alarms', () => {
    const problems = Array.from({ length: 8 }, (_, i) =>
      makeAlarm({ alarmName: `alarm-${i}`, state: 'ALARM', threshold: { level: 'critical', reason: 'ALARM' }, consoleLink: `https://console.aws.amazon.com/${i}` }),
    );
    const embed = buildHealthReportEmbed(problems);
    const linksField = embed.fields.find((f) => f.name === '🔗 Links');
    expect(linksField?.value.split('\n')).toHaveLength(5);
  });
});

describe('handler', () => {
  it('calls getAlerts() then postDiscordEmbeds() with exactly 1 embed, returns the correct problemCount', async () => {
    getAlertsMock.mockResolvedValue([
      makeAlarm(),
      makeAlarm({ alarmName: 'a2', state: 'ALARM', threshold: { level: 'critical', reason: 'ALARM' } }),
    ]);
    postDiscordEmbedsMock.mockResolvedValue(undefined);

    const result = await handler();

    expect(result).toEqual({ ok: true, problemCount: 1 });
    expect(postDiscordEmbedsMock).toHaveBeenCalledTimes(1);
    expect(postDiscordEmbedsMock.mock.calls[0][0]).toHaveLength(1);
  });

  it('resolves the EC2 Name tag for a problem alarm and shows it instead of the raw InstanceId', async () => {
    getAlertsMock.mockResolvedValue([
      makeAlarm({
        alarmName: 'ec2-cpu-high',
        state: 'ALARM',
        threshold: { level: 'critical', reason: 'ALARM' },
        relatedResourceId: 'i-0a1b2c3d4e5f60001',
      }),
    ]);
    ec2SendMock.mockResolvedValue({
      Reservations: [{ Instances: [{ Tags: [{ Key: 'Name', Value: 'abc-prod-ec2-gateway' }] }] }],
    });
    postDiscordEmbedsMock.mockResolvedValue(undefined);

    await handler();

    expect(ec2SendMock).toHaveBeenCalledTimes(1);
    const embed = postDiscordEmbedsMock.mock.calls[0][0][0];
    const field = embed.fields.find((f: { name: string }) => f.name.startsWith('Alarms needing attention'));
    expect(field.value).toContain('abc-prod-ec2-gateway');
    expect(field.value).not.toContain('i-0a1b2c3d4e5f60001');
  });

  it('does not call DescribeInstances for a non-EC2 relatedResourceId (e.g. an RDS identifier)', async () => {
    getAlertsMock.mockResolvedValue([
      makeAlarm({
        alarmName: 'rds-cpu-high',
        state: 'ALARM',
        threshold: { level: 'critical', reason: 'ALARM' },
        relatedResourceId: 'abc-prod-rds-postgres',
      }),
    ]);
    postDiscordEmbedsMock.mockResolvedValue(undefined);

    await handler();

    expect(ec2SendMock).not.toHaveBeenCalled();
  });

  it('only resolves each unique instance id once, even if several problem alarms share it', async () => {
    getAlertsMock.mockResolvedValue([
      makeAlarm({ alarmName: 'ec2-cpu-high', state: 'ALARM', threshold: { level: 'critical', reason: 'ALARM' }, relatedResourceId: 'i-0a1b2c3d4e5f60001' }),
      makeAlarm({ alarmName: 'ec2-status-check-failed', state: 'ALARM', threshold: { level: 'critical', reason: 'ALARM' }, relatedResourceId: 'i-0a1b2c3d4e5f60001' }),
    ]);
    ec2SendMock.mockResolvedValue({ Reservations: [{ Instances: [{ Tags: [{ Key: 'Name', Value: 'abc-prod-ec2-gateway' }] }] }] });
    postDiscordEmbedsMock.mockResolvedValue(undefined);

    await handler();

    expect(ec2SendMock).toHaveBeenCalledTimes(1);
  });

  it('EC2 DescribeInstances failing does not throw and still sends the report with the raw id', async () => {
    getAlertsMock.mockResolvedValue([
      makeAlarm({ alarmName: 'ec2-cpu-high', state: 'ALARM', threshold: { level: 'critical', reason: 'ALARM' }, relatedResourceId: 'i-0a1b2c3d4e5f60001' }),
    ]);
    ec2SendMock.mockRejectedValue(new Error('AccessDenied'));
    postDiscordEmbedsMock.mockResolvedValue(undefined);

    await expect(handler()).resolves.toEqual({ ok: true, problemCount: 1 });
    const embed = postDiscordEmbedsMock.mock.calls[0][0][0];
    const field = embed.fields.find((f: { name: string }) => f.name.startsWith('Alarms needing attention'));
    expect(field.value).toContain('i-0a1b2c3d4e5f60001');
  });
});
