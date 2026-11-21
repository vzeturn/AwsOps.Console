import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SNSEvent } from 'aws-lambda';

process.env.ALERT_HOOK_URL_PARAM_NAME = '/abc/ops-dashboard/prod/alert-hook-url';
process.env.AWS_REGION = 'ap-southeast-1';

const ssmSendMock = vi.fn();
vi.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: vi.fn().mockImplementation(() => ({ send: ssmSendMock })),
  GetParameterCommand: vi.fn().mockImplementation((input: unknown) => ({ __cmd: 'GetParameter', input })),
}));

const ec2SendMock = vi.fn();
vi.mock('@aws-sdk/client-ec2', () => ({
  EC2Client: vi.fn().mockImplementation(() => ({ send: ec2SendMock })),
  DescribeInstancesCommand: vi.fn().mockImplementation((input: unknown) => ({ __cmd: 'DescribeInstances', input })),
}));

const cloudtrailSendMock = vi.fn();
vi.mock('@aws-sdk/client-cloudtrail', () => ({
  CloudTrailClient: vi.fn().mockImplementation(() => ({ send: cloudtrailSendMock })),
  LookupEventsCommand: vi.fn().mockImplementation((input: unknown) => ({ __cmd: 'LookupEvents', input })),
}));

const postMock = vi.fn();
vi.mock('./alertHook.js', () => ({ postAlertEmbeds: postMock }));

const { handler } = await import('./alarm-notifier.js');

/** Build a minimal SNSEvent containing only the fields the handler actually uses — following the
 * same pattern as other tests in the codebase (mock only what's needed, don't copy the entire SDK shape). */
function buildSnsEvent(messages: unknown[]): SNSEvent {
  return {
    Records: messages.map((message, i) => ({
      Sns: { Message: JSON.stringify(message), MessageId: `msg-${i}` },
    })),
  } as unknown as SNSEvent;
}

const ALARM_MESSAGE = {
  AlarmName: 'abc-prod-ec2-cpu-high_i-0a1b2c3d4e5f60001',
  AlarmDescription: 'CPU abnormally high',
  NewStateValue: 'ALARM',
  OldStateValue: 'OK',
  NewStateReason: 'Threshold Crossed: 1 datapoint [95.0] was greater than or equal to the threshold (90.0).',
  StateChangeTime: '2026-08-10T10:00:00.000Z',
  Region: 'Asia Pacific (Singapore)',
  AlarmArn: 'arn:aws:cloudwatch:ap-southeast-1:123456789012:alarm:abc-prod-ec2-cpu-high_i-0a1b2c3d4e5f60001',
  Trigger: {
    MetricName: 'CPUUtilization',
    Namespace: 'AWS/EC2',
    Dimensions: [{ name: 'InstanceId', value: 'i-0a1b2c3d4e5f60001' }],
    Threshold: 90,
    ComparisonOperator: 'GreaterThanOrEqualToThreshold',
  },
};

beforeEach(() => {
  postMock.mockReset();
  postMock.mockResolvedValue(undefined);
  ssmSendMock.mockReset();
  ssmSendMock.mockResolvedValue({ Parameter: { Value: 'https://rt.example.test/hooks/alert/test-token' } });
  ec2SendMock.mockReset();
  ec2SendMock.mockResolvedValue({
    Reservations: [{ Instances: [{ Tags: [{ Key: 'Name', Value: 'abc-prod-ec2-gateway' }] }] }],
  });
  cloudtrailSendMock.mockReset();
  cloudtrailSendMock.mockResolvedValue({ Events: [] });
});

describe('alarm-notifier handler', () => {
  it('hands exactly one embed to the alert hook containing AlarmName/state/metric/dimension/reason', async () => {
    await handler(buildSnsEvent([ALARM_MESSAGE]));

    expect(postMock).toHaveBeenCalledTimes(1);
    const body = { embeds: postMock.mock.calls[0][0] };
    expect(body.embeds).toHaveLength(1);
    const embed = body.embeds[0];
    expect(embed.title).toContain('abc-prod-ec2-cpu-high_i-0a1b2c3d4e5f60001');
    expect(embed.color).toBe(0xed4245); // ALARM -> red
    expect(JSON.stringify(embed.fields)).toContain('abc-prod-ec2-gateway');
    // The raw InstanceId is deliberately kept OUT of the human-facing "Related resource" field
    // (resolved to its Name tag instead — see the assertion above) — it is still expected to
    // appear in the "🏷️ Metadata" field's AlarmArn line, which exists specifically to give an
    // exact, copy-pasteable identifier (see opsNotification.ts's Metadata field design).
    const relatedResourceField = embed.fields.find((f: { name: string }) => f.name === 'Related resource');
    expect(relatedResourceField.value).not.toContain('i-0a1b2c3d4e5f60001');
    expect(JSON.stringify(embed.fields)).toContain('CPUUtilization');
    expect(embed.timestamp).toBe('2026-08-10T10:00:00.000Z');
  });

  it('Embed color matches each NewStateValue (ALARM=red, INSUFFICIENT_DATA=yellow, OK=green)', async () => {
    await handler(buildSnsEvent([{ ...ALARM_MESSAGE, NewStateValue: 'OK' }]));
    let body = { embeds: postMock.mock.calls[0][0] };
    expect(body.embeds[0].color).toBe(0x57f287);

    postMock.mockClear();
    await handler(buildSnsEvent([{ ...ALARM_MESSAGE, NewStateValue: 'INSUFFICIENT_DATA' }]));
    body = { embeds: postMock.mock.calls[0][0] };
    expect(body.embeds[0].color).toBe(0xfaa61a);
  });

  it('handles multiple Records independently in 1 batch -> calls the alert hook exactly once per Record', async () => {
    await handler(buildSnsEvent([ALARM_MESSAGE, { ...ALARM_MESSAGE, AlarmName: 'alarm-2' }]));
    expect(postMock).toHaveBeenCalledTimes(2);
  });

  it('1 invalid JSON message (missing AlarmName) -> skipped, does not throw, does not call the alert hook for that record', async () => {
    await expect(
      handler(buildSnsEvent([{ NewStateValue: 'ALARM' }, ALARM_MESSAGE])),
    ).resolves.toBeUndefined();
    // Only the valid record (ALARM_MESSAGE) calls the alert hook.
    expect(postMock).toHaveBeenCalledTimes(1);
  });

  it('alert delivery rejects unexpectedly -> does not throw out of the handler, only logs the error', async () => {
    postMock.mockRejectedValue(new Error('hub down'));
    await expect(handler(buildSnsEvent([ALARM_MESSAGE]))).resolves.toBeUndefined();
  });

  it('record.Sns.Message is not valid JSON -> skipped, does not throw', async () => {
    const event = { Records: [{ Sns: { Message: 'not-json{{{', MessageId: 'bad-1' } }] } as unknown as SNSEvent;
    await expect(handler(event)).resolves.toBeUndefined();
    expect(postMock).not.toHaveBeenCalled();
  });

  it('InstanceId dimension -> looks up the Name tag via EC2 DescribeInstances and shows ONLY the name (without the raw InstanceId) in the "Related resource" field', async () => {
    await handler(buildSnsEvent([ALARM_MESSAGE]));

    expect(ec2SendMock).toHaveBeenCalledTimes(1);
    const [sentCommand] = ec2SendMock.mock.calls[0];
    expect(sentCommand.input).toEqual({ InstanceIds: ['i-0a1b2c3d4e5f60001'] });

    const body = { embeds: postMock.mock.calls[0][0] };
    const resourceField = body.embeds[0].fields.find((f: { name: string }) => f.name === 'Related resource');
    expect(resourceField.value).toContain('abc-prod-ec2-gateway');
    expect(resourceField.value).not.toContain('i-0a1b2c3d4e5f60001');
  });

  it('instance has no Name tag (or it was deleted) -> still shows the raw InstanceId, does not throw', async () => {
    ec2SendMock.mockResolvedValue({ Reservations: [] });
    await handler(buildSnsEvent([ALARM_MESSAGE]));

    const body = { embeds: postMock.mock.calls[0][0] };
    const resourceField = body.embeds[0].fields.find((f: { name: string }) => f.name === 'Related resource');
    expect(resourceField.value).toContain('i-0a1b2c3d4e5f60001');
    expect(resourceField.value).not.toContain('(**');
  });

  it('EC2 DescribeInstances errors (missing IAM permission/temporary API error) -> does NOT throw, notification still sent with the raw InstanceId', async () => {
    ec2SendMock.mockRejectedValue(new Error('AccessDenied'));
    await expect(handler(buildSnsEvent([ALARM_MESSAGE]))).resolves.toBeUndefined();

    expect(postMock).toHaveBeenCalledTimes(1);
    const body = { embeds: postMock.mock.calls[0][0] };
    const resourceField = body.embeds[0].fields.find((f: { name: string }) => f.name === 'Related resource');
    expect(resourceField.value).toContain('i-0a1b2c3d4e5f60001');
  });

  it('NewStateValue=OK, OldStateValue=INSUFFICIENT_DATA (alarm freshly recreated after instance restart) -> does NOT send to alert hub', async () => {
    await handler(buildSnsEvent([{ ...ALARM_MESSAGE, NewStateValue: 'OK', OldStateValue: 'INSUFFICIENT_DATA' }]));
    expect(postMock).not.toHaveBeenCalled();
  });

  it('NewStateValue=OK, OldStateValue=ALARM (a real incident was resolved) -> still sends to alert hub normally', async () => {
    await handler(buildSnsEvent([{ ...ALARM_MESSAGE, NewStateValue: 'OK', OldStateValue: 'ALARM' }]));
    expect(postMock).toHaveBeenCalledTimes(1);
  });

  it('dimension is not InstanceId (e.g. DBInstanceIdentifier) -> does NOT call EC2 DescribeInstances', async () => {
    await handler(
      buildSnsEvent([
        {
          ...ALARM_MESSAGE,
          Trigger: { ...ALARM_MESSAGE.Trigger, Dimensions: [{ name: 'DBInstanceIdentifier', value: 'abc-prod-db' }] },
        },
      ]),
    );
    expect(ec2SendMock).not.toHaveBeenCalled();
  });

  it('ALARM state with a documented metric (CPUUtilization) -> attaches a Runbook field with the next step + escalation condition', async () => {
    await handler(buildSnsEvent([ALARM_MESSAGE]));
    const embed = { embeds: postMock.mock.calls[0][0] }.embeds[0];
    const runbookField = embed.fields.find((f: { name: string }) => f.name === 'Runbook');
    expect(runbookField).toBeDefined();
    expect(runbookField.value).toContain('High CPU utilization');
    expect(runbookField.value).toContain('Next step:');
    expect(runbookField.value).toContain('Escalate if:');
  });

  it('OK (recovered) state -> does NOT attach a Runbook field (nothing to remediate)', async () => {
    await handler(buildSnsEvent([{ ...ALARM_MESSAGE, NewStateValue: 'OK', OldStateValue: 'ALARM' }]));
    const embed = { embeds: postMock.mock.calls[0][0] }.embeds[0];
    expect(embed.fields.find((f: { name: string }) => f.name === 'Runbook')).toBeUndefined();
  });

  it('ALARM with a resolvable runbook -> SEV-1 in the title, states Impact', async () => {
    await handler(buildSnsEvent([ALARM_MESSAGE]));
    const embed = { embeds: postMock.mock.calls[0][0] }.embeds[0];
    expect(embed.title).toContain('[SEV-1]');
    const impact = embed.fields.find((f: { name: string }) => f.name === '🎯 Impact');
    expect(impact).toBeDefined();
  });

  it('ALARM on a metric with NO runbook entry -> SEV-2 (still a real breach, no known next step)', async () => {
    await handler(buildSnsEvent([{ ...ALARM_MESSAGE, Trigger: { ...ALARM_MESSAGE.Trigger, MetricName: 'SomeUnknownMetric' } }]));
    const embed = { embeds: postMock.mock.calls[0][0] }.embeds[0];
    expect(embed.title).toContain('[SEV-2]');
  });

  it('INSUFFICIENT_DATA -> SEV-3, no Impact field (the problem IS the missing data, already stated by Status)', async () => {
    await handler(buildSnsEvent([{ ...ALARM_MESSAGE, NewStateValue: 'INSUFFICIENT_DATA' }]));
    const embed = { embeds: postMock.mock.calls[0][0] }.embeds[0];
    expect(embed.title).toContain('[SEV-3]');
    expect(embed.fields.find((f: { name: string }) => f.name === '🎯 Impact')).toBeUndefined();
  });

  it('OK (recovered) -> no SEV tier at all, no Impact field', async () => {
    await handler(buildSnsEvent([{ ...ALARM_MESSAGE, NewStateValue: 'OK', OldStateValue: 'ALARM' }]));
    const embed = { embeds: postMock.mock.calls[0][0] }.embeds[0];
    expect(embed.title).not.toContain('SEV-');
    expect(embed.fields.find((f: { name: string }) => f.name === '🎯 Impact')).toBeUndefined();
  });

  it('includes a Links field pointing to the specific alarm in CloudWatch, built from the region code (not the display name)', async () => {
    await handler(buildSnsEvent([ALARM_MESSAGE]));
    const embed = { embeds: postMock.mock.calls[0][0] }.embeds[0];
    const links = embed.fields.find((f: { name: string }) => f.name === '🔗 Links');
    expect(links.value).toContain('ap-southeast-1.console.aws.amazon.com');
    expect(links.value).not.toContain('Asia Pacific (Singapore)');
  });

  it('includes a Metadata field with the region and the full AlarmArn', async () => {
    await handler(buildSnsEvent([ALARM_MESSAGE]));
    const embed = { embeds: postMock.mock.calls[0][0] }.embeds[0];
    const metadata = embed.fields.find((f: { name: string }) => f.name === '🏷️ Metadata');
    expect(metadata.value).toContain('arn:aws:cloudwatch');
  });

  it('ALARM state on a metric with no catalog entry -> no Runbook field, does not throw', async () => {
    await handler(
      buildSnsEvent([{ ...ALARM_MESSAGE, Trigger: { ...ALARM_MESSAGE.Trigger, MetricName: 'SomeUncatalogedMetric' } }]),
    );
    const embed = { embeds: postMock.mock.calls[0][0] }.embeds[0];
    expect(embed.fields.find((f: { name: string }) => f.name === 'Runbook')).toBeUndefined();
  });
});

/**
 * The real payload an RDS event subscription delivers, copied from the shape AWS documents and from the
 * actual event abc-prod-rds-postgres has been emitting every two hours since at least 2026-08-25.
 *
 * Note the field names contain SPACES. That is not a transcription slip — it is what RDS sends, and it is
 * exactly why the handler's original `!message.AlarmName` guard silently dropped these.
 */
const RDS_EVENT_MESSAGE = {
  'Event Source': 'db-instance',
  'Event Time': '2026-09-08 03:15:27.964',
  'Identifier Link':
    'https://console.aws.amazon.com/rds/home?region=ap-southeast-1#dbinstance:id=abc-prod-rds-postgres',
  'Source ID': 'abc-prod-rds-postgres',
  'Source ARN': 'arn:aws:rds:ap-southeast-1:123456789012:db:abc-prod-rds-postgres',
  'Event ID':
    'http://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_Events.html#RDS-EVENT-0089',
  'Event Message':
    'Storage size 600 GiB is approaching the maximum storage threshold 700 GiB. Increase the maximum storage threshold.',
};

describe('alarm-notifier — RDS event subscription messages', () => {
  it('delivers an RDS event instead of dropping it as an unrecognised shape', async () => {
    // The regression this guards. Before RDS events were handled, this payload hit the
    // `!message.AlarmName` guard and was logged-and-skipped — so adding the subscription would have
    // produced a channel that is configured, billed, and silent. That is the exact failure mode this
    // project keeps running into: an empty result that looks like success.
    await handler(buildSnsEvent([RDS_EVENT_MESSAGE]));

    expect(postMock).toHaveBeenCalledTimes(1);
    const embed = { embeds: postMock.mock.calls[0][0] }.embeds[0];
    expect(embed.title).toContain('abc-prod-rds-postgres');
    expect(embed.footer.text).toContain('RDS event');
    // The message itself must survive verbatim: it is the only part that says what is actually wrong.
    const what = embed.fields.find((f: { name: string }) => f.name === 'What happened');
    expect(what.value).toContain('approaching the maximum storage threshold');
  });

  it("converts RDS's non-ISO 'Event Time' into a timestamp alert hub accepts", async () => {
    // RDS sends "YYYY-MM-DD HH:MM:SS.mmm" in UTC. Passing that straight through gets the whole webhook
    // rejected with a 400, which would lose the notification over a formatting detail.
    await handler(buildSnsEvent([RDS_EVENT_MESSAGE]));
    const embed = { embeds: postMock.mock.calls[0][0] }.embeds[0];
    expect(embed.timestamp).toBe('2026-09-08T03:15:27.964Z');
  });

  it('omits the timestamp rather than sending an unparseable one', async () => {
    await handler(buildSnsEvent([{ ...RDS_EVENT_MESSAGE, 'Event Time': 'not a date at all' }]));
    const embed = { embeds: postMock.mock.calls[0][0] }.embeds[0];
    expect(embed.timestamp).toBeUndefined();
    // Still delivered — a bad date must not cost the message.
    expect(postMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces the searchable RDS-EVENT code, not just the documentation URL', async () => {
    await handler(buildSnsEvent([RDS_EVENT_MESSAGE]));
    const embed = { embeds: postMock.mock.calls[0][0] }.embeds[0];
    const evt = embed.fields.find((f: { name: string }) => f.name === 'Event');
    expect(evt.value).toContain('RDS-EVENT-0089');
  });

  it('a "storage approaching threshold" event attaches the FreeStorageSpace Runbook field', async () => {
    await handler(buildSnsEvent([RDS_EVENT_MESSAGE]));
    const embed = { embeds: postMock.mock.calls[0][0] }.embeds[0];
    const runbookField = embed.fields.find((f: { name: string }) => f.name === 'Runbook');
    expect(runbookField).toBeDefined();
    expect(runbookField.value).toContain('Low free storage space');
  });

  it('an RDS event message with no recognized pattern -> no Runbook field, still delivered', async () => {
    await handler(buildSnsEvent([{ ...RDS_EVENT_MESSAGE, 'Event Message': 'Backup for abc-prod-rds-postgres has started.' }]));
    const embed = { embeds: postMock.mock.calls[0][0] }.embeds[0];
    expect(embed.fields.find((f: { name: string }) => f.name === 'Runbook')).toBeUndefined();
  });

  it('a Multi-AZ failover event -> SEV-3, states the impact (brief interruption + DNS propagation)', async () => {
    await handler(buildSnsEvent([{ ...RDS_EVENT_MESSAGE, 'Event Message': 'Multi-AZ instance failover started.' }]));
    const embed = { embeds: postMock.mock.calls[0][0] }.embeds[0];
    expect(embed.title).toContain('[SEV-3]');
    expect(embed.color).toBe(0xfaa61a);
    const impact = embed.fields.find((f: { name: string }) => f.name === '🎯 Impact');
    expect(impact.value).toContain('DNS propagation');
  });

  it('a rejected failover ("abandoning user requested failover") -> SEV-1, states the escalation-worthy impact', async () => {
    await handler(buildSnsEvent([{ ...RDS_EVENT_MESSAGE, 'Event Message': 'Abandoning user requested failover since a failover recently occurred on the database instance.' }]));
    const embed = { embeds: postMock.mock.calls[0][0] }.embeds[0];
    expect(embed.title).toContain('[SEV-1]');
    expect(embed.color).toBe(0xed4245);
  });

  it('a routine backup event ("Backing up DB instance") -> info severity, no SEV tier, no Impact field', async () => {
    await handler(buildSnsEvent([{ ...RDS_EVENT_MESSAGE, 'Event Message': 'Backing up DB instance.' }]));
    const embed = { embeds: postMock.mock.calls[0][0] }.embeds[0];
    expect(embed.title).not.toContain('SEV-');
    expect(embed.color).toBe(0x5865f2);
    expect(embed.fields.find((f: { name: string }) => f.name === '🎯 Impact')).toBeUndefined();
  });

  it('an unclassified event message defaults to the original warning/amber behavior, unchanged', async () => {
    await handler(buildSnsEvent([{ ...RDS_EVENT_MESSAGE, 'Event Message': 'Something this project has never seen before.' }]));
    const embed = { embeds: postMock.mock.calls[0][0] }.embeds[0];
    expect(embed.color).toBe(0xfaa61a);
    expect(embed.title).toContain('[SEV-3]');
  });

  it('includes a Metadata field with the region and source id', async () => {
    await handler(buildSnsEvent([RDS_EVENT_MESSAGE]));
    const embed = { embeds: postMock.mock.calls[0][0] }.embeds[0];
    const metadata = embed.fields.find((f: { name: string }) => f.name === '🏷️ Metadata');
    expect(metadata.value).toContain('ap-southeast-1');
    expect(metadata.value).toContain('abc-prod-rds-postgres');
  });

  it('still routes a CloudWatch alarm down the alarm path, unchanged', async () => {
    // The RDS check runs first, so this pins that it cannot swallow alarms.
    await handler(buildSnsEvent([ALARM_MESSAGE]));
    const embed = { embeds: postMock.mock.calls[0][0] }.embeds[0];
    expect(embed.footer.text).toContain('CloudWatch Alarm');
    expect(embed.color).toBe(0xed4245);
  });

  it('handles a mixed batch: one alarm and one RDS event in the same invoke', async () => {
    await handler(buildSnsEvent([ALARM_MESSAGE, RDS_EVENT_MESSAGE]));
    expect(postMock).toHaveBeenCalledTimes(2);
    const footers = postMock.mock.calls.map(
      (c) => (c[0] as { footer: { text: string } }[])[0].footer.text,
    );
    expect(footers.some((f) => f.includes('CloudWatch Alarm'))).toBe(true);
    expect(footers.some((f) => f.includes('RDS event'))).toBe(true);
  });

  it('still ignores a payload that is neither shape, without throwing', async () => {
    await handler(buildSnsEvent([{ something: 'unrelated' }]));
    expect(postMock).not.toHaveBeenCalled();
  });
});

/**
 * A realistic GuardDuty Finding event as EventBridge delivers it to SNS when the rule has NO
 * `InputTransformer` (see `GuardDutyFindingsRule` in infra/ops-dashboard.yaml) — the message body
 * is the FULL event envelope (source/detail-type/region/detail), not just `detail`.
 */
const GUARDDUTY_FINDING_MESSAGE = {
  version: '0',
  id: 'abc-123',
  'detail-type': 'GuardDuty Finding',
  source: 'aws.guardduty',
  account: '123456789012',
  time: '2026-09-11T10:00:00Z',
  region: 'ap-southeast-1',
  resources: [],
  detail: {
    schemaVersion: '2.0',
    accountId: '123456789012',
    region: 'ap-southeast-1',
    id: 'finding-id-xyz',
    type: 'Backdoor:EC2/C&CActivity.B!DNS',
    title: 'EC2 instance is querying a domain name associated with a known Command & Control server.',
    description: 'EC2 instance i-0a1b2c3d4e5f60001 is querying a domain name associated with a known C&C server.',
    severity: 8.0,
    resource: {
      resourceType: 'Instance',
      instanceDetails: {
        instanceId: 'i-0a1b2c3d4e5f60001',
        tags: [{ key: 'Name', value: 'abc-prod-ec2-gateway' }],
      },
    },
  },
};

describe('alarm-notifier — GuardDuty finding messages', () => {
  it('delivers a GuardDuty finding instead of dropping it as an unrecognised shape', async () => {
    await handler(buildSnsEvent([GUARDDUTY_FINDING_MESSAGE]));

    expect(postMock).toHaveBeenCalledTimes(1);
    const embed = { embeds: postMock.mock.calls[0][0] }.embeds[0];
    expect(embed.footer.text).toContain('GuardDuty');
    expect(embed.title).toContain('Command & Control server');
  });

  it('maps severity 8.0 to the HIGH tier (red)', async () => {
    await handler(buildSnsEvent([GUARDDUTY_FINDING_MESSAGE]));
    const embed = { embeds: postMock.mock.calls[0][0] }.embeds[0];
    expect(embed.color).toBe(0xed4245);
    const severityField = embed.fields.find((f: { name: string }) => f.name === 'Severity');
    expect(severityField.value).toContain('HIGH');
    expect(severityField.value).toContain('8.0');
  });

  it('maps severity 5.0 to the MEDIUM tier (orange)', async () => {
    await handler(buildSnsEvent([{ ...GUARDDUTY_FINDING_MESSAGE, detail: { ...GUARDDUTY_FINDING_MESSAGE.detail, severity: 5.0 } }]));
    const embed = { embeds: postMock.mock.calls[0][0] }.embeds[0];
    expect(embed.color).toBe(0xfaa61a);
    const severityField = embed.fields.find((f: { name: string }) => f.name === 'Severity');
    expect(severityField.value).toContain('MEDIUM');
  });

  it('maps severity 2.0 to the LOW tier (blue) — total coverage even though the EventBridge rule filters this out in practice', async () => {
    await handler(buildSnsEvent([{ ...GUARDDUTY_FINDING_MESSAGE, detail: { ...GUARDDUTY_FINDING_MESSAGE.detail, severity: 2.0 } }]));
    const embed = { embeds: postMock.mock.calls[0][0] }.embeds[0];
    expect(embed.color).toBe(0x5865f2);
  });

  it('shows the EC2 instance Name tag from the embedded finding detail, without an extra DescribeInstances call', async () => {
    await handler(buildSnsEvent([GUARDDUTY_FINDING_MESSAGE]));
    expect(ec2SendMock).not.toHaveBeenCalled();
    const embed = { embeds: postMock.mock.calls[0][0] }.embeds[0];
    const resourceField = embed.fields.find((f: { name: string }) => f.name === 'Affected resource');
    expect(resourceField.value).toContain('abc-prod-ec2-gateway');
  });

  it('falls back to the raw instanceId when there is no Name tag', async () => {
    const noNameTag = {
      ...GUARDDUTY_FINDING_MESSAGE,
      detail: {
        ...GUARDDUTY_FINDING_MESSAGE.detail,
        resource: { resourceType: 'Instance', instanceDetails: { instanceId: 'i-notag123' } },
      },
    };
    await handler(buildSnsEvent([noNameTag]));
    const embed = { embeds: postMock.mock.calls[0][0] }.embeds[0];
    const resourceField = embed.fields.find((f: { name: string }) => f.name === 'Affected resource');
    expect(resourceField.value).toContain('i-notag123');
  });

  it('describes an S3 bucket resource', async () => {
    const s3Finding = {
      ...GUARDDUTY_FINDING_MESSAGE,
      detail: {
        ...GUARDDUTY_FINDING_MESSAGE.detail,
        resource: { resourceType: 'S3Bucket', s3BucketDetails: [{ name: 'abc-prod-assessment-report' }] },
      },
    };
    await handler(buildSnsEvent([s3Finding]));
    const embed = { embeds: postMock.mock.calls[0][0] }.embeds[0];
    const resourceField = embed.fields.find((f: { name: string }) => f.name === 'Affected resource');
    expect(resourceField.value).toContain('abc-prod-assessment-report');
  });

  it('includes a working console deep-link built from the finding id and region', async () => {
    await handler(buildSnsEvent([GUARDDUTY_FINDING_MESSAGE]));
    const embed = { embeds: postMock.mock.calls[0][0] }.embeds[0];
    const linksField = embed.fields.find((f: { name: string }) => f.name === '🔗 Links');
    expect(linksField.value).toContain('finding-id-xyz');
    expect(linksField.value).toContain('ap-southeast-1');
  });

  it('HIGH severity -> SEV-1 in the title, states Impact', async () => {
    await handler(buildSnsEvent([GUARDDUTY_FINDING_MESSAGE]));
    const embed = { embeds: postMock.mock.calls[0][0] }.embeds[0];
    expect(embed.title).toContain('[SEV-1]');
    expect(embed.fields.find((f: { name: string }) => f.name === '🎯 Impact')).toBeDefined();
  });

  it('LOW severity -> no SEV tier, no Impact field (this Lambda\'s own rule filters these out in practice)', async () => {
    const lowFinding = { ...GUARDDUTY_FINDING_MESSAGE, detail: { ...GUARDDUTY_FINDING_MESSAGE.detail, severity: 2.0 } };
    await handler(buildSnsEvent([lowFinding]));
    const embed = { embeds: postMock.mock.calls[0][0] }.embeds[0];
    expect(embed.title).not.toContain('SEV-');
    expect(embed.fields.find((f: { name: string }) => f.name === '🎯 Impact')).toBeUndefined();
  });

  it('includes a Metadata field with the region', async () => {
    await handler(buildSnsEvent([GUARDDUTY_FINDING_MESSAGE]));
    const embed = { embeds: postMock.mock.calls[0][0] }.embeds[0];
    const metadata = embed.fields.find((f: { name: string }) => f.name === '🏷️ Metadata');
    expect(metadata.value).toContain('ap-southeast-1');
  });

  it('HIGH severity -> "Standard applied" field tells the operator to treat it as an active incident', async () => {
    await handler(buildSnsEvent([GUARDDUTY_FINDING_MESSAGE]));
    const embed = { embeds: postMock.mock.calls[0][0] }.embeds[0];
    const standardField = embed.fields.find((f: { name: string }) => f.name === 'Standard applied');
    expect(standardField).toBeDefined();
    expect(standardField.value).toContain('active security incident');
  });

  it('MEDIUM severity -> "Standard applied" field gives the same-business-day guidance', async () => {
    await handler(buildSnsEvent([{ ...GUARDDUTY_FINDING_MESSAGE, detail: { ...GUARDDUTY_FINDING_MESSAGE.detail, severity: 5.0 } }]));
    const embed = { embeds: postMock.mock.calls[0][0] }.embeds[0];
    const standardField = embed.fields.find((f: { name: string }) => f.name === 'Standard applied');
    expect(standardField.value).toContain('business day');
  });

  it('still routes a CloudWatch alarm down the alarm path, unchanged, even after adding GuardDuty handling', async () => {
    await handler(buildSnsEvent([ALARM_MESSAGE]));
    const embed = { embeds: postMock.mock.calls[0][0] }.embeds[0];
    expect(embed.footer.text).toContain('CloudWatch Alarm');
  });

  it('handles a mixed batch: one GuardDuty finding and one CloudWatch alarm in the same invoke', async () => {
    await handler(buildSnsEvent([GUARDDUTY_FINDING_MESSAGE, ALARM_MESSAGE]));
    expect(postMock).toHaveBeenCalledTimes(2);
    const footers = postMock.mock.calls.map((c) => (c[0] as { footer: { text: string } }[])[0].footer.text);
    expect(footers.some((f) => f.includes('GuardDuty'))).toBe(true);
    expect(footers.some((f) => f.includes('CloudWatch Alarm'))).toBe(true);
  });
});

/**
 * A real `CIS-*-Alarm` message shape, copied from the actual live alarm confirmed on this
 * account (2026-09-22 investigation): `Dimensions: []` always, `Namespace: 'CISBenchmark'` — the
 * exact structural vagueness `lookupCisBenchmarkEvent`'s enrichment exists to fix. See
 * `shared/src/runbookCatalog.ts`'s CIS section header for the full background.
 */
const CIS_ALARM_MESSAGE = {
  AlarmName: 'CIS-SecurityGroupChanges-Alarm',
  AlarmDescription: 'CIS Benchmark alert: SecurityGroupChanges',
  NewStateValue: 'ALARM',
  OldStateValue: 'OK',
  NewStateReason: 'Threshold Crossed: 1 datapoint [1.0] was greater than or equal to the threshold (1.0).',
  StateChangeTime: '2026-09-22T08:25:00.000Z',
  Region: 'Asia Pacific (Singapore)',
  AlarmArn: 'arn:aws:cloudwatch:ap-southeast-1:123456789012:alarm:CIS-SecurityGroupChanges-Alarm',
  Trigger: {
    MetricName: 'SecurityGroupChangesCount',
    Namespace: 'CISBenchmark',
    Dimensions: [],
    Threshold: 1,
    ComparisonOperator: 'GreaterThanOrEqualToThreshold',
    Period: 300,
  },
};

/** A realistic CloudTrail `LookupEvents` response entry for an `AuthorizeSecurityGroupIngress`
 * call — the exact shape `event.CloudTrailEvent` carries as a JSON STRING (not a parsed object),
 * matching the real API contract this Lambda's `JSON.parse(event.CloudTrailEvent)` call expects. */
function buildCloudTrailEvent(overrides: Record<string, unknown> = {}) {
  const raw = {
    eventName: 'AuthorizeSecurityGroupIngress',
    eventTime: '2026-09-22T08:24:12Z',
    userIdentity: { type: 'IAMUser', arn: 'arn:aws:iam::123456789012:user/vu.tq', userName: 'vu.tq' },
    sourceIPAddress: '118.69.34.219',
    recipientAccountId: '123456789012',
    awsRegion: 'ap-southeast-1',
    ...overrides,
  };
  return {
    EventName: raw.eventName,
    EventTime: new Date(raw.eventTime as string),
    CloudTrailEvent: JSON.stringify(raw),
    Resources: [{ ResourceName: 'sg-0123456789abcdef0', ResourceType: 'AWS::EC2::SecurityGroup' }],
  };
}

describe('alarm-notifier — CIS Benchmark alarm CloudTrail enrichment', () => {
  it('attaches a "CloudTrail event found" field with principal/source IP/account/resource when CloudTrail has a matching event', async () => {
    cloudtrailSendMock.mockResolvedValue({ Events: [buildCloudTrailEvent()] });

    await handler(buildSnsEvent([CIS_ALARM_MESSAGE]));

    expect(postMock).toHaveBeenCalledTimes(1);
    const embed = { embeds: postMock.mock.calls[0][0] }.embeds[0];
    const field = embed.fields.find((f: { name: string }) => f.name === '🔎 CloudTrail event found');
    expect(field).toBeDefined();
    expect(field.value).toContain('AuthorizeSecurityGroupIngress');
    expect(field.value).toContain('arn:aws:iam::123456789012:user/vu.tq');
    expect(field.value).toContain('118.69.34.219');
    expect(field.value).toContain('123456789012');
    expect(field.value).toContain('sg-0123456789abcdef0');
  });

  it('queries CloudTrail scoped to a window around the alarm StateChangeTime, using an EventName lookup attribute', async () => {
    cloudtrailSendMock.mockResolvedValue({ Events: [buildCloudTrailEvent()] });
    await handler(buildSnsEvent([CIS_ALARM_MESSAGE]));

    expect(cloudtrailSendMock).toHaveBeenCalledTimes(1);
    const [sentCommand] = cloudtrailSendMock.mock.calls[0];
    expect(sentCommand.input.LookupAttributes).toEqual([{ AttributeKey: 'EventName', AttributeValue: 'AuthorizeSecurityGroupIngress' }]);
    expect(sentCommand.input.StartTime.getTime()).toBeLessThan(new Date(CIS_ALARM_MESSAGE.StateChangeTime).getTime());
    expect(sentCommand.input.EndTime.getTime()).toBeGreaterThan(new Date(CIS_ALARM_MESSAGE.StateChangeTime).getTime());
  });

  it('no matching CloudTrail event found in the window -> no enrichment field, notification still sent normally', async () => {
    cloudtrailSendMock.mockResolvedValue({ Events: [] });
    await handler(buildSnsEvent([CIS_ALARM_MESSAGE]));

    expect(postMock).toHaveBeenCalledTimes(1);
    const embed = { embeds: postMock.mock.calls[0][0] }.embeds[0];
    expect(embed.fields.find((f: { name: string }) => f.name === '🔎 CloudTrail event found')).toBeUndefined();
  });

  it('CloudTrail LookupEvents throws (missing permission/throttling) -> does not throw out of the handler, notification still sent without enrichment', async () => {
    cloudtrailSendMock.mockRejectedValue(new Error('AccessDenied'));
    await expect(handler(buildSnsEvent([CIS_ALARM_MESSAGE]))).resolves.toBeUndefined();

    expect(postMock).toHaveBeenCalledTimes(1);
    const embed = { embeds: postMock.mock.calls[0][0] }.embeds[0];
    expect(embed.fields.find((f: { name: string }) => f.name === '🔎 CloudTrail event found')).toBeUndefined();
  });

  it('a CIS alarm with a resolvable runbook (SecurityGroupChangesCount) -> SEV-1, correct runbook title', async () => {
    await handler(buildSnsEvent([CIS_ALARM_MESSAGE]));
    const embed = { embeds: postMock.mock.calls[0][0] }.embeds[0];
    expect(embed.title).toContain('[SEV-1]');
    const runbookField = embed.fields.find((f: { name: string }) => f.name === 'Runbook');
    expect(runbookField.value).toContain('security group changed');
  });

  it('RootAccountUsageCount -> filters CloudTrail events client-side by userIdentity.type === "Root" rather than a single eventName lookup attribute', async () => {
    cloudtrailSendMock.mockResolvedValue({
      Events: [
        buildCloudTrailEvent({ eventName: 'ConsoleLogin', userIdentity: { type: 'IAMUser', arn: 'arn:aws:iam::123456789012:user/someone' } }),
        buildCloudTrailEvent({ eventName: 'CreateAccessKey', userIdentity: { type: 'Root' }, sourceIPAddress: '203.0.113.5' }),
      ],
    });

    await handler(
      buildSnsEvent([
        { ...CIS_ALARM_MESSAGE, AlarmName: 'CIS-RootAccountUsage-Alarm', Trigger: { ...CIS_ALARM_MESSAGE.Trigger, MetricName: 'RootAccountUsageCount' } },
      ]),
    );

    const [sentCommand] = cloudtrailSendMock.mock.calls[0];
    expect(sentCommand.input.LookupAttributes).toBeUndefined(); // No single eventName filter — scans the window and filters client-side.
    const embed = { embeds: postMock.mock.calls[0][0] }.embeds[0];
    const field = embed.fields.find((f: { name: string }) => f.name === '🔎 CloudTrail event found');
    expect(field.value).toContain('CreateAccessKey'); // The Root-identity event, not the first (IAMUser) one.
    expect(field.value).toContain('root');
    expect(field.value).toContain('203.0.113.5');
  });

  it('UnauthorizedAPICallsCount -> filters CloudTrail events client-side by errorCode and states the match was by error code, not an exact eventName', async () => {
    cloudtrailSendMock.mockResolvedValue({
      Events: [
        buildCloudTrailEvent({ eventName: 'DescribeInstances', errorCode: undefined }),
        buildCloudTrailEvent({ eventName: 'DeleteBucket', errorCode: 'AccessDenied', sourceIPAddress: '198.51.100.7' }),
      ],
    });

    await handler(
      buildSnsEvent([
        { ...CIS_ALARM_MESSAGE, AlarmName: 'CIS-UnauthorizedAPICalls-Alarm', Trigger: { ...CIS_ALARM_MESSAGE.Trigger, MetricName: 'UnauthorizedAPICallsCount' } },
      ]),
    );

    const [sentCommand] = cloudtrailSendMock.mock.calls[0];
    expect(sentCommand.input.LookupAttributes).toBeUndefined();
    const embed = { embeds: postMock.mock.calls[0][0] }.embeds[0];
    const field = embed.fields.find((f: { name: string }) => f.name === '🔎 CloudTrail event found');
    expect(field.value).toContain('DeleteBucket');
    expect(field.value).toContain('198.51.100.7');
    expect(field.value).toContain('Matched by error code');
  });

  it('a non-CIS alarm (regular EC2 CPU alarm) -> never calls CloudTrail at all', async () => {
    await handler(buildSnsEvent([ALARM_MESSAGE]));
    expect(cloudtrailSendMock).not.toHaveBeenCalled();
  });

  it('a CIS alarm transitioning to OK -> no CloudTrail lookup (enrichment is ALARM-only)', async () => {
    await handler(buildSnsEvent([{ ...CIS_ALARM_MESSAGE, NewStateValue: 'OK', OldStateValue: 'ALARM' }]));
    expect(cloudtrailSendMock).not.toHaveBeenCalled();
  });
});
