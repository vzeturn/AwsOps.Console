/** Pure logic for Security Group EGRESS rules — an exact mirror of `securityGroupRule.ts`'s
 * (ingress) structure, differing ONLY in the security warning semantics (broad egress = data
 * exfiltration risk, not inbound attack surface). Shares `SENSITIVE_PORTS` with the ingress module —
 * the same sensitive port list applies to both directions. */
import {
  type SecurityGroupProtocol,
  SENSITIVE_PORTS,
  formatPortRange,
  ipToInt,
  intToIp,
} from './securityGroupRule.js';

export interface SecurityGroupEgressRule {
  protocol: SecurityGroupProtocol;
  fromPort: number;
  toPort: number;
  cidrIp: string;
  description?: string;
}

const VALID_PROTOCOLS: readonly SecurityGroupProtocol[] = ['tcp', 'udp', 'icmp'];
const MAX_DESCRIPTION_LENGTH = 255;
const DESCRIPTION_PATTERN = /^[A-Za-z0-9 ._\-:/()#,@[\]+=&;{}!$*]*$/;

type ParseResult =
  | { ok: true; rule: SecurityGroupEgressRule }
  | { ok: false; message: string };

/** Canonicalize + validate one IPv4 CIDR — bit-math logic identical to `parseSecurityGroupIngressRule`. */
function parseCidr(cidrIp: string): { ok: true; cidr: string } | { ok: false; message: string } {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(cidrIp.trim());
  if (!match) return { ok: false, message: `Invalid CIDR: ${cidrIp}` };
  const [, a, b, c, d, prefixStr] = match;
  const octets = [a, b, c, d].map(Number);
  if (octets.some((o) => o < 0 || o > 255)) return { ok: false, message: `Invalid CIDR: ${cidrIp}` };
  const prefix = Number(prefixStr);
  if (prefix < 0 || prefix > 32) return { ok: false, message: `Invalid CIDR: ${cidrIp}` };

  const ip = ipToInt(octets[0], octets[1], octets[2], octets[3]);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const network = (ip & mask) >>> 0;
  return { ok: true, cidr: `${intToIp(network)}/${prefix}` };
}

export function parseSecurityGroupEgressRule(params: Record<string, string>): ParseResult {
  const protocol = params.protocol as SecurityGroupProtocol;
  if (!VALID_PROTOCOLS.includes(protocol)) {
    return { ok: false, message: `Invalid protocol: ${params.protocol ?? '(empty)'}` };
  }

  const fromPort = Number(params.fromPort);
  const toPort = Number(params.toPort);
  const isIcmp = protocol === 'icmp';
  const portFloor = isIcmp ? -1 : 0;
  if (
    !Number.isInteger(fromPort) ||
    !Number.isInteger(toPort) ||
    fromPort < portFloor ||
    toPort < portFloor ||
    fromPort > 65535 ||
    toPort > 65535 ||
    fromPort > toPort
  ) {
    return { ok: false, message: `Invalid port range: ${params.fromPort ?? ''}-${params.toPort ?? ''}` };
  }

  if (!params.cidrIp) {
    return { ok: false, message: 'Missing cidrIp' };
  }
  const cidrResult = parseCidr(params.cidrIp);
  if (!cidrResult.ok) return cidrResult;

  if (params.description !== undefined) {
    if (params.description.length > MAX_DESCRIPTION_LENGTH) {
      return { ok: false, message: `Description exceeds ${MAX_DESCRIPTION_LENGTH} characters` };
    }
    if (!DESCRIPTION_PATTERN.test(params.description)) {
      return { ok: false, message: 'Description contains invalid characters' };
    }
  }

  return {
    ok: true,
    rule: {
      protocol,
      fromPort,
      toPort,
      cidrIp: cidrResult.cidr,
      ...(params.description ? { description: params.description } : {}),
    },
  };
}

export interface EgressPermissionLike {
  IpProtocol?: string;
  FromPort?: number;
  ToPort?: number;
  IpRanges?: Array<{ CidrIp?: string }>;
}

export function securityGroupHasEgressRule(
  perms: EgressPermissionLike[] | undefined,
  rule: SecurityGroupEgressRule,
): boolean {
  if (!perms) return false;
  return perms.some(
    (p) =>
      p.IpProtocol === rule.protocol &&
      p.FromPort === rule.fromPort &&
      p.ToPort === rule.toPort &&
      (p.IpRanges ?? []).some((r) => r.CidrIp === rule.cidrIp),
  );
}

export function describeSecurityGroupEgressRule(
  actionType: 'SecurityGroup_AuthorizeEgress' | 'SecurityGroup_RevokeEgress',
  rule: SecurityGroupEgressRule,
): string {
  const verb = actionType === 'SecurityGroup_AuthorizeEgress' ? 'Allow' : 'Revoke';
  const portDesc = formatPortRange(rule.protocol, rule.fromPort, rule.toPort);
  return `${verb} outbound ${rule.protocol.toUpperCase()} ${portDesc} to ${rule.cidrIp}`;
}

/** Warns ONLY for AuthorizeEgress (widening scope) — RevokeEgress always NARROWS exposure and never
 * needs a warning, same logic as `buildSecurityImpactWarning` (ingress). */
export function buildEgressSecurityImpactWarning(
  actionType: 'SecurityGroup_AuthorizeEgress' | 'SecurityGroup_RevokeEgress',
  rule: SecurityGroupEgressRule,
): string | undefined {
  if (actionType !== 'SecurityGroup_AuthorizeEgress') return undefined;

  const isWideOpen = rule.cidrIp === '0.0.0.0/0';
  const prefixMatch = /\/(\d{1,2})$/.exec(rule.cidrIp);
  const prefix = prefixMatch ? Number(prefixMatch[1]) : 32;
  const isBroadRange = prefix <= 8;
  const sensitivePortName = SENSITIVE_PORTS.get(rule.fromPort);

  if ((isWideOpen || isBroadRange) && sensitivePortName) {
    return `CRITICAL SECURITY WARNING: allows the instance to connect outbound to ${rule.cidrIp} on port ${sensitivePortName} (${rule.fromPort}) — this could be abused to exfiltrate data if the instance is compromised.`;
  }
  if (isWideOpen) {
    return `Warning: allows the instance to connect outbound TO ANY ADDRESS (0.0.0.0/0) on port ${rule.fromPort}-${rule.toPort}.`;
  }
  return undefined;
}
