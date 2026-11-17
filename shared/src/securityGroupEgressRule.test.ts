import { describe, it, expect } from 'vitest';
import {
  parseSecurityGroupEgressRule,
  securityGroupHasEgressRule,
  describeSecurityGroupEgressRule,
  buildEgressSecurityImpactWarning,
  type SecurityGroupEgressRule,
} from './securityGroupEgressRule.js';

describe('parseSecurityGroupEgressRule', () => {
  it('parses a valid tcp rule', () => {
    const result = parseSecurityGroupEgressRule({
      protocol: 'tcp',
      fromPort: '443',
      toPort: '443',
      cidrIp: '0.0.0.0/0',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rule).toEqual({ protocol: 'tcp', fromPort: 443, toPort: 443, cidrIp: '0.0.0.0/0' });
    }
  });

  it('rejects an invalid protocol', () => {
    const result = parseSecurityGroupEgressRule({ protocol: 'sctp', fromPort: '1', toPort: '1', cidrIp: '10.0.0.0/8' });
    expect(result.ok).toBe(false);
  });

  it('rejects a malformed CIDR', () => {
    const result = parseSecurityGroupEgressRule({ protocol: 'tcp', fromPort: '80', toPort: '80', cidrIp: 'not-a-cidr' });
    expect(result.ok).toBe(false);
  });
});

describe('securityGroupHasEgressRule', () => {
  const rule: SecurityGroupEgressRule = { protocol: 'tcp', fromPort: 3306, toPort: 3306, cidrIp: '10.0.0.0/16' };

  it('finds a matching permission', () => {
    const perms = [{ IpProtocol: 'tcp', FromPort: 3306, ToPort: 3306, IpRanges: [{ CidrIp: '10.0.0.0/16' }] }];
    expect(securityGroupHasEgressRule(perms, rule)).toBe(true);
  });

  it('returns false when no permission matches', () => {
    expect(securityGroupHasEgressRule([], rule)).toBe(false);
    expect(securityGroupHasEgressRule(undefined, rule)).toBe(false);
  });
});

describe('buildEgressSecurityImpactWarning', () => {
  it('warns on 0.0.0.0/0 + sensitive port for Authorize', () => {
    const rule: SecurityGroupEgressRule = { protocol: 'tcp', fromPort: 3306, toPort: 3306, cidrIp: '0.0.0.0/0' };
    const warning = buildEgressSecurityImpactWarning('SecurityGroup_AuthorizeEgress', rule);
    expect(warning).toBeDefined();
    expect(warning).toMatch(/WARNING/);
  });

  it('never warns for RevokeEgress (narrowing exposure)', () => {
    const rule: SecurityGroupEgressRule = { protocol: 'tcp', fromPort: 3306, toPort: 3306, cidrIp: '0.0.0.0/0' };
    expect(buildEgressSecurityImpactWarning('SecurityGroup_RevokeEgress', rule)).toBeUndefined();
  });

  it('does not warn on a narrow CIDR + non-sensitive port', () => {
    const rule: SecurityGroupEgressRule = { protocol: 'tcp', fromPort: 8080, toPort: 8080, cidrIp: '10.0.5.0/32' };
    expect(buildEgressSecurityImpactWarning('SecurityGroup_AuthorizeEgress', rule)).toBeUndefined();
  });
});

describe('describeSecurityGroupEgressRule', () => {
  it('produces a human-readable summary', () => {
    const rule: SecurityGroupEgressRule = { protocol: 'tcp', fromPort: 443, toPort: 443, cidrIp: '0.0.0.0/0' };
    const summary = describeSecurityGroupEgressRule('SecurityGroup_AuthorizeEgress', rule);
    expect(summary).toContain('443');
    expect(summary).toContain('0.0.0.0/0');
  });
});
