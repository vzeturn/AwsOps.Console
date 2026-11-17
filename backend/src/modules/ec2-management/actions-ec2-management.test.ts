import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildMockAppConfig, buildMockEvent } from '../../shared-kernel/testHelpers.js';

// `config.ts` throws at module load if a required environment variable is missing (fail-loud, see
// config.ts) — the whole module is mocked instead of setting each env var, same pattern as
// actions-security-group.test.ts. `vi.mock` factories are hoisted above imports, so
// `buildMockAppConfig` must be called inline here rather than referencing a module-scope constant.
vi.mock('../../config.js', () => ({
  config: buildMockAppConfig(),
  corsHeaders: () => ({}),
}));

// The `vi.mock` factory is hoisted ABOVE every const declaration in the file — referencing `send`
// directly (declared with `const` below) inside the factory would throw "Cannot access before
// initialization". `vi.hoisted()` creates the mock so it is hoisted at the same time, letting the
// factory below access it safely.
const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: vi.fn(() => ({ send })),
  InvokeCommand: vi.fn((input) => input),
}));
vi.mock('../web/index.js', () => ({ isOperatorMember: vi.fn() }));

import { handler } from './actions-ec2-management.js';
import { isOperatorMember } from '../web/index.js';

describe('POST /actions/ec2-management', () => {
  beforeEach(() => {
    send.mockReset();
    vi.mocked(isOperatorMember).mockReset();
  });

  it('rejects non-operators before parsing the body', async () => {
    vi.mocked(isOperatorMember).mockReturnValue(false);
    await expect(handler(buildMockEvent({ actionType: 'Ec2_ChangeInstanceType' }), {})).rejects.toThrow(/operator/i);
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects an unknown actionType', async () => {
    vi.mocked(isOperatorMember).mockReturnValue(true);
    await expect(handler(buildMockEvent({ actionType: 'Bogus_Action', resourceId: 'i-abc123' }), {})).rejects.toThrow();
  });

  it('rejects a malformed instance id', async () => {
    vi.mocked(isOperatorMember).mockReturnValue(true);
    await expect(
      handler(buildMockEvent({ actionType: 'Ec2_ChangeInstanceType', resourceId: 'not-an-instance-id' }), {}),
    ).rejects.toThrow();
  });

  it('forwards Ec2_UpdateTags with set/remove JSON-encoded into params', async () => {
    vi.mocked(isOperatorMember).mockReturnValue(true);
    send.mockResolvedValue({ Payload: Buffer.from(JSON.stringify({ outcome: 'success' })) });
    const result = (await handler(
      buildMockEvent({ actionType: 'Ec2_UpdateTags', resourceId: 'i-abc12345', params: { set: { team: 'ops' }, remove: ['old'] } }),
      { preferred_username: 'someone@example.com' },
    )) as { statusCode: number; body: string };
    expect(result.statusCode).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
