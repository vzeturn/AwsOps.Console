import type { AssessmentReport, ComplianceData, ProtectionGap, RecommendationItem, TopologyData } from '@ops-dashboard/shared';
import { buildTopologyIndex } from '../../attribution.js';
import type { FindingsSnapshot } from '../types.js';

export const NOW = '2026-09-25T03:00:00.000Z';
export const REGION = 'ap-southeast-1';
export const ACCOUNT_ID = '123456789012';
export const VPC = 'vpc-0aaa1111';

/** prod VPC: 1 public subnet (1a), 2 private subnets (1a, 1b) both egressing via ONE NAT. */
export function buildTopology(overrides: Partial<TopologyData> = {}): TopologyData {
  return {
    region: REGION,
    accountId: ACCOUNT_ID,
    generatedAt: NOW,
    edges: [],
    unplacedResources: [],
    vpcs: [
      {
        vpcId: VPC,
        name: 'prod',
        cidrBlock: '10.0.0.0/16',
        isDefault: false,
        subnets: [
          { subnetId: 'subnet-0pub1a', name: 'public-1a', cidrBlock: '10.0.0.0/24', availabilityZone: 'ap-southeast-1a', tier: 'public', isPublic: true, availableIpCount: 250 },
          { subnetId: 'subnet-0prv1a', name: 'private-1a', cidrBlock: '10.0.1.0/24', availabilityZone: 'ap-southeast-1a', tier: 'private', isPublic: false, availableIpCount: 250, egressVia: { id: 'nat-0aaa', kind: 'natgw' } },
          { subnetId: 'subnet-0prv1b', name: 'private-1b', cidrBlock: '10.0.2.0/24', availabilityZone: 'ap-southeast-1b', tier: 'private', isPublic: false, availableIpCount: 250, egressVia: { id: 'nat-0aaa', kind: 'natgw' } },
        ],
      },
    ],
    resources: [
      { id: 'i-0web1', kind: 'ec2', name: 'web-1', state: 'running', vpcId: VPC, subnetIds: ['subnet-0prv1a'], availabilityZone: 'ap-southeast-1a' },
      { id: 'prod-db', kind: 'rds', name: 'prod-db', state: 'available', vpcId: VPC, subnetIds: ['subnet-0prv1b'], availabilityZone: 'ap-southeast-1b' },
      { id: 'nat-0aaa', kind: 'natgw', name: 'nat-a', state: 'available', vpcId: VPC, subnetIds: ['subnet-0pub1a'], availabilityZone: 'ap-southeast-1a' },
    ],
    ...overrides,
  };
}

export function buildSnapshot(overrides: Partial<FindingsSnapshot> = {}): FindingsSnapshot {
  const topology = overrides.topology ?? buildTopology();
  return {
    now: NOW,
    region: REGION,
    accountId: ACCOUNT_ID,
    topology,
    topologyIndex: buildTopologyIndex(topology),
    observedAt: {},
    ...overrides,
  };
}

export function buildAssessment(recommendations: RecommendationItem[], protectionGaps: ProtectionGap[] = []): AssessmentReport {
  return {
    account: ACCOUNT_ID,
    region: REGION,
    periodStart: '2026-08-25',
    periodEnd: '2026-09-24',
    generatedAt: NOW,
    compute: { lambda: [] },
    database: {},
    networking: { natGateways: [] },
    storage: { s3Buckets: [], ebsVolumes: [] },
    savingsPlans: { coverageByService: [] },
    backup: { protectionGaps },
    recommendations,
  };
}

export function buildRecommendation(overrides: Partial<RecommendationItem>): RecommendationItem {
  return {
    id: 'rec-1',
    category: 'compute' as RecommendationItem['category'],
    resourceType: 'ec2-instance',
    resourceId: 'i-0web1',
    resourceName: 'web-1',
    currentState: 'Average CPU 2% over 30 days',
    recommendedAction: 'Downsize to t3.small',
    estimatedMonthlySavingsUsd: 12,
    risk: 'low',
    priority: 'high',
    findingType: 'ec2LowCpu',
    ...overrides,
  };
}

/** Test-only: ComplianceData carries Config-era fields this feature never reads. */
export function buildCompliance(recentBackupJobs: ComplianceData['recentBackupJobs']): ComplianceData {
  return { recentBackupJobs, dlmPolicies: [], configRules: [], generatedAt: NOW, asOf: NOW } as unknown as ComplianceData;
}
