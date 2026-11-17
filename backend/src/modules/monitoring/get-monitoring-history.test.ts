import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LambdaFunctionURLEvent } from 'aws-lambda';
import type { ThresholdHistoryEntry } from '@ops-dashboard/shared';
import { HttpError } from '../../shared-kernel/errors.js';

// Task 7.3: unit test for get-monitoring-history.ts (required-parameter validation + dispatch to
// threshold-history-service.js). router.test.ts (Task 7.3) only verifies the router calls this
// handler correctly — the 400-on-missing-parameter logic is this handler's own responsibility
// (not router.ts), so it's tested here, the same way assessment-service.ts's S3-read logic is
// tested separately in assessment-service.test.ts instead of router.test.ts.
//
// Mocks config.js to avoid readRequiredEnv throwing (lib/response.ts -> config.js reads corsHeaders/allowedOrigins).
vi.mock('../../config.js', () => ({
  config: { allowedOrigins: [] },
  corsHeaders: () => ({}),
}));

// Mocks threshold-history-service.js to avoid a module-scope throw (missing env
// ASSESSMENT_BUCKET_NAME) and to directly control what getHistory() returns.
const getHistoryMock = vi.fn();
vi.mock('./threshold-history-service.js', () => ({
  getHistory: getHistoryMock,
}));

const { handler } = await import('./get-monitoring-history.js');

function buildEvent(queryStringParameters: Record<string, string> | undefined): LambdaFunctionURLEvent {
  return {
    headers: {},
    rawPath: '/monitoring/history',
    queryStringParameters,
    requestContext: { http: { method: 'GET' } },
  } as unknown as LambdaFunctionURLEvent;
}

beforeEach(() => {
  getHistoryMock.mockReset();
});

describe('get-monitoring-history handler', () => {
  it('valid resourceType/resourceId/metric → calls getHistory with the correct parameters, returns 200 with that result', async () => {
    const entries: ThresholdHistoryEntry[] = [
      { metric: 'CPUUtilization', timestamp: '2024-01-01T00:00:00.000Z', oldValue: 10, newValue: 90, oldLevel: 'ok', newLevel: 'critical' },
    ];
    getHistoryMock.mockResolvedValue(entries);

    const event = buildEvent({ resourceType: 'ec2', resourceId: 'i-abc123', metric: 'CPUUtilization' });
    const result = await handler(event);

    expect(getHistoryMock).toHaveBeenCalledTimes(1);
    expect(getHistoryMock).toHaveBeenCalledWith('ec2', 'i-abc123', 'CPUUtilization');
    // LambdaFunctionURLResult (= APIGatewayProxyResultV2) allows body to be a raw string, but
    // get-monitoring-history.ts always returns an { statusCode, headers, body } object via
    // lib/response.ts — cast explicitly to access statusCode/body (same pattern as router.test.ts).
    const typedResult = result as { statusCode: number; body: string };
    expect(typedResult.statusCode).toBe(200);
    expect(JSON.parse(typedResult.body)).toEqual(entries);
  });

  it.each([
    ['missing resourceType', { resourceId: 'i-abc123', metric: 'CPUUtilization' }],
    ['missing resourceId', { resourceType: 'ec2', metric: 'CPUUtilization' }],
    ['missing metric', { resourceType: 'ec2', resourceId: 'i-abc123' }],
    ['no query string at all', undefined],
  ])('%s → throws HttpError 400 (badRequest), does not call getHistory', async (_label, params) => {
    const event = buildEvent(params as Record<string, string> | undefined);

    await expect(handler(event)).rejects.toThrow(HttpError);
    await expect(handler(event)).rejects.toMatchObject({ statusCode: 400 });
    expect(getHistoryMock).not.toHaveBeenCalled();
  });

  it('invalid resourceType (outside ec2/rds/alb/ebs) → throws HttpError 400, does not call getHistory', async () => {
    const event = buildEvent({ resourceType: 'unknown-type', resourceId: 'i-abc123', metric: 'CPUUtilization' });

    await expect(handler(event)).rejects.toMatchObject({ statusCode: 400 });
    expect(getHistoryMock).not.toHaveBeenCalled();
  });
});
