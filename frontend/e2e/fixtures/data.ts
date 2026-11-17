/**
 * Fixture payloads for the mocked backend (`mockApi.ts`). Shapes match `@ops-dashboard/shared`'s
 * types exactly — kept in one file so every spec reads from the same known state instead of each
 * spec inventing its own slightly-different fixture.
 */

export const ME_OPERATOR = {
  sub: 'e2e-test-sub-0001',
  name: 'E2E Test User',
  email: 'e2e-test-user@example.test',
  isOperator: true,
};

export const EC2_RUNNING = {
  instanceId: 'i-0e2erunning0001',
  name: 'e2e-web-01',
  region: 'ap-southeast-1',
  state: 'running',
  instanceType: 't3.medium',
  platform: 'linux' as const,
  threshold: { level: 'ok' as const, reason: 'CPU utilization within normal range' },
  tags: { Name: 'e2e-web-01', Department: 'SALE' },
  securityGroupIds: ['sg-0e2eweb0001'],
};

export const EC2_STOPPED = {
  instanceId: 'i-0e2estopped0002',
  name: 'e2e-batch-02',
  region: 'ap-southeast-1',
  state: 'stopped',
  instanceType: 't3.large',
  platform: 'linux' as const,
  threshold: { level: 'ok' as const, reason: 'Instance is stopped' },
  tags: { Name: 'e2e-batch-02' },
  securityGroupIds: ['sg-0e2ebatch0002'],
};

export const RDS_AVAILABLE = {
  dbInstanceIdentifier: 'e2e-db-01',
  region: 'ap-southeast-1',
  status: 'available',
  engine: 'postgres',
  multiAz: false,
  freeStorageGb: 45.2,
  allocatedStorageGb: 100,
  threshold: { level: 'ok' as const, reason: 'Storage headroom is adequate' },
};

export const ALB_1 = {
  name: 'e2e-alb-01',
  region: 'ap-southeast-1',
  state: 'active',
  unhealthyTargets: 0,
  totalTargets: 2,
  threshold: { level: 'ok' as const, reason: 'All targets healthy' },
  arnSuffix: 'app/e2e-alb-01/abc123',
  targetGroups: [{ targetGroupName: 'e2e-tg-01', unhealthyTargets: 0, totalTargets: 2 }],
};

export const INFRA_DATA = {
  ec2: [EC2_RUNNING, EC2_STOPPED],
  rds: [RDS_AVAILABLE],
  alb: [ALB_1],
  generatedAt: new Date().toISOString(),
  asOf: new Date().toISOString(),
};

export const TOPOLOGY_DATA = {
  region: 'ap-southeast-1',
  accountId: '123456789012',
  vpcs: [
    {
      vpcId: 'vpc-0e2e0001',
      name: 'e2e-vpc',
      cidrBlock: '10.0.0.0/16',
      isDefault: false,
      subnets: [
        {
          subnetId: 'subnet-0e2e0001',
          name: 'e2e-public-a',
          cidrBlock: '10.0.1.0/24',
          availabilityZone: 'ap-southeast-1a',
          tier: 'public' as const,
          isPublic: true,
          availableIpCount: 250,
        },
      ],
    },
  ],
  edges: [],
  resources: [
    {
      id: EC2_RUNNING.instanceId,
      kind: 'ec2' as const,
      name: EC2_RUNNING.name,
      state: 'running',
      detail: EC2_RUNNING.instanceType,
      vpcId: 'vpc-0e2e0001',
      subnetIds: ['subnet-0e2e0001'],
      availabilityZone: 'ap-southeast-1a',
      monitoringType: 'ec2' as const,
    },
  ],
  unplacedResources: [],
  accountResources: [],
  generatedAt: new Date().toISOString(),
};

export const COMPLIANCE_DATA = {
  recentBackupJobs: [
    {
      jobId: 'backup-job-0001',
      resourceName: 'e2e-db-01',
      state: 'COMPLETED',
      creationDate: new Date().toISOString(),
      threshold: { level: 'ok' as const, reason: 'Backup completed successfully' },
    },
  ],
  dlmPolicies: [
    { policyId: 'policy-0001', description: 'Daily EBS snapshots', state: 'ENABLED', targetVolumeCount: 3 },
  ],
  configRules: [
    { ruleName: 'required-tags', complianceType: 'COMPLIANT', threshold: { level: 'ok' as const, reason: 'All resources tagged' } },
  ],
  configStatus: 'evaluated' as const,
  generatedAt: new Date().toISOString(),
  asOf: new Date().toISOString(),
};

export const COST_DATA = {
  monthToDateUsd: 1234.56,
  forecastMonthUsd: 2500.0,
  forecastAvailable: true,
  previousMonthUsd: 2100.0,
  byService: [
    { service: 'Amazon EC2', amountUsd: 600.12 },
    { service: 'Amazon RDS', amountUsd: 400.44 },
    { service: 'Amazon S3', amountUsd: 234.0 },
  ],
  threshold: { level: 'ok' as const, reason: 'On track vs. forecast' },
  cachedAt: new Date().toISOString(),
  dailyCostUsd: Array.from({ length: 5 }, (_, i) => ({
    date: new Date(Date.now() - (4 - i) * 86400000).toISOString().slice(0, 10),
    amountUsd: 40 + i * 2,
  })),
  monthlyHistory: [],
};

export const ASSESSMENT_REPORT = {
  account: '123456789012',
  region: 'ap-southeast-1',
  periodStart: new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10),
  periodEnd: new Date().toISOString().slice(0, 10),
  generatedAt: new Date().toISOString(),
  compute: { lambda: [] },
  database: {},
  networking: { natGateways: [] },
  storage: { s3Buckets: [], ebsVolumes: [] },
  savingsPlans: { coverageByService: [] },
  backup: { protectionGaps: [] },
  recommendations: [
    {
      id: 'rec-0001',
      category: 'storage' as const,
      resourceType: 'ebs-volume',
      resourceId: 'vol-0e2eunattached01',
      resourceName: 'vol-0e2eunattached01',
      currentState: 'unattached for 14 days',
      recommendedAction: 'Snapshot and delete this unattached volume',
      estimatedMonthlySavingsUsd: 8.5,
      risk: 'low' as const,
      priority: 'medium' as const,
      findingType: 'ebsVolumeUnattached' as const,
    },
    {
      id: 'rec-0002',
      category: 'database' as const,
      resourceType: 'rds-instance',
      resourceId: RDS_AVAILABLE.dbInstanceIdentifier,
      resourceName: RDS_AVAILABLE.dbInstanceIdentifier,
      currentState: 'Single-AZ',
      recommendedAction: 'Enable Multi-AZ for high availability',
      estimatedMonthlySavingsUsd: null,
      risk: 'low' as const,
      priority: 'low' as const,
      // No FINDING_TYPE_ACTION_OVERRIDES entry for rdsMissingMultiAz => manual-only, exercises the
      // "Manual only" (no button) branch of AssessmentPage.
      findingType: 'rdsMissingMultiAz' as const,
    },
  ],
};

export const MONITORING_DATA = {
  resources: [
    {
      resourceType: 'ec2' as const,
      resourceId: EC2_RUNNING.instanceId,
      resourceName: EC2_RUNNING.name,
      region: 'ap-southeast-1',
      metrics: [
        {
          name: 'CPUUtilization',
          value: 23.4,
          unit: 'Percent',
          threshold: { level: 'ok' as const, reason: 'Within normal range' },
          trend: [{ timestamp: new Date().toISOString(), value: 23.4 }],
          consoleLink: 'https://console.aws.amazon.com/cloudwatch/',
        },
      ],
    },
    {
      resourceType: 'ecs' as const,
      resourceId: 'e2e-cluster/e2e-service',
      resourceName: 'e2e-service',
      region: 'ap-southeast-1',
      metrics: [
        {
          name: 'CPUUtilization',
          value: 70.1,
          unit: 'Percent',
          threshold: { level: 'warn' as const, reason: 'Approaching capacity' },
          trend: [{ timestamp: new Date().toISOString(), value: 70.1 }],
          consoleLink: 'https://console.aws.amazon.com/ecs/',
        },
      ],
    },
  ],
  alerts: [
    {
      alarmName: 'e2e-high-cpu-alarm',
      state: 'OK' as const,
      threshold: { level: 'ok' as const, reason: 'Alarm is OK' },
      namespace: 'AWS/EC2',
      region: 'ap-southeast-1',
      consoleLink: 'https://console.aws.amazon.com/cloudwatch/',
      relatedResourceId: EC2_RUNNING.instanceId,
      metricName: 'CPUUtilization',
      comparisonOperator: 'above' as const,
    },
  ],
  generatedAt: new Date().toISOString(),
};

export const SECURITY_GROUPS_DATA = {
  groups: [
    {
      groupId: 'sg-0e2eweb0001',
      groupName: 'e2e-web-sg',
      vpcId: 'vpc-0e2e0001',
      description: 'Web tier security group',
      ingressRules: [
        {
          ruleId: 'sgr-0001',
          protocol: 'tcp',
          fromPort: 443,
          toPort: 443,
          cidrIp: '0.0.0.0/0',
          sourceLabel: '0.0.0.0/0',
          removable: true,
          description: 'HTTPS from anywhere',
        },
      ],
      egressRules: [
        {
          ruleId: 'sgr-0002',
          protocol: '-1',
          fromPort: null,
          toPort: null,
          cidrIp: '0.0.0.0/0',
          sourceLabel: '0.0.0.0/0',
          removable: false,
          description: 'Default allow-all egress',
        },
      ],
    },
  ],
  truncated: false,
};

export const LOG_GROUPS_DATA = {
  groups: [
    { logGroupName: '/aws/lambda/e2e-router-fn', retentionInDays: null, storedBytes: 5_242_880 },
    { logGroupName: '/aws/lambda/e2e-action-fn', retentionInDays: 30, storedBytes: 1_048_576 },
  ],
  truncated: false,
};

export const LOG_EVENTS_PAGE = {
  events: [
    { eventId: 'evt-0001', timestamp: Date.now() - 60_000, logStreamName: 'stream-1', message: 'START RequestId: e2e-test' },
    { eventId: 'evt-0002', timestamp: Date.now() - 30_000, logStreamName: 'stream-1', message: 'END RequestId: e2e-test' },
  ],
  truncatedMessageCount: 0,
};

export const SCHEDULED_ACTIONS_DATA = {
  recurringRules: [
    {
      name: 'e2e-nightly-downsize',
      scheduleExpression: 'cron(0 20 * * ? *)',
      state: 'ENABLED' as const,
      targetFunctionName: 'e2e-scheduler-fn',
      description: 'Nightly EC2 downsize',
    },
  ],
  oneTimeSchedules: [
    {
      name: 'e2e-one-time-0001',
      runAtIso: new Date(Date.now() + 3600_000).toISOString(),
      actionAfterCompletion: 'DELETE' as const,
      targetFunctionName: 'e2e-scheduler-fn',
      ec2: { instanceId: EC2_RUNNING.instanceId, targetType: 't3.small' },
    },
  ],
};

export const ACTION_AUDIT_RECORDS = [
  {
    executedBy: 'e2e-test-user@example.test',
    executedAt: new Date(Date.now() - 86400000).toISOString(),
    actionType: 'EC2_Reboot' as const,
    resource: { id: EC2_RUNNING.instanceId, arn: `arn:aws:ec2:ap-southeast-1:123456789012:instance/${EC2_RUNNING.instanceId}`, region: 'ap-southeast-1' },
    params: {},
    outcome: 'success' as const,
  },
];
