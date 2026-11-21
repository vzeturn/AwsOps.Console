import { describe, it, expect, vi, beforeEach } from 'vitest';
import { monthStart } from './costDateRanges.js';
// Lean_Lambda_Exception (Requirement 6.4a): direct import, not `../ec2-management/index.js` —
// see the exception comment in `cost-collector.ts` (same reason): the barrel re-exports handler
// files that import `config.ts` at module scope, which this test does not mock (it tests
// `cost-collector.ts`, a lean standalone Lambda entry that never needs `config.ts`).
import { PATCH_TIMEZONE } from '../ec2-management/tagConventions.js';

// Task 10.2: unit test for the daily cost part of cost-collector.ts.
// Mocks @aws-sdk/client-cost-explorer (GetCostAndUsageCommand shares 1 class for MTD/prevMonth/
// daily — distinguished by `Granularity`/`GroupBy` in the input, flagged via __type on the object
// returned from the mock constructor, following the same pattern as
// savings-plans-collector.test.ts), @aws-sdk/client-s3 (because the handler reads/writes the cost
// cache via GetObjectCommand/PutObjectCommand — used to be SSM Parameter Store but the Standard
// tier only allows up to 4096 bytes/value, so it moved to S3), and @aws-sdk/client-ssm
// (alertHook.ts still reads the alert hook URL from an SSM Parameter, unrelated to the
// cost cache — uses its own separate client/mock).
const ceSendMock = vi.fn();
const s3SendMock = vi.fn();
const ssmSendMock = vi.fn();

vi.mock('@aws-sdk/client-cost-explorer', () => ({
  CostExplorerClient: vi.fn().mockImplementation(() => ({ send: ceSendMock })),
  GetCostAndUsageCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'costAndUsage', input })),
  GetCostForecastCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'forecast', input })),
}));

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({ send: s3SendMock })),
  GetObjectCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'getObject', input })),
  PutObjectCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'putObject', input })),
}));

vi.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: vi.fn().mockImplementation(() => ({ send: ssmSendMock })),
  GetParameterCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'getParameter', input })),
}));

// ALERT_HOOK_URL_PARAM_NAME is read at the MODULE SCOPE of alertHook.ts (same pattern
// as alarm-notifier.ts) — MUST be set BEFORE this module is imported (dynamic import right
// below) for postAlertEmbeds() to get the correct value, not set inside each describe's
// beforeEach (too late by then, the module has already finished loading).
process.env.ALERT_HOOK_URL_PARAM_NAME = '/abc/ops-dashboard/prod/alert-hook-url';

// Import after the mocks are declared (vi.mock is hoisted to the top by vitest).
const { handler } = await import('./cost-collector.js');

/** Fake S3 body — `transformToString()` mimics the real SDK, enough for `readCachedCostData`/the
 * handler to read it back. */
function s3Body(value: string): { transformToString: () => Promise<string> } {
  return { transformToString: () => Promise.resolve(value) };
}

beforeEach(() => {
  ceSendMock.mockReset();
  s3SendMock.mockReset();
  ssmSendMock.mockReset();
  process.env.ASSESSMENT_BUCKET_NAME = 'test-assessment-bucket';
  process.env.AWS_ACCOUNT_ID = '111111111111';
  // alert hook URL (SSM) — defaults to an empty resolve so tests that don't care about the
  // notify don't have to mock it themselves; postAlertEmbeds catches its own errors, doesn't
  // throw even when the webhook is missing.
  ssmSendMock.mockImplementation(() => Promise.reject(new Error('ParameterNotFound')));
});

interface CostAndUsageInput {
  Granularity: 'MONTHLY' | 'DAILY';
  GroupBy?: unknown[];
}

function mockCostExplorerResponses(dailyResultsByTime: unknown[]): void {
  ceSendMock.mockImplementation((command: { __type: string; input?: CostAndUsageInput }) => {
    if (command.__type === 'forecast') {
      return Promise.resolve({ Total: { Amount: '0' } });
    }
    const { Granularity, GroupBy } = command.input as CostAndUsageInput;
    if (Granularity === 'DAILY') {
      return Promise.resolve({ ResultsByTime: dailyResultsByTime });
    }
    if (GroupBy) {
      // MTD/monthly-history grouped by SERVICE — not important for this test, return empty.
      return Promise.resolve({ ResultsByTime: [{ Groups: [] }] });
    }
    // prevMonth (MONTHLY, no grouping)
    return Promise.resolve({ ResultsByTime: [{ Total: { UnblendedCost: { Amount: '0' } } }] });
  });
  // First run in the test: GetObjectCommand (reads the old cache) rejects (object doesn't exist
  // yet) -> treated as no old cache (per readCachedCostData). PutObjectCommand succeeds normally.
  // The default threshold (forecast=0, previousMonth=0) is 'ok' -> no alert hub notify.
  s3SendMock.mockImplementation((command: { __type: string }) => {
    if (command.__type === 'getObject') return Promise.reject(new Error('NoSuchKey'));
    return Promise.resolve({});
  });
}

describe('cost-collector handler — dailyCostUsd', () => {
  it('correctly maps date/amountUsd from ResultsByTime (Granularity DAILY) into dailyCostUsd', async () => {
    mockCostExplorerResponses([
      { TimePeriod: { Start: '2025-01-01' }, Total: { UnblendedCost: { Amount: '12.34' } } },
      { TimePeriod: { Start: '2025-01-02' }, Total: { UnblendedCost: { Amount: '56.78' } } },
      { TimePeriod: { Start: '2025-01-03' }, Total: { UnblendedCost: { Amount: '0' } } },
    ]);

    const result = await handler();

    expect(result).toEqual({ ok: true });

    const putCall = s3SendMock.mock.calls.find((c) => (c[0] as { __type: string }).__type === 'putObject')!;
    const cached = JSON.parse((putCall[0] as { input: { Body: string } }).input.Body);

    expect(cached.dailyCostUsd).toEqual([
      { date: '2025-01-01', amountUsd: 12.34 },
      { date: '2025-01-02', amountUsd: 56.78 },
      { date: '2025-01-03', amountUsd: 0 },
    ]);
  });

  it('returns empty dailyCostUsd when ResultsByTime (DAILY) is empty/undefined, without breaking the job', async () => {
    mockCostExplorerResponses([]);

    const result = await handler();

    expect(result).toEqual({ ok: true });
    const putCall = s3SendMock.mock.calls.find((c) => (c[0] as { __type: string }).__type === 'putObject')!;
    const cached = JSON.parse((putCall[0] as { input: { Body: string } }).input.Body);

    expect(cached.dailyCostUsd).toEqual([]);
  });

  it('uses "" for date when TimePeriod.Start is missing, and "0" for amountUsd when Amount is missing', async () => {
    mockCostExplorerResponses([{ TimePeriod: undefined, Total: undefined }]);

    await handler();

    const putCall = s3SendMock.mock.calls.find((c) => (c[0] as { __type: string }).__type === 'putObject')!;
    const cached = JSON.parse((putCall[0] as { input: { Body: string } }).input.Body);

    expect(cached.dailyCostUsd).toEqual([{ date: '', amountUsd: 0 }]);
  });
});

describe('cost-collector handler — LINKED_ACCOUNT filter (Requirement: abc-prod is a member account in the AWS Organization)', () => {
  it('every GetCostAndUsage/GetCostForecast call has Filter.Dimensions.Key=LINKED_ACCOUNT matching AWS_ACCOUNT_ID', async () => {
    process.env.AWS_ACCOUNT_ID = '111111111111';
    mockCostExplorerResponses([]);

    await handler();

    const costAndUsageCalls = ceSendMock.mock.calls.filter((c) => (c[0] as { __type: string }).__type === 'costAndUsage');
    expect(costAndUsageCalls.length).toBeGreaterThan(0);
    for (const call of costAndUsageCalls) {
      const input = (call[0] as { input: { Filter?: { Dimensions?: { Key?: string; Values?: string[] } } } }).input;
      expect(input.Filter?.Dimensions?.Key).toBe('LINKED_ACCOUNT');
      expect(input.Filter?.Dimensions?.Values).toEqual(['111111111111']);
    }

    const forecastCalls = ceSendMock.mock.calls.filter((c) => (c[0] as { __type: string }).__type === 'forecast');
    expect(forecastCalls.length).toBe(1);
    const forecastInput = (forecastCalls[0][0] as { input: { Filter?: { Dimensions?: { Key?: string; Values?: string[] } } } }).input;
    expect(forecastInput.Filter?.Dimensions?.Key).toBe('LINKED_ACCOUNT');
    expect(forecastInput.Filter?.Dimensions?.Values).toEqual(['111111111111']);
  });

  it('missing AWS_ACCOUNT_ID -> throws immediately, does not call Cost Explorer (fail-fast, avoids silently reporting the wrong account)', async () => {
    delete process.env.AWS_ACCOUNT_ID;
    mockCostExplorerResponses([]);

    await expect(handler()).rejects.toThrow(/AWS_ACCOUNT_ID/);
    expect(ceSendMock).not.toHaveBeenCalled();
  });
});

describe('cost-collector handler — monthlyHistory', () => {
  it('builds monthlyHistory from ResultsByTime (Granularity MONTHLY, GroupBy SERVICE) with the correct MoM delta', async () => {
    ceSendMock.mockImplementation((command: { __type: string; input?: CostAndUsageInput }) => {
      if (command.__type === 'forecast') return Promise.resolve({ Total: { Amount: '0' } });
      const { Granularity, GroupBy } = command.input as CostAndUsageInput;
      if (Granularity === 'DAILY') return Promise.resolve({ ResultsByTime: [] });
      if (GroupBy) {
        // Shares the same response for both MTD and monthly-history (this test doesn't
        // distinguish between the 2 calls, it only needs to confirm buildMonthlyCostSummaries is
        // called correctly with the data Cost Explorer returns).
        return Promise.resolve({
          ResultsByTime: [
            { TimePeriod: { Start: '2026-06-01' }, Groups: [{ Keys: ['Amazon EC2'], Metrics: { UnblendedCost: { Amount: '100' } } }] },
            { TimePeriod: { Start: '2026-07-01' }, Groups: [{ Keys: ['Amazon EC2'], Metrics: { UnblendedCost: { Amount: '150' } } }] },
          ],
        });
      }
      return Promise.resolve({ ResultsByTime: [{ Total: { UnblendedCost: { Amount: '0' } } }] });
    });
    s3SendMock.mockImplementation((command: { __type: string }) => {
      if (command.__type === 'getObject') return Promise.reject(new Error('NoSuchKey'));
      return Promise.resolve({});
    });

    await handler();

    const putCall = s3SendMock.mock.calls.find((c) => (c[0] as { __type: string }).__type === 'putObject')!;
    const cached = JSON.parse((putCall[0] as { input: { Body: string } }).input.Body);

    expect(cached.monthlyHistory).toHaveLength(2);
    expect(cached.monthlyHistory[0]).toMatchObject({ month: '2026-06', totalUsd: 100, deltaUsd: 0, deltaPercent: null });
    expect(cached.monthlyHistory[1]).toMatchObject({ month: '2026-07', totalUsd: 150, deltaUsd: 50, deltaPercent: 50 });
    expect(cached.monthlyHistory[1].topIncreasedServices).toEqual([
      { service: 'Amazon EC2', currentMonthUsd: 150, previousMonthUsd: 100, deltaUsd: 50, deltaPercent: 50 },
    ]);
  });

  it('GetCostAndUsage (MONTHLY history) fails -> monthlyHistory is empty, does not break the whole job', async () => {
    // Distinguishes the MTD call (TimePeriod.Start = start of the current month) from the
    // monthly-history call (a longer time range, different Start) by `input.TimePeriod.Start` —
    // both have GroupBy SERVICE so they can't be distinguished by that field alone like the other
    // tests in this file.
    const now = new Date();
    const currentMonthStart = monthStart(now, PATCH_TIMEZONE);
    ceSendMock.mockImplementation((command: { __type: string; input?: CostAndUsageInput & { TimePeriod?: { Start?: string } } }) => {
      if (command.__type === 'forecast') return Promise.resolve({ Total: { Amount: '0' } });
      const { Granularity, GroupBy, TimePeriod } = command.input as CostAndUsageInput & { TimePeriod?: { Start?: string } };
      if (Granularity === 'DAILY') return Promise.resolve({ ResultsByTime: [] });
      if (GroupBy) {
        if (TimePeriod?.Start === currentMonthStart) return Promise.resolve({ ResultsByTime: [{ Groups: [] }] });
        return Promise.reject(new Error('Throttling'));
      }
      return Promise.resolve({ ResultsByTime: [{ Total: { UnblendedCost: { Amount: '0' } } }] });
    });

    const result = await handler();

    expect(result).toEqual({ ok: true });
    const putCall = s3SendMock.mock.calls.find((c) => (c[0] as { __type: string }).__type === 'putObject')!;
    const cached = JSON.parse((putCall[0] as { input: { Body: string } }).input.Body);
    expect(cached.monthlyHistory).toEqual([]);
  });
});

describe('cost-collector handler — forecastAvailable (does not hide a forecast failure behind a misleading $0.00)', () => {
  it('GetCostForecast succeeds -> forecastAvailable=true', async () => {
    mockCostExplorerResponses([]);

    await handler();

    const putCall = s3SendMock.mock.calls.find((c) => (c[0] as { __type: string }).__type === 'putObject')!;
    const cached = JSON.parse((putCall[0] as { input: { Body: string } }).input.Body);
    expect(cached.forecastAvailable).toBe(true);
  });

  it('GetCostForecast fails (e.g. Throttling) -> forecastAvailable=false, does NOT break the whole job', async () => {
    ceSendMock.mockImplementation((command: { __type: string; input?: CostAndUsageInput }) => {
      if (command.__type === 'forecast') return Promise.reject(new Error('Throttling'));
      const { Granularity, GroupBy } = command.input as CostAndUsageInput;
      if (Granularity === 'DAILY') return Promise.resolve({ ResultsByTime: [] });
      if (GroupBy) return Promise.resolve({ ResultsByTime: [{ Groups: [] }] });
      return Promise.resolve({ ResultsByTime: [{ Total: { UnblendedCost: { Amount: '0' } } }] });
    });
    s3SendMock.mockImplementation((command: { __type: string }) => {
      if (command.__type === 'getObject') return Promise.reject(new Error('NoSuchKey'));
      return Promise.resolve({});
    });

    const result = await handler();

    expect(result).toEqual({ ok: true });
    const putCall = s3SendMock.mock.calls.find((c) => (c[0] as { __type: string }).__type === 'putObject')!;
    const cached = JSON.parse((putCall[0] as { input: { Body: string } }).input.Body);
    expect(cached.forecastAvailable).toBe(false);
  });
});

describe('cost-collector handler — alert hub notify when the threshold gets worse', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    vi.stubGlobal('fetch', fetchMock);
    process.env.ALERT_HOOK_URL_PARAM_NAME = '/abc/ops-dashboard/prod/alert-hook-url';
  });

  function mockCeWithForecast(forecastAmount: string, previousMonthAmount: string): void {
    ceSendMock.mockImplementation((command: { __type: string; input?: CostAndUsageInput }) => {
      if (command.__type === 'forecast') return Promise.resolve({ Total: { Amount: forecastAmount } });
      const { Granularity, GroupBy } = command.input as CostAndUsageInput;
      if (Granularity === 'DAILY') return Promise.resolve({ ResultsByTime: [] });
      if (GroupBy) return Promise.resolve({ ResultsByTime: [{ Groups: [] }] });
      return Promise.resolve({ ResultsByTime: [{ Total: { UnblendedCost: { Amount: previousMonthAmount } } }] });
    });
  }

  it('first run (no old cache), current threshold = ok -> does NOT send alert hub', async () => {
    mockCeWithForecast('0', '100'); // forecast=0+mtd(0)=0, previousMonth=100 -> forecast is much lower -> ok
    s3SendMock.mockImplementation((command: { __type: string }) => {
      if (command.__type === 'getObject') return Promise.reject(new Error('NoSuchKey'));
      return Promise.resolve({});
    });

    await handler();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('first run (no old cache), current threshold = critical -> STILL sends alert hub immediately', async () => {
    mockCeWithForecast('200', '100'); // forecast=200+mtd(0)=200, previousMonth=100 -> 200 >= 100*1.3 -> critical
    // Old cache read from S3 (doesn't exist yet) -> rejects; alert hook URL read from SSM
    // (webhook already configured) -> resolves. 2 different clients (s3SendMock/ssmSendMock) so
    // there's no need to distinguish by Name like when both used SSM before.
    s3SendMock.mockImplementation((command: { __type: string }) => {
      if (command.__type === 'getObject') return Promise.reject(new Error('NoSuchKey'));
      return Promise.resolve({});
    });
    ssmSendMock.mockImplementation(() => Promise.resolve({ Parameter: { Value: 'https://rt.example.test/hooks/alert/test-token' } }));

    await handler();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.severity).toBe('critical');
    expect(body.title).toContain('CRITICAL');
  });

  it('old cache threshold=ok, this run threshold=warn -> sends alert hub (got worse)', async () => {
    mockCeWithForecast('115', '100'); // forecast=115, previousMonth=100 -> 115 >= 100*1.1 -> warn
    s3SendMock.mockImplementation((command: { __type: string }) => {
      if (command.__type === 'getObject') {
        return Promise.resolve({
          Body: s3Body(JSON.stringify({ forecastMonthUsd: 90, previousMonthUsd: 100, monthToDateUsd: 0, byService: [], cachedAt: '', dailyCostUsd: [], monthlyHistory: [] })),
        });
      }
      return Promise.resolve({});
    });

    await handler();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('old cache threshold=critical, this run threshold=warn (improved) -> does NOT send alert hub', async () => {
    mockCeWithForecast('115', '100'); // forecast=115 -> warn
    s3SendMock.mockImplementation((command: { __type: string }) => {
      if (command.__type === 'getObject') {
        return Promise.resolve({
          Body: s3Body(JSON.stringify({ forecastMonthUsd: 200, previousMonthUsd: 100, monthToDateUsd: 0, byService: [], cachedAt: '', dailyCostUsd: [], monthlyHistory: [] })),
        });
      }
      return Promise.resolve({});
    });

    await handler();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('old cache and this run at the SAME warn level (unchanged) -> does NOT send alert hub', async () => {
    mockCeWithForecast('115', '100'); // forecast=115 -> warn
    s3SendMock.mockImplementation((command: { __type: string }) => {
      if (command.__type === 'getObject') {
        return Promise.resolve({
          Body: s3Body(JSON.stringify({ forecastMonthUsd: 112, previousMonthUsd: 100, monthToDateUsd: 0, byService: [], cachedAt: '', dailyCostUsd: [], monthlyHistory: [] })),
        });
      }
      return Promise.resolve({});
    });

    await handler();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('the embed explains the +10%/+30% standard being applied (the "how")', async () => {
    mockCeWithForecast('200', '100'); // -> critical
    ssmSendMock.mockImplementation(() => Promise.resolve({ Parameter: { Value: 'https://rt.example.test/hooks/alert/test-token' } }));
    s3SendMock.mockImplementation((command: { __type: string }) => {
      if (command.__type === 'getObject') return Promise.reject(new Error('NoSuchKey'));
      return Promise.resolve({});
    });

    await handler();

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const howBlock = (body.text as string).split('\n\n').find((b) => b.startsWith('**🛠️ Next steps**'));
    expect(howBlock).toContain('10%');
    expect(howBlock).toContain('30%');
  });

  it('includes a "Biggest cost increases" field listing services whose cost grew since the last cache', async () => {
    ceSendMock.mockImplementation((command: { __type: string; input?: CostAndUsageInput }) => {
      if (command.__type === 'forecast') return Promise.resolve({ Total: { Amount: '200' } });
      const { Granularity, GroupBy } = command.input as CostAndUsageInput;
      if (Granularity === 'DAILY') return Promise.resolve({ ResultsByTime: [] });
      if (GroupBy) {
        return Promise.resolve({
          ResultsByTime: [{ Groups: [{ Keys: ['Amazon EC2'], Metrics: { UnblendedCost: { Amount: '150' } } }] }],
        });
      }
      return Promise.resolve({ ResultsByTime: [{ Total: { UnblendedCost: { Amount: '100' } } }] });
    });
    ssmSendMock.mockImplementation(() => Promise.resolve({ Parameter: { Value: 'https://rt.example.test/hooks/alert/test-token' } }));
    s3SendMock.mockImplementation((command: { __type: string }) => {
      if (command.__type === 'getObject') {
        return Promise.resolve({
          Body: s3Body(
            JSON.stringify({
              forecastMonthUsd: 90,
              previousMonthUsd: 100,
              monthToDateUsd: 0,
              byService: [{ service: 'Amazon EC2', amountUsd: 50 }],
              cachedAt: '',
              dailyCostUsd: [],
              monthlyHistory: [],
            }),
          ),
        });
      }
      return Promise.resolve({});
    });

    await handler();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const moversBlock = (body.text as string).split('\n\n').find((b) => b.startsWith('**Biggest cost increases'));
    expect(moversBlock).toBeDefined();
    expect(moversBlock).toContain('Amazon EC2');
  });
});
