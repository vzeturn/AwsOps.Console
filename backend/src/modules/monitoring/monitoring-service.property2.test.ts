import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';
import type {
  OnlineResources,
  OnlineEc2Instance,
  OnlineEbsVolume,
  OnlineRdsInstance,
  AlbTargetsSummary,
  OnlineEcsService,
} from './monitoring-service.js';

// monitoring-service.ts (Task 3.10) imports `threshold-history-service.ts`, which throws at module
// scope if ASSESSMENT_BUCKET_NAME is missing — set before import even though this test never calls
// recordIfChanged/getHistory.
process.env.ASSESSMENT_BUCKET_NAME = 'test-assessment-bucket';

// `monitoring-service.ts` imports `loadAlb` from `infra-service.ts`, which imports `config.ts`
// (module singleton that throws if any required env var, e.g. ENTRA_TENANT_ID, is missing) at
// module scope. This test never calls `loadAlb`/AWS APIs — mock `config.js` so the import chain
// resolves, following the exact pattern used in `router.test.ts`.
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

const { buildMetricQueries, METRIC_DEFINITIONS, ebsMetricDefinitionsFor, isIoOptimizedVolumeType, ecsResourceId } =
  await import('./monitoring-service.js');

const EBS_VOLUME_TYPES = ['io1', 'io2', 'gp3', 'gp2', 'st1', 'sc1', 'standard'];

const EC2_METRIC_NAMES = METRIC_DEFINITIONS.ec2.map((m) => m.name);
const RDS_METRIC_NAMES = METRIC_DEFINITIONS.rds.map((m) => m.name);
const ALB_METRIC_NAMES = METRIC_DEFINITIONS.alb.map((m) => m.name);
const ECS_METRIC_NAMES = METRIC_DEFINITIONS.ecs.map((m) => m.name);

/** Generates `OnlineResources` with a unique id per type prefix (avoiding id collisions between
 * different resource kinds, so grouping queries by resourceId doesn't get mixed up), and each EBS
 * volume's `volumeType` is chosen randomly from a set including both `io1`/`io2` and other types
 * (gp3/gp2/st1/sc1/standard). */
const onlineResourcesArb: fc.Arbitrary<OnlineResources> = fc
  .record({
    ec2Count: fc.integer({ min: 0, max: 6 }),
    rdsCount: fc.integer({ min: 0, max: 3 }),
    albCount: fc.integer({ min: 0, max: 3 }),
    ecsCount: fc.integer({ min: 0, max: 4 }),
    ebsVolumeTypes: fc.array(fc.constantFrom(...EBS_VOLUME_TYPES), { minLength: 0, maxLength: 8 }),
  })
  .map(({ ec2Count, rdsCount, albCount, ecsCount, ebsVolumeTypes }) => {
    const ec2: OnlineEc2Instance[] = Array.from({ length: ec2Count }, (_, i) => ({
      instanceId: `i_${i}`,
      name: `ec2-${i}`,
      region: 'ap-southeast-1',
      instanceType: 't3.micro',
    }));

    const ebs: OnlineEbsVolume[] = ebsVolumeTypes.map((volumeType, i) => ({
      volumeId: `vol_${i}`,
      region: 'ap-southeast-1',
      volumeType,
      sizeGb: 8,
      instanceId: ec2[i % Math.max(ec2Count, 1)]?.instanceId ?? 'i_0',
    }));

    const rds: OnlineRdsInstance[] = Array.from({ length: rdsCount }, (_, i) => ({
      dbInstanceIdentifier: `db_${i}`,
      region: 'ap-southeast-1',
      dbInstanceClass: 'db.m8i.large',
      engine: 'sqlserver-se',
    }));

    const alb: AlbTargetsSummary[] = Array.from({ length: albCount }, (_, i) => ({
      name: `alb_${i}`,
      region: 'ap-southeast-1',
      unhealthyTargets: 0,
      totalTargets: 1,
      arnSuffix: `app/alb_${i}/0123456789abcdef`,
      targetGroups: [],
      tags: {},
    }));

    const ecs: OnlineEcsService[] = Array.from({ length: ecsCount }, (_, i) => ({
      serviceName: `svc_${i}`,
      clusterName: `cluster_${i}`,
      region: 'ap-southeast-1',
    }));

    return { ec2, ebs, rds, alb, ecs };
  });

/** Gets the set of metric names `buildMetricQueries` actually produces for a specific resourceId,
 * based on the dimension value in `MetricStat.Metric.Dimensions[0].Value` (not parsing `Id`). */
function metricNamesFor(queries: ReturnType<typeof buildMetricQueries>, resourceId: string): string[] {
  return queries
    .filter((q) => q.MetricStat?.Metric?.Dimensions?.[0]?.Value === resourceId)
    .map((q) => q.MetricStat!.Metric!.MetricName!);
}

// Feature: realtime-monitoring-dashboard, Property 2: Per-resource-kind metric set completeness
// Validates: Requirements 1.1, 3.1, 3.2, 4.1, 5.1
describe('Property 2: Per-resource-kind metric set completeness', () => {
  it('metric-name set produced for each Online_Resource exactly equals the fixed set for its kind', () => {
    fc.assert(
      fc.property(onlineResourcesArb, (resources) => {
        const queries = buildMetricQueries(resources);

        // EC2: always exactly 4 base metrics, no more, no less.
        for (const instance of resources.ec2) {
          const names = metricNamesFor(queries, instance.instanceId);
          expect(names).toHaveLength(4);
          expect(new Set(names)).toEqual(new Set(EC2_METRIC_NAMES));
        }

        // RDS: always exactly 14 metrics.
        for (const db of resources.rds) {
          const names = metricNamesFor(queries, db.dbInstanceIdentifier);
          expect(names).toHaveLength(14);
          expect(new Set(names)).toEqual(new Set(RDS_METRIC_NAMES));
        }

        // ALB: always exactly 2 metrics — filtered by `arnSuffix` (the dimension value CloudWatch
        // ACTUALLY uses, NOT `name` — see the `extractAlbArnSuffix`/`buildMetricDataQuery` bug fix).
        for (const alb of resources.alb) {
          const names = metricNamesFor(queries, alb.arnSuffix!);
          expect(names).toHaveLength(2);
          expect(new Set(names)).toEqual(new Set(ALB_METRIC_NAMES));
        }

        // EBS: 5 base metrics, +1 (VolumeThroughputPercentage) ONLY for io1/io2.
        for (const volume of resources.ebs) {
          const names = metricNamesFor(queries, volume.volumeId);
          const expectedNames = ebsMetricDefinitionsFor(volume.volumeType).map((m) => m.name);
          const expectedCount = isIoOptimizedVolumeType(volume.volumeType) ? 6 : 5;

          expect(names).toHaveLength(expectedCount);
          expect(new Set(names)).toEqual(new Set(expectedNames));
          expect(names.includes('VolumeThroughputPercentage')).toBe(
            isIoOptimizedVolumeType(volume.volumeType),
          );
        }

        // ECS: always exactly 2 metrics, AND each query must carry BOTH dimensions
        // (ClusterName+ServiceName) — unlike every other resource kind (only 1 dimension).
        for (const service of resources.ecs) {
          const resourceId = ecsResourceId(service.clusterName, service.serviceName);
          const ecsQueries = queries.filter(
            (q) =>
              q.MetricStat?.Metric?.Dimensions?.some((d) => d.Name === 'ServiceName' && d.Value === service.serviceName) &&
              q.MetricStat?.Metric?.Dimensions?.some((d) => d.Name === 'ClusterName' && d.Value === service.clusterName),
          );
          const names = ecsQueries.map((q) => q.MetricStat!.Metric!.MetricName!);

          expect(names).toHaveLength(2);
          expect(new Set(names)).toEqual(new Set(ECS_METRIC_NAMES));
          for (const q of ecsQueries) {
            expect(q.MetricStat?.Metric?.Dimensions).toHaveLength(2);
            expect(q.Id).toContain(resourceId.replace(/[^a-zA-Z0-9_]/g, '_'));
          }
        }
      }),
      { numRuns: 100 },
    );
  });
});
