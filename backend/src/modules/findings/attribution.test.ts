import { describe, it, expect } from 'vitest';
import type { TopologyData } from '@ops-dashboard/shared';
import { buildTopologyIndex, attributeResource } from './attribution.js';

const TOPOLOGY: TopologyData = {
  region: 'ap-southeast-1',
  generatedAt: '2026-09-25T03:00:00.000Z',
  edges: [],
  vpcs: [
    {
      vpcId: 'vpc-0aaa1111',
      name: 'prod',
      cidrBlock: '10.0.0.0/16',
      isDefault: false,
      subnets: [
        { subnetId: 'subnet-0prv1a', name: 'p1a', cidrBlock: '10.0.1.0/24', availabilityZone: 'ap-southeast-1a', tier: 'private', isPublic: false, availableIpCount: 200 },
      ],
    },
  ],
  resources: [{ id: 'i-0web1', kind: 'ec2', name: 'web-1', state: 'running', vpcId: 'vpc-0aaa1111', subnetIds: ['subnet-0prv1a'] }],
  unplacedResources: [{ id: 'my-bucket', kind: 's3', name: 'my-bucket', state: 'ok', subnetIds: [] }],
};

describe('attributeResource', () => {
  const index = buildTopologyIndex(TOPOLOGY);

  it('places a topology resource in its VPC/subnet and derives AZ from the subnet', () => {
    expect(attributeResource(index, 'i-0web1')).toEqual({ vpcId: 'vpc-0aaa1111', subnetId: 'subnet-0prv1a', az: 'ap-southeast-1a' });
  });

  it('attributes a VPC id and a subnet id to themselves', () => {
    expect(attributeResource(index, 'vpc-0aaa1111')).toEqual({ vpcId: 'vpc-0aaa1111' });
    expect(attributeResource(index, 'subnet-0prv1a')).toEqual({ vpcId: 'vpc-0aaa1111', subnetId: 'subnet-0prv1a', az: 'ap-southeast-1a' });
  });

  it('uses the caller hint (e.g. a security group vpcId) when the id is not in topology', () => {
    expect(attributeResource(index, 'sg-1', { vpcId: 'vpc-0aaa1111' })).toEqual({ vpcId: 'vpc-0aaa1111' });
  });

  it('falls back to the account scope for unattributable resources', () => {
    expect(attributeResource(index, 'my-bucket')).toEqual({ vpcId: 'account' });
    expect(attributeResource(index, '')).toEqual({ vpcId: 'account' });
  });

  it('records which VPCs actually contain resources', () => {
    expect(index.placedVpcIds.has('vpc-0aaa1111')).toBe(true);
  });
});
