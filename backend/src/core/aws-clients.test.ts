import { describe, it, expect, vi, beforeEach } from 'vitest';

const ec2ConstructorSpy = vi.fn();
const cloudwatchConstructorSpy = vi.fn();
const costExplorerConstructorSpy = vi.fn();

vi.mock('@aws-sdk/client-application-auto-scaling', () => ({
  ApplicationAutoScalingClient: vi.fn().mockImplementation(() => ({})),
}));
vi.mock('@aws-sdk/client-backup', () => ({ BackupClient: vi.fn().mockImplementation(() => ({})) }));
vi.mock('@aws-sdk/client-cloudwatch', () => ({
  CloudWatchClient: vi.fn().mockImplementation((config: unknown) => {
    cloudwatchConstructorSpy(config);
    return {};
  }),
}));
vi.mock('@aws-sdk/client-cloudwatch-logs', () => ({ CloudWatchLogsClient: vi.fn().mockImplementation(() => ({})) }));
vi.mock('@aws-sdk/client-compute-optimizer', () => ({ ComputeOptimizerClient: vi.fn().mockImplementation(() => ({})) }));
vi.mock('@aws-sdk/client-config-service', () => ({ ConfigServiceClient: vi.fn().mockImplementation(() => ({})) }));
vi.mock('@aws-sdk/client-cost-explorer', () => ({
  CostExplorerClient: vi.fn().mockImplementation((config: unknown) => {
    costExplorerConstructorSpy(config);
    return {};
  }),
}));
vi.mock('@aws-sdk/client-dlm', () => ({ DLMClient: vi.fn().mockImplementation(() => ({})) }));
vi.mock('@aws-sdk/client-ec2', () => ({
  EC2Client: vi.fn().mockImplementation((config: unknown) => {
    ec2ConstructorSpy(config);
    return {};
  }),
}));
vi.mock('@aws-sdk/client-ecs', () => ({ ECSClient: vi.fn().mockImplementation(() => ({})) }));
vi.mock('@aws-sdk/client-elastic-load-balancing-v2', () => ({
  ElasticLoadBalancingV2Client: vi.fn().mockImplementation(() => ({})),
}));
vi.mock('@aws-sdk/client-eventbridge', () => ({ EventBridgeClient: vi.fn().mockImplementation(() => ({})) }));
vi.mock('@aws-sdk/client-guardduty', () => ({ GuardDutyClient: vi.fn().mockImplementation(() => ({})) }));
vi.mock('@aws-sdk/client-lambda', () => ({ LambdaClient: vi.fn().mockImplementation(() => ({})) }));
vi.mock('@aws-sdk/client-rds', () => ({ RDSClient: vi.fn().mockImplementation(() => ({})) }));
vi.mock('@aws-sdk/client-s3', () => ({ S3Client: vi.fn().mockImplementation(() => ({})) }));
vi.mock('@aws-sdk/client-scheduler', () => ({ SchedulerClient: vi.fn().mockImplementation(() => ({})) }));
vi.mock('@aws-sdk/client-sns', () => ({ SNSClient: vi.fn().mockImplementation(() => ({})) }));
vi.mock('@aws-sdk/client-ssm', () => ({ SSMClient: vi.fn().mockImplementation(() => ({})) }));

describe('core/aws-clients', () => {
  beforeEach(() => {
    vi.resetModules();
    ec2ConstructorSpy.mockClear();
    cloudwatchConstructorSpy.mockClear();
    costExplorerConstructorSpy.mockClear();
    process.env.AWS_REGION = 'ap-southeast-1';
  });

  it('returns the same client instance on repeated calls to the same getter', async () => {
    const { getEc2Client } = await import('./aws-clients.js');
    const first = getEc2Client();
    const second = getEc2Client();
    expect(first).toBe(second);
    expect(ec2ConstructorSpy).toHaveBeenCalledTimes(1);
  });

  it('returns a distinct instance per different getter', async () => {
    const { getEc2Client, getRdsClient } = await import('./aws-clients.js');
    expect(getEc2Client()).not.toBe(getRdsClient());
  });

  it('constructs the Cost Explorer client with region us-east-1 regardless of AWS_REGION', async () => {
    process.env.AWS_REGION = 'eu-west-1';
    const { getCostExplorerClient } = await import('./aws-clients.js');
    getCostExplorerClient();
    expect(costExplorerConstructorSpy).toHaveBeenCalledWith(expect.objectContaining({ region: 'us-east-1' }));
  });

  it('constructs every non-Cost-Explorer client with process.env.AWS_REGION', async () => {
    process.env.AWS_REGION = 'ap-southeast-1';
    const { getEc2Client } = await import('./aws-clients.js');
    getEc2Client();
    expect(ec2ConstructorSpy).toHaveBeenCalledWith(expect.objectContaining({ region: 'ap-southeast-1' }));
  });

  it('applies the throttle-prone retry profile to the CloudWatch client', async () => {
    const { getCloudWatchClient } = await import('./aws-clients.js');
    getCloudWatchClient();
    expect(cloudwatchConstructorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ retryMode: 'adaptive', maxAttempts: 8 }),
    );
  });

  it('applies the standard retry profile to a non-CloudWatch client', async () => {
    const { getEc2Client } = await import('./aws-clients.js');
    getEc2Client();
    expect(ec2ConstructorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ retryMode: 'standard', maxAttempts: 3 }),
    );
  });

  it('exposes exactly one getter per AWS service used in this codebase', async () => {
    const module = await import('./aws-clients.js');
    const expectedGetters = [
      'getApplicationAutoScalingClient',
      'getBackupClient',
      'getCloudWatchClient',
      'getCloudWatchLogsClient',
      'getComputeOptimizerClient',
      'getConfigServiceClient',
      'getCostExplorerClient',
      'getDlmClient',
      'getEc2Client',
      'getEcsClient',
      'getElasticLoadBalancingV2Client',
      'getEventBridgeClient',
      'getGuardDutyClient',
      'getLambdaClient',
      'getRdsClient',
      'getS3Client',
      'getSchedulerClient',
      'getSnsClient',
      'getSsmClient',
    ];
    for (const name of expectedGetters) {
      expect(typeof (module as Record<string, unknown>)[name]).toBe('function');
    }
  });
});
