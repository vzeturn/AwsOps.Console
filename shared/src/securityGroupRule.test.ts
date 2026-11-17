import { describe, it, expect } from 'vitest';
import {
  buildSecurityImpactWarning,
  cidrPrefixLength,
  describeSecurityGroupRule,
  formatPortRange,
  parseSecurityGroupIngressRule,
  securityGroupHasIngressRule,
  wellKnownPortLabel,
  type SecurityGroupIngressRule,
} from './securityGroupRule.js';

function rule(overrides: Partial<SecurityGroupIngressRule> = {}): SecurityGroupIngressRule {
  return { protocol: 'tcp', fromPort: 443, toPort: 443, cidrIp: '10.0.0.0/16', ...overrides };
}

describe('parseSecurityGroupIngressRule', () => {
  it('accepts a valid tcp rule', () => {
    const result = parseSecurityGroupIngressRule({
      protocol: 'tcp',
      fromPort: 443,
      toPort: 443,
      cidrIp: '10.0.0.0/16',
    });

    expect(result).toEqual({ ok: true, rule: rule() });
  });

  it('accepts numbers as STRINGS (query string of GET /actions/preview) and normalizes them to integers', () => {
    const result = parseSecurityGroupIngressRule({
      protocol: 'TCP',
      fromPort: '80',
      toPort: '80',
      cidrIp: ' 10.0.0.0/16 ',
    });

    expect(result).toEqual({ ok: true, rule: rule({ fromPort: 80, toPort: 80 }) });
  });

  it('rejects a protocol other than tcp/udp/icmp', () => {
    const result = parseSecurityGroupIngressRule({ protocol: '-1', fromPort: 0, toPort: 65535, cidrIp: '0.0.0.0/0' });

    expect(result.ok).toBe(false);
  });

  it('rejects -1 with protocol tcp (only icmp uses -1)', () => {
    const result = parseSecurityGroupIngressRule({ protocol: 'tcp', fromPort: -1, toPort: -1, cidrIp: '10.0.0.0/16' });

    expect(result.ok).toBe(false);
  });

  it('requires icmp to be -1/-1', () => {
    expect(parseSecurityGroupIngressRule({ protocol: 'icmp', fromPort: -1, toPort: -1, cidrIp: '10.0.0.0/16' }).ok).toBe(
      true,
    );
    expect(parseSecurityGroupIngressRule({ protocol: 'icmp', fromPort: 8, toPort: 0, cidrIp: '10.0.0.0/16' }).ok).toBe(
      false,
    );
  });

  it('rejects a port outside 0-65535 and a reversed port range', () => {
    expect(parseSecurityGroupIngressRule({ protocol: 'tcp', fromPort: 70000, toPort: 70000, cidrIp: '10.0.0.0/16' }).ok).toBe(
      false,
    );
    expect(parseSecurityGroupIngressRule({ protocol: 'tcp', fromPort: 500, toPort: 80, cidrIp: '10.0.0.0/16' }).ok).toBe(
      false,
    );
  });

  it('rejects malformed CIDR syntax, an octet > 255, and a prefix > 32', () => {
    for (const cidrIp of ['10.0.0.0', '10.0.0.0/16/8', '300.0.0.0/8', '10.0.0.0/33', '::/0']) {
      expect(parseSecurityGroupIngressRule({ protocol: 'tcp', fromPort: 80, toPort: 80, cidrIp }).ok).toBe(false);
    }
  });

  it('rejects a non-canonical CIDR and suggests the correct network range', () => {
    const result = parseSecurityGroupIngressRule({
      protocol: 'tcp',
      fromPort: 80,
      toPort: 80,
      cidrIp: '10.1.2.3/24',
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain('10.1.2.0/24');
  });

  it('handles a first octet >= 128 correctly (JS signed bit-shift trap)', () => {
    expect(parseSecurityGroupIngressRule({ protocol: 'tcp', fromPort: 80, toPort: 80, cidrIp: '192.168.0.0/16' }).ok).toBe(
      true,
    );
    expect(parseSecurityGroupIngressRule({ protocol: 'tcp', fromPort: 80, toPort: 80, cidrIp: '192.168.1.1/16' }).ok).toBe(
      false,
    );
  });

  it('accepts 0.0.0.0/0 (syntactically valid — the risk is handled via a WARNING, not a block)', () => {
    expect(parseSecurityGroupIngressRule({ protocol: 'tcp', fromPort: 22, toPort: 22, cidrIp: '0.0.0.0/0' }).ok).toBe(true);
  });

  it('rejects a description that is too long or contains characters AWS does not accept', () => {
    const base = { protocol: 'tcp', fromPort: 80, toPort: 80, cidrIp: '10.0.0.0/16' };

    expect(parseSecurityGroupIngressRule({ ...base, description: 'a'.repeat(256) }).ok).toBe(false);
    // The non-ASCII characters ARE the test input: `DESCRIPTION_PATTERN` only allows the ASCII set
    // the AWS API accepts, so this asserts a description with accented characters is rejected. Do
    // not replace the escapes with plain ASCII, or the validator (correctly) accepts the string.
    expect(parseSecurityGroupIngressRule({ ...base, description: 'non-ASCII description \u00e9\u00e8' }).ok).toBe(false);
    expect(parseSecurityGroupIngressRule({ ...base, description: 'VPN office' })).toEqual({
      ok: true,
      rule: rule({ fromPort: 80, toPort: 80, description: 'VPN office' }),
    });
  });

  it('treats an empty/whitespace description as having NO description', () => {
    const result = parseSecurityGroupIngressRule({
      protocol: 'tcp',
      fromPort: 80,
      toPort: 80,
      cidrIp: '10.0.0.0/16',
      description: '   ',
    });

    expect(result).toEqual({ ok: true, rule: rule({ fromPort: 80, toPort: 80 }) });
  });
});

describe('buildSecurityImpactWarning', () => {
  it('warns CRITICAL when a sensitive port is opened to 0.0.0.0/0', () => {
    const warning = buildSecurityImpactWarning(
      'SecurityGroup_AuthorizeIngress',
      rule({ fromPort: 22, toPort: 22, cidrIp: '0.0.0.0/0' }),
    );

    expect(warning).toContain('CRITICAL');
    expect(warning).toContain('22 (SSH)');
  });

  it('catches a sensitive port sitting IN THE MIDDLE of a broad port range', () => {
    const warning = buildSecurityImpactWarning(
      'SecurityGroup_AuthorizeIngress',
      rule({ fromPort: 3000, toPort: 4000, cidrIp: '0.0.0.0/0' }),
    );

    expect(warning).toContain('3389 (RDP)');
  });

  it('still warns when opening 0.0.0.0/0 for a NON-sensitive port (lower severity)', () => {
    const warning = buildSecurityImpactWarning('SecurityGroup_AuthorizeIngress', rule({ cidrIp: '0.0.0.0/0' }));

    expect(warning).toContain('SECURITY WARNING');
    expect(warning).not.toContain('CRITICAL');
  });

  it('warns when a sensitive port is opened to a very broad source range (/8)', () => {
    const warning = buildSecurityImpactWarning(
      'SecurityGroup_AuthorizeIngress',
      rule({ fromPort: 3306, toPort: 3306, cidrIp: '10.0.0.0/8' }),
    );

    expect(warning).toContain('3306 (MySQL)');
  });

  it('does NOT warn for a narrow rule and NEVER warns when REVOKING a rule', () => {
    expect(buildSecurityImpactWarning('SecurityGroup_AuthorizeIngress', rule())).toBeUndefined();
    // Revoking a rule only narrows the attack surface — warning here would teach users to ignore warnings.
    expect(
      buildSecurityImpactWarning('SecurityGroup_RevokeIngress', rule({ fromPort: 22, toPort: 22, cidrIp: '0.0.0.0/0' })),
    ).toBeUndefined();
  });
});

describe('securityGroupHasIngressRule', () => {
  const target = rule({ fromPort: 22, toPort: 22, cidrIp: '10.0.0.0/16' });

  it('matches the exact tuple (protocol, port range, CIDR)', () => {
    expect(
      securityGroupHasIngressRule(
        [{ IpProtocol: 'tcp', FromPort: 22, ToPort: 22, IpRanges: [{ CidrIp: '10.0.0.0/16' }] }],
        target,
      ),
    ).toBe(true);
  });

  it('does not match when any component differs, and is safe with empty/undefined lists', () => {
    expect(
      securityGroupHasIngressRule(
        [{ IpProtocol: 'udp', FromPort: 22, ToPort: 22, IpRanges: [{ CidrIp: '10.0.0.0/16' }] }],
        target,
      ),
    ).toBe(false);
    expect(
      securityGroupHasIngressRule(
        [{ IpProtocol: 'tcp', FromPort: 22, ToPort: 22, IpRanges: [{ CidrIp: '10.0.0.0/24' }] }],
        target,
      ),
    ).toBe(false);
    expect(securityGroupHasIngressRule([], target)).toBe(false);
    expect(securityGroupHasIngressRule(undefined, target)).toBe(false);
  });
});

describe('formatPortRange / describeSecurityGroupRule / helper', () => {
  it('formatPortRange shows the service label, port range, and special forms', () => {
    expect(formatPortRange('tcp', 22, 22)).toBe('tcp 22 (SSH)');
    expect(formatPortRange('tcp', 8080, 8090)).toBe('tcp 8080-8090');
    expect(formatPortRange('icmp', -1, -1)).toBe('icmp all types');
    expect(formatPortRange('-1', null, null)).toBe('all protocols / all ports');
    expect(formatPortRange('tcp', null, null)).toBe('tcp all ports');
  });

  it('describeSecurityGroupRule uses the correct verb per actionType', () => {
    expect(describeSecurityGroupRule('SecurityGroup_AuthorizeIngress', rule({ fromPort: 22, toPort: 22 }))).toBe(
      'OPEN tcp 22 (SSH) for 10.0.0.0/16',
    );
    expect(describeSecurityGroupRule('SecurityGroup_RevokeIngress', rule({ fromPort: 22, toPort: 22 }))).toBe(
      'CLOSE tcp 22 (SSH) for 10.0.0.0/16',
    );
  });

  it('cidrPrefixLength and wellKnownPortLabel', () => {
    expect(cidrPrefixLength('10.0.0.0/8')).toBe(8);
    expect(cidrPrefixLength('not-a-cidr')).toBeUndefined();
    expect(wellKnownPortLabel(443)).toBe('HTTPS');
    expect(wellKnownPortLabel(9999)).toBeUndefined();
  });
});
