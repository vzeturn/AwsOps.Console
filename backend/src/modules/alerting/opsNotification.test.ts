import { describe, it, expect } from 'vitest';
import { buildOpsNotificationEmbed } from './opsNotification.js';

describe('buildOpsNotificationEmbed — backward-compatible core (unchanged behavior)', () => {
  it('renders only "what" + severity emoji/color when nothing else is supplied (no SEV tier for success)', () => {
    const embed = buildOpsNotificationEmbed({ what: 'Nightly backup completed', severity: 'success' });
    expect(embed.title).toBe('🟢 Nightly backup completed');
    expect(embed.color).toBe(0x57f287);
    expect(embed.description).toBeUndefined();
    expect(embed.fields).toEqual([]);
  });

  it('omits every optional slot that is not provided (no empty/placeholder fields)', () => {
    const embed = buildOpsNotificationEmbed({ what: 'X', severity: 'info', who: 'system:cost-collector' });
    expect(embed.fields).toEqual([{ name: 'Who', value: 'system:cost-collector', inline: true }]);
  });

  it('maps why to description, where/who to inline fields, how (string) to a "Next steps" field, in Where/Who/When/Next-steps order', () => {
    const embed = buildOpsNotificationEmbed({
      what: 'STG environment auto-stopped',
      severity: 'warning',
      why: 'No ALB requests for 30 minutes.',
      where: 'abc-stg-ec2-ewarranty (Staging)',
      who: 'system:abc-stg-idle-stop',
      when: '2026-09-11 09:22 UTC',
      how: 'Will auto-wake on the next real request via the ALB 5xx alarm.',
    });

    expect(embed.title).toBe('🟠 [SEV-3] STG environment auto-stopped');
    expect(embed.description).toBe('No ALB requests for 30 minutes.');
    expect(embed.fields).toEqual([
      { name: 'Where', value: 'abc-stg-ec2-ewarranty (Staging)', inline: true },
      { name: 'Who', value: 'system:abc-stg-idle-stop', inline: true },
      { name: 'When', value: '2026-09-11 09:22 UTC', inline: true },
      { name: '🛠️ Next steps', value: 'Will auto-wake on the next real request via the ALB 5xx alarm.', inline: false },
    ]);
  });

  it('appends extra fields after the named fields, preserving caller-chosen inline flags', () => {
    const embed = buildOpsNotificationEmbed({
      what: 'Cost anomaly detected',
      severity: 'critical',
      extra: [{ name: 'Estimated impact', value: '$482.10', inline: true }],
    });
    expect(embed.fields).toEqual([{ name: 'Estimated impact', value: '$482.10', inline: true }]);
  });

  it('defaults the footer, and allows overriding it', () => {
    const defaultFooter = buildOpsNotificationEmbed({ what: 'X', severity: 'info' });
    expect(defaultFooter.footer).toEqual({ text: 'ops-dashboard · Ops Notification' });

    const customFooter = buildOpsNotificationEmbed({ what: 'X', severity: 'info', footer: 'ops-dashboard · Manual Action' });
    expect(customFooter.footer).toEqual({ text: 'ops-dashboard · Manual Action' });
  });

  it('defaults the timestamp to "now" and allows an explicit override', () => {
    const withOverride = buildOpsNotificationEmbed({ what: 'X', severity: 'info', timestampOverride: '2026-01-01T00:00:00.000Z' });
    expect(withOverride.timestamp).toBe('2026-01-01T00:00:00.000Z');

    const withoutOverride = buildOpsNotificationEmbed({ what: 'X', severity: 'info' });
    expect(() => new Date(withoutOverride.timestamp as string)).not.toThrow();
    expect(Number.isNaN(new Date(withoutOverride.timestamp as string).getTime())).toBe(false);
  });

  it('maps each severity to its own emoji + color, matching the palette already used elsewhere in the app', () => {
    expect(buildOpsNotificationEmbed({ what: 'X', severity: 'critical' })).toMatchObject({ title: '🔴 [SEV-2] X', color: 0xed4245 });
    expect(buildOpsNotificationEmbed({ what: 'X', severity: 'warning' })).toMatchObject({ title: '🟠 [SEV-3] X', color: 0xfaa61a });
    expect(buildOpsNotificationEmbed({ what: 'X', severity: 'success' })).toMatchObject({ title: '🟢 X', color: 0x57f287 });
    expect(buildOpsNotificationEmbed({ what: 'X', severity: 'info' })).toMatchObject({ title: '🔵 X', color: 0x5865f2 });
  });
});

describe('buildOpsNotificationEmbed — SEV tier', () => {
  it('critical WITH impact -> SEV-1', () => {
    const embed = buildOpsNotificationEmbed({ what: 'X', severity: 'critical', impact: 'Customers cannot check out.' });
    expect(embed.title).toBe('🔴 [SEV-1] X');
  });

  it('critical WITHOUT impact -> SEV-2', () => {
    const embed = buildOpsNotificationEmbed({ what: 'X', severity: 'critical' });
    expect(embed.title).toBe('🔴 [SEV-2] X');
  });

  it('warning is always SEV-3, regardless of impact', () => {
    expect(buildOpsNotificationEmbed({ what: 'X', severity: 'warning' }).title).toBe('🟠 [SEV-3] X');
    expect(buildOpsNotificationEmbed({ what: 'X', severity: 'warning', impact: 'Some impact' }).title).toBe('🟠 [SEV-3] X');
  });

  it('success/info never show a SEV tier, even with impact supplied', () => {
    expect(buildOpsNotificationEmbed({ what: 'X', severity: 'success', impact: 'N/A' }).title).toBe('🟢 X');
    expect(buildOpsNotificationEmbed({ what: 'X', severity: 'info', impact: 'N/A' }).title).toBe('🔵 X');
  });
});

describe('buildOpsNotificationEmbed — Impact field', () => {
  it('renders Impact as the FIRST field, full-width', () => {
    const embed = buildOpsNotificationEmbed({
      what: 'X',
      severity: 'critical',
      impact: 'Customers cannot complete checkout; estimated 30% order drop.',
      who: 'system:x',
    });
    expect(embed.fields[0]).toEqual({ name: '🎯 Impact', value: 'Customers cannot complete checkout; estimated 30% order drop.', inline: false });
  });

  it('omits the Impact field entirely when not supplied', () => {
    const embed = buildOpsNotificationEmbed({ what: 'X', severity: 'critical' });
    expect(embed.fields.find((f) => f.name === '🎯 Impact')).toBeUndefined();
  });
});

describe('buildOpsNotificationEmbed — Likely causes field', () => {
  it('renders each cause as a bullet line', () => {
    const embed = buildOpsNotificationEmbed({
      what: 'X',
      severity: 'critical',
      likelyCauses: ['Third-party payment gateway timeout.', 'Database connection interrupted.', 'A recent deploy introduced a bug.'],
    });
    const field = embed.fields.find((f) => f.name === '🔍 Likely causes');
    expect(field?.value).toBe(
      '• Third-party payment gateway timeout.\n• Database connection interrupted.\n• A recent deploy introduced a bug.',
    );
  });

  it('omits the field entirely when the array is empty or not supplied', () => {
    expect(buildOpsNotificationEmbed({ what: 'X', severity: 'critical', likelyCauses: [] }).fields).toEqual([]);
    expect(buildOpsNotificationEmbed({ what: 'X', severity: 'critical' }).fields).toEqual([]);
  });
});

describe('buildOpsNotificationEmbed — Next steps field (how, string vs. array)', () => {
  it('a string "how" renders as a plain sentence (unchanged from the original template)', () => {
    const embed = buildOpsNotificationEmbed({ what: 'X', severity: 'warning', how: 'Retry automatically.' });
    expect(embed.fields).toEqual([{ name: '🛠️ Next steps', value: 'Retry automatically.', inline: false }]);
  });

  it('an array "how" renders as a numbered checklist, in the given order', () => {
    const embed = buildOpsNotificationEmbed({
      what: 'X',
      severity: 'critical',
      how: ['Check the payment partner status page.', 'Roll back the last deploy if one happened in the last hour.', 'Escalate to @payment-team.'],
    });
    const field = embed.fields.find((f) => f.name === '🛠️ Next steps');
    expect(field?.value).toBe(
      '1. Check the payment partner status page.\n2. Roll back the last deploy if one happened in the last hour.\n3. Escalate to @payment-team.',
    );
  });
});

describe('buildOpsNotificationEmbed — Links field', () => {
  it('renders each link as a markdown-linked line, in the given order', () => {
    const embed = buildOpsNotificationEmbed({
      what: 'X',
      severity: 'critical',
      links: [
        { label: 'CloudWatch Dashboard', url: 'https://console.aws.amazon.com/cloudwatch/dash' },
        { label: 'View Error Logs', url: 'https://console.aws.amazon.com/cloudwatch/logs' },
      ],
    });
    const field = embed.fields.find((f) => f.name === '🔗 Links');
    expect(field?.value).toBe(
      '[CloudWatch Dashboard](https://console.aws.amazon.com/cloudwatch/dash)\n[View Error Logs](https://console.aws.amazon.com/cloudwatch/logs)',
    );
  });

  it('omits the field entirely when the array is empty or not supplied', () => {
    expect(buildOpsNotificationEmbed({ what: 'X', severity: 'info', links: [] }).fields).toEqual([]);
    expect(buildOpsNotificationEmbed({ what: 'X', severity: 'info' }).fields).toEqual([]);
  });
});

describe('buildOpsNotificationEmbed — Metadata field', () => {
  it('renders account/region/resourceArn/owner as one code-block field', () => {
    const embed = buildOpsNotificationEmbed({
      what: 'X',
      severity: 'critical',
      account: '123456789012',
      region: 'ap-southeast-1',
      resourceArn: 'arn:aws:apigateway:ap-southeast-1::payment-api',
      owner: '@payment-team',
    });
    const field = embed.fields.find((f) => f.name === '🏷️ Metadata');
    expect(field?.value).toBe(
      '```\nAccount:  123456789012\nRegion:   ap-southeast-1\nResource: arn:aws:apigateway:ap-southeast-1::payment-api\nOwner:    @payment-team\n```',
    );
  });

  it('omits individual lines that were not supplied, keeping only the ones that were', () => {
    const embed = buildOpsNotificationEmbed({ what: 'X', severity: 'info', region: 'ap-southeast-1' });
    const field = embed.fields.find((f) => f.name === '🏷️ Metadata');
    expect(field?.value).toBe('```\nRegion:   ap-southeast-1\n```');
  });

  it('omits the field entirely when none of account/region/resourceArn/owner were supplied', () => {
    expect(buildOpsNotificationEmbed({ what: 'X', severity: 'info' }).fields).toEqual([]);
  });
});

describe('buildOpsNotificationEmbed — full field ordering (every slot populated)', () => {
  it('renders Impact, Likely causes, Where/Who/When, Next steps, extra, Links, Metadata, in that exact order', () => {
    const embed = buildOpsNotificationEmbed({
      what: 'High 5xx error rate',
      severity: 'critical',
      why: '5xx error rate is 8.5% (threshold: >5% for 3 consecutive minutes).',
      impact: 'Customers cannot complete checkout; estimated 30% order drop.',
      likelyCauses: ['Third-party payment gateway timeout.', 'A recent deploy introduced a bug.'],
      where: 'payment-api (Production)',
      who: 'system:discord-alarm-notifier',
      when: '2026-09-21 16:30:00 +07:00',
      how: ['Check the payment partner status page.', 'Roll back the last deploy if one happened in the last hour.'],
      extra: [{ name: 'Error rate', value: '8.5%', inline: true }],
      links: [{ label: 'CloudWatch Dashboard', url: 'https://example.com/dash' }],
      account: '123456789012',
      region: 'ap-southeast-1',
      resourceArn: 'arn:aws:apigateway:payment-api',
      owner: '@payment-team',
    });

    expect(embed.fields.map((f) => f.name)).toEqual([
      '🎯 Impact',
      '🔍 Likely causes',
      'Where',
      'Who',
      'When',
      '🛠️ Next steps',
      'Error rate',
      '🔗 Links',
      '🏷️ Metadata',
    ]);
  });
});
