import { describe, it, expect, vi, beforeEach } from 'vitest';

// Task 6.4: unit test for rds-collector.ts
// The collector reads the region directly from process.env.AWS_REGION (the Lambda runtime always
// sets this variable itself) — set it before importing the module; no longer mocking config.ts
// (the collector does not import config.ts).
process.env.AWS_REGION = 'ap-southeast-1';

const rdsSendMock = vi.fn();
const cloudwatchSendMock = vi.fn();

vi.mock('@aws-sdk/client-rds', () => ({
  RDSClient: vi.fn().mockImplementation(() => ({ send: rdsSendMock })),
  DescribeDBInstancesCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
}));

vi.mock('@aws-sdk/client-cloudwatch', () => ({
  CloudWatchClient: vi.fn().mockImplementation(() => ({ send: cloudwatchSendMock })),
  GetMetricDataCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
}));

// Import after the mocks are declared (vi.mock is hoisted to the top by vitest).
const { collectRds } = await import('./rds-collector.js');

beforeEach(() => {
  rdsSendMock.mockReset();
  cloudwatchSendMock.mockReset();
});

describe('collectRds', () => {
  it('flags isProduction=true via the Environment=production tag, keeps multiAz=false correct', async () => {
    rdsSendMock.mockResolvedValue({
      DBInstances: [
        {
          DBInstanceIdentifier: 'db-prod-1',
          Engine: 'postgres',
          DBInstanceClass: 'db.t3.medium',
          MultiAZ: false,
          AllocatedStorage: 100,
          TagList: [{ Key: 'Environment', Value: 'production' }],
        },
      ],
    });
    cloudwatchSendMock.mockResolvedValue({
      MetricDataResults: [
        { Id: 'cpu_db_prod_1', Values: [45] },
        { Id: 'cpumax_db_prod_1', Values: [78] },
        { Id: 'conn_db_prod_1', Values: [10] },
      ],
    });

    const result = await collectRds();

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      dbInstanceIdentifier: 'db-prod-1',
      multiAz: false,
      isProduction: true,
      maxCpuPercent: 78,
    });
  });

  it('returns avgCpuPercent matching the low CPU value mocked from CloudWatch', async () => {
    rdsSendMock.mockResolvedValue({
      DBInstances: [
        {
          DBInstanceIdentifier: 'db-dev-2',
          Engine: 'mysql',
          DBInstanceClass: 'db.t3.small',
          MultiAZ: true,
          AllocatedStorage: 20,
          TagList: [{ Key: 'Environment', Value: 'dev' }],
        },
      ],
    });
    cloudwatchSendMock.mockResolvedValue({
      MetricDataResults: [
        { Id: 'cpu_db_dev_2', Values: [2.5] },
        { Id: 'cpumax_db_dev_2', Values: [9.1] },
        { Id: 'conn_db_dev_2', Values: [1] },
      ],
    });

    const result = await collectRds();

    expect(result).toHaveLength(1);
    expect(result[0].avgCpuPercent).toBe(2.5);
    expect(result[0].maxCpuPercent).toBe(9.1);
    expect(result[0].avgConnections).toBe(1);
  });

  it('merges RDS instances across multiple pages when DescribeDBInstances returns a Marker', async () => {
    rdsSendMock
      .mockResolvedValueOnce({
        DBInstances: [
          {
            DBInstanceIdentifier: 'db-page1',
            Engine: 'postgres',
            DBInstanceClass: 'db.t3.medium',
            MultiAZ: false,
            AllocatedStorage: 50,
            TagList: [],
          },
        ],
        Marker: 'marker-page-2',
      })
      .mockResolvedValueOnce({
        DBInstances: [
          {
            DBInstanceIdentifier: 'db-page2',
            Engine: 'mysql',
            DBInstanceClass: 'db.t3.small',
            MultiAZ: true,
            AllocatedStorage: 20,
            TagList: [],
          },
        ],
      });
    cloudwatchSendMock.mockResolvedValue({ MetricDataResults: [] });

    const result = await collectRds();

    expect(result.map((r) => r.dbInstanceIdentifier)).toEqual(['db-page1', 'db-page2']);
    expect(rdsSendMock).toHaveBeenCalledTimes(2);
  });

  it('runs GetMetricData batches concurrently rather than strictly sequentially', async () => {
    // INSTANCES_PER_BATCH = 150 in rds-collector.ts -> 451 instances triggers 4 batches.
    const instanceCount = 451;
    rdsSendMock.mockResolvedValue({
      DBInstances: Array.from({ length: instanceCount }, (_, i) => ({
        DBInstanceIdentifier: `db-conc${i}`,
        Engine: 'postgres',
        DBInstanceClass: 'db.t3.micro',
        MultiAZ: false,
        AllocatedStorage: 20,
        TagList: [],
      })),
    });
    const BATCH_DELAY_MS = 40;
    cloudwatchSendMock.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ MetricDataResults: [] }), BATCH_DELAY_MS)),
    );

    const start = Date.now();
    const result = await collectRds();
    const elapsedMs = Date.now() - start;

    expect(result).toHaveLength(instanceCount);
    expect(elapsedMs).toBeLessThan(BATCH_DELAY_MS * 2.5);
  });

  it('treats isProduction=false when the instance has no matching environment tag', async () => {
    rdsSendMock.mockResolvedValue({
      DBInstances: [
        {
          DBInstanceIdentifier: 'db-no-tag-3',
          Engine: 'postgres',
          DBInstanceClass: 'db.t3.micro',
          MultiAZ: false,
          AllocatedStorage: 10,
          TagList: [],
        },
      ],
    });
    cloudwatchSendMock.mockResolvedValue({ MetricDataResults: [] });

    const result = await collectRds();

    expect(result).toHaveLength(1);
    expect(result[0].isProduction).toBe(false);
    expect(result[0].avgCpuPercent).toBeNull();
    expect(result[0].maxCpuPercent).toBeNull();
    expect(result[0].avgConnections).toBeNull();
  });
});
