import { describe, it, expect, vi, beforeEach } from 'vitest';

// `../ec2-management/index.js` re-exports `actions-ec2-management.ts` (the router-facing handler
// for a DIFFERENT route), which imports `../../config.js` — the fail-loud `AppConfig` singleton
// that reads `ENTRA_TENANT_ID`/etc. at module scope. Because an ES module barrel evaluates every one
// of its own exports' source files when any single symbol is imported from it, importing this
// module's helpers below transitively loads `config.ts` too. `get-monitoring.ts` itself runs inside
// `router.ts` in production (already granted the full `AppConfig` env var set), so the barrel import
// is safe there — but this test imports the module standalone, so `config.js` must be mocked first,
// same pattern as `get-compliance.test.ts`/`get-infra.test.ts`.
vi.mock('../../config.js', () => ({
  config: { allowedOrigins: [], awsRegion: 'ap-southeast-1', assessmentBucketName: 'test-assessment-bucket' },
  corsHeaders: () => ({}),
}));

const { isSnapshotFresh, MONITORING_CACHE_TTL_MS, MONITORING_CACHE_S3_KEY } = await import('../ec2-management/index.js');

const readCachedJsonMock = vi.fn();
const writeCachedJsonMock = vi.fn();
const buildMonitoringSnapshotMock = vi.fn();

vi.mock('../../shared-kernel/s3Cache.js', () => ({
  readCachedJson: (key: string) => readCachedJsonMock(key),
  writeCachedJson: (key: string, data: unknown) => writeCachedJsonMock(key, data),
}));
vi.mock('./monitoring-snapshot.js', () => ({
  buildMonitoringSnapshot: () => buildMonitoringSnapshotMock(),
}));
vi.mock('../../shared-kernel/response.js', () => ({
  ok: (_event: unknown, body: unknown) => ({ statusCode: 200, body }),
}));

const { handler } = await import('./get-monitoring.js');

const EVENT = {} as never;

function snapshot(generatedAt: string, marker = 'x') {
  return { resources: [], alerts: [], generatedAt, marker };
}

beforeEach(() => {
  readCachedJsonMock.mockReset();
  writeCachedJsonMock.mockReset();
  buildMonitoringSnapshotMock.mockReset();
  writeCachedJsonMock.mockResolvedValue(undefined);
});

/**
 * These tests exist because this route is the only one whose caching decision has a direct, unbounded
 * COST consequence: a cache miss calls the billed CloudWatch `GetMetricData` API. "Did it serve from
 * cache?" is therefore a correctness property here, not a performance detail.
 */
describe('GET /monitoring — lazy write-through cache', () => {
  it('serves a fresh cached snapshot WITHOUT calling CloudWatch', async () => {
    const cached = snapshot(new Date().toISOString(), 'from-cache');
    readCachedJsonMock.mockResolvedValue(cached);

    const res = (await handler(EVENT)) as unknown as { body: unknown };

    expect(res.body).toBe(cached);
    expect(buildMonitoringSnapshotMock).not.toHaveBeenCalled();
    expect(writeCachedJsonMock).not.toHaveBeenCalled();
  });

  it('rebuilds and caches when the snapshot is older than the TTL', async () => {
    readCachedJsonMock.mockResolvedValue(
      snapshot(new Date(Date.now() - MONITORING_CACHE_TTL_MS - 1000).toISOString(), 'stale'),
    );
    const fresh = snapshot(new Date().toISOString(), 'rebuilt');
    buildMonitoringSnapshotMock.mockResolvedValue(fresh);

    const res = (await handler(EVENT)) as unknown as { body: unknown };

    expect(res.body).toBe(fresh);
    expect(buildMonitoringSnapshotMock).toHaveBeenCalledTimes(1);
    expect(writeCachedJsonMock).toHaveBeenCalledWith(MONITORING_CACHE_S3_KEY, fresh);
  });

  it('rebuilds when there is no cache at all (first ever request)', async () => {
    readCachedJsonMock.mockResolvedValue(undefined);
    const fresh = snapshot(new Date().toISOString());
    buildMonitoringSnapshotMock.mockResolvedValue(fresh);

    await handler(EVENT);

    expect(buildMonitoringSnapshotMock).toHaveBeenCalledTimes(1);
    expect(writeCachedJsonMock).toHaveBeenCalledTimes(1);
  });

  /**
   * A failed cache write must not turn an already-successful response into an error. The handler
   * relies on `writeCachedJson` swallowing its own failures (verified in `s3Cache.test.ts`) rather
   * than wrapping the call itself — so this asserts the handler does not ADD any failure path of its
   * own on top of that contract.
   */
  it('returns the snapshot even though the cache write resolved without confirming success', async () => {
    readCachedJsonMock.mockResolvedValue(undefined);
    const fresh = snapshot(new Date().toISOString(), 'rebuilt');
    buildMonitoringSnapshotMock.mockResolvedValue(fresh);
    writeCachedJsonMock.mockResolvedValue(undefined); // what the real never-throwing writer does

    const res = (await handler(EVENT)) as unknown as { body: unknown };

    expect(res.body).toBe(fresh);
  });
});

describe('isSnapshotFresh', () => {
  const now = new Date('2026-09-04T12:00:00.000Z').getTime();
  const ttl = 4 * 60 * 1000;

  it('accepts a snapshot inside the window', () => {
    expect(isSnapshotFresh(new Date(now - 60_000).toISOString(), ttl, now)).toBe(true);
  });

  it('rejects one exactly at and past the window', () => {
    expect(isSnapshotFresh(new Date(now - ttl).toISOString(), ttl, now)).toBe(false);
    expect(isSnapshotFresh(new Date(now - ttl - 1).toISOString(), ttl, now)).toBe(false);
  });

  it('rejects missing or unparseable timestamps rather than serving them', () => {
    expect(isSnapshotFresh(undefined, ttl, now)).toBe(false);
    expect(isSnapshotFresh('', ttl, now)).toBe(false);
    expect(isSnapshotFresh('not-a-date', ttl, now)).toBe(false);
  });

  /**
   * A future timestamp (clock skew, or a hand-edited object) would otherwise compute a negative age
   * and look permanently fresh — freezing the dashboard on data that never refreshes again.
   */
  it('rejects a timestamp in the future instead of pinning the cache forever', () => {
    expect(isSnapshotFresh(new Date(now + 60_000).toISOString(), ttl, now)).toBe(false);
  });
});

describe('MONITORING_CACHE_TTL_MS', () => {
  /**
   * The TTL is the cost ceiling for this route. If someone lowers it, the worst-case bill rises
   * proportionally, so pin the reasoning: it must not drop below the 5-minute publishing interval of
   * EC2 basic monitoring by more than a small margin, because a shorter TTL cannot surface datapoints
   * CloudWatch has not published yet.
   */
  it('stays in the range where a rebuild can actually yield new datapoints', () => {
    expect(MONITORING_CACHE_TTL_MS).toBeGreaterThanOrEqual(60_000);
    expect(MONITORING_CACHE_TTL_MS).toBeLessThanOrEqual(5 * 60_000);
  });

  it('keeps the worst-case GetMetricData spend under $0.50/day at ~82 metrics per rebuild', () => {
    const rebuildsPerDay = (24 * 60 * 60 * 1000) / MONITORING_CACHE_TTL_MS;
    const usdPerDay = rebuildsPerDay * 82 * 0.00001;
    expect(usdPerDay).toBeLessThan(0.5);
  });
});
