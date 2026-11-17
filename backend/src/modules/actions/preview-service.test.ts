import { describe, it, expect, vi, beforeEach } from 'vitest';

// preview-service.ts imports from `../governance/index.js`, whose barrel also evaluates
// `s3PolicyStore.ts` -> `assessment/infra-review-collector/clients.ts`, which reads
// ASSESSMENT_BUCKET_NAME/AWS_ACCOUNT_ID directly from process.env at module scope (independent of
// the `config.js` mock below) and throws if missing.
process.env.ASSESSMENT_BUCKET_NAME = 'test-assessment-bucket';
process.env.AWS_ACCOUNT_ID = '123456789012';

vi.mock('../../config.js', () => ({
  config: { awsRegion: 'ap-southeast-1', awsAccountId: '123456789012' },
}));

const ec2SendMock = vi.fn();
const rdsSendMock = vi.fn();
vi.mock('@aws-sdk/client-ec2', () => ({
  EC2Client: vi.fn().mockImplementation(() => ({ send: ec2SendMock })),
  DescribeInstancesCommand: vi.fn().mockImplementation((input) => ({ __type: 'DescribeInstances', input })),
}));
vi.mock('@aws-sdk/client-rds', () => ({
  RDSClient: vi.fn().mockImplementation(() => ({ send: rdsSendMock })),
  DescribeDBInstancesCommand: vi.fn().mockImplementation((input) => ({ __type: 'DescribeDBInstances', input })),
}));

const { buildActionPreviewDirect } = await import('./preview-service.js');

beforeEach(() => {
  ec2SendMock.mockReset();
  rdsSendMock.mockReset();
});

describe('buildActionPreviewDirect — lifecycle actions', () => {
  it('EC2_Reboot: returns a preview when the instance is running', async () => {
    ec2SendMock.mockResolvedValue({ Reservations: [{ Instances: [{ State: { Name: 'running' } }] }] });
    const preview = await buildActionPreviewDirect('EC2_Reboot', 'i-abc');
    expect(preview.awsApiCall).toBe('ec2:RebootInstances');
  });

  it('EC2_Reboot: throws badRequest when the instance is not running', async () => {
    ec2SendMock.mockResolvedValue({ Reservations: [{ Instances: [{ State: { Name: 'stopped' } }] }] });
    await expect(buildActionPreviewDirect('EC2_Reboot', 'i-abc')).rejects.toThrow();
  });

  it('RDS_Start: returns a preview when status is "stopped"', async () => {
    rdsSendMock.mockResolvedValue({ DBInstances: [{ DBInstanceStatus: 'stopped' }] });
    const preview = await buildActionPreviewDirect('RDS_Start', 'db-1');
    expect(preview.awsApiCall).toBe('rds:StartDBInstance');
  });

  it('RDS_Stop: throws badRequest when status is not "available"', async () => {
    rdsSendMock.mockResolvedValue({ DBInstances: [{ DBInstanceStatus: 'stopped' }] });
    await expect(buildActionPreviewDirect('RDS_Stop', 'db-1')).rejects.toThrow();
  });

  it('RDS_Reboot: returns a preview when status is "available"', async () => {
    rdsSendMock.mockResolvedValue({ DBInstances: [{ DBInstanceStatus: 'available' }] });
    const preview = await buildActionPreviewDirect('RDS_Reboot', 'db-1');
    expect(preview.awsApiCall).toBe('rds:RebootDBInstance');
  });
});
