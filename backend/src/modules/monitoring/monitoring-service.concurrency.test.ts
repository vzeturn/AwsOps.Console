import { describe, it, expect, vi, beforeEach } from 'vitest';

// Pins the two properties that make `getMonitoringData()` both FAST and CORRECT after it was changed
// from "one metric at a time, everywhere" to "resources in parallel, metrics within a resource still
// sequential":
//
//   1. SAFETY  - two metrics of the SAME resource never overlap. `recordIfChanged()` does a full
//                read-modify-write of `threshold-history/{resourceType}-{resourceId}.json`, so an
//                overlap there is a lost update: the second write clobbers the first.
//   2. SPEED   - two DIFFERENT resources DO overlap. Without this, the refactor achieved nothing, and
//                a future well-meaning `await` reintroducing serialisation would go unnoticed.
//
// Property 1 alone is satisfied by fully sequential code, and property 2 alone is satisfied by fully
// parallel (broken) code. Only asserting BOTH describes the intended design.

process.env.AWS_REGION = 'ap-southeast-1';
process.env.ASSESSMENT_BUCKET_NAME = 'test-assessment-bucket';

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

// ---- instrumentation ----
// Intercepting recordIfChanged directly observes exactly the critical section, rather than trying to
// infer it from S3 GET/PUT traffic.
const active = new Set<string>();
let sameResourceOverlaps: string[] = [];
let maxConcurrentResources = 0;
let recordedKeys: string[] = [];

vi.mock('./threshold-history-service.js', () => ({
  recordIfChanged: async (resourceType: string, resourceId: string, metricName: string) => {
    const key = `${resourceType}-${resourceId}`;
    if (active.has(key)) sameResourceOverlaps.push(`${key}/${metricName}`);
    active.add(key);
    maxConcurrentResources = Math.max(maxConcurrentResources, active.size);
    recordedKeys.push(key);
    // A real await so other resources get a chance to interleave; without yielding, everything would
    // look sequential no matter how the code is written.
    await new Promise((resolve) => setTimeout(resolve, 3));
    active.delete(key);
  },
  getHistory: async () => ({ history: [] }),
}));

const ec2SendMock = vi.fn();
const rdsSendMock = vi.fn();
const elbSendMock = vi.fn();
const ecsSendMock = vi.fn();
const cwSendMock = vi.fn();
const s3SendMock = vi.fn();

vi.mock('@aws-sdk/client-ec2', () => ({
  EC2Client: vi.fn().mockImplementation(() => ({ send: ec2SendMock })),
  DescribeInstancesCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'DescribeInstances', input })),
  DescribeVolumesCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'DescribeVolumes', input })),
}));

vi.mock('@aws-sdk/client-rds', () => ({
  RDSClient: vi.fn().mockImplementation(() => ({ send: rdsSendMock })),
  DescribeDBInstancesCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'DescribeDBInstances', input })),
}));

vi.mock('@aws-sdk/client-elastic-load-balancing-v2', () => ({
  ElasticLoadBalancingV2Client: vi.fn().mockImplementation(() => ({ send: elbSendMock })),
  DescribeLoadBalancersCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'DescribeLoadBalancers', input })),
  DescribeTargetGroupsCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'DescribeTargetGroups', input })),
  DescribeTargetHealthCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'DescribeTargetHealth', input })),
}));

vi.mock('@aws-sdk/client-ecs', () => ({
  ECSClient: vi.fn().mockImplementation(() => ({ send: ecsSendMock })),
  ListClustersCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'ListClusters', input })),
  ListServicesCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'ListServices', input })),
  DescribeServicesCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'DescribeServices', input })),
}));

vi.mock('@aws-sdk/client-cloudwatch', () => ({
  CloudWatchClient: vi.fn().mockImplementation(() => ({ send: cwSendMock })),
  ListMetricsCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'ListMetrics', input })),
  GetMetricDataCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'GetMetricData', input })),
}));

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({ send: s3SendMock })),
  GetObjectCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'GetObject', input })),
  PutObjectCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'PutObject', input })),
}));

const { getMonitoringData } = await import('./monitoring-service.js');

const instance = (id: string) => ({
  InstanceId: id,
  InstanceType: 't3.medium',
  State: { Name: 'running' },
  Placement: { AvailabilityZone: 'ap-southeast-1a' },
  Tags: [{ Key: 'Name', Value: `name-${id}` }],
});

beforeEach(() => {
  active.clear();
  sameResourceOverlaps = [];
  maxConcurrentResources = 0;
  recordedKeys = [];

  ec2SendMock.mockReset();
  rdsSendMock.mockReset();
  elbSendMock.mockReset();
  ecsSendMock.mockReset();
  cwSendMock.mockReset();
  s3SendMock.mockReset();

  // 3 EC2 instances + 2 RDS instances = 5 resources, each with several metrics.
  ec2SendMock.mockImplementation(async (command: { __type: string }) => {
    if (command.__type === 'DescribeInstances') {
      return { Reservations: [{ Instances: [instance('i-aaa'), instance('i-bbb'), instance('i-ccc')] }] };
    }
    if (command.__type === 'DescribeVolumes') return { Volumes: [] };
    return {};
  });

  rdsSendMock.mockImplementation(async () => ({
    DBInstances: [
      {
        DBInstanceIdentifier: 'db-one',
        DBInstanceClass: 'db.m8i.large',
        Engine: 'postgres',
        AllocatedStorage: 100,
        DBInstanceStatus: 'available',
        AvailabilityZone: 'ap-southeast-1a',
      },
      {
        DBInstanceIdentifier: 'db-two',
        DBInstanceClass: 'db.m8i.large',
        Engine: 'postgres',
        AllocatedStorage: 100,
        DBInstanceStatus: 'available',
        AvailabilityZone: 'ap-southeast-1a',
      },
    ],
  }));

  elbSendMock.mockImplementation(async () => ({ LoadBalancers: [] }));
  ecsSendMock.mockImplementation(async () => ({ clusterArns: [] }));

  cwSendMock.mockImplementation(async (command: { __type: string; input?: { MetricDataQueries?: { Id: string }[] } }) => {
    if (command.__type === 'ListMetrics') return { Metrics: [] };
    if (command.__type === 'GetMetricData') {
      // Give every query a datapoint, so every metric gets a threshold and therefore triggers a
      // history write — otherwise there would be nothing to observe.
      return {
        MetricDataResults: (command.input?.MetricDataQueries ?? []).map((q) => ({
          Id: q.Id,
          Timestamps: [new Date()],
          Values: [50],
        })),
      };
    }
    return {};
  });

  s3SendMock.mockImplementation(async () => ({}));
});

describe('getMonitoringData concurrency: parallel across resources, sequential within one', () => {
  it('never overlaps two metrics of the SAME resource (no lost update on the history object)', async () => {
    await getMonitoringData();

    expect(recordedKeys.length).toBeGreaterThan(0); // the test would be vacuous otherwise
    expect(sameResourceOverlaps).toEqual([]);
  });

  it('DOES overlap different resources, so the refactor actually buys parallelism', async () => {
    await getMonitoringData();

    expect(maxConcurrentResources).toBeGreaterThan(1);
  });

  it('every resource still appears exactly once, in the original type order', async () => {
    const data = await getMonitoringData();

    expect(data.resources.map((r) => r.resourceId)).toEqual([
      'i-aaa',
      'i-bbb',
      'i-ccc',
      'db-one',
      'db-two',
    ]);
    expect(data.resources.map((r) => r.resourceType)).toEqual(['ec2', 'ec2', 'ec2', 'rds', 'rds']);
  });

  it('metrics keep their per-resource order despite running concurrently with other resources', async () => {
    const first = await getMonitoringData();
    const second = await getMonitoringData();

    // Same input -> identical metric ordering on both runs. Concurrency must not make the response
    // nondeterministic, which is what a naive Promise.all over all metrics would have done.
    for (const [i, resource] of first.resources.entries()) {
      expect(resource.metrics.map((m) => m.name)).toEqual(second.resources[i].metrics.map((m) => m.name));
    }
  });
});
