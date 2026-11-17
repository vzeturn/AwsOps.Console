import { describe, it, expect } from 'vitest';
import type { SecurityGroupRuleView, SecurityGroupSummary } from '@ops-dashboard/shared';
import { SG_WIDE_OPEN, exposedSensitivePorts } from './security-group-checks.js';
import { GUARDDUTY_FINDING } from './guardduty-checks.js';
import { PUBLIC_BUCKET_UNEXPLAINED, ENDPOINT_REMOTE_ACCESS_TOOL } from './exposure-checks.js';
import { buildSnapshot, NOW, VPC } from '../__fixtures__/snapshot.js';

function rule(overrides: Partial<SecurityGroupRuleView>): SecurityGroupRuleView {
  return { protocol: 'tcp', fromPort: 22, toPort: 22, cidrIp: '0.0.0.0/0', sourceLabel: '0.0.0.0/0', removable: true, ...overrides };
}

function group(ingressRules: SecurityGroupRuleView[], overrides: Partial<SecurityGroupSummary> = {}): SecurityGroupSummary {
  return { groupId: 'sg-0web', groupName: 'web', vpcId: VPC, description: 'web', ingressRules, egressRules: [], ...overrides };
}

describe('exposedSensitivePorts', () => {
  it('matches single ports, ranges and all-traffic rules from the world', () => {
    expect(exposedSensitivePorts(rule({}))).toEqual([22]);
    expect(exposedSensitivePorts(rule({ fromPort: 3300, toPort: 3400 }))).toEqual([3306, 3389]);
    expect(exposedSensitivePorts(rule({ protocol: '-1', fromPort: null, toPort: null })).length).toBe(7);
    expect(exposedSensitivePorts(rule({ cidrIp: undefined, sourceLabel: '::/0' }))).toEqual([22]);
  });

  it('ignores restricted CIDRs, SG references and non-TCP protocols', () => {
    expect(exposedSensitivePorts(rule({ cidrIp: '10.0.0.0/8', sourceLabel: '10.0.0.0/8' }))).toEqual([]);
    expect(exposedSensitivePorts(rule({ cidrIp: undefined, sourceLabel: 'sg-0other' }))).toEqual([]);
    expect(exposedSensitivePorts(rule({ protocol: 'udp' }))).toEqual([]);
  });
});

describe('sec.sg-wide-open-sensitive-port', () => {
  it('fail: one high finding per exposed group, placed in its VPC', () => {
    const [d] = SG_WIDE_OPEN.run(buildSnapshot({ securityGroups: [group([rule({}), rule({ fromPort: 3389, toPort: 3389 })])] }));
    expect(d).toMatchObject({ kpi: 'security', severity: 'high', vpcId: VPC, resourceId: 'sg-0web', isoControls: ['A.8.20'] });
    expect(d.evidence.data).toMatchObject({ exposedPorts: [{ port: 22, service: 'SSH' }, { port: 3389, service: 'RDP' }] });
  });

  it('pass: HTTPS from the world is not a sensitive port', () => {
    expect(SG_WIDE_OPEN.run(buildSnapshot({ securityGroups: [group([rule({ fromPort: 443, toPort: 443 })])] }))).toEqual([]);
  });
});

describe('sec.guardduty-finding', () => {
  const gd = { id: 'gd-1', arn: 'arn:aws:guardduty:ap-southeast-1:123456789012:detector/d/finding/gd-1', type: 'Recon:EC2/PortProbeUnprotectedPort', title: 'Unprotected port probed', severity: 8, instanceId: 'i-0web1', updatedAt: NOW };

  it('fail: maps GuardDuty bands and attributes via instance', () => {
    const [d] = GUARDDUTY_FINDING.run(buildSnapshot({ guardDuty: [gd, { ...gd, id: 'gd-2', arn: 'arn:x:gd-2', severity: 9.5 }, { ...gd, id: 'gd-3', arn: 'arn:x:gd-3', severity: 5, instanceId: undefined }] }));
    expect(d).toMatchObject({ severity: 'high', vpcId: VPC, resourceArn: gd.arn, source: 'guardduty' });
    const all = GUARDDUTY_FINDING.run(buildSnapshot({ guardDuty: [{ ...gd, severity: 9.5 }, { ...gd, id: 'gd-3', arn: 'arn:x:gd-3', severity: 5, instanceId: undefined }] }));
    expect(all.map((x) => [x.severity, x.vpcId])).toEqual([['critical', VPC], ['medium', 'account']]);
  });

  it('pass: below-threshold severity produces nothing', () => {
    expect(GUARDDUTY_FINDING.run(buildSnapshot({ guardDuty: [{ ...gd, severity: 2 }] }))).toEqual([]);
  });
});

describe('sec.public-bucket-unexplained', () => {
  it('fail: public bucket without DataClass=public -> critical, account-wide', () => {
    const [d] = PUBLIC_BUCKET_UNEXPLAINED.run(buildSnapshot({ publicBuckets: [{ bucketName: 'leaky', isPublic: true, dataClassTagValue: undefined }] }));
    expect(d).toMatchObject({ severity: 'critical', vpcId: 'account', resourceArn: 'arn:aws:s3:::leaky', isoControls: ['A.8.12'] });
  });

  it('pass: sanctioned public bucket or private bucket', () => {
    expect(
      PUBLIC_BUCKET_UNEXPLAINED.run(
        buildSnapshot({ publicBuckets: [{ bucketName: 'assets', isPublic: true, dataClassTagValue: 'public' }, { bucketName: 'data', isPublic: false, dataClassTagValue: undefined }] }),
      ),
    ).toEqual([]);
  });
});

describe('sec.endpoint-remote-access-tool', () => {
  const report = (hasSecurityExceptionTag: boolean) => ({ generatedAt: NOW, scanned: 1, findings: [{ instanceId: 'i-0web1', detectedProcesses: ['tailscaled'], hasSecurityExceptionTag }] });

  it('fail: untagged remote-access tool -> high, placed on the instance', () => {
    const [d] = ENDPOINT_REMOTE_ACCESS_TOOL.run(buildSnapshot({ endpointDrift: report(false) }));
    expect(d).toMatchObject({ severity: 'high', vpcId: VPC, resourceId: 'i-0web1' });
  });

  it('pass: sanctioned (SecurityException tag) produces nothing', () => {
    expect(ENDPOINT_REMOTE_ACCESS_TOOL.run(buildSnapshot({ endpointDrift: report(true) }))).toEqual([]);
  });
});
