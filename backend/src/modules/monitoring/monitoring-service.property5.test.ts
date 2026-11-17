import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';
import type { MonitoringResourceType } from '@ops-dashboard/shared';

// monitoring-service.ts (Task 3.10) imports `threshold-history-service.ts`, which throws at module
// scope if ASSESSMENT_BUCKET_NAME is missing — set before import even though this test never calls
// recordIfChanged/getHistory.
process.env.ASSESSMENT_BUCKET_NAME = 'test-assessment-bucket';

// `monitoring-service.ts` imports `loadAlb` from `infra-service.ts`, which imports `config.ts`
// (module singleton that throws if any required env var, e.g. ENTRA_TENANT_ID, is missing) at
// module scope. This test never calls `loadAlb`/AWS APIs — mock `config.js` so the import chain
// resolves, following the exact pattern used in `monitoring-service.property2.test.ts`.
vi.mock('../../config.js', () => ({
  config: {
    allowedOrigins: [],
    entraTenantId: 'test-tenant',
    entraClientId: 'test-client',
    allowedGroupIds: [],
    awsRegion: 'ap-southeast-1',
    costCacheParamName: 'test-cost-cache-param',
    assessmentBucketName: 'test-assessment-bucket',
  },
  corsHeaders: () => ({}),
}));

const { evalMonitoringThreshold } = await import('./monitoring-service.js');

/**
 * Measured-only set per the design's Data Models "Metric & threshold definitions" table, mirrored
 * by `evalMonitoringThreshold`'s `default: return undefined;` case: EC2 NetworkIn/NetworkOut, EBS
 * Read/WriteOps/Bytes/ThroughputPercentage, RDS DatabaseConnections/IOPS/Throughput/DiskQueueDepth/
 * NetworkThroughput.
 */
const MEASURED_ONLY_METRICS: Array<{ resourceType: MonitoringResourceType; metricName: string }> = [
  { resourceType: 'ec2', metricName: 'NetworkIn' },
  { resourceType: 'ec2', metricName: 'NetworkOut' },
  { resourceType: 'ebs', metricName: 'VolumeReadOps' },
  { resourceType: 'ebs', metricName: 'VolumeWriteOps' },
  { resourceType: 'ebs', metricName: 'VolumeReadBytes' },
  { resourceType: 'ebs', metricName: 'VolumeWriteBytes' },
  { resourceType: 'ebs', metricName: 'VolumeThroughputPercentage' },
  { resourceType: 'rds', metricName: 'DatabaseConnections' },
  { resourceType: 'rds', metricName: 'ReadIOPS' },
  { resourceType: 'rds', metricName: 'WriteIOPS' },
  { resourceType: 'rds', metricName: 'ReadThroughput' },
  { resourceType: 'rds', metricName: 'WriteThroughput' },
  { resourceType: 'rds', metricName: 'DiskQueueDepth' },
  { resourceType: 'rds', metricName: 'NetworkReceiveThroughput' },
  { resourceType: 'rds', metricName: 'NetworkTransmitThroughput' },
];

/** Arbitrary numeric value covering edge cases (0, negative, very large) plus general doubles,
 * per the task's request — measured-only metrics must yield `undefined` regardless of magnitude. */
const measuredValueArb = fc.oneof(
  fc.constant(0),
  fc.constant(-0),
  fc.double({ min: -1e12, max: 1e12, noNaN: true }),
  fc.integer(),
  fc.constant(Number.MAX_SAFE_INTEGER),
  fc.constant(-Number.MAX_SAFE_INTEGER),
);

// Feature: realtime-monitoring-dashboard, Property 5: Measured-only metrics never receive a Threshold_Level
// Validates: Requirements 1.5, 3.4, 4.7
describe('Property 5: Measured-only metrics never receive a Threshold_Level', () => {
  it('evalMonitoringThreshold returns undefined for every measured-only metric, for any value', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...MEASURED_ONLY_METRICS),
        measuredValueArb,
        ({ resourceType, metricName }, value) => {
          const result = evalMonitoringThreshold(resourceType, metricName, value);
          expect(result).toBeUndefined();
        },
      ),
      { numRuns: 100 },
    );
  });
});
