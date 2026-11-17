import { describe, it, expect } from 'vitest';
import type { SecurityGroupSummary } from '@ops-dashboard/shared';
import { VPC_FLOW_LOGS_DISABLED, DEFAULT_SG_NOT_EMPTY, SINGLE_NAT_MULTI_AZ, RDS_PUBLICLY_ACCESSIBLE, RDS_IN_PUBLIC_SUBNET } from './network-checks.js';
import { buildSnapshot, buildTopology, VPC } from '../__fixtures__/snapshot.js';
import type { RdsExposure } from '../types.js';

const rds = (overrides: Partial<RdsExposure> = {}): RdsExposure => ({
  dbInstanceIdentifier: 'prod-db',
  dbInstanceArn: 'arn:aws:rds:ap-southeast-1:123456789012:db:prod-db',
  publiclyAccessible: false,
  vpcId: VPC,
  subnetIds: ['subnet-0prv1a', 'subnet-0prv1b'],
  ...overrides,
});

describe('net.vpc-flow-logs-disabled', () => {
  it('fail: VPC with no active flow log', () => {
    const [d] = VPC_FLOW_LOGS_DISABLED.run(buildSnapshot({ flowLogResourceIds: [] }));
    expect(d).toMatchObject({ kpi: 'network', vpcId: VPC, resourceId: VPC, resourceArn: `arn:aws:ec2:ap-southeast-1:123456789012:vpc/${VPC}` });
  });

  it('pass: VPC with active flow log; empty default VPC is skipped', () => {
    expect(VPC_FLOW_LOGS_DISABLED.run(buildSnapshot({ flowLogResourceIds: [VPC] }))).toEqual([]);
    const withEmptyDefault = buildTopology();
    withEmptyDefault.vpcs.push({ vpcId: 'vpc-0def', name: 'default', cidrBlock: '172.31.0.0/16', isDefault: true, subnets: [] });
    expect(VPC_FLOW_LOGS_DISABLED.run(buildSnapshot({ topology: withEmptyDefault, flowLogResourceIds: [VPC] }))).toEqual([]);
  });
});

describe('net.default-sg-not-empty', () => {
  const defaultSg = (rules: number): SecurityGroupSummary => ({
    groupId: 'sg-0def',
    groupName: 'default',
    vpcId: VPC,
    description: 'default VPC security group',
    ingressRules: Array.from({ length: rules }, () => ({ protocol: '-1', fromPort: null, toPort: null, sourceLabel: 'sg-0def', removable: false })),
    egressRules: [],
  });

  it('fail: default SG with any rule', () => {
    expect(DEFAULT_SG_NOT_EMPTY.run(buildSnapshot({ securityGroups: [defaultSg(1)] }))[0]).toMatchObject({ vpcId: VPC, resourceId: 'sg-0def', isoControls: ['A.8.20'] });
  });

  it('pass: default SG with no rules, or a non-default SG with rules', () => {
    expect(DEFAULT_SG_NOT_EMPTY.run(buildSnapshot({ securityGroups: [defaultSg(0), { ...defaultSg(2), groupName: 'web' }] }))).toEqual([]);
  });
});

describe('net.single-nat-multi-az', () => {
  it('fail: private subnets in 2 AZs share one NAT -> resilience finding on the NAT', () => {
    const [d] = SINGLE_NAT_MULTI_AZ.run(buildSnapshot());
    expect(d).toMatchObject({ kpi: 'resilience', resourceId: 'nat-0aaa', vpcId: VPC, isoControls: ['A.5.30', 'A.8.14'] });
  });

  it('pass: one NAT per AZ', () => {
    const topology = buildTopology();
    topology.vpcs[0].subnets[2] = { ...topology.vpcs[0].subnets[2], egressVia: { id: 'nat-0bbb', kind: 'natgw' } };
    expect(SINGLE_NAT_MULTI_AZ.run(buildSnapshot({ topology }))).toEqual([]);
  });
});

describe('net.rds-publicly-accessible / net.rds-in-public-subnet', () => {
  it('fail: PubliclyAccessible=true -> high security finding', () => {
    expect(RDS_PUBLICLY_ACCESSIBLE.run(buildSnapshot({ rdsInstances: [rds({ publiclyAccessible: true })] }))[0]).toMatchObject({ kpi: 'security', severity: 'high' });
  });

  it('fail: DB placed in a public subnet', () => {
    const topology = buildTopology();
    topology.resources[1] = { ...topology.resources[1], subnetIds: ['subnet-0pub1a'] };
    expect(RDS_IN_PUBLIC_SUBNET.run(buildSnapshot({ topology, rdsInstances: [rds()] }))[0]).toMatchObject({ kpi: 'network', resourceId: 'prod-db' });
  });

  it('fail: unplaced DB whose subnet group contains a public subnet', () => {
    const topology = buildTopology({ resources: [] });
    expect(RDS_IN_PUBLIC_SUBNET.run(buildSnapshot({ topology, rdsInstances: [rds({ subnetIds: ['subnet-0pub1a', 'subnet-0prv1b'] })] }))).toHaveLength(1);
  });

  it('pass: private, non-public DB', () => {
    const snapshot = buildSnapshot({ rdsInstances: [rds()] });
    expect(RDS_PUBLICLY_ACCESSIBLE.run(snapshot)).toEqual([]);
    expect(RDS_IN_PUBLIC_SUBNET.run(snapshot)).toEqual([]);
  });
});
