import type { RecommendationFindingType } from '@ops-dashboard/shared';
import { COST_PRIORITY_SEVERITY } from '../../defaults.js';
import { recommendationCheck } from '../recommendation-check.js';
import type { CheckDefinition } from '../types.js';

/** Adapter over the existing cost/idle-waste recommendations (assessment-report.json). */
export const COST_RULES: ReadonlyArray<{ findingType: RecommendationFindingType; checkId: string; title: string; isoControls: string[] }> = [
  { findingType: 'ec2LowCpu', checkId: 'cost.ec2-low-cpu', title: 'EC2 instance is underutilised', isoControls: [] },
  { findingType: 'ec2Stopped', checkId: 'cost.ec2-stopped', title: 'EC2 instance stopped long-term (still paying for EBS)', isoControls: [] },
  { findingType: 'rdsLowCpu', checkId: 'cost.rds-low-cpu', title: 'RDS instance is underutilised', isoControls: [] },
  { findingType: 'rdsLowConnections', checkId: 'cost.rds-low-connections', title: 'RDS instance has almost no connections', isoControls: [] },
  { findingType: 'natGatewayLowThroughput', checkId: 'cost.nat-gateway-low-throughput', title: 'NAT gateway carries almost no traffic', isoControls: [] },
  { findingType: 'ebsVolumeUnattached', checkId: 'cost.ebs-volume-unattached', title: 'EBS volume is unattached', isoControls: [] },
  { findingType: 'ebsVolumeGp2ShouldBeGp3', checkId: 'cost.ebs-gp2-to-gp3', title: 'EBS volume is gp2 (gp3 is cheaper)', isoControls: [] },
  { findingType: 's3BucketNoLifecyclePolicy', checkId: 'cost.s3-no-lifecycle', title: 'S3 bucket has no lifecycle policy', isoControls: [] },
  { findingType: 'cloudWatchLogGroupNoRetention', checkId: 'cost.log-group-no-retention', title: 'Log group keeps data forever', isoControls: ['A.8.15'] },
  { findingType: 'elasticIpUnused', checkId: 'cost.elastic-ip-unused', title: 'Elastic IP is not associated', isoControls: [] },
  { findingType: 'savingsPlanCoverageLow', checkId: 'cost.savings-plan-coverage-low', title: 'Savings Plan coverage is low', isoControls: [] },
];

export const COST_CHECKS: CheckDefinition[] = COST_RULES.map((rule) =>
  recommendationCheck(
    {
      checkId: rule.checkId,
      source: 'cost',
      kpi: 'cost',
      isoControls: rule.isoControls,
      requires: ['topology', 'assessment'],
      title: rule.title,
      impact: 'Paying for capacity or storage that delivers no value.',
      remediation: ['Review the recommendation on the Cost/Assessment page and apply it through the approval workflow.'],
    },
    rule.findingType,
    (rec) => COST_PRIORITY_SEVERITY[rec.priority],
  ),
);
