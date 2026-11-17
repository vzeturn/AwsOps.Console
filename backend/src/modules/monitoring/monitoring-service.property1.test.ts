import { describe, it, expect, vi, beforeEach } from 'vitest';
import fc from 'fast-check';

// Feature: realtime-monitoring-dashboard, Property 1: Online_Resource filtering is exact and stateless
//
// For any collection of EC2/RDS/EBS resources with arbitrary states/attachment info, and any two
// independent evaluations of the same input, the set of resources included in MonitoringData SHALL
// be exactly the subset satisfying the Online_Resource predicate (EC2 `running`, RDS `available`,
// EBS `attached` to a `running` EC2), and SHALL be identical across repeated evaluations of the same
// input (no dependency on prior calls or stored state).
//
// Validates: Requirements 6.1, 6.2, 6.3, 3.5

// Task 2.2: property test for `loadOnlineEc2`/`loadOnlineEbs`/`loadOnlineRds` in monitoring-service.ts
// Reads the region directly from process.env.AWS_REGION (same as
// ec2-collector.test.ts/rds-collector.test.ts) — set it before importing the module.
process.env.AWS_REGION = 'ap-southeast-1';
// monitoring-service.ts (Task 3.10) statically imports `threshold-history-service.ts`, which
// throws at module scope if ASSESSMENT_BUCKET_NAME is missing — set it before importing, even
// though this test doesn't call recordIfChanged/getHistory.
process.env.ASSESSMENT_BUCKET_NAME = 'test-assessment-bucket';

// monitoring-service.ts statically imports `loadAlb` from infra-service.ts, which creates an AWS
// SDK client at module scope reading `config.awsRegion` (readRequiredEnv throws if the env var is
// missing) — mock config.js following the same pattern as router.test.ts/assessment-service.test.ts
// so the import doesn't throw.
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

// infra-service.ts (imported by monitoring-service.ts) creates an ElasticLoadBalancingV2Client at
// module scope — unused in this property (only tests loadOnlineEc2/loadOnlineEbs/loadOnlineRds),
// but must be mocked so importing monitoring-service.js doesn't construct a real client.
vi.mock('@aws-sdk/client-elastic-load-balancing-v2', () => ({
  ElasticLoadBalancingV2Client: vi.fn().mockImplementation(() => ({ send: elbSendMock })),
  DescribeLoadBalancersCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
  DescribeTargetGroupsCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
  DescribeTargetHealthCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
}));

// Import after the mocks are declared (vi.mock is hoisted to the top by vitest).
const { loadOnlineEc2, loadOnlineEbs, loadOnlineRds } = await import('./monitoring-service.js');

beforeEach(() => {
  ec2SendMock.mockReset();
  rdsSendMock.mockReset();
  elbSendMock.mockReset();
});

// ---- Arbitraries ----

const EC2_STATES = ['running', 'stopped', 'pending', 'stopping', 'shutting-down', 'terminated'] as const;
const RDS_STATUSES = ['available', 'stopped', 'starting', 'backing-up', 'failed', 'creating'] as const;
const EBS_ATTACHMENT_STATES = ['attached', 'attaching', 'detaching', 'detached'] as const;

const ec2StatesArb = fc.array(fc.constantFrom(...EC2_STATES), { minLength: 0, maxLength: 8 });
const rdsStatusesArb = fc.array(fc.constantFrom(...RDS_STATUSES), { minLength: 0, maxLength: 8 });

/**
 * Each EBS volume may have no attachment at all (`attachmentState: undefined`), or be attached via
 * a `parentIndex` pointing into the list of EC2 instances generated in the same test run —
 * `parentIndex` is allowed to exceed the actual number of EC2 instances generated (simulating an
 * "orphaned" volume pointing to an instance not present in this cycle's `DescribeInstances` result).
 */
const ebsSpecsArb = fc.array(
  fc.record({
    attachmentState: fc.option(fc.constantFrom(...EBS_ATTACHMENT_STATES), { nil: undefined }),
    parentIndex: fc.integer({ min: 0, max: 9 }),
  }),
  { minLength: 0, maxLength: 8 },
);

interface EbsSpec {
  attachmentState: (typeof EBS_ATTACHMENT_STATES)[number] | undefined;
  parentIndex: number;
}

function mockDescribeInstances(states: readonly string[]) {
  return {
    Reservations: states.map((state, idx) => ({
      Instances: [
        {
          InstanceId: `i-${idx}`,
          InstanceType: 't3.medium',
          State: { Name: state },
          Tags: [{ Key: 'Name', Value: `instance-${idx}` }],
        },
      ],
    })),
  };
}

function mockDescribeDBInstances(statuses: readonly string[]) {
  return {
    DBInstances: statuses.map((status, idx) => ({
      DBInstanceIdentifier: `db-${idx}`,
      DBInstanceStatus: status,
      DBInstanceClass: 'db.t3.medium',
      Engine: 'postgres',
    })),
  };
}

function mockDescribeVolumes(specs: EbsSpec[]) {
  return {
    Volumes: specs.map((spec, idx) => ({
      VolumeId: `vol-${idx}`,
      VolumeType: 'gp3',
      Size: 100,
      ...(spec.attachmentState === undefined
        ? {}
        : {
            Attachments: [
              { State: spec.attachmentState, InstanceId: `i-${spec.parentIndex}` },
            ],
          }),
    })),
  };
}

function setupSendMock(ec2States: readonly string[], ebsSpecs: EbsSpec[], rdsStatuses: readonly string[]) {
  ec2SendMock.mockImplementation(async (command: { __type?: string }) => {
    if (command.__type === 'DescribeVolumes') return mockDescribeVolumes(ebsSpecs);
    return mockDescribeInstances(ec2States); // __type === 'DescribeInstances'
  });
  rdsSendMock.mockImplementation(async () => mockDescribeDBInstances(rdsStatuses));
}

describe('Online_Resource filtering (Property 1)', () => {
  it('loadOnlineEc2/loadOnlineEbs/loadOnlineRds return exactly the subset satisfying Online_Resource, identically across 2 independent calls', async () => {
    await fc.assert(
      fc.asyncProperty(ec2StatesArb, ebsSpecsArb, rdsStatusesArb, async (ec2States, ebsSpecs, rdsStatuses) => {
        setupSendMock(ec2States, ebsSpecs, rdsStatuses);

        // ---- 1st evaluation ----
        const ec2Result1 = await loadOnlineEc2();
        const rdsResult1 = await loadOnlineRds();
        const ebsResult1 = await loadOnlineEbs(ec2Result1);

        // ---- 2nd evaluation, same input (statelessness — no dependency on the prior call) ----
        const ec2Result2 = await loadOnlineEc2();
        const rdsResult2 = await loadOnlineRds();
        const ebsResult2 = await loadOnlineEbs(ec2Result2);

        // ---- Exactness: EC2 keeps only `running` instances, in generation order ----
        const expectedEc2Ids = ec2States
          .map((state, idx) => ({ state, idx }))
          .filter(({ state }) => state === 'running')
          .map(({ idx }) => `i-${idx}`);
        expect(ec2Result1.map((r) => r.instanceId)).toEqual(expectedEc2Ids);

        // ---- Exactness: RDS keeps only `available` instances ----
        const expectedRdsIds = rdsStatuses
          .map((status, idx) => ({ status, idx }))
          .filter(({ status }) => status === 'available')
          .map(({ idx }) => `db-${idx}`);
        expect(rdsResult1.map((r) => r.dbInstanceIdentifier)).toEqual(expectedRdsIds);

        // ---- Exactness: EBS keeps only volumes `attached` TO an EC2 instance that is `running` ----
        const runningInstanceIds = new Set(expectedEc2Ids);
        const expectedEbsIds = ebsSpecs
          .map((spec, idx) => ({ spec, idx }))
          .filter(
            ({ spec }) =>
              spec.attachmentState === 'attached' && runningInstanceIds.has(`i-${spec.parentIndex}`),
          )
          .map(({ idx }) => `vol-${idx}`);
        expect(ebsResult1.map((r) => r.volumeId)).toEqual(expectedEbsIds);

        // ---- Statelessness: the 2nd call with the same input must produce a result identical to the 1st ----
        expect(ec2Result2).toEqual(ec2Result1);
        expect(rdsResult2).toEqual(rdsResult1);
        expect(ebsResult2).toEqual(ebsResult1);
      }),
      { numRuns: 150 },
    );
  });
});
