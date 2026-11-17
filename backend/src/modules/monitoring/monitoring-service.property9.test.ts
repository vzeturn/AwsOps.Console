import { describe, it, expect, vi, beforeEach } from 'vitest';
import fc from 'fast-check';

// Feature: realtime-monitoring-dashboard, Property 9: Resource identity completeness
//
// For any MonitoringResource produced by the service, resourceId and region SHALL be non-empty
// strings, regardless of resource kind.
//
// Validates: Requirements 12.1

// Task 3.5: property test for `getMonitoringData()` (Task 3.10, fully implemented) in
// monitoring-service.ts. Set env vars before importing — same pattern as
// property1.test.ts/property2.test.ts: `monitoring-service.ts` reads `AWS_REGION` directly from
// process.env, and statically imports `threshold-history-service.ts`, which throws at module scope
// if `ASSESSMENT_BUCKET_NAME` is missing.
process.env.AWS_REGION = 'ap-southeast-1';
process.env.ASSESSMENT_BUCKET_NAME = 'test-assessment-bucket';

// `monitoring-service.ts` statically imports `loadAlb` from infra-service.ts, which imports
// `config.ts` (a singleton that throws if a required env var is missing) at module scope — mock it
// following the same pattern used in property1.test.ts/property2.test.ts so the import doesn't throw.
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

const ec2SendMock = vi.fn();
const rdsSendMock = vi.fn();
const elbSendMock = vi.fn();
const ecsSendMock = vi.fn();
const cwSendMock = vi.fn();
const s3SendMock = vi.fn();

vi.mock('@aws-sdk/client-ec2', () => ({
  EC2Client: vi.fn().mockImplementation(() => ({ send: ec2SendMock })),
  DescribeInstancesCommand: vi
    .fn()
    .mockImplementation((input: unknown) => ({ __type: 'DescribeInstances', input })),
  DescribeVolumesCommand: vi
    .fn()
    .mockImplementation((input: unknown) => ({ __type: 'DescribeVolumes', input })),
}));

vi.mock('@aws-sdk/client-rds', () => ({
  RDSClient: vi.fn().mockImplementation(() => ({ send: rdsSendMock })),
  DescribeDBInstancesCommand: vi
    .fn()
    .mockImplementation((input: unknown) => ({ __type: 'DescribeDBInstances', input })),
}));

vi.mock('@aws-sdk/client-elastic-load-balancing-v2', () => ({
  ElasticLoadBalancingV2Client: vi.fn().mockImplementation(() => ({ send: elbSendMock })),
  DescribeLoadBalancersCommand: vi
    .fn()
    .mockImplementation((input: unknown) => ({ __type: 'DescribeLoadBalancers', input })),
  DescribeTargetGroupsCommand: vi
    .fn()
    .mockImplementation((input: unknown) => ({ __type: 'DescribeTargetGroups', input })),
  DescribeTargetHealthCommand: vi
    .fn()
    .mockImplementation((input: unknown) => ({ __type: 'DescribeTargetHealth', input })),
  DescribeTagsCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'DescribeTags', input })),
}));

// Adds an ECS mock — without it, `loadOnlineEcsServices()` would call real AWS directly if valid
// credentials happen to be present in the test-running environment, making the property test
// nondeterministic (real ECS resource counts from the account would leak into the
// `monitoring.resources` result, breaking the `toHaveLength` assertion). This property's scenario
// never generates any ECS service (Scenario has no `ecs` field) -> always returns empty, preserving
// the invariant "only generate the exact resource count per the mocked EC2/EBS/RDS/ALB scenario".
vi.mock('@aws-sdk/client-ecs', () => ({
  ECSClient: vi.fn().mockImplementation(() => ({ send: ecsSendMock })),
  ListClustersCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'ListClusters', input })),
  ListServicesCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'ListServices', input })),
  DescribeServicesCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'DescribeServices', input })),
}));

vi.mock('@aws-sdk/client-cloudwatch', () => ({
  CloudWatchClient: vi.fn().mockImplementation(() => ({ send: cwSendMock })),
  ListMetricsCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'ListMetrics', input })),
  GetMetricDataCommand: vi
    .fn()
    .mockImplementation((input: unknown) => ({ __type: 'GetMetricData', input })),
}));

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({ send: s3SendMock })),
  GetObjectCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'GetObject', input })),
  PutObjectCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'PutObject', input })),
}));

// Import after the mocks are declared (vi.mock is hoisted to the top by vitest).
const { getMonitoringData } = await import('./monitoring-service.js');

beforeEach(() => {
  ec2SendMock.mockReset();
  rdsSendMock.mockReset();
  elbSendMock.mockReset();
  ecsSendMock.mockReset();
  cwSendMock.mockReset();
  s3SendMock.mockReset();
});

// ---- Arbitraries ----

interface Scenario {
  ec2Ids: string[];
  ebsVolumeIds: string[]; // each volume attaches to ec2Ids[i % ec2Ids.length]
  rdsIds: string[];
  rdsClasses: string[]; // indexed by rdsIds — deliberately mixes known/unknown classes in RDS_INSTANCE_RAM_GIB
  albNames: string[];
}

// minLength 1 + trim filter: a "meaningful" id resembling a real AWS resource id (not an
// all-whitespace string) — the property still asserts .length > 0 on the untrimmed value itself.
const idArb = fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0);

const scenarioArb: fc.Arbitrary<Scenario> = fc
  .record({
    ec2Ids: fc.array(idArb, { minLength: 0, maxLength: 3 }),
    ebsCount: fc.integer({ min: 0, max: 3 }),
    rdsIds: fc.array(idArb, { minLength: 0, maxLength: 2 }),
    rdsClasses: fc.array(fc.constantFrom('db.m8i.large', 'db.unknown-class'), { minLength: 0, maxLength: 2 }),
    albNames: fc.array(idArb, { minLength: 0, maxLength: 2 }),
  })
  .map(({ ec2Ids, ebsCount, rdsIds, rdsClasses, albNames }) => ({
    ec2Ids,
    // An EBS_Volume is only an Online_Resource when attached to a running EC2 instance — if there
    // are no EC2 instances, generate no volumes at all (keeps the scenario valid, avoiding having
    // to handle "orphaned" volumes here — a different property, Property 1, already covers that case).
    ebsVolumeIds: ec2Ids.length > 0 ? Array.from({ length: ebsCount }, (_, i) => `vol-${i}`) : [],
    rdsIds,
    rdsClasses,
    albNames,
  }));

function setupMocks(scenario: Scenario): void {
  ec2SendMock.mockImplementation(async (command: { __type?: string }) => {
    if (command.__type === 'DescribeVolumes') {
      return {
        Volumes: scenario.ebsVolumeIds.map((volumeId, i) => ({
          VolumeId: volumeId,
          VolumeType: 'gp3',
          Size: 100,
          Attachments: [{ State: 'attached', InstanceId: scenario.ec2Ids[i % scenario.ec2Ids.length] }],
        })),
      };
    }
    return {
      Reservations: scenario.ec2Ids.map((instanceId) => ({
        Instances: [
          {
            InstanceId: instanceId,
            InstanceType: 't3.micro',
            State: { Name: 'running' },
            Tags: [{ Key: 'Name', Value: `name-${instanceId}` }],
          },
        ],
      })),
    };
  });

  rdsSendMock.mockImplementation(async () => ({
    DBInstances: scenario.rdsIds.map((dbInstanceIdentifier, i) => ({
      DBInstanceIdentifier: dbInstanceIdentifier,
      DBInstanceStatus: 'available',
      DBInstanceClass: scenario.rdsClasses[i] ?? 'db.m8i.large',
      Engine: 'sqlserver-se',
      AllocatedStorage: 100,
    })),
  }));

  elbSendMock.mockImplementation(async (command: { __type?: string }) => {
    if (command.__type === 'DescribeLoadBalancers') {
      return {
        LoadBalancers: scenario.albNames.map((name) => ({
          LoadBalancerName: name,
          LoadBalancerArn: `arn:aws:elasticloadbalancing:ap-southeast-1:123456789012:loadbalancer/app/${name}/abc`,
          State: { Code: 'active' },
        })),
      };
    }
    if (command.__type === 'DescribeTargetGroups') {
      return { TargetGroups: [] }; // no target groups needed for this property (identity check only).
    }
    if (command.__type === 'DescribeTargetHealth') {
      return { TargetHealthDescriptions: [] };
    }
    if (command.__type === 'DescribeTags') {
      return { TagDescriptions: [{ Tags: [] }] };
    }
    return {};
  });

  // This property doesn't exercise ECS_Service (Scenario has no `ecs` field) -> no clusters exist,
  // `loadOnlineEcsServices()` returns empty right after the first ListClusters call.
  ecsSendMock.mockImplementation(async () => ({ clusterArns: [] }));

  cwSendMock.mockImplementation(async (command: { __type?: string }) => {
    if (command.__type === 'ListMetrics') return { Metrics: [] }; // no CWAgent — irrelevant to this property.
    if (command.__type === 'GetMetricData') return { MetricDataResults: [] }; // measured values are irrelevant to this property.
    return {};
  });

  s3SendMock.mockImplementation(async (command: { __type?: string }) => {
    if (command.__type === 'GetObject') {
      const err = new Error('NoSuchKey');
      err.name = 'NoSuchKey';
      throw err; // threshold-history-service.ts treats NoSuchKey as "no history yet" and doesn't rethrow.
    }
    if (command.__type === 'PutObject') return {};
    return {};
  });
}

describe('Resource identity completeness (Property 9)', () => {
  it('every produced MonitoringResource has non-empty resourceId and region, regardless of resource kind', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (scenario) => {
        setupMocks(scenario);

        const monitoring = await getMonitoringData();

        // Sanity: every online resource generated must appear (no kind missing/extra).
        expect(monitoring.resources).toHaveLength(
          scenario.ec2Ids.length + scenario.ebsVolumeIds.length + scenario.rdsIds.length + scenario.albNames.length,
        );

        for (const resource of monitoring.resources) {
          expect(typeof resource.resourceId).toBe('string');
          expect(resource.resourceId.length).toBeGreaterThan(0);
          expect(typeof resource.region).toBe('string');
          expect(resource.region.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 30 },
    );
  });
});
