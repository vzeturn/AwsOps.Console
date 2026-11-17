import { describe, it, expect, vi, beforeEach } from 'vitest';

// Unit test for `buildActionPreviewDirect('RDS_ApplyResourceGovernance', ...)` — follows the same
// pattern as preview-service.ecsRds.test.ts/preview-service.ec2Rightsize.test.ts.
process.env.AWS_REGION = 'ap-southeast-1';
process.env.ASSESSMENT_BUCKET_NAME = 'test-assessment-bucket';
// preview-service.ts imports from `../governance/index.js`, whose barrel also evaluates
// `s3PolicyStore.ts` -> `assessment/infra-review-collector/clients.ts`, which reads
// AWS_ACCOUNT_ID directly from process.env at module scope and throws if missing.
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
}));

const { buildActionPreviewDirect } = await import('./preview-service.js');

beforeEach(() => {
  rdsSendMock.mockReset();
});

describe('buildActionPreviewDirect — RDS_ApplyResourceGovernance', () => {
  it('SQL Server: returns a preview with the correct engineFamily/parameterGroupName/parameterNames', async () => {
    rdsSendMock.mockResolvedValue({
      DBInstances: [
        {
          Engine: 'sqlserver-se',
          DBInstanceClass: 'db.m8i.large',
          DBParameterGroups: [{ DBParameterGroupName: 'sqlserver-se-15-pg' }],
        },
      ],
    });

    const preview = await buildActionPreviewDirect('RDS_ApplyResourceGovernance', 'acme-rds-production-env');

    expect(preview.actionType).toBe('RDS_ApplyResourceGovernance');
    expect(preview.reversibilityClass).toBe('reversible');
    expect(preview.resource.id).toBe('acme-rds-production-env');
    expect(preview.params.engineFamily).toBe('sqlserver');
    expect(preview.params.parameterGroupName).toBe('sqlserver-se-15-pg');
    expect(preview.params.parameterNames).toContain('max degree of parallelism');
  });

  it('PostgreSQL: returns a preview with the correct engineFamily/parameterNames', async () => {
    rdsSendMock.mockResolvedValue({
      DBInstances: [
        {
          Engine: 'postgres',
          DBInstanceClass: 'db.m7g.2xlarge',
          DBParameterGroups: [{ DBParameterGroupName: 'prod-logging-group-18' }],
        },
      ],
    });

    const preview = await buildActionPreviewDirect('RDS_ApplyResourceGovernance', 'abc-prod-rds-postgres');

    expect(preview.params.engineFamily).toBe('postgres');
    expect(preview.params.parameterNames).toContain('statement_timeout');
  });

  it('throws badRequest when the instance uses the default parameter group (default.*)', async () => {
    rdsSendMock.mockResolvedValue({
      DBInstances: [
        { Engine: 'postgres', DBInstanceClass: 'db.m7g.2xlarge', DBParameterGroups: [{ DBParameterGroupName: 'default.postgres18' }] },
      ],
    });

    await expect(buildActionPreviewDirect('RDS_ApplyResourceGovernance', 'some-instance')).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it('throws badRequest when the DB instance is not found', async () => {
    rdsSendMock.mockResolvedValue({ DBInstances: [] });

    await expect(buildActionPreviewDirect('RDS_ApplyResourceGovernance', 'unknown-db')).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it('throws badRequest when the engine is unsupported (mysql)', async () => {
    rdsSendMock.mockResolvedValue({
      DBInstances: [{ Engine: 'mysql', DBInstanceClass: 'db.m8i.large', DBParameterGroups: [{ DBParameterGroupName: 'my-pg' }] }],
    });

    await expect(buildActionPreviewDirect('RDS_ApplyResourceGovernance', 'mysql-db')).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it('throws badRequest when the DBInstanceClass is not present in the vCPU/RAM lookup table', async () => {
    rdsSendMock.mockResolvedValue({
      DBInstances: [{ Engine: 'postgres', DBInstanceClass: 'db.unknown.class', DBParameterGroups: [{ DBParameterGroupName: 'my-pg' }] }],
    });

    await expect(buildActionPreviewDirect('RDS_ApplyResourceGovernance', 'unknown-class-db')).rejects.toMatchObject({
      statusCode: 400,
    });
  });
});
