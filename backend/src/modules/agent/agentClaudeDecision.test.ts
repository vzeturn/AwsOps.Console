import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseAgentDecision, type AgentDecisionCandidate } from './agentClaudeDecision.js';

describe('parseAgentDecision (pure, untrusted-input parsing)', () => {
  const eligible = new Set(['c0', 'c1', 'c2']);

  it('accepts a well-formed response and preserves order', () => {
    const raw = JSON.stringify({ selected: [{ candidateId: 'c1', rationale: 'Biggest savings.' }, { candidateId: 'c0', rationale: 'Also worth it.' }] });
    expect(parseAgentDecision(raw, eligible)).toEqual({
      selected: [
        { candidateId: 'c1', rationale: 'Biggest savings.' },
        { candidateId: 'c0', rationale: 'Also worth it.' },
      ],
    });
  });

  it('returns an empty selection for {"selected": []}', () => {
    expect(parseAgentDecision('{"selected": []}', eligible)).toEqual({ selected: [] });
  });

  it('strips a markdown code fence before parsing', () => {
    const raw = '```json\n{"selected": [{"candidateId": "c2", "rationale": "ok"}]}\n```';
    expect(parseAgentDecision(raw, eligible)).toEqual({ selected: [{ candidateId: 'c2', rationale: 'ok' }] });
  });

  it('fails safe (empty selection) on invalid JSON', () => {
    expect(parseAgentDecision('not json at all', eligible)).toEqual({ selected: [] });
  });

  it('fails safe on a response missing the "selected" key', () => {
    expect(parseAgentDecision('{"foo": "bar"}', eligible)).toEqual({ selected: [] });
  });

  it('fails safe when "selected" is not an array', () => {
    expect(parseAgentDecision('{"selected": "c0"}', eligible)).toEqual({ selected: [] });
  });

  it('SECURITY: silently drops a candidateId not in the eligible set, never throws', () => {
    const raw = JSON.stringify({
      selected: [
        { candidateId: 'c0', rationale: 'legit' },
        { candidateId: 'SecurityGroup_Delete', rationale: 'injected — not a real candidateId, must be dropped' },
      ],
    });
    expect(parseAgentDecision(raw, eligible)).toEqual({ selected: [{ candidateId: 'c0', rationale: 'legit' }] });
  });

  it('SECURITY: a response containing ONLY ineligible ids resolves to an empty selection, not an error', () => {
    const raw = JSON.stringify({ selected: [{ candidateId: 'not-a-real-id', rationale: 'hallucinated' }] });
    expect(parseAgentDecision(raw, eligible)).toEqual({ selected: [] });
  });

  it('drops a duplicate selection of the same candidateId, keeping only the first', () => {
    const raw = JSON.stringify({
      selected: [
        { candidateId: 'c0', rationale: 'first' },
        { candidateId: 'c0', rationale: 'second, should be dropped' },
      ],
    });
    expect(parseAgentDecision(raw, eligible)).toEqual({ selected: [{ candidateId: 'c0', rationale: 'first' }] });
  });

  it('drops an entry missing candidateId or rationale, or with the wrong type', () => {
    const raw = JSON.stringify({
      selected: [
        { candidateId: 'c0' }, // missing rationale
        { rationale: 'no id' }, // missing candidateId
        { candidateId: 123, rationale: 'wrong type' },
        { candidateId: 'c1', rationale: 'valid' },
      ],
    });
    expect(parseAgentDecision(raw, eligible)).toEqual({ selected: [{ candidateId: 'c1', rationale: 'valid' }] });
  });

  it('truncates an overly long rationale to 500 characters', () => {
    const longRationale = 'x'.repeat(1000);
    const raw = JSON.stringify({ selected: [{ candidateId: 'c0', rationale: longRationale }] });
    const result = parseAgentDecision(raw, eligible);
    expect(result.selected[0].rationale.length).toBe(500);
  });
});

const ssmSendMock = vi.fn();

vi.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: vi.fn().mockImplementation(() => ({ send: ssmSendMock })),
  GetParameterCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'GetParameter', input })),
}));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const CANDIDATES: AgentDecisionCandidate[] = [
  { candidateId: 'c0', summary: 'EBS gp2->gp3 for vol-1', estimatedMonthlySavingsUsd: 12.5 },
  { candidateId: 'c1', summary: 'CloudWatch log retention for /aws/lambda/foo', estimatedMonthlySavingsUsd: 2 },
];

beforeEach(() => {
  ssmSendMock.mockReset();
  fetchMock.mockReset();
  vi.resetModules();
  process.env.AGENT_CLAUDE_MODEL_ID = 'claude-sonnet-4-6';
  process.env.AGENT_CLAUDE_API_KEY_PARAM_NAME = 'test-claude-api-key-param';
  ssmSendMock.mockResolvedValue({ Parameter: { Value: 'sk-ant-test-key' } });
});

function anthropicTextResponse(text: string) {
  return { ok: true, json: async () => ({ content: [{ type: 'text', text }] }) };
}

describe('decideAgentActions (Claude API-integrated)', () => {
  it('returns an empty decision immediately when candidates is empty, without calling fetch', async () => {
    const { decideAgentActions } = await import('./agentClaudeDecision.js');
    const result = await decideAgentActions([], 5);
    expect(result).toEqual({ selected: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns an empty decision immediately when budget is 0, without calling fetch', async () => {
    const { decideAgentActions } = await import('./agentClaudeDecision.js');
    const result = await decideAgentActions(CANDIDATES, 0);
    expect(result).toEqual({ selected: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('parses a valid Claude response into a decision', async () => {
    fetchMock.mockResolvedValue(anthropicTextResponse(JSON.stringify({ selected: [{ candidateId: 'c0', rationale: 'Highest savings.' }] })));
    const { decideAgentActions } = await import('./agentClaudeDecision.js');

    const result = await decideAgentActions(CANDIDATES, 5);
    expect(result).toEqual({ selected: [{ candidateId: 'c0', rationale: 'Highest savings.' }] });
  });

  it('calls the Anthropic Messages API with the API key header, version header, and explicit max_tokens', async () => {
    fetchMock.mockResolvedValue(anthropicTextResponse('{"selected": []}'));
    const { decideAgentActions } = await import('./agentClaudeDecision.js');

    await decideAgentActions(CANDIDATES, 5);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('sk-ant-test-key');
    expect((init.headers as Record<string, string>)['anthropic-version']).toBeTruthy();
    const body = JSON.parse(init.body as string);
    expect(body.max_tokens).toBeGreaterThan(0);
    expect(body.model).toBe('claude-sonnet-4-6');
  });

  it('truncates the model selection to the budget (defense-in-depth against a model ignoring the prompt)', async () => {
    fetchMock.mockResolvedValue(
      anthropicTextResponse(JSON.stringify({ selected: [{ candidateId: 'c0', rationale: 'a' }, { candidateId: 'c1', rationale: 'b' }] })),
    );
    const { decideAgentActions } = await import('./agentClaudeDecision.js');

    const result = await decideAgentActions(CANDIDATES, 1);
    expect(result.selected).toHaveLength(1);
    expect(result.selected[0].candidateId).toBe('c0');
  });

  it('fails safe (empty decision) when AGENT_CLAUDE_MODEL_ID is not configured, without calling fetch', async () => {
    delete process.env.AGENT_CLAUDE_MODEL_ID;
    const { decideAgentActions } = await import('./agentClaudeDecision.js');

    const result = await decideAgentActions(CANDIDATES, 5);
    expect(result).toEqual({ selected: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails safe (empty decision) when the SSM parameter for the API key is not configured', async () => {
    delete process.env.AGENT_CLAUDE_API_KEY_PARAM_NAME;
    const { decideAgentActions } = await import('./agentClaudeDecision.js');

    const result = await decideAgentActions(CANDIDATES, 5);
    expect(result).toEqual({ selected: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails safe (empty decision) when reading the API key from SSM fails', async () => {
    ssmSendMock.mockRejectedValue(new Error('AccessDenied'));
    const { decideAgentActions } = await import('./agentClaudeDecision.js');

    const result = await decideAgentActions(CANDIDATES, 5);
    expect(result).toEqual({ selected: [] });
  });

  it('fails safe (empty decision) when the fetch call throws (network error)', async () => {
    fetchMock.mockRejectedValue(new Error('network error'));
    const { decideAgentActions } = await import('./agentClaudeDecision.js');

    const result = await decideAgentActions(CANDIDATES, 5);
    expect(result).toEqual({ selected: [] });
  });

  it('fails safe (empty decision) when the API returns a non-2xx status', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 429, text: async () => 'rate limited' });
    const { decideAgentActions } = await import('./agentClaudeDecision.js');

    const result = await decideAgentActions(CANDIDATES, 5);
    expect(result).toEqual({ selected: [] });
  });

  it('fails safe (empty decision) when the response has no text content block', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ content: [] }) });
    const { decideAgentActions } = await import('./agentClaudeDecision.js');

    const result = await decideAgentActions(CANDIDATES, 5);
    expect(result).toEqual({ selected: [] });
  });

  it('SECURITY: a model response selecting an id not among the real candidates never surfaces as a selection', async () => {
    fetchMock.mockResolvedValue(
      anthropicTextResponse(JSON.stringify({ selected: [{ candidateId: 'EC2_Reboot:i-evil', rationale: 'trying to sneak in an operator-only action' }] })),
    );
    const { decideAgentActions } = await import('./agentClaudeDecision.js');

    const result = await decideAgentActions(CANDIDATES, 5);
    expect(result).toEqual({ selected: [] });
  });

  it('reuses the cached API key across multiple calls within the same module instance (only 1 SSM read)', async () => {
    fetchMock.mockResolvedValue(anthropicTextResponse('{"selected": []}'));
    const { decideAgentActions } = await import('./agentClaudeDecision.js');

    await decideAgentActions(CANDIDATES, 5);
    await decideAgentActions(CANDIDATES, 5);

    expect(ssmSendMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
