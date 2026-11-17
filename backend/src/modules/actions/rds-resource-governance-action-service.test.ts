import { describe, it, expect, vi, beforeEach } from 'vitest';

// rds-resource-governance-action-service.ts imports from `../governance/index.js`, whose barrel
// also evaluates `s3PolicyStore.ts` -> `assessment/infra-review-collector/clients.ts`, which reads
// ASSESSMENT_BUCKET_NAME/AWS_ACCOUNT_ID directly from process.env at module scope (independent of
// the `config.js` mock below) and throws if missing.
process.env.ASSESSMENT_BUCKET_NAME = 'test-assessment-bucket';
process.env.AWS_ACCOUNT_ID = '123456789012';

vi.mock('../../config.js', () => ({
  config: {
    allowedOrigins: [],
    entraTenantId: 'test-tenant',
    entraClientId: 'test-client',
    allowedGroupIds: [],
    awsRegion: 'ap-southeast-1',
    costCacheParamName: 'test-cost-cache-param',
    assessmentBucketName: 'test-assessment-bucket',
    ec2StateManagerServiceTokenParamName: 'test-service-token-param',
    ec2StateManagerFunctionUrl: 'https://example.invalid/',
    actionExecutionFunctionName: 'test-action-execution-fn',
  },
  corsHeaders: () => ({}),
}));

const rdsSendMock = vi.fn();

vi.mock('@aws-sdk/client-rds', () => ({
  RDSClient: vi.fn().mockImplementation(() => ({ send: rdsSendMock })),
  DescribeDBInstancesCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'DescribeDBInstances', input })),
  DescribeDBParametersCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'DescribeDBParameters', input })),
  ModifyDBParameterGroupCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: 'ModifyDBParameterGroup', input })),
}));

const { executeRdsApplyResourceGovernance } = await import('./rds-resource-governance-action-service.js');

beforeEach(() => {
  rdsSendMock.mockReset();
});

/** Mock for the acme-rds-production-env case (SQL Server, db.m8i.large = 2 vCPU/8 GiB) — the
 * current values match exactly the REAL data confirmed on the account (max degree of
 * parallelism=8, max server memory (mb)=3072, query governor cost limit=0). */
function mockSqlServerInstance(currentParams: Record<string, string>): void {
  rdsSendMock.mockImplementation(async (command: { __type?: string; input?: unknown }) => {
    if (command.__type === 'DescribeDBInstances') {
      return {
        DBInstances: [
          {
            Engine: 'sqlserver-se',
            DBInstanceClass: 'db.m8i.large',
            DBParameterGroups: [{ DBParameterGroupName: 'sqlserver-se-15-pg' }],
          },
        ],
      };
    }
    if (command.__type === 'DescribeDBParameters') {
      return {
        Parameters: Object.entries(currentParams).map(([ParameterName, ParameterValue]) => ({ ParameterName, ParameterValue })),
      };
    }
    if (command.__type === 'ModifyDBParameterGroup') {
      return {};
    }
    throw new Error(`Unexpected command: ${command.__type}`);
  });
}

function mockPostgresInstance(currentParams: Record<string, string>): void {
  rdsSendMock.mockImplementation(async (command: { __type?: string; input?: unknown }) => {
    if (command.__type === 'DescribeDBInstances') {
      return {
        DBInstances: [
          {
            Engine: 'postgres',
            DBInstanceClass: 'db.m7g.2xlarge',
            DBParameterGroups: [{ DBParameterGroupName: 'prod-logging-group-18' }],
          },
        ],
      };
    }
    if (command.__type === 'DescribeDBParameters') {
      return {
        Parameters: Object.entries(currentParams).map(([ParameterName, ParameterValue]) => ({ ParameterName, ParameterValue })),
      };
    }
    if (command.__type === 'ModifyDBParameterGroup') {
      return {};
    }
    throw new Error(`Unexpected command: ${command.__type}`);
  });
}

describe('executeRdsApplyResourceGovernance', () => {
  it('SQL Server (real acme-rds-production-env case) -> applies exactly 3 parameters (maxDop=2, maxServerMemory=6144 per the industry-standard OS reservation formula, queryGovernor=50000), ApplyMethod=immediate', async () => {
    mockSqlServerInstance({
      'max degree of parallelism': '8',
      'max server memory (mb)': '3072',
      'query governor cost limit': '0',
    });

    const result = await executeRdsApplyResourceGovernance('acme-rds-production-env');

    expect(result.outcome).toBe('success');
    expect(result.appliedParameterNames).toEqual([
      'max degree of parallelism',
      'max server memory (mb)',
      'query governor cost limit',
    ]);
    expect(result.requiresReboot).toBe(false);

    // db.m8i.large = 8 GiB -> 2 GiB OS reservation (industry-standard formula) -> maxServerMemory =
    // (8-2)*1024 = 6144 MB (NOT 6553 MB from the old 80% formula). queryGovernor = 50000
    // (NOT 300 — that caused a real incident wrongly blocking valid application queries; also NOT
    // 9000 — that would wrongly block valid business reports observed reaching a cost of ~30000).
    const modifyCall = rdsSendMock.mock.calls.find((c) => c[0].__type === 'ModifyDBParameterGroup')!;
    const params = modifyCall[0].input.Parameters as { ParameterName: string; ParameterValue: string; ApplyMethod: string }[];
    expect(params).toEqual(
      expect.arrayContaining([
        { ParameterName: 'max degree of parallelism', ParameterValue: '2', ApplyMethod: 'immediate' },
        { ParameterName: 'max server memory (mb)', ParameterValue: '6144', ApplyMethod: 'immediate' },
        { ParameterName: 'query governor cost limit', ParameterValue: '50000', ApplyMethod: 'immediate' },
      ]),
    );
    expect(modifyCall[0].input.DBParameterGroupName).toBe('sqlserver-se-15-pg');
  });

  it('PostgreSQL (real abc-prod-rds-postgres case) -> applies exactly 3 parameters (statementTimeout=300000, maxParallelWorkers=4, workMem=131072)', async () => {
    mockPostgresInstance({
      statement_timeout: '0',
      max_parallel_workers_per_gather: '2',
      work_mem: '4096',
    });

    const result = await executeRdsApplyResourceGovernance('abc-prod-rds-postgres');

    expect(result.outcome).toBe('success');
    expect(result.appliedParameterNames).toEqual([
      'statement_timeout',
      'max_parallel_workers_per_gather',
      'work_mem',
    ]);

    const modifyCall = rdsSendMock.mock.calls.find((c) => c[0].__type === 'ModifyDBParameterGroup')!;
    const params = modifyCall[0].input.Parameters as { ParameterName: string; ParameterValue: string }[];
    expect(params).toEqual(
      expect.arrayContaining([
        { ParameterName: 'statement_timeout', ParameterValue: '300000', ApplyMethod: 'immediate' },
        { ParameterName: 'max_parallel_workers_per_gather', ParameterValue: '4', ApplyMethod: 'immediate' },
        { ParameterName: 'work_mem', ParameterValue: '131072', ApplyMethod: 'immediate' },
      ]),
    );
  });

  it('idempotent: parameter ALREADY at the target value -> NOT included in ModifyDBParameterGroup, only the mismatched parameter is changed', async () => {
    mockSqlServerInstance({
      'max degree of parallelism': '2', // already correct
      'max server memory (mb)': '3072', // still wrong
      'query governor cost limit': '50000', // already correct
    });

    const result = await executeRdsApplyResourceGovernance('acme-rds-production-env');

    expect(result.outcome).toBe('success');
    expect(result.appliedParameterNames).toEqual(['max server memory (mb)']);

    const modifyCall = rdsSendMock.mock.calls.find((c) => c[0].__type === 'ModifyDBParameterGroup')!;
    expect(modifyCall[0].input.Parameters).toEqual([
      { ParameterName: 'max server memory (mb)', ParameterValue: '6144', ApplyMethod: 'immediate' },
    ]);
  });

  it('all parameters ALREADY at the target value -> success, appliedParameterNames empty, does NOT call ModifyDBParameterGroup', async () => {
    mockSqlServerInstance({
      'max degree of parallelism': '2',
      'max server memory (mb)': '6144',
      'query governor cost limit': '50000',
    });

    const result = await executeRdsApplyResourceGovernance('acme-rds-production-env');

    expect(result.outcome).toBe('success');
    expect(result.appliedParameterNames).toEqual([]);
    expect(rdsSendMock.mock.calls.some((c) => c[0].__type === 'ModifyDBParameterGroup')).toBe(false);
  });

  it('instance does not exist -> rejected', async () => {
    rdsSendMock.mockResolvedValue({ DBInstances: [] });

    const result = await executeRdsApplyResourceGovernance('i-do-not-exist');

    expect(result.outcome).toBe('rejected');
  });

  it('instance using the DEFAULT DB Parameter Group (default.*) -> rejected, does NOT call ModifyDBParameterGroup', async () => {
    rdsSendMock.mockImplementation(async (command: { __type?: string }) => {
      if (command.__type === 'DescribeDBInstances') {
        return {
          DBInstances: [
            {
              Engine: 'postgres',
              DBInstanceClass: 'db.m7g.2xlarge',
              DBParameterGroups: [{ DBParameterGroupName: 'default.postgres18' }],
            },
          ],
        };
      }
      throw new Error(`Unexpected command: ${command.__type}`);
    });

    const result = await executeRdsApplyResourceGovernance('some-default-group-instance');

    expect(result.outcome).toBe('rejected');
    expect(result.reason).toContain('default');
    expect(rdsSendMock.mock.calls.some((c) => c[0].__type === 'ModifyDBParameterGroup')).toBe(false);
  });

  it('unsupported engine (mysql) -> rejected', async () => {
    rdsSendMock.mockImplementation(async (command: { __type?: string }) => {
      if (command.__type === 'DescribeDBInstances') {
        return {
          DBInstances: [
            { Engine: 'mysql', DBInstanceClass: 'db.m8i.large', DBParameterGroups: [{ DBParameterGroupName: 'my-custom-pg' }] },
          ],
        };
      }
      throw new Error(`Unexpected command: ${command.__type}`);
    });

    const result = await executeRdsApplyResourceGovernance('mysql-instance');

    expect(result.outcome).toBe('rejected');
  });

  it('DBInstanceClass not present in the vCPU/RAM lookup table -> rejected (fail-safe, no guessing)', async () => {
    rdsSendMock.mockImplementation(async (command: { __type?: string }) => {
      if (command.__type === 'DescribeDBInstances') {
        return {
          DBInstances: [
            { Engine: 'postgres', DBInstanceClass: 'db.unknown.class', DBParameterGroups: [{ DBParameterGroupName: 'my-custom-pg' }] },
          ],
        };
      }
      throw new Error(`Unexpected command: ${command.__type}`);
    });

    const result = await executeRdsApplyResourceGovernance('unknown-class-instance');

    expect(result.outcome).toBe('rejected');
  });

  it('DescribeDBInstances throws an error -> failure', async () => {
    rdsSendMock.mockRejectedValue(new Error('AccessDenied'));

    const result = await executeRdsApplyResourceGovernance('acme-rds-production-env');

    expect(result.outcome).toBe('failure');
  });

  it('ModifyDBParameterGroup throws an error -> failure', async () => {
    rdsSendMock.mockImplementation(async (command: { __type?: string }) => {
      if (command.__type === 'DescribeDBInstances') {
        return {
          DBInstances: [
            {
              Engine: 'sqlserver-se',
              DBInstanceClass: 'db.m8i.large',
              DBParameterGroups: [{ DBParameterGroupName: 'sqlserver-se-15-pg' }],
            },
          ],
        };
      }
      if (command.__type === 'DescribeDBParameters') {
        return { Parameters: [] };
      }
      if (command.__type === 'ModifyDBParameterGroup') {
        throw new Error('Throttling');
      }
      throw new Error(`Unexpected command: ${command.__type}`);
    });

    const result = await executeRdsApplyResourceGovernance('acme-rds-production-env');

    expect(result.outcome).toBe('failure');
  });
});
