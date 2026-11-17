import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.AWS_REGION = 'ap-southeast-1';
process.env.AWS_ACCOUNT_ID = '123456789012';
process.env.ASSESSMENT_BUCKET_NAME = 'test-assessment-bucket';

const ec2SendMock = vi.fn();
const s3SendMock = vi.fn();
const postDiscordEmbedsMock = vi.fn();

vi.mock('@aws-sdk/client-ec2', () => ({
  EC2Client: vi.fn().mockImplementation(() => ({ send: ec2SendMock })),
  DescribeInstancesCommand: vi.fn().mockImplementation((input: unknown) => ({ __cmd: 'DescribeInstances', input })),
  DescribeInstanceTypesCommand: vi.fn().mockImplementation((input: unknown) => ({ __cmd: 'DescribeInstanceTypes', input })),
  ModifyInstanceAttributeCommand: vi.fn().mockImplementation((input: unknown) => ({ __cmd: 'ModifyInstanceAttribute', input })),
  CreateTagsCommand: vi.fn().mockImplementation((input: unknown) => ({ __cmd: 'CreateTags', input })),
  DeleteTagsCommand: vi.fn().mockImplementation((input: unknown) => ({ __cmd: 'DeleteTags', input })),
}));

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({ send: s3SendMock })),
  PutObjectCommand: vi.fn().mockImplementation((input: unknown) => ({ __cmd: 'PutObject', input })),
}));

vi.mock('../alerting/discordWebhook.js', () => ({
  postDiscordEmbeds: postDiscordEmbedsMock,
}));

const fetchEc2RecommendationDetailMock = vi.fn();
vi.mock('../infra/compute-optimizer-collector.js', () => ({
  fetchEc2RecommendationDetail: fetchEc2RecommendationDetailMock,
  NORMALIZED_FINDING: {
    UNDERPROVISIONED: 'UNDERPROVISIONED',
    OVERPROVISIONED: 'OVERPROVISIONED',
    OPTIMIZED: 'OPTIMIZED',
    NOT_OPTIMIZED: 'NOTOPTIMIZED',
  },
}));

const { handler } = await import('./ec2-rightsize-applier.js');

beforeEach(() => {
  ec2SendMock.mockReset();
  s3SendMock.mockReset();
  postDiscordEmbedsMock.mockReset();
  fetchEc2RecommendationDetailMock.mockReset();
  s3SendMock.mockResolvedValue({});
  postDiscordEmbedsMock.mockResolvedValue(undefined);
  // Default: Compute Optimizer has no data (like an account not yet enrolled/a new instance) ->
  // every existing test (written before the cross-family logic existed) falls back to same-family
  // as before.
  fetchEc2RecommendationDetailMock.mockResolvedValue(undefined);
});

function stateChangeEvent(instanceId: string, state: string) {
  return {
    id: 'evt-1',
    version: '0',
    account: '123456789012',
    time: new Date().toISOString(),
    region: 'ap-southeast-1',
    resources: [],
    source: 'aws.ec2',
    'detail-type': 'EC2 Instance State-change Notification' as const,
    detail: { 'instance-id': instanceId, state },
  };
}

function instanceTypeInfo(instanceType: string, vcpus: number, memoryMiB: number, architectures: string[]) {
  return {
    InstanceType: instanceType,
    VCpuInfo: { DefaultVCpus: vcpus },
    MemoryInfo: { SizeInMiB: memoryMiB },
    ProcessorInfo: { SupportedArchitectures: architectures },
  };
}

describe('ec2-rightsize-applier handler', () => {
  it('event state other than "stopped" -> skips immediately, does not call DescribeInstances', async () => {
    await handler(stateChangeEvent('i-1', 'running'));
    expect(ec2SendMock).not.toHaveBeenCalled();
  });

  it('instance has no pending tag -> skips, mutates nothing (most EC2 stops in the account fall here)', async () => {
    ec2SendMock.mockImplementation((command: { __cmd: string }) => {
      if (command.__cmd === 'DescribeInstances') {
        return Promise.resolve({
          Reservations: [{ Instances: [{ InstanceId: 'i-1', InstanceType: 't3.large', Tags: [{ Key: 'Name', Value: 'web' }] }] }],
        });
      }
      return Promise.resolve({});
    });

    await handler(stateChangeEvent('i-1', 'stopped'));

    expect(ec2SendMock.mock.calls.some((c) => c[0].__cmd === 'ModifyInstanceAttribute')).toBe(false);
    expect(ec2SendMock.mock.calls.some((c) => c[0].__cmd === 'DeleteTags')).toBe(false);
  });

  it('instance does not exist (terminated) -> skips, does not throw', async () => {
    ec2SendMock.mockResolvedValue({ Reservations: [] });
    await expect(handler(stateChangeEvent('i-gone', 'stopped'))).resolves.toBeUndefined();
  });

  it('has a pending tag but also an exempt tag -> only clears the pending tag, does NOT change InstanceType', async () => {
    ec2SendMock.mockImplementation((command: { __cmd: string }) => {
      if (command.__cmd === 'DescribeInstances') {
        return Promise.resolve({
          Reservations: [
            {
              Instances: [
                {
                  InstanceId: 'i-exempt',
                  InstanceType: 'r6i.24xlarge',
                  Tags: [
                    { Key: 'OpsDashboard:PendingAutoRightsize', Value: 'down' },
                    { Key: 'OpsDashboard:NoAutoRightsize', Value: 'true' },
                  ],
                },
              ],
            },
          ],
        });
      }
      return Promise.resolve({});
    });

    await handler(stateChangeEvent('i-exempt', 'stopped'));

    const deleteTagsCall = ec2SendMock.mock.calls.find((c) => c[0].__cmd === 'DeleteTags');
    expect(deleteTagsCall).toBeDefined();
    expect(deleteTagsCall![0].input.Resources).toEqual(['i-exempt']);
    expect(ec2SendMock.mock.calls.some((c) => c[0].__cmd === 'ModifyInstanceAttribute')).toBe(false);
  });

  it('direction "down" — pending, all conditions met -> changes InstanceType, clears pending tag, writes cooldown tag, writes audit, notifies Discord success', async () => {
    ec2SendMock.mockImplementation((command: { __cmd: string }) => {
      if (command.__cmd === 'DescribeInstances') {
        return Promise.resolve({
          Reservations: [
            {
              Instances: [
                {
                  InstanceId: 'i-down1',
                  InstanceType: 'r6i.24xlarge',
                  Tags: [{ Key: 'OpsDashboard:PendingAutoRightsize', Value: 'down' }],
                },
              ],
            },
          ],
        });
      }
      if (command.__cmd === 'DescribeInstanceTypes') {
        return Promise.resolve({
          InstanceTypes: [
            instanceTypeInfo('r6i.16xlarge', 64, 524288, ['x86_64']),
            instanceTypeInfo('r6i.24xlarge', 96, 786432, ['x86_64']),
          ],
        });
      }
      return Promise.resolve({});
    });

    await handler(stateChangeEvent('i-down1', 'stopped'));

    const modifyCall = ec2SendMock.mock.calls.find((c) => c[0].__cmd === 'ModifyInstanceAttribute');
    expect(modifyCall![0].input).toEqual({ InstanceId: 'i-down1', InstanceType: { Value: 'r6i.16xlarge' } });

    expect(ec2SendMock.mock.calls.some((c) => c[0].__cmd === 'DeleteTags')).toBe(true);
    const createTagsCall = ec2SendMock.mock.calls.find((c) => c[0].__cmd === 'CreateTags');
    expect(createTagsCall![0].input.Tags[0].Key).toBe('OpsDashboard:LastAutoRightsizeDate');

    const putObjectCall = s3SendMock.mock.calls.find((c) => c[0].__cmd === 'PutObject');
    expect(putObjectCall).toBeDefined();
    const auditBody = JSON.parse(putObjectCall![0].input.Body);
    expect(auditBody.outcome).toBe('success');
    expect(auditBody.actionType).toBe('EC2_AutoRightsize');
    expect(auditBody.executedBy).toBe('system:ec2-rightsize-applier');
    expect(auditBody.params.newInstanceType).toBe('r6i.16xlarge');

    expect(postDiscordEmbedsMock).toHaveBeenCalledTimes(1);

    // Requirement: a successful change should say how to undo it, not just what changed.
    const embed = postDiscordEmbedsMock.mock.calls[0][0][0];
    const rollbackField = embed.fields.find((f: { name: string }) => f.name === 'Rollback');
    expect(rollbackField).toBeDefined();
    expect(rollbackField.value).toContain('r6i.24xlarge');
    expect(rollbackField.value).toContain('OpsDashboard:NoAutoRightsize');
  });

  it('direction "up" — picks the real NEXT LARGER size within the same family', async () => {
    ec2SendMock.mockImplementation((command: { __cmd: string }) => {
      if (command.__cmd === 'DescribeInstances') {
        return Promise.resolve({
          Reservations: [
            {
              Instances: [
                { InstanceId: 'i-up1', InstanceType: 'm6g.large', Tags: [{ Key: 'OpsDashboard:PendingAutoRightsize', Value: 'up' }] },
              ],
            },
          ],
        });
      }
      if (command.__cmd === 'DescribeInstanceTypes') {
        return Promise.resolve({
          InstanceTypes: [instanceTypeInfo('m6g.large', 2, 8192, ['arm64']), instanceTypeInfo('m6g.xlarge', 4, 16384, ['arm64'])],
        });
      }
      return Promise.resolve({});
    });

    await handler(stateChangeEvent('i-up1', 'stopped'));

    const modifyCall = ec2SendMock.mock.calls.find((c) => c[0].__cmd === 'ModifyInstanceAttribute');
    expect(modifyCall![0].input).toEqual({ InstanceId: 'i-up1', InstanceType: { Value: 'm6g.xlarge' } });
  });

  it('Compute Optimizer recommends a DIFFERENT family with migrationEffort=VeryLow + empty platformDifferences -> applies EXACTLY that type (source=computeOptimizer)', async () => {
    ec2SendMock.mockImplementation((command: { __cmd: string; input?: { Filters?: { Values: string[] }[] } }) => {
      if (command.__cmd === 'DescribeInstances') {
        return Promise.resolve({
          Reservations: [
            { Instances: [{ InstanceId: 'i-crossfamily1', InstanceType: 'm5.large', Tags: [{ Key: 'OpsDashboard:PendingAutoRightsize', Value: 'down' }] }] },
          ],
        });
      }
      if (command.__cmd === 'DescribeInstanceTypes') {
        const filterValue = command.input?.Filters?.[0]?.Values[0] ?? '';
        if (filterValue === 'm6i.large') return Promise.resolve({ InstanceTypes: [instanceTypeInfo('m6i.large', 2, 8192, ['x86_64'])] });
        if (filterValue === 'm5.large') return Promise.resolve({ InstanceTypes: [instanceTypeInfo('m5.large', 2, 8192, ['x86_64'])] });
        return Promise.resolve({ InstanceTypes: [] });
      }
      return Promise.resolve({});
    });
    fetchEc2RecommendationDetailMock.mockResolvedValue({
      finding: 'OVERPROVISIONED',
      findingReasonCodes: [],
      topRecommendationOption: { instanceType: 'm6i.large', migrationEffort: 'VeryLow', platformDifferences: [] },
    });

    await handler(stateChangeEvent('i-crossfamily1', 'stopped'));

    const modifyCall = ec2SendMock.mock.calls.find((c) => c[0].__cmd === 'ModifyInstanceAttribute');
    expect(modifyCall![0].input).toEqual({ InstanceId: 'i-crossfamily1', InstanceType: { Value: 'm6i.large' } });
    const auditBody = JSON.parse(s3SendMock.mock.calls.find((c) => c[0].__cmd === 'PutObject')![0].input.Body);
    expect(auditBody.params.source).toBe('computeOptimizer');
    expect(auditBody.params.newInstanceType).toBe('m6i.large');
  });

  it('Compute Optimizer recommends Graviton/arm64 (migrationEffort other than VeryLow) -> NOT applied, falls back to same-family (architecture unchanged)', async () => {
    ec2SendMock.mockImplementation((command: { __cmd: string; input?: { Filters?: { Values: string[] }[] } }) => {
      if (command.__cmd === 'DescribeInstances') {
        return Promise.resolve({
          Reservations: [
            { Instances: [{ InstanceId: 'i-graviton1', InstanceType: 'm5.xlarge', Tags: [{ Key: 'OpsDashboard:PendingAutoRightsize', Value: 'down' }] }] },
          ],
        });
      }
      if (command.__cmd === 'DescribeInstanceTypes') {
        const filterValue = command.input?.Filters?.[0]?.Values[0] ?? '';
        // current family is m5 - the same-family fallback calls DescribeInstanceTypes with 'm5.*'.
        if (filterValue === 'm5.*') {
          return Promise.resolve({
            InstanceTypes: [instanceTypeInfo('m5.large', 2, 8192, ['x86_64']), instanceTypeInfo('m5.xlarge', 4, 16384, ['x86_64'])],
          });
        }
        return Promise.resolve({ InstanceTypes: [] });
      }
      return Promise.resolve({});
    });
    // Compute Optimizer recommends moving to Graviton (m6g) - migrationEffort 'Medium' (NOT
    // VeryLow) because the CPU architecture changes - it MUST be rejected, and DescribeInstanceTypes
    // must not be called for m6g.large.
    fetchEc2RecommendationDetailMock.mockResolvedValue({
      finding: 'OVERPROVISIONED',
      findingReasonCodes: [],
      topRecommendationOption: { instanceType: 'm6g.large', migrationEffort: 'Medium', platformDifferences: ['Architecture'] },
    });

    await handler(stateChangeEvent('i-graviton1', 'stopped'));

    // Same-family fallback: m5.xlarge -> m5.large (one step down within the SAME family, NOT m6g).
    const modifyCall = ec2SendMock.mock.calls.find((c) => c[0].__cmd === 'ModifyInstanceAttribute');
    expect(modifyCall![0].input).toEqual({ InstanceId: 'i-graviton1', InstanceType: { Value: 'm5.large' } });
    expect(ec2SendMock.mock.calls.some((c) => c[0].__cmd === 'DescribeInstanceTypes' && c[0].input?.Filters?.[0]?.Values[0] === 'm6g.large')).toBe(false);
  });

  it('Compute Optimizer recommends a "clean" different family (VeryLow) but no longer confirms the same direction (changed its mind) -> falls back to same-family', async () => {
    ec2SendMock.mockImplementation((command: { __cmd: string; input?: { Filters?: { Values: string[] }[] } }) => {
      if (command.__cmd === 'DescribeInstances') {
        return Promise.resolve({
          Reservations: [
            { Instances: [{ InstanceId: 'i-changedmind1', InstanceType: 'm5.xlarge', Tags: [{ Key: 'OpsDashboard:PendingAutoRightsize', Value: 'down' }] }] },
          ],
        });
      }
      if (command.__cmd === 'DescribeInstanceTypes') {
        const filterValue = command.input?.Filters?.[0]?.Values[0] ?? '';
        if (filterValue === 'm5.*') {
          return Promise.resolve({
            InstanceTypes: [instanceTypeInfo('m5.large', 2, 8192, ['x86_64']), instanceTypeInfo('m5.xlarge', 4, 16384, ['x86_64'])],
          });
        }
        return Promise.resolve({ InstanceTypes: [] });
      }
      return Promise.resolve({});
    });
    // The finding is now OPTIMIZED (no longer confirms 'down') - even a "clean"
    // topRecommendationOption must NOT be used, because Compute Optimizer changed its mind before
    // the instance was stopped.
    fetchEc2RecommendationDetailMock.mockResolvedValue({
      finding: 'OPTIMIZED',
      findingReasonCodes: [],
      topRecommendationOption: { instanceType: 'm6i.large', migrationEffort: 'VeryLow', platformDifferences: [] },
    });

    await handler(stateChangeEvent('i-changedmind1', 'stopped'));

    const modifyCall = ec2SendMock.mock.calls.find((c) => c[0].__cmd === 'ModifyInstanceAttribute');
    expect(modifyCall![0].input).toEqual({ InstanceId: 'i-changedmind1', InstanceType: { Value: 'm5.large' } });
  });

  it('cannot find a target (already the smallest size) -> rejected, clears pending tag, writes audit rejected, does NOT call ModifyInstanceAttribute', async () => {
    ec2SendMock.mockImplementation((command: { __cmd: string }) => {
      if (command.__cmd === 'DescribeInstances') {
        return Promise.resolve({
          Reservations: [
            { Instances: [{ InstanceId: 'i-smallest', InstanceType: 't4g.nano', Tags: [{ Key: 'OpsDashboard:PendingAutoRightsize', Value: 'down' }] }] },
          ],
        });
      }
      if (command.__cmd === 'DescribeInstanceTypes') {
        return Promise.resolve({ InstanceTypes: [instanceTypeInfo('t4g.nano', 2, 512, ['arm64'])] });
      }
      return Promise.resolve({});
    });

    await handler(stateChangeEvent('i-smallest', 'stopped'));

    expect(ec2SendMock.mock.calls.some((c) => c[0].__cmd === 'ModifyInstanceAttribute')).toBe(false);
    expect(ec2SendMock.mock.calls.some((c) => c[0].__cmd === 'DeleteTags')).toBe(true);
    const auditBody = JSON.parse(s3SendMock.mock.calls.find((c) => c[0].__cmd === 'PutObject')![0].input.Body);
    expect(auditBody.outcome).toBe('rejected');
  });

  it('CPU architecture incompatible -> rejected, does NOT call ModifyInstanceAttribute (absolute safety net, cannot actually happen within the same family but still tested for defense-in-depth)', async () => {
    ec2SendMock.mockImplementation((command: { __cmd: string }) => {
      if (command.__cmd === 'DescribeInstances') {
        return Promise.resolve({
          Reservations: [
            { Instances: [{ InstanceId: 'i-incompat', InstanceType: 'x1.large', Tags: [{ Key: 'OpsDashboard:PendingAutoRightsize', Value: 'down' }] }] },
          ],
        });
      }
      if (command.__cmd === 'DescribeInstanceTypes') {
        return Promise.resolve({
          InstanceTypes: [instanceTypeInfo('x1.medium', 1, 2048, ['arm64']), instanceTypeInfo('x1.large', 2, 4096, ['x86_64'])],
        });
      }
      return Promise.resolve({});
    });

    await handler(stateChangeEvent('i-incompat', 'stopped'));

    expect(ec2SendMock.mock.calls.some((c) => c[0].__cmd === 'ModifyInstanceAttribute')).toBe(false);
    const auditBody = JSON.parse(s3SendMock.mock.calls.find((c) => c[0].__cmd === 'PutObject')![0].input.Body);
    expect(auditBody.outcome).toBe('rejected');
  });

  it('ModifyInstanceAttribute throws an error -> failure, still clears the pending tag, writes audit failure, does NOT write the cooldown tag', async () => {
    ec2SendMock.mockImplementation((command: { __cmd: string }) => {
      if (command.__cmd === 'DescribeInstances') {
        return Promise.resolve({
          Reservations: [
            { Instances: [{ InstanceId: 'i-modifyfail', InstanceType: 'r6i.24xlarge', Tags: [{ Key: 'OpsDashboard:PendingAutoRightsize', Value: 'down' }] }] },
          ],
        });
      }
      if (command.__cmd === 'DescribeInstanceTypes') {
        return Promise.resolve({
          InstanceTypes: [instanceTypeInfo('r6i.16xlarge', 64, 524288, ['x86_64']), instanceTypeInfo('r6i.24xlarge', 96, 786432, ['x86_64'])],
        });
      }
      if (command.__cmd === 'ModifyInstanceAttribute') return Promise.reject(new Error('IncorrectInstanceState'));
      return Promise.resolve({});
    });

    await handler(stateChangeEvent('i-modifyfail', 'stopped'));

    expect(ec2SendMock.mock.calls.some((c) => c[0].__cmd === 'DeleteTags')).toBe(true);
    expect(ec2SendMock.mock.calls.some((c) => c[0].__cmd === 'CreateTags')).toBe(false);
    const auditBody = JSON.parse(s3SendMock.mock.calls.find((c) => c[0].__cmd === 'PutObject')![0].input.Body);
    expect(auditBody.outcome).toBe('failure');
  });

  it('CreateTags (cooldown) throws an error after the type change succeeded -> still treated as success, does not throw', async () => {
    ec2SendMock.mockImplementation((command: { __cmd: string }) => {
      if (command.__cmd === 'DescribeInstances') {
        return Promise.resolve({
          Reservations: [
            { Instances: [{ InstanceId: 'i-cooldownfail', InstanceType: 'r6i.24xlarge', Tags: [{ Key: 'OpsDashboard:PendingAutoRightsize', Value: 'down' }] }] },
          ],
        });
      }
      if (command.__cmd === 'DescribeInstanceTypes') {
        return Promise.resolve({
          InstanceTypes: [instanceTypeInfo('r6i.16xlarge', 64, 524288, ['x86_64']), instanceTypeInfo('r6i.24xlarge', 96, 786432, ['x86_64'])],
        });
      }
      if (command.__cmd === 'CreateTags') return Promise.reject(new Error('AccessDenied'));
      return Promise.resolve({});
    });

    await expect(handler(stateChangeEvent('i-cooldownfail', 'stopped'))).resolves.toBeUndefined();
    const auditBody = JSON.parse(s3SendMock.mock.calls.find((c) => c[0].__cmd === 'PutObject')![0].input.Body);
    expect(auditBody.outcome).toBe('success');
  });

  it('pendingAutoRightsizeDirection has an unexpected value (not up/down) -> treated as no pending, skips', async () => {
    ec2SendMock.mockResolvedValue({
      Reservations: [
        { Instances: [{ InstanceId: 'i-weird', InstanceType: 't3.large', Tags: [{ Key: 'OpsDashboard:PendingAutoRightsize', Value: 'sideways' }] }] },
      ],
    });

    await handler(stateChangeEvent('i-weird', 'stopped'));

    expect(ec2SendMock.mock.calls.some((c) => c[0].__cmd === 'ModifyInstanceAttribute')).toBe(false);
    expect(ec2SendMock.mock.calls.some((c) => c[0].__cmd === 'DeleteTags')).toBe(false);
  });
});
