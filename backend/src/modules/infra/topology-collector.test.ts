import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.AWS_REGION = 'ap-southeast-1';

const ec2SendMock = vi.fn();
const rdsSendMock = vi.fn();
const elbSendMock = vi.fn();
const ecsSendMock = vi.fn();

const s3SendMock = vi.fn();

vi.mock('@aws-sdk/client-ec2', () => ({
  EC2Client: vi.fn().mockImplementation(() => ({ send: ec2SendMock })),
  DescribeVpcsCommand: vi.fn().mockImplementation((input: unknown) => ({ __t: 'Vpcs', input })),
  DescribeSubnetsCommand: vi.fn().mockImplementation((input: unknown) => ({ __t: 'Subnets', input })),
  DescribeRouteTablesCommand: vi.fn().mockImplementation((input: unknown) => ({ __t: 'RouteTables', input })),
  DescribeInstancesCommand: vi.fn().mockImplementation((input: unknown) => ({ __t: 'Instances', input })),
  DescribeNatGatewaysCommand: vi.fn().mockImplementation((input: unknown) => ({ __t: 'Nat', input })),
  DescribeTransitGatewaysCommand: vi.fn().mockImplementation((input: unknown) => ({ __t: 'Tgw', input })),
  DescribeTransitGatewayVpcAttachmentsCommand: vi
    .fn()
    .mockImplementation((input: unknown) => ({ __t: 'TgwAttachments', input })),
}));
vi.mock('@aws-sdk/client-rds', () => ({
  RDSClient: vi.fn().mockImplementation(() => ({ send: rdsSendMock })),
  DescribeDBInstancesCommand: vi.fn().mockImplementation((input: unknown) => ({ __t: 'Db', input })),
}));
// S3 is mocked the same way as every other client here — a test that forgets this mock must fail
// loudly (an unmocked `S3Client` making a REAL network call in a unit test), never silently succeed
// against a real AWS account.
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({ send: s3SendMock })),
  ListBucketsCommand: vi.fn().mockImplementation((input: unknown) => ({ __t: 'Buckets', input })),
}));
vi.mock('@aws-sdk/client-elastic-load-balancing-v2', () => ({
  ElasticLoadBalancingV2Client: vi.fn().mockImplementation(() => ({ send: elbSendMock })),
  DescribeLoadBalancersCommand: vi.fn().mockImplementation((input: unknown) => ({ __t: 'Lb', input })),
  DescribeTargetGroupsCommand: vi.fn().mockImplementation((input: unknown) => ({ __t: 'Tg', input })),
  DescribeTargetHealthCommand: vi.fn().mockImplementation((input: unknown) => ({ __t: 'Th', input })),
}));
vi.mock('@aws-sdk/client-ecs', () => ({
  ECSClient: vi.fn().mockImplementation(() => ({ send: ecsSendMock })),
  ListClustersCommand: vi.fn().mockImplementation((input: unknown) => ({ __t: 'Clusters', input })),
  ListServicesCommand: vi.fn().mockImplementation((input: unknown) => ({ __t: 'Services', input })),
  DescribeServicesCommand: vi.fn().mockImplementation((input: unknown) => ({ __t: 'DescServices', input })),
}));

const { collectTopology } = await import('./topology-collector.js');

/** One VPC, two AZs, one public + one private subnet. The public subnet's route table has a default
 *  route to an IGW; the private one's goes to a NAT gateway, which must NOT count as public. */
function baseNetwork() {
  return {
    Vpcs: [{ VpcId: 'vpc-1', CidrBlock: '10.0.0.0/16', IsDefault: false, Tags: [{ Key: 'Name', Value: 'prod-vpc' }] }],
    Subnets: [
      { SubnetId: 'subnet-pub', VpcId: 'vpc-1', CidrBlock: '10.0.1.0/24', AvailabilityZone: 'ap-southeast-1a', AvailableIpAddressCount: 250, Tags: [{ Key: 'Name', Value: 'public-1a' }] },
      { SubnetId: 'subnet-priv', VpcId: 'vpc-1', CidrBlock: '10.0.2.0/24', AvailabilityZone: 'ap-southeast-1b', AvailableIpAddressCount: 200, Tags: [{ Key: 'Name', Value: 'private-1b' }] },
    ],
    RouteTables: [
      {
        VpcId: 'vpc-1',
        Associations: [{ SubnetId: 'subnet-pub' }],
        Routes: [{ DestinationCidrBlock: '0.0.0.0/0', GatewayId: 'igw-abc', State: 'active' }],
      },
      {
        VpcId: 'vpc-1',
        Associations: [{ SubnetId: 'subnet-priv' }],
        Routes: [{ DestinationCidrBlock: '0.0.0.0/0', NatGatewayId: 'nat-abc', State: 'active' }],
      },
    ],
  };
}

function wireEc2(overrides: Record<string, unknown> = {}) {
  const net = { ...baseNetwork(), Instances: [], Nat: [], TransitGateways: [], TgwAttachments: [], ...overrides };
  ec2SendMock.mockImplementation(async (cmd: { __t: string }) => {
    switch (cmd.__t) {
      case 'Vpcs':
        return { Vpcs: net.Vpcs };
      case 'Subnets':
        return { Subnets: net.Subnets };
      case 'RouteTables':
        return { RouteTables: net.RouteTables };
      case 'Instances':
        return { Reservations: [{ Instances: net.Instances }] };
      case 'Nat':
        return { NatGateways: net.Nat };
      case 'Tgw':
        return { TransitGateways: net.TransitGateways };
      case 'TgwAttachments':
        return { TransitGatewayVpcAttachments: net.TgwAttachments };
      default:
        return {};
    }
  });
}

beforeEach(() => {
  ec2SendMock.mockReset();
  rdsSendMock.mockReset();
  elbSendMock.mockReset();
  ecsSendMock.mockReset();
  s3SendMock.mockReset();
  rdsSendMock.mockResolvedValue({ DBInstances: [] });
  elbSendMock.mockResolvedValue({ LoadBalancers: [] });
  ecsSendMock.mockResolvedValue({ clusterArns: [] });
  s3SendMock.mockResolvedValue({ Buckets: [] });
  wireEc2();
});

describe('collectTopology — account id', () => {
  it('carries AWS_ACCOUNT_ID through, for labelling the Infra Map account frame only', async () => {
    process.env.AWS_ACCOUNT_ID = '123456789012';
    const data = await collectTopology();
    expect(data.accountId).toBe('123456789012');
    delete process.env.AWS_ACCOUNT_ID;
  });

  it('does not throw when AWS_ACCOUNT_ID is missing — a cosmetic label, not a required input', async () => {
    delete process.env.AWS_ACCOUNT_ID;
    const data = await collectTopology();
    expect(data.accountId).toBeUndefined();
  });
});

describe('collectTopology — public/private is derived from route tables, never from names', () => {
  it('a default route via an internet gateway makes the subnet public', async () => {
    const data = await collectTopology();
    const pub = data.vpcs[0].subnets.find((s) => s.subnetId === 'subnet-pub');
    expect(pub?.isPublic).toBe(true);
  });

  it('a default route via a NAT gateway does NOT make the subnet public', async () => {
    // The whole point: most private subnets DO reach the internet, through NAT. Treating any default
    // route as internet access would mislabel them and misrepresent the security posture.
    const data = await collectTopology();
    const priv = data.vpcs[0].subnets.find((s) => s.subnetId === 'subnet-priv');
    expect(priv?.isPublic).toBe(false);
  });

  it('a subnet with NO explicit association falls back to the VPC main route table', async () => {
    const net = baseNetwork();
    net.RouteTables = [
      {
        VpcId: 'vpc-1',
        Associations: [{ Main: true }],
        Routes: [{ DestinationCidrBlock: '0.0.0.0/0', GatewayId: 'igw-main', State: 'active' }],
      },
    ] as never;
    wireEc2({ RouteTables: net.RouteTables });

    const data = await collectTopology();
    expect(data.vpcs[0].subnets.every((s) => s.isPublic)).toBe(true);
  });

  it('a subnet whose name says "public" but routes only via NAT is reported PRIVATE', async () => {
    const net = baseNetwork();
    net.Subnets[1].Tags = [{ Key: 'Name', Value: 'public-but-actually-not' }];
    wireEc2({ Subnets: net.Subnets });

    const data = await collectTopology();
    const misnamed = data.vpcs[0].subnets.find((s) => s.subnetId === 'subnet-priv');
    expect(misnamed?.name).toBe('public-but-actually-not');
    expect(misnamed?.isPublic).toBe(false);
  });

  it('IPv6 ::/0 via an internet gateway also counts as public', async () => {
    const net = baseNetwork();
    net.RouteTables[1].Routes = [
      { DestinationIpv6CidrBlock: '::/0', GatewayId: 'igw-v6', State: 'active' },
    ] as never;
    wireEc2({ RouteTables: net.RouteTables });

    const data = await collectTopology();
    expect(data.vpcs[0].subnets.find((s) => s.subnetId === 'subnet-priv')?.isPublic).toBe(true);
  });

  it('a BLACKHOLE route to a detached internet gateway is NOT public', async () => {
    // Found on the real account (abc-prod, 2026-09-07), not invented for the test: the default VPC
    // vpc-0a1b2c3d still had `0.0.0.0/0 -> igw-0a1b2c3d` in its main route table after that gateway
    // was attached to a DIFFERENT VPC. AWS leaves the orphaned route behind with State 'blackhole'.
    //
    // The first version of this collector ignored State and reported both of that VPC's subnets as
    // PUBLIC. For a security-facing diagram that error direction is the worse one: it invents exposure
    // that does not exist.
    const net = baseNetwork();
    net.RouteTables = [
      {
        VpcId: 'vpc-1',
        Associations: [{ Main: true }],
        Routes: [
          { DestinationCidrBlock: '10.0.0.0/16', GatewayId: 'local', State: 'active' },
          { DestinationCidrBlock: '0.0.0.0/0', GatewayId: 'igw-0a1b2c3d', State: 'blackhole' },
        ],
      },
    ] as never;
    wireEc2({ RouteTables: net.RouteTables });

    const data = await collectTopology();
    expect(data.vpcs[0].subnets.every((s) => s.isPublic)).toBe(false);
    expect(data.vpcs[0].subnets.some((s) => s.isPublic)).toBe(false);
  });

  it('a route with no State at all is treated as NOT usable (fail towards private)', async () => {
    // Unknown connectivity must not be reported as internet exposure.
    const net = baseNetwork();
    net.RouteTables[1].Routes = [{ DestinationCidrBlock: '0.0.0.0/0', GatewayId: 'igw-x' }] as never;
    wireEc2({ RouteTables: net.RouteTables });

    const data = await collectTopology();
    expect(data.vpcs[0].subnets.find((s) => s.subnetId === 'subnet-priv')?.isPublic).toBe(false);
  });
});

describe('collectTopology — resource placement', () => {
  it('places an EC2 instance in its subnet and skips terminated ones', async () => {
    wireEc2({
      Instances: [
        { InstanceId: 'i-live', State: { Name: 'running' }, InstanceType: 't3.small', VpcId: 'vpc-1', SubnetId: 'subnet-priv', Placement: { AvailabilityZone: 'ap-southeast-1b' }, Tags: [{ Key: 'Name', Value: 'app' }] },
        // Terminated instances linger in DescribeInstances for up to an hour but no longer occupy the
        // subnet; drawing them would show capacity that does not exist.
        { InstanceId: 'i-dead', State: { Name: 'terminated' }, VpcId: 'vpc-1', SubnetId: 'subnet-priv' },
      ],
    });

    const data = await collectTopology();
    const ids = data.resources.map((r) => r.id);
    expect(ids).toContain('i-live');
    expect(ids).not.toContain('i-dead');
    expect(data.resources.find((r) => r.id === 'i-live')?.subnetIds).toEqual(['subnet-priv']);
    expect(data.resources.find((r) => r.id === 'i-live')?.monitoringType).toBe('ec2');
  });

  it('an ALB spans every subnet it is attached to', async () => {
    elbSendMock.mockResolvedValue({
      LoadBalancers: [
        {
          LoadBalancerName: 'prod-alb',
          Type: 'application',
          State: { Code: 'active' },
          VpcId: 'vpc-1',
          AvailabilityZones: [{ SubnetId: 'subnet-pub' }, { SubnetId: 'subnet-priv' }],
        },
      ],
    });

    const data = await collectTopology();
    const albRes = data.resources.find((r) => r.id === 'prod-alb');
    expect(albRes?.kind).toBe('alb');
    expect(albRes?.subnetIds).toEqual(['subnet-pub', 'subnet-priv']);
  });

  it('a network load balancer is drawn but gets no monitoringType', async () => {
    // /monitoring only covers ALBs (AWS/ApplicationELB). An NLB still belongs on the map — omitting
    // it would hide a real component — it just is not clickable through to metrics.
    elbSendMock.mockResolvedValue({
      LoadBalancers: [
        { LoadBalancerName: 'kafka-nlb', Type: 'network', State: { Code: 'active' }, VpcId: 'vpc-1', AvailabilityZones: [{ SubnetId: 'subnet-priv' }] },
      ],
    });

    const data = await collectTopology();
    const nlb = data.resources.find((r) => r.id === 'kafka-nlb');
    expect(nlb?.kind).toBe('nlb');
    expect(nlb?.monitoringType).toBeUndefined();
  });

  it('an RDS instance reports every subnet of its subnet group', async () => {
    rdsSendMock.mockResolvedValue({
      DBInstances: [
        {
          DBInstanceIdentifier: 'prod-db',
          DBInstanceStatus: 'available',
          Engine: 'postgres',
          DBInstanceClass: 'db.m7g.xlarge',
          AvailabilityZone: 'ap-southeast-1b',
          DBSubnetGroup: { VpcId: 'vpc-1', Subnets: [{ SubnetIdentifier: 'subnet-pub' }, { SubnetIdentifier: 'subnet-priv' }] },
        },
      ],
    });

    const data = await collectTopology();
    const db = data.resources.find((r) => r.id === 'prod-db');
    expect(db?.subnetIds).toEqual(['subnet-pub', 'subnet-priv']);
    expect(db?.availabilityZone).toBe('ap-southeast-1b');
    expect(db?.detail).toContain('postgres');
  });

  it('merges RDS instances across multiple pages when DescribeDBInstances returns a Marker', async () => {
    rdsSendMock
      .mockResolvedValueOnce({
        DBInstances: [
          {
            DBInstanceIdentifier: 'db-page1',
            DBInstanceStatus: 'available',
            Engine: 'postgres',
            DBInstanceClass: 'db.t3.medium',
            AvailabilityZone: 'ap-southeast-1a',
            DBSubnetGroup: { VpcId: 'vpc-1', Subnets: [{ SubnetIdentifier: 'subnet-pub' }] },
          },
        ],
        Marker: 'marker-page-2',
      })
      .mockResolvedValueOnce({
        DBInstances: [
          {
            DBInstanceIdentifier: 'db-page2',
            DBInstanceStatus: 'available',
            Engine: 'mysql',
            DBInstanceClass: 'db.t3.small',
            AvailabilityZone: 'ap-southeast-1b',
            DBSubnetGroup: { VpcId: 'vpc-1', Subnets: [{ SubnetIdentifier: 'subnet-priv' }] },
          },
        ],
      });

    const data = await collectTopology();
    expect(data.resources.map((r) => r.id)).toEqual(expect.arrayContaining(['db-page1', 'db-page2']));
    expect(rdsSendMock).toHaveBeenCalledTimes(2);
  });

  it('merges load balancer PLACEMENT across multiple pages when DescribeLoadBalancers returns a NextMarker', async () => {
    // Same note as the "INGRESS edges" test below: branch on Marker presence, not a global call
    // counter, since loadLoadBalancerEdges and loadLoadBalancerPlacement each run their own
    // independent fetchAllPages loop against this same mock.
    elbSendMock.mockImplementation(async (cmd: { __t: string; input?: { Marker?: string } }) => {
      if (cmd.__t === 'Lb') {
        if (!cmd.input?.Marker) {
          return {
            LoadBalancers: [{ LoadBalancerName: 'lb-placement-page1', Type: 'application', VpcId: 'vpc-1' }],
            NextMarker: 'marker-page-2',
          };
        }
        return { LoadBalancers: [{ LoadBalancerName: 'lb-placement-page2', Type: 'network', VpcId: 'vpc-1' }] };
      }
      if (cmd.__t === 'Tg') return { TargetGroups: [] };
      return {};
    });

    const data = await collectTopology();
    const allIds = [...data.resources, ...data.unplacedResources].map((r) => r.id);
    expect(allIds).toEqual(expect.arrayContaining(['lb-placement-page1', 'lb-placement-page2']));
  });

  it('an ECS service without awsvpc networking is reported UNPLACED, not drawn somewhere arbitrary', async () => {
    ecsSendMock.mockImplementation(async (cmd: { __t: string }) => {
      if (cmd.__t === 'Clusters') return { clusterArns: ['arn:aws:ecs:ap-southeast-1:1:cluster/prod'] };
      if (cmd.__t === 'Services') return { serviceArns: ['arn:aws:ecs:ap-southeast-1:1:service/prod/api'] };
      return {
        services: [
          { serviceName: 'api', status: 'ACTIVE', runningCount: 2, desiredCount: 2, networkConfiguration: undefined },
        ],
      };
    });

    const data = await collectTopology();
    expect(data.resources.find((r) => r.id === 'prod/api')).toBeUndefined();
    expect(data.unplacedResources.map((r) => r.id)).toContain('prod/api');
  });

  it('a resource in an unknown subnet becomes unplaced rather than being silently dropped', async () => {
    // Silently omitting a resource would make an incomplete map look complete — the same class of
    // failure as a metric that reports 0 when it has no data.
    wireEc2({
      Instances: [
        { InstanceId: 'i-elsewhere', State: { Name: 'running' }, VpcId: 'vpc-other', SubnetId: 'subnet-gone' },
      ],
    });

    const data = await collectTopology();
    expect(data.resources.find((r) => r.id === 'i-elsewhere')).toBeUndefined();
    expect(data.unplacedResources.map((r) => r.id)).toContain('i-elsewhere');
  });
});

describe('collectTopology — subnet tier is the architectural role', () => {
  it('igw route -> public, nat route -> private', async () => {
    const data = await collectTopology();
    const byId = new Map(data.vpcs[0].subnets.map((s) => [s.subnetId, s]));
    expect(byId.get('subnet-pub')?.tier).toBe('public');
    expect(byId.get('subnet-priv')?.tier).toBe('private');
    expect(byId.get('subnet-priv')?.egressVia).toEqual({ id: 'nat-abc', kind: 'natgw' });
  });

  it('no usable default route at all -> isolated (the data tier)', async () => {
    const net = baseNetwork();
    net.RouteTables = [
      {
        VpcId: 'vpc-1',
        Associations: [{ Main: true }],
        Routes: [{ DestinationCidrBlock: '10.0.0.0/16', GatewayId: 'local', State: 'active' }],
      },
    ] as never;
    wireEc2({ RouteTables: net.RouteTables });

    const data = await collectTopology();
    expect(data.vpcs[0].subnets.every((s) => s.tier === 'isolated')).toBe(true);
    expect(data.vpcs[0].subnets.every((s) => s.egressVia === undefined)).toBe(true);
  });

  it('both an igw AND a nat route -> public, because direct reachability dominates', async () => {
    const net = baseNetwork();
    net.RouteTables[1].Routes = [
      { DestinationCidrBlock: '0.0.0.0/0', NatGatewayId: 'nat-abc', State: 'active' },
      // IPv6 default routes arrive on their OWN field. Writing '::/0' into `DestinationCidrBlock`, as an
      // earlier version of this fixture did, is not how AWS reports it, and the test then passed for the
      // wrong reason: the route was ignored entirely rather than recognised as internet-facing.
      { DestinationIpv6CidrBlock: '::/0', GatewayId: 'igw-abc', State: 'active' },
    ] as never;
    wireEc2({ RouteTables: net.RouteTables });

    const data = await collectTopology();
    const priv = data.vpcs[0].subnets.find((s) => s.subnetId === 'subnet-priv');
    expect(priv?.tier).toBe('public');
    // ...and NO egress NAT is reported, even though the NAT route is still in the table. The field means
    // "the NAT this tier leaves through", which only makes sense for the private tier: a public subnet's
    // egress is its internet gateway, so drawing a NAT arrow out of the edge band would name the wrong
    // path.
    expect(priv?.egressVia).toBeUndefined();
  });

  it('a blackholed nat route does not make a subnet private', async () => {
    const net = baseNetwork();
    net.RouteTables[1].Routes = [
      { DestinationCidrBlock: '0.0.0.0/0', NatGatewayId: 'nat-gone', State: 'blackhole' },
    ] as never;
    wireEc2({ RouteTables: net.RouteTables });

    const data = await collectTopology();
    const sn = data.vpcs[0].subnets.find((s) => s.subnetId === 'subnet-priv');
    expect(sn?.tier).toBe('isolated');
    expect(sn?.egressVia).toBeUndefined();
  });

  it('an EC2 NAT instance route -> private, pointing at the INSTANCE', async () => {
    // The abc-uat-vpc case. A managed NAT gateway appears as `NatGatewayId`; an EC2 NAT instance appears
    // as `InstanceId` + `NetworkInterfaceId` with no `NatGatewayId` at all. Matching only on
    // `NatGatewayId`, as this collector originally did, classified all seven abc-uat subnets `isolated` —
    // the map would have said they have no way out while they were reaching the internet fine.
    const net = baseNetwork();
    net.RouteTables[1].Routes = [
      {
        DestinationCidrBlock: '0.0.0.0/0',
        InstanceId: 'i-nat',
        NetworkInterfaceId: 'eni-nat',
        InstanceOwnerId: '123456789012',
        State: 'active',
      },
    ] as never;
    wireEc2({
      RouteTables: net.RouteTables,
      Instances: [{ InstanceId: 'i-nat', State: { Name: 'running' }, VpcId: 'vpc-1', SubnetId: 'subnet-pub' }],
    });

    const data = await collectTopology();
    const priv = data.vpcs[0].subnets.find((s) => s.subnetId === 'subnet-priv');
    expect(priv?.tier).toBe('private');
    // The INSTANCE id, not the ENI: the instance is a node on the map, the ENI is not.
    expect(priv?.egressVia).toEqual({ id: 'i-nat', kind: 'instance' });
    expect(data.edges).toEqual(
      expect.arrayContaining([{ from: 'subnet-priv', to: 'i-nat', kind: 'egress-via' }]),
    );
  });

  it('a STOPPED NAT instance makes the subnet isolated, because AWS blackholes the route', async () => {
    // Not a hypothetical: stopping or terminating the NAT instance leaves the route in place with
    // State='blackhole'. Reporting the subnet as private then would claim working egress that does not
    // exist, and hide the actual outage behind a normal-looking diagram.
    const net = baseNetwork();
    net.RouteTables[1].Routes = [
      { DestinationCidrBlock: '0.0.0.0/0', InstanceId: 'i-nat', NetworkInterfaceId: 'eni-nat', State: 'blackhole' },
    ] as never;
    wireEc2({ RouteTables: net.RouteTables });

    const data = await collectTopology();
    const priv = data.vpcs[0].subnets.find((s) => s.subnetId === 'subnet-priv');
    expect(priv?.tier).toBe('isolated');
    expect(priv?.egressVia).toBeUndefined();
  });

  it('reports tgwId when a subnet routes a specific CIDR through a Transit Gateway', async () => {
    // The realistic shape: a TGW route is usually NOT the default route, so this must be detected
    // independently of `egressVia`/`tier`, across every route in the table.
    const net = baseNetwork();
    net.RouteTables[1].Routes = [
      ...net.RouteTables[1].Routes,
      { DestinationCidrBlock: '10.99.0.0/16', TransitGatewayId: 'tgw-1', State: 'active' },
    ] as never;
    wireEc2({ RouteTables: net.RouteTables });

    const data = await collectTopology();
    const priv = data.vpcs[0].subnets.find((s) => s.subnetId === 'subnet-priv');
    expect(priv?.tgwId).toBe('tgw-1');
    // The tier/egress classification is untouched by this — the route is non-default, so it plays
    // no part in deciding public/private/isolated or the NAT egress target.
    expect(priv?.tier).toBe('private');
    expect(priv?.egressVia).toEqual({ id: 'nat-abc', kind: 'natgw' });
  });

  it('does not report tgwId when no route in the table names a Transit Gateway', async () => {
    const data = await collectTopology();
    expect(data.vpcs[0].subnets.find((s) => s.subnetId === 'subnet-priv')?.tgwId).toBeUndefined();
  });

  it('ignores a blackholed Transit Gateway route when reporting tgwId', async () => {
    const net = baseNetwork();
    net.RouteTables[1].Routes = [
      ...net.RouteTables[1].Routes,
      { DestinationCidrBlock: '10.99.0.0/16', TransitGatewayId: 'tgw-stale', State: 'blackhole' },
    ] as never;
    wireEc2({ RouteTables: net.RouteTables });

    const data = await collectTopology();
    expect(data.vpcs[0].subnets.find((s) => s.subnetId === 'subnet-priv')?.tgwId).toBeUndefined();
  });

  it('a public subnet can also report tgwId — the field is independent of tier', async () => {
    const net = baseNetwork();
    net.RouteTables[0].Routes = [
      ...net.RouteTables[0].Routes,
      { DestinationCidrBlock: '10.99.0.0/16', TransitGatewayId: 'tgw-1', State: 'active' },
    ] as never;
    wireEc2({ RouteTables: net.RouteTables });

    const data = await collectTopology();
    const pub = data.vpcs[0].subnets.find((s) => s.subnetId === 'subnet-pub');
    expect(pub?.tier).toBe('public');
    expect(pub?.tgwId).toBe('tgw-1');
  });

  it('a transit-gateway default route is private with no drawable target, not isolated', async () => {
    // It plainly has a way out, so `isolated` would be false. But there is no transit-gateway node on
    // this map, so no arrow is invented for it.
    const net = baseNetwork();
    net.RouteTables[1].Routes = [
      { DestinationCidrBlock: '0.0.0.0/0', TransitGatewayId: 'tgw-abc', State: 'active' },
    ] as never;
    wireEc2({ RouteTables: net.RouteTables });

    const data = await collectTopology();
    const priv = data.vpcs[0].subnets.find((s) => s.subnetId === 'subnet-priv');
    expect(priv?.tier).toBe('private');
    expect(priv?.egressVia).toBeUndefined();
    expect(data.edges.some((e) => e.kind === 'egress-via')).toBe(false);
  });

  it('isPublic stays consistent with tier for existing consumers', async () => {
    const data = await collectTopology();
    for (const subnet of data.vpcs[0].subnets) {
      expect(subnet.isPublic).toBe(subnet.tier === 'public');
    }
  });
});

describe('collectTopology — edges are derived, never invented', () => {
  function wireLoadBalancer(targets: { Id: string }[], scheme = 'internet-facing') {
    elbSendMock.mockImplementation(async (cmd: { __t: string }) => {
      if (cmd.__t === 'Lb') {
        return {
          LoadBalancers: [
            {
              LoadBalancerName: 'edge-alb',
              Type: 'application',
              Scheme: scheme,
              State: { Code: 'active' },
              VpcId: 'vpc-1',
              LoadBalancerArn: 'arn:lb',
              AvailabilityZones: [{ SubnetId: 'subnet-pub' }],
            },
          ],
        };
      }
      if (cmd.__t === 'Tg') return { TargetGroups: [{ TargetGroupArn: 'arn:tg' }] };
      if (cmd.__t === 'Th') return { TargetHealthDescriptions: targets.map((t) => ({ Target: t })) };
      return {};
    });
  }

  it('an internet-facing load balancer gets an ingress edge from the internet node', async () => {
    wireEc2({ Instances: [{ InstanceId: 'i-web', State: { Name: 'running' }, VpcId: 'vpc-1', SubnetId: 'subnet-priv' }] });
    wireLoadBalancer([{ Id: 'i-web' }]);

    const data = await collectTopology();
    expect(data.edges).toEqual(
      expect.arrayContaining([{ from: 'internet', to: 'edge-alb', kind: 'ingress-from' }]),
    );
  });

  it('an internal load balancer gets NO ingress edge', async () => {
    wireEc2({ Instances: [{ InstanceId: 'i-web', State: { Name: 'running' }, VpcId: 'vpc-1', SubnetId: 'subnet-priv' }] });
    wireLoadBalancer([{ Id: 'i-web' }], 'internal');

    const data = await collectTopology();
    expect(data.edges.some((e) => e.kind === 'ingress-from')).toBe(false);
  });

  it('an instance target becomes a balances-to edge to that instance', async () => {
    wireEc2({ Instances: [{ InstanceId: 'i-web', State: { Name: 'running' }, VpcId: 'vpc-1', SubnetId: 'subnet-priv' }] });
    wireLoadBalancer([{ Id: 'i-web' }]);

    const data = await collectTopology();
    expect(data.edges).toEqual(
      expect.arrayContaining([{ from: 'edge-alb', to: 'i-web', kind: 'balances-to' }]),
    );
  });

  it('an IP target with no matching ECS service produces NO edge rather than a made-up one', async () => {
    // An IP is not a node on the map. Guessing which service owns it would invent a dependency.
    wireEc2({ Instances: [] });
    wireLoadBalancer([{ Id: '10.0.2.55' }]);

    const data = await collectTopology();
    expect(data.edges.some((e) => e.kind === 'balances-to')).toBe(false);
  });

  it('an IP-target group owned by an ECS service resolves to that service', async () => {
    wireEc2({ Instances: [] });
    wireLoadBalancer([{ Id: '10.0.2.55' }]);
    ecsSendMock.mockImplementation(async (cmd: { __t: string }) => {
      if (cmd.__t === 'Clusters') return { clusterArns: ['arn:aws:ecs:r:1:cluster/prod'] };
      if (cmd.__t === 'Services') return { serviceArns: ['arn:svc'] };
      return {
        services: [
          {
            serviceName: 'api',
            status: 'ACTIVE',
            runningCount: 1,
            desiredCount: 1,
            loadBalancers: [{ targetGroupArn: 'arn:tg' }],
            networkConfiguration: { awsvpcConfiguration: { subnets: ['subnet-priv'] } },
          },
        ],
      };
    });

    const data = await collectTopology();
    expect(data.edges).toEqual(
      expect.arrayContaining([{ from: 'edge-alb', to: 'prod/api', kind: 'balances-to' }]),
    );
  });

  it('a private subnet gets an egress edge to its NAT gateway, from the route table alone', async () => {
    wireEc2({ Nat: [{ NatGatewayId: 'nat-abc', State: 'available', VpcId: 'vpc-1', SubnetId: 'subnet-pub' }] });

    const data = await collectTopology();
    expect(data.edges).toEqual(
      expect.arrayContaining([{ from: 'subnet-priv', to: 'nat-abc', kind: 'egress-via' }]),
    );
  });

  it('drops an edge whose target is not on the map', async () => {
    // The NAT gateway is absent, so the egress arrow would point at nothing. An arrow to an invisible
    // node reads as a dependency on something the operator cannot see.
    wireEc2({ Nat: [] });

    const data = await collectTopology();
    expect(data.edges.some((e) => e.to === 'nat-abc')).toBe(false);
  });

  it('collapses the same relationship reported by several target groups into ONE edge', async () => {
    // Observed on abc-prod (2026-09-08): `abc-smoketest-alb` has three target groups all registering the
    // same instance, so the collector emitted the identical edge three times and the account's connection
    // count read 24 instead of 20. Which target group traffic passed through is not on the map at all, so
    // the duplicates only corrupted a number the operator is shown.
    wireEc2({ Instances: [{ InstanceId: 'i-web', State: { Name: 'running' }, VpcId: 'vpc-1', SubnetId: 'subnet-priv' }] });
    elbSendMock.mockImplementation(async (cmd: { __t: string }) => {
      if (cmd.__t === 'Lb') {
        return {
          LoadBalancers: [
            {
              LoadBalancerName: 'edge-alb',
              Type: 'application',
              Scheme: 'internet-facing',
              State: { Code: 'active' },
              VpcId: 'vpc-1',
              LoadBalancerArn: 'arn:lb',
              AvailabilityZones: [{ SubnetId: 'subnet-pub' }],
            },
          ],
        };
      }
      if (cmd.__t === 'Tg') {
        return { TargetGroups: [{ TargetGroupArn: 'arn:tg-a' }, { TargetGroupArn: 'arn:tg-b' }, { TargetGroupArn: 'arn:tg-c' }] };
      }
      if (cmd.__t === 'Th') return { TargetHealthDescriptions: [{ Target: { Id: 'i-web' } }] };
      return {};
    });

    const data = await collectTopology();
    const toInstance = data.edges.filter((e) => e.kind === 'balances-to' && e.to === 'i-web');
    expect(toInstance).toHaveLength(1);
  });

  it('an edge failure costs the arrows, not the map', async () => {
    elbSendMock.mockRejectedValue(new Error('AccessDenied'));

    const data = await collectTopology();

    expect(data.vpcs).toHaveLength(1);
    expect(Array.isArray(data.edges)).toBe(true);
  });

  it('merges load balancer INGRESS edges across multiple pages when DescribeLoadBalancers returns a NextMarker', async () => {
    // NOTE: collectTopology() calls DescribeLoadBalancers from TWO independent call sites
    // (loadLoadBalancerEdges AND loadLoadBalancerPlacement), each running its OWN fetchAllPages
    // loop — so the mock branches on whether a Marker was supplied (page 1 vs page 2) rather than
    // a global call counter, which would conflate the two independent loops' page sequences.
    elbSendMock.mockImplementation(async (cmd: { __t: string; input?: { Marker?: string } }) => {
      if (cmd.__t === 'Lb') {
        if (!cmd.input?.Marker) {
          return {
            LoadBalancers: [
              {
                LoadBalancerName: 'edge-alb-page1',
                Type: 'application',
                Scheme: 'internet-facing',
                State: { Code: 'active' },
                VpcId: 'vpc-1',
                LoadBalancerArn: 'arn:lb-page1',
                AvailabilityZones: [{ SubnetId: 'subnet-pub' }],
              },
            ],
            NextMarker: 'marker-page-2',
          };
        }
        return {
          LoadBalancers: [
            {
              LoadBalancerName: 'edge-alb-page2',
              Type: 'application',
              Scheme: 'internet-facing',
              State: { Code: 'active' },
              VpcId: 'vpc-1',
              LoadBalancerArn: 'arn:lb-page2',
              AvailabilityZones: [{ SubnetId: 'subnet-priv' }],
            },
          ],
        };
      }
      if (cmd.__t === 'Tg') return { TargetGroups: [] };
      return {};
    });

    const data = await collectTopology();
    expect(data.edges).toEqual(
      expect.arrayContaining([
        { from: 'internet', to: 'edge-alb-page1', kind: 'ingress-from' },
        { from: 'internet', to: 'edge-alb-page2', kind: 'ingress-from' },
      ]),
    );
  });
});

describe('collectTopology — Transit Gateway, shown but not invented', () => {
  it('lists an available Transit Gateway as an account-level resource', async () => {
    wireEc2({
      TransitGateways: [{ TransitGatewayId: 'tgw-1', State: 'available', Description: 'shared', Tags: [{ Key: 'Name', Value: 'core-tgw' }] }],
    });

    const data = await collectTopology();
    expect(data.accountResources?.map((r) => r.id)).toContain('tgw-1');
    const tgw = data.accountResources?.find((r) => r.id === 'tgw-1');
    expect(tgw?.kind).toBe('tgw');
    expect(tgw?.name).toBe('core-tgw');
    // Account-level: no subnet, no VPC of its own — pinning it to one would misrepresent a resource
    // that by design spans several.
    expect(tgw?.subnetIds).toEqual([]);
  });

  it('does not list a deleted/deleting Transit Gateway', async () => {
    wireEc2({
      TransitGateways: [
        { TransitGatewayId: 'tgw-gone', State: 'deleted' },
        { TransitGatewayId: 'tgw-going', State: 'deleting' },
      ],
    });

    const data = await collectTopology();
    expect(data.accountResources?.map((r) => r.id)).toEqual([]);
  });

  it('draws an attached-to edge only for an available (TGW, VPC) attachment, both already on the map', async () => {
    wireEc2({
      TransitGateways: [{ TransitGatewayId: 'tgw-1', State: 'available' }],
      TgwAttachments: [{ TransitGatewayId: 'tgw-1', VpcId: 'vpc-1', State: 'available' }],
    });

    const data = await collectTopology();
    expect(data.edges).toEqual(expect.arrayContaining([{ from: 'tgw-1', to: 'vpc-1', kind: 'attached-to' }]));
  });

  it('omits an attachment that is not yet available (e.g. pending)', async () => {
    wireEc2({
      TransitGateways: [{ TransitGatewayId: 'tgw-1', State: 'available' }],
      TgwAttachments: [{ TransitGatewayId: 'tgw-1', VpcId: 'vpc-1', State: 'pending' }],
    });

    const data = await collectTopology();
    expect(data.edges.some((e) => e.kind === 'attached-to')).toBe(false);
  });

  it('omits an attachment naming a VPC this collector did not return', async () => {
    // An arrow to an invisible box is worse than no arrow — same rule every other edge on this map
    // already follows.
    wireEc2({
      TransitGateways: [{ TransitGatewayId: 'tgw-1', State: 'available' }],
      TgwAttachments: [{ TransitGatewayId: 'tgw-1', VpcId: 'vpc-not-on-map', State: 'available' }],
    });

    const data = await collectTopology();
    expect(data.edges.some((e) => e.kind === 'attached-to')).toBe(false);
  });

  it('refines a VPC-level attached-to edge down to the specific subnet whose route table names the TGW', async () => {
    const net = baseNetwork();
    // subnet-priv's route table gains a SPECIFIC (non-default) route to the TGW, alongside its
    // existing NAT default route — the realistic shape: a TGW route is usually for one CIDR, not
    // the subnet's whole default egress.
    net.RouteTables[1].Routes = [
      ...net.RouteTables[1].Routes,
      { DestinationCidrBlock: '10.99.0.0/16', TransitGatewayId: 'tgw-1', State: 'active' },
    ] as never;
    wireEc2({
      RouteTables: net.RouteTables,
      TransitGateways: [{ TransitGatewayId: 'tgw-1', State: 'available' }],
      TgwAttachments: [{ TransitGatewayId: 'tgw-1', VpcId: 'vpc-1', State: 'available' }],
    });

    const data = await collectTopology();
    // The coarse VPC-level edge is gone, replaced by the sharper subnet-level one.
    expect(data.edges).toEqual(
      expect.arrayContaining([{ from: 'tgw-1', to: 'subnet-priv', kind: 'attached-to' }]),
    );
    expect(data.edges.some((e) => e.kind === 'attached-to' && e.to === 'vpc-1')).toBe(false);
  });

  it('keeps the VPC-level attached-to edge when no subnet route corroborates the attachment', async () => {
    // The attachment is real (`available`) but nothing in this VPC's own route tables currently
    // routes to it — dropping the edge would understate a real attachment; the coarse VPC-level
    // line is the honest middle ground.
    wireEc2({
      TransitGateways: [{ TransitGatewayId: 'tgw-1', State: 'available' }],
      TgwAttachments: [{ TransitGatewayId: 'tgw-1', VpcId: 'vpc-1', State: 'available' }],
    });

    const data = await collectTopology();
    expect(data.edges).toEqual(expect.arrayContaining([{ from: 'tgw-1', to: 'vpc-1', kind: 'attached-to' }]));
  });

  it('refines into edges for BOTH subnets when two subnets in the same VPC each route to the TGW', async () => {
    const net = baseNetwork();
    net.RouteTables[0].Routes = [
      ...net.RouteTables[0].Routes,
      { DestinationCidrBlock: '10.99.0.0/16', TransitGatewayId: 'tgw-1', State: 'active' },
    ] as never;
    net.RouteTables[1].Routes = [
      ...net.RouteTables[1].Routes,
      { DestinationCidrBlock: '10.99.0.0/16', TransitGatewayId: 'tgw-1', State: 'active' },
    ] as never;
    wireEc2({
      RouteTables: net.RouteTables,
      TransitGateways: [{ TransitGatewayId: 'tgw-1', State: 'available' }],
      TgwAttachments: [{ TransitGatewayId: 'tgw-1', VpcId: 'vpc-1', State: 'available' }],
    });

    const data = await collectTopology();
    const toTgw = data.edges.filter((e) => e.kind === 'attached-to' && e.from === 'tgw-1');
    expect(toTgw.map((e) => e.to).sort()).toEqual(['subnet-priv', 'subnet-pub']);
  });

  it('ignores a blackholed TGW route when refining — the same standard every other route check uses', async () => {
    const net = baseNetwork();
    net.RouteTables[1].Routes = [
      ...net.RouteTables[1].Routes,
      { DestinationCidrBlock: '10.99.0.0/16', TransitGatewayId: 'tgw-1', State: 'blackhole' },
    ] as never;
    wireEc2({
      RouteTables: net.RouteTables,
      TransitGateways: [{ TransitGatewayId: 'tgw-1', State: 'available' }],
      TgwAttachments: [{ TransitGatewayId: 'tgw-1', VpcId: 'vpc-1', State: 'available' }],
    });

    const data = await collectTopology();
    // No subnet corroborates it (the only route is blackholed), so the coarse VPC-level edge stands.
    expect(data.edges).toEqual(expect.arrayContaining([{ from: 'tgw-1', to: 'vpc-1', kind: 'attached-to' }]));
  });

  it('a Transit Gateway failure costs the TGW box, not the whole map', async () => {
    ec2SendMock.mockImplementation(async (cmd: { __t: string }) => {
      if (cmd.__t === 'Tgw') throw new Error('AccessDenied');
      const net = baseNetwork();
      if (cmd.__t === 'Vpcs') return { Vpcs: net.Vpcs };
      if (cmd.__t === 'Subnets') return { Subnets: net.Subnets };
      if (cmd.__t === 'RouteTables') return { RouteTables: net.RouteTables };
      return {};
    });

    const data = await collectTopology();
    expect(data.vpcs).toHaveLength(1);
    expect(data.accountResources?.some((r) => r.kind === 'tgw')).toBe(false);
  });
});

describe('collectTopology — S3 buckets, listed with no invented edges', () => {
  it('lists every bucket as an account-level resource with no subnet and no edge', async () => {
    s3SendMock.mockResolvedValue({ Buckets: [{ Name: 'abc-prod-assets' }, { Name: 'abc-prod-logs' }] });

    const data = await collectTopology();
    const ids = data.accountResources?.map((r) => r.id) ?? [];
    expect(ids).toContain('abc-prod-assets');
    expect(ids).toContain('abc-prod-logs');
    const bucket = data.accountResources?.find((r) => r.id === 'abc-prod-assets');
    expect(bucket?.kind).toBe('s3');
    expect(bucket?.subnetIds).toEqual([]);
    // No AWS API says which VPC's traffic reaches which bucket — a VPC Gateway Endpoint's route
    // targets the whole S3 prefix list, not one bucket. Drawing a line would be an invented
    // dependency, so there must be NONE for a bucket.
    expect(data.edges.some((e) => e.from === 'abc-prod-assets' || e.to === 'abc-prod-assets')).toBe(false);
  });

  it('an S3 listing failure costs the S3 boxes, not the whole map', async () => {
    s3SendMock.mockRejectedValue(new Error('AccessDenied'));

    const data = await collectTopology();
    expect(data.vpcs).toHaveLength(1);
    expect(data.accountResources?.some((r) => r.kind === 's3')).toBe(false);
  });
});

describe('collectTopology — failure model', () => {
  it('one failing resource family does not blank the map', async () => {
    rdsSendMock.mockRejectedValue(new Error('AccessDenied'));
    elbSendMock.mockRejectedValue(new Error('Throttling'));

    const data = await collectTopology();

    expect(data.vpcs).toHaveLength(1);
    expect(data.vpcs[0].subnets).toHaveLength(2);
  });

  it('a VPC/subnet failure PROPAGATES so the old cache is kept instead of being overwritten empty', async () => {
    // An empty map renders perfectly and claims "you have no infrastructure". That must never be
    // written over a good cache, so this error is deliberately NOT swallowed.
    ec2SendMock.mockImplementation(async (cmd: { __t: string }) => {
      if (cmd.__t === 'RouteTables') throw new Error('AccessDenied: DescribeRouteTables');
      return {};
    });

    await expect(collectTopology()).rejects.toThrow(/DescribeRouteTables/);
  });

  it('subnets and VPCs come back in a stable order', async () => {
    const first = await collectTopology();
    const second = await collectTopology();
    expect(first.vpcs.map((v) => v.vpcId)).toEqual(second.vpcs.map((v) => v.vpcId));
    expect(first.vpcs[0].subnets.map((s) => s.subnetId)).toEqual(second.vpcs[0].subnets.map((s) => s.subnetId));
    // ap-southeast-1a before 1b — sorted by AZ, not by discovery order.
    expect(first.vpcs[0].subnets[0].availabilityZone).toBe('ap-southeast-1a');
  });
});
