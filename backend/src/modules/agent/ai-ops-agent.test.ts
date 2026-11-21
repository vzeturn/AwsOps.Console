import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AssessmentReport, RecommendationItem } from '@ops-dashboard/shared';

process.env.AWS_REGION = 'ap-southeast-1';
process.env.ASSESSMENT_BUCKET_NAME = 'test-assessment-bucket';
process.env.ACTION_EXECUTION_FUNCTION_NAME = 'test-action-execution-fn';

const s3SendMock = vi.fn();
const lambdaSendMock = vi.fn();
const isAgentAutoExecuteEnabledMock = vi.fn();
const reserveAgentExecutionBudgetMock = vi.fn();
const decideAgentActionsMock = vi.fn();
const postAlertEmbedsMock = vi.fn();

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({ send: s3SendMock })),
  GetObjectCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'GetObject', input })),
}));

vi.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: vi.fn().mockImplementation(() => ({ send: lambdaSendMock })),
  InvokeCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'Invoke', input })),
}));

vi.mock('./agentKillSwitch.js', () => ({
  isAgentAutoExecuteEnabled: isAgentAutoExecuteEnabledMock,
}));

vi.mock('./agentRateLimiter.js', () => ({
  reserveAgentExecutionBudget: reserveAgentExecutionBudgetMock,
}));

vi.mock('./agentClaudeDecision.js', () => ({
  decideAgentActions: decideAgentActionsMock,
}));

vi.mock('../alerting/alertHook.js', () => ({
  postAlertEmbeds: postAlertEmbedsMock,
}));

const { handler, findEligibleFindings } = await import('./ai-ops-agent.js');

function jsonBody(value: unknown) {
  return { transformToString: async () => JSON.stringify(value) };
}

function recommendation(overrides: Partial<RecommendationItem> = {}): RecommendationItem {
  return {
    id: 'rec-1',
    category: 'storage',
    resourceType: 'ebs-volume',
    resourceId: 'vol-123',
    resourceName: 'vol-123',
    currentState: 'gp2',
    recommendedAction: 'Convert to gp3',
    estimatedMonthlySavingsUsd: 10,
    risk: 'low',
    priority: 'medium',
    findingType: 'ebsVolumeGp2ShouldBeGp3',
    ...overrides,
  };
}

function baseReport(recommendations: RecommendationItem[]): AssessmentReport {
  return {
    account: '123456789012',
    region: 'ap-southeast-1',
    periodStart: '2026-09-01',
    periodEnd: '2026-09-11',
    generatedAt: '2026-09-11T00:00:00.000Z',
    compute: { lambda: [] },
    database: {},
    networking: { natGateways: [] },
    storage: { s3Buckets: [], ebsVolumes: [] },
    savingsPlans: { coverageByService: [] },
    backup: { protectionGaps: [] },
    recommendations,
  };
}

beforeEach(() => {
  s3SendMock.mockReset();
  lambdaSendMock.mockReset();
  isAgentAutoExecuteEnabledMock.mockReset();
  reserveAgentExecutionBudgetMock.mockReset();
  decideAgentActionsMock.mockReset();
  postAlertEmbedsMock.mockReset();
  postAlertEmbedsMock.mockResolvedValue(undefined);
});

describe('findEligibleFindings (pure)', () => {
  it('includes a finding matched to an allowlisted actionType', () => {
    const report = baseReport([recommendation({ findingType: 'ebsVolumeGp2ShouldBeGp3' })]);
    const eligible = findEligibleFindings(report);
    expect(eligible).toHaveLength(1);
    expect(eligible[0]).toMatchObject({ candidateId: 'c0', actionType: 'EBS_ModifyVolumeType' });
  });

  it('excludes a finding with no matching Action_Catalog override (manual-only finding)', () => {
    const report = baseReport([recommendation({ findingType: 'savingsPlanCoverageLow' })]);
    expect(findEligibleFindings(report)).toEqual([]);
  });

  it('excludes a finding matched to an operator-only/irreversible action (e.g. ec2LowCpu -> EC2_Rightsize is allowlisted, but elasticIpUnused -> ElasticIp_Release is irreversible)', () => {
    const report = baseReport([recommendation({ findingType: 'elasticIpUnused', resourceType: 'elastic-ip' })]);
    expect(findEligibleFindings(report)).toEqual([]);
  });

  it('includes ec2LowCpu (maps to EC2_Rightsize, which is allowlisted)', () => {
    const report = baseReport([recommendation({ findingType: 'ec2LowCpu', resourceType: 'ec2-instance', category: 'compute' })]);
    const eligible = findEligibleFindings(report);
    expect(eligible).toHaveLength(1);
    expect(eligible[0].actionType).toBe('EC2_Rightsize');
  });

  it('skips a finding already marked executed:true, even if otherwise eligible', () => {
    const report = baseReport([recommendation({ findingType: 'ebsVolumeGp2ShouldBeGp3', executed: true })]);
    expect(findEligibleFindings(report)).toEqual([]);
  });

  it('assigns sequential candidateIds only to eligible findings (skipped findings do not consume an id)', () => {
    const report = baseReport([
      recommendation({ id: 'a', findingType: 'savingsPlanCoverageLow' }), // ineligible, skipped
      recommendation({ id: 'b', findingType: 'ebsVolumeGp2ShouldBeGp3', resourceId: 'vol-b' }),
      recommendation({ id: 'c', findingType: 'cloudWatchLogGroupNoRetention', resourceType: 'cloudwatch-log-group', category: 'compute', resourceId: '/aws/lambda/foo' }),
    ]);
    const eligible = findEligibleFindings(report);
    expect(eligible.map((e) => e.candidateId)).toEqual(['c0', 'c1']);
    expect(eligible.map((e) => e.item.resourceId)).toEqual(['vol-b', '/aws/lambda/foo']);
  });
});

describe('handler (integration)', () => {
  it('kill switch disabled -> skips entirely, never reads S3/invokes the model/executes anything', async () => {
    isAgentAutoExecuteEnabledMock.mockResolvedValue(false);

    const result = await handler();

    expect(result).toEqual({ ok: true, eligibleCount: 0, selectedCount: 0, executedCount: 0, succeededCount: 0 });
    expect(s3SendMock).not.toHaveBeenCalled();
    expect(reserveAgentExecutionBudgetMock).not.toHaveBeenCalled();
    expect(decideAgentActionsMock).not.toHaveBeenCalled();
    expect(lambdaSendMock).not.toHaveBeenCalled();
  });

  it('no assessment report available -> returns empty result without calling the rate limiter/model', async () => {
    isAgentAutoExecuteEnabledMock.mockResolvedValue(true);
    s3SendMock.mockRejectedValue(new Error('NoSuchKey'));

    const result = await handler();

    expect(result.eligibleCount).toBe(0);
    expect(reserveAgentExecutionBudgetMock).not.toHaveBeenCalled();
  });

  it('no eligible findings -> returns empty result without calling the rate limiter/model', async () => {
    isAgentAutoExecuteEnabledMock.mockResolvedValue(true);
    s3SendMock.mockResolvedValue({ Body: jsonBody(baseReport([recommendation({ findingType: 'savingsPlanCoverageLow' })])) });

    const result = await handler();

    expect(result.eligibleCount).toBe(0);
    expect(reserveAgentExecutionBudgetMock).not.toHaveBeenCalled();
  });

  it('rate limit budget exhausted (allowedCount=0) -> skips the model call and execution entirely', async () => {
    isAgentAutoExecuteEnabledMock.mockResolvedValue(true);
    s3SendMock.mockResolvedValue({ Body: jsonBody(baseReport([recommendation({ findingType: 'ebsVolumeGp2ShouldBeGp3' })])) });
    reserveAgentExecutionBudgetMock.mockResolvedValue({ allowedCount: 0, budgetRemainingAfter: 0 });

    const result = await handler();

    expect(result).toEqual({ ok: true, eligibleCount: 1, selectedCount: 0, executedCount: 0, succeededCount: 0 });
    expect(decideAgentActionsMock).not.toHaveBeenCalled();
    expect(lambdaSendMock).not.toHaveBeenCalled();
  });

  it('happy path: eligible finding selected by the model -> invokes action-execution-fn and posts one alert embed', async () => {
    isAgentAutoExecuteEnabledMock.mockResolvedValue(true);
    s3SendMock.mockResolvedValue({
      Body: jsonBody(baseReport([recommendation({ findingType: 'ebsVolumeGp2ShouldBeGp3', resourceId: 'vol-123' })])),
    });
    reserveAgentExecutionBudgetMock.mockResolvedValue({ allowedCount: 1, budgetRemainingAfter: 4 });
    decideAgentActionsMock.mockResolvedValue({ selected: [{ candidateId: 'c0', rationale: 'Cheap and safe.' }] });
    lambdaSendMock.mockResolvedValue({ Payload: Buffer.from(JSON.stringify({ outcome: 'success', newVolumeType: 'gp3' })) });

    const result = await handler();

    expect(result).toEqual({ ok: true, eligibleCount: 1, selectedCount: 1, executedCount: 1, succeededCount: 1 });
    expect(lambdaSendMock).toHaveBeenCalledTimes(1);
    const invokeInput = lambdaSendMock.mock.calls[0][0].input as { FunctionName: string; Payload: Buffer };
    expect(invokeInput.FunctionName).toBe('test-action-execution-fn');
    const request = JSON.parse(invokeInput.Payload.toString('utf-8'));
    expect(request).toEqual({
      actionType: 'EBS_ModifyVolumeType',
      resourceId: 'vol-123',
      region: 'ap-southeast-1',
      params: {},
      executedBy: 'agent:ops-ai-agent',
    });
    expect(postAlertEmbedsMock).toHaveBeenCalledTimes(1);

    // Requirement: cite the runbook's rollback step in the notification itself, since nobody
    // confirmed this action by hand — this may be the first time an operator learns it happened.
    const embed = postAlertEmbedsMock.mock.calls[0][0][0];
    const field = embed.fields.find((f: { name: string }) => f.name.includes('EBS_ModifyVolumeType'));
    expect(field.value).toContain('Rollback:');
    expect(field.value).toContain('ModifyVolume back to gp2');
  });

  it('Bedrock selects nothing -> no execution, no alert', async () => {
    isAgentAutoExecuteEnabledMock.mockResolvedValue(true);
    s3SendMock.mockResolvedValue({ Body: jsonBody(baseReport([recommendation({ findingType: 'ebsVolumeGp2ShouldBeGp3' })])) });
    reserveAgentExecutionBudgetMock.mockResolvedValue({ allowedCount: 1, budgetRemainingAfter: 4 });
    decideAgentActionsMock.mockResolvedValue({ selected: [] });

    const result = await handler();

    expect(result).toEqual({ ok: true, eligibleCount: 1, selectedCount: 0, executedCount: 0, succeededCount: 0 });
    expect(lambdaSendMock).not.toHaveBeenCalled();
    expect(postAlertEmbedsMock).not.toHaveBeenCalled();
  });

  it('SECURITY: a selected candidateId that does not resolve to a known finding is skipped, never invoked', async () => {
    isAgentAutoExecuteEnabledMock.mockResolvedValue(true);
    s3SendMock.mockResolvedValue({ Body: jsonBody(baseReport([recommendation({ findingType: 'ebsVolumeGp2ShouldBeGp3' })])) });
    reserveAgentExecutionBudgetMock.mockResolvedValue({ allowedCount: 1, budgetRemainingAfter: 4 });
    decideAgentActionsMock.mockResolvedValue({ selected: [{ candidateId: 'ghost-id', rationale: 'should never execute' }] });

    const result = await handler();

    expect(result.executedCount).toBe(0);
    expect(lambdaSendMock).not.toHaveBeenCalled();
  });

  it('action-execution-fn returns a failure outcome -> still reported, embed severity reflects the failure', async () => {
    isAgentAutoExecuteEnabledMock.mockResolvedValue(true);
    s3SendMock.mockResolvedValue({ Body: jsonBody(baseReport([recommendation({ findingType: 'ebsVolumeGp2ShouldBeGp3' })])) });
    reserveAgentExecutionBudgetMock.mockResolvedValue({ allowedCount: 1, budgetRemainingAfter: 4 });
    decideAgentActionsMock.mockResolvedValue({ selected: [{ candidateId: 'c0', rationale: 'try it' }] });
    lambdaSendMock.mockResolvedValue({ Payload: Buffer.from(JSON.stringify({ outcome: 'failure', reason: 'ModifyVolume failed' })) });

    const result = await handler();

    expect(result).toEqual({ ok: true, eligibleCount: 1, selectedCount: 1, executedCount: 1, succeededCount: 0 });
    expect(postAlertEmbedsMock).toHaveBeenCalledTimes(1);
    const embed = postAlertEmbedsMock.mock.calls[0][0][0];
    expect(embed.title).toContain('0/1');
    // A failed execution changed nothing, so there is nothing to roll back — must not claim one.
    const field = embed.fields.find((f: { name: string }) => f.name.includes('EBS_ModifyVolumeType'));
    expect(field.value).not.toContain('Rollback:');
  });

  it('invoking action-execution-fn throws -> treated as a failure result, does not crash the run', async () => {
    isAgentAutoExecuteEnabledMock.mockResolvedValue(true);
    s3SendMock.mockResolvedValue({ Body: jsonBody(baseReport([recommendation({ findingType: 'ebsVolumeGp2ShouldBeGp3' })])) });
    reserveAgentExecutionBudgetMock.mockResolvedValue({ allowedCount: 1, budgetRemainingAfter: 4 });
    decideAgentActionsMock.mockResolvedValue({ selected: [{ candidateId: 'c0', rationale: 'try it' }] });
    lambdaSendMock.mockRejectedValue(new Error('ServiceException'));

    const result = await handler();

    expect(result.executedCount).toBe(1);
    expect(result.succeededCount).toBe(0);
  });
});
