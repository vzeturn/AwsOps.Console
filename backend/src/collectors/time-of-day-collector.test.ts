// backend/src/collectors/time-of-day-collector.test.ts
import { describe, it, expect, vi } from 'vitest';
import { collectHourlyMetrics } from './time-of-day-collector.js';

function fakeClients(datapoints: { Timestamp: Date; Value: number }[]) {
  const send = vi.fn().mockResolvedValue({
    MetricDataResults: [{ Id: 'cpu', Timestamps: datapoints.map((d) => d.Timestamp), Values: datapoints.map((d) => d.Value) }],
  });
  return { send } as unknown as import('@aws-sdk/client-cloudwatch').CloudWatchClient;
}

describe('collectHourlyMetrics', () => {
  it('groups datapoints by (dayOfWeek, hour) in PATCH_TIMEZONE, computes p75CpuPercent', async () => {
    // 2026-08-24 is a Monday (dayOfWeek=1 in Asia/Ho_Chi_Minh, UTC+7) - 3 datapoints at 8am UTC+7 (01:00 UTC).
    const cloudwatch = fakeClients([
      { Timestamp: new Date('2026-08-24T01:00:00Z'), Value: 40 },
      { Timestamp: new Date('2026-08-17T01:00:00Z'), Value: 60 },
      { Timestamp: new Date('2026-08-10T01:00:00Z'), Value: 80 },
    ]);
    const result = await collectHourlyMetrics(cloudwatch, 'i-1', new Date('2026-08-27T00:00:00Z'));
    const point = result.find((p) => p.dayOfWeek === 1 && p.hour === 8);
    expect(point).toBeDefined();
    expect(point?.p75CpuPercent).toBeGreaterThanOrEqual(60);
  });

  it('CloudWatch error -> returns empty, does not throw (fail-safe, following the loadInstanceMetrics pattern)', async () => {
    const cloudwatch = { send: vi.fn().mockRejectedValue(new Error('Throttling')) } as unknown as import('@aws-sdk/client-cloudwatch').CloudWatchClient;
    const result = await collectHourlyMetrics(cloudwatch, 'i-1', new Date('2026-08-27T00:00:00Z'));
    expect(result).toEqual([]);
  });

  it('no datapoints at all -> returns empty', async () => {
    const cloudwatch = fakeClients([]);
    const result = await collectHourlyMetrics(cloudwatch, 'i-1', new Date('2026-08-27T00:00:00Z'));
    expect(result).toEqual([]);
  });
});
