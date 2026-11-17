/**
 * Validates and describes a Security Group ingress rule — a PURE FUNCTION shared by backend and frontend.
 *
 * Why this lives in `shared` instead of being duplicated per side: the form in `SecurityGroupsTab` must
 * enable/disable its button and show the exact error message the backend WILL return; two hand-written
 * copies of the rules would inevitably drift over time, and when they drift the operator always loses
 * (they get to click the button, only to receive a 400 afterward).
 * The frontend is UX; the backend (`handlers/actions-security-group.ts` + `services/
 * security-group-action-service.ts`) is where it is actually ENFORCED — both sides call the function below.
 */

export type SecurityGroupProtocol = 'tcp' | 'udp' | 'icmp';

export interface SecurityGroupIngressRule {
  protocol: SecurityGroupProtocol;
  fromPort: number;
  toPort: number;
  /** CANONICAL IPv4 CIDR (host bits = 0), e.g. '10.0.0.0/24'. */
  cidrIp: string;
  description?: string;
}

export type SecurityGroupRuleParseResult =
  | { ok: true; rule: SecurityGroupIngressRule }
  | { ok: false; message: string };

const PROTOCOLS: readonly SecurityGroupProtocol[] = ['tcp', 'udp', 'icmp'];

/**
 * Ports where opening them to the Internet is the most commonly exploited misconfiguration on AWS
 * (SSH/RDP brute-force, publicly exposed databases). This list is used ONLY to WARN, never to block —
 * see `buildSecurityImpactWarning`.
 */
export const SENSITIVE_PORTS: ReadonlyMap<number, string> = new Map([
  [22, 'SSH'],
  [3389, 'RDP'],
  [1433, 'SQL Server'],
  [3306, 'MySQL'],
  [5432, 'PostgreSQL'],
  [6379, 'Redis'],
  [27017, 'MongoDB'],
]);

/** Well-known service label for a port — used for both warnings and the rule table display. */
export function wellKnownPortLabel(port: number): string | undefined {
  return SENSITIVE_PORTS.get(port) ?? EXTRA_PORT_LABELS.get(port);
}

/** Well-known ports that are NOT sensitive — shown for readability only, never trigger a warning. */
const EXTRA_PORT_LABELS: ReadonlyMap<number, string> = new Map([
  [80, 'HTTP'],
  [443, 'HTTPS'],
  [53, 'DNS'],
  [25, 'SMTP'],
  [587, 'SMTP submission'],
]);

/** Character set AWS allows in a SG rule's `Description` (the API errors outside this set). */
const DESCRIPTION_PATTERN = /^[a-zA-Z0-9 ._\-:/()#,@[\]+=&;{}!$*]*$/;
const MAX_DESCRIPTION_LENGTH = 255;
const CIDR_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;

/**
 * Accepts both `number` and `string` because this SAME parse function serves 2 sources with
 * different types: the query string of `GET /actions/preview` (every value is a string) and the
 * JSON body of `POST /actions/security-group` (numbers are real numbers).
 */
function toInteger(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isInteger(value) ? value : undefined;
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number.parseInt(value.trim(), 10);
  return undefined;
}

export function ipToInt(a: number, b: number, c: number, d: number): number {
  // `>>> 0` is REQUIRED: JS's `<<` operator works on SIGNED 32-bit numbers, so a first octet >= 128
  // would produce a negative number and every subsequent comparison would silently be wrong.
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

export function intToIp(value: number): string {
  return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.');
}

/** Prefix bit length of a valid CIDR — used to measure "how broad is the source range". */
export function cidrPrefixLength(cidrIp: string): number | undefined {
  const match = CIDR_PATTERN.exec(cidrIp);
  return match ? Number.parseInt(match[5], 10) : undefined;
}

function parseCidr(raw: unknown): { ok: true; cidrIp: string } | { ok: false; message: string } {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { ok: false, message: 'Missing cidrIp — must be an IPv4 range in CIDR notation, e.g. 10.0.0.0/24.' };
  }
  const cidr = raw.trim();
  const match = CIDR_PATTERN.exec(cidr);
  if (!match) {
    return { ok: false, message: `Invalid cidrIp "${cidr}" — must be IPv4 in CIDR notation, e.g. 10.0.0.0/24 or 0.0.0.0/0.` };
  }
  const octets = [match[1], match[2], match[3], match[4]].map((o) => Number.parseInt(o, 10));
  if (octets.some((o) => o > 255)) {
    return { ok: false, message: `Invalid cidrIp "${cidr}" — each octet must be between 0 and 255.` };
  }
  const prefix = Number.parseInt(match[5], 10);
  if (prefix > 32) {
    return { ok: false, message: `Invalid cidrIp "${cidr}" — prefix length must be between 0 and 32.` };
  }
  // EC2 REJECTS a non-canonical CIDR ("CIDR block ... is malformed"). Caught here so the user gets a
  // concrete fix suggestion instead of a raw AWS error message after they've already clicked confirm.
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const ipInt = ipToInt(octets[0], octets[1], octets[2], octets[3]);
  const network = (ipInt & mask) >>> 0;
  if (network !== ipInt) {
    return {
      ok: false,
      message: `cidrIp "${cidr}" is not canonical (host bits must be 0) — did you mean ${intToIp(network)}/${prefix}?`,
    };
  }
  return { ok: true, cidrIp: cidr };
}

/**
 * Parses and STRICTLY validates. Returns a union result instead of throwing: both callers need to
 * read the error message to display it (frontend inline under the input, backend as the body of a
 * 400) — throwing would force every call site to wrap a try/catch for a perfectly normal situation.
 */
export function parseSecurityGroupIngressRule(input: Record<string, unknown>): SecurityGroupRuleParseResult {
  const rawProtocol = typeof input.protocol === 'string' ? input.protocol.trim().toLowerCase() : '';
  if (!PROTOCOLS.includes(rawProtocol as SecurityGroupProtocol)) {
    return { ok: false, message: `Unsupported protocol "${String(input.protocol ?? '')}" — only tcp, udp, or icmp are accepted.` };
  }
  const protocol = rawProtocol as SecurityGroupProtocol;

  const fromPort = toInteger(input.fromPort);
  const toPort = toInteger(input.toPort);
  if (fromPort === undefined || toPort === undefined) {
    return { ok: false, message: 'fromPort and toPort are required and must be integers.' };
  }

  if (protocol === 'icmp') {
    // AWS convention: ICMP uses a (type, code) pair, and -1/-1 means "any type". The dashboard only
    // supports this exact form — picking a specific ICMP type is rare and error-prone; leave that to the Console.
    if (fromPort !== -1 || toPort !== -1) {
      return { ok: false, message: 'For protocol icmp, fromPort and toPort must both be -1 (any ICMP type).' };
    }
  } else {
    if (fromPort === -1 || toPort === -1) {
      return { ok: false, message: `For protocol ${protocol}, -1 is not valid — enter a specific port range (0-65535).` };
    }
    if (fromPort < 0 || fromPort > 65535 || toPort < 0 || toPort > 65535) {
      return { ok: false, message: 'fromPort and toPort must be between 0 and 65535.' };
    }
    if (fromPort > toPort) {
      return { ok: false, message: `Invalid port range: fromPort (${fromPort}) must be less than or equal to toPort (${toPort}).` };
    }
  }

  const cidr = parseCidr(input.cidrIp);
  if (!cidr.ok) return { ok: false, message: cidr.message };

  let description: string | undefined;
  if (input.description !== undefined && input.description !== null && input.description !== '') {
    if (typeof input.description !== 'string') {
      return { ok: false, message: 'description must be a string.' };
    }
    const trimmed = input.description.trim();
    if (trimmed !== '') {
      if (trimmed.length > MAX_DESCRIPTION_LENGTH) {
        return { ok: false, message: `description must be at most ${MAX_DESCRIPTION_LENGTH} characters (currently ${trimmed.length}).` };
      }
      if (!DESCRIPTION_PATTERN.test(trimmed)) {
        return { ok: false, message: 'description contains characters AWS does not accept — only a-z A-Z 0-9 and . _ - : / ( ) # , @ [ ] + = & ; { } ! $ * are allowed' };
      }
      description = trimmed;
    }
  }

  return {
    ok: true,
    rule: { protocol, fromPort, toPort, cidrIp: cidr.cidrIp, ...(description ? { description } : {}) },
  };
}

/** Whether the port range touches any sensitive port — returns the service name so warnings can be specific. */
function sensitiveServicesInRange(rule: SecurityGroupIngressRule): string[] {
  if (rule.protocol === 'icmp') return [];
  const hits: string[] = [];
  for (const [port, label] of SENSITIVE_PORTS) {
    if (rule.fromPort <= port && port <= rule.toPort) hits.push(`${port} (${label})`);
  }
  return hits;
}

/** Threshold for a "very broad source range": /8 or wider means 16.7 million+ addresses. */
const BROAD_PREFIX_THRESHOLD = 8;

/**
 * Exposure-level warning — ONLY for the OPEN-rule action. Removing a rule never warns because it only
 * NARROWS the attack surface; attaching a warning there would teach operators to ignore warnings.
 *
 * Does NOT hard-block `0.0.0.0/0` on a sensitive port: blocking here would just push the operator to
 * the AWS Console — where there is absolutely NO warning, no preview, and no Action_Audit_Record.
 * Instead, whenever this function returns a string, `ConfirmationDialog` REQUIRES typing the exact
 * sg-id to confirm (the same friction level as an irreversible action).
 */
export function buildSecurityImpactWarning(
  actionType: string,
  rule: SecurityGroupIngressRule,
): string | undefined {
  if (actionType !== 'SecurityGroup_AuthorizeIngress') return undefined;

  const services = sensitiveServicesInRange(rule);
  const isOpenToWorld = rule.cidrIp === '0.0.0.0/0';

  if (isOpenToWorld && services.length > 0) {
    return `CRITICAL SECURITY WARNING: this rule opens port ${services.join(', ')} to the ENTIRE Internet (0.0.0.0/0). This is the most commonly exploited misconfiguration on AWS — the server will be scanned within minutes. Only proceed if you genuinely intend this; otherwise, restrict the source to your office IP or VPC range.`;
  }
  if (isOpenToWorld) {
    return `SECURITY WARNING: this rule opens ${formatPortRange(rule.protocol, rule.fromPort, rule.toPort)} to the ENTIRE Internet (0.0.0.0/0). Consider restricting the source to a specific IP range before proceeding.`;
  }

  const prefix = cidrPrefixLength(rule.cidrIp);
  if (services.length > 0 && prefix !== undefined && prefix <= BROAD_PREFIX_THRESHOLD) {
    return `SECURITY WARNING: this rule opens port ${services.join(', ')} to a very broad source range ${rule.cidrIp} (/${prefix}, equivalent to millions of addresses). Consider narrowing the source range if possible.`;
  }
  return undefined;
}

/** Human-readable port range description — shared by warnings, preview, the rule table, and audit. */
export function formatPortRange(protocol: string, fromPort: number | null, toPort: number | null): string {
  if (protocol === '-1') return 'all protocols / all ports';
  if (fromPort === null || toPort === null) return `${protocol} all ports`;
  if (fromPort === -1 && toPort === -1) return `${protocol} all types`;
  if (fromPort === toPort) {
    const label = wellKnownPortLabel(fromPort);
    return label ? `${protocol} ${fromPort} (${label})` : `${protocol} ${fromPort}`;
  }
  return `${protocol} ${fromPort}-${toPort}`;
}

/**
 * The MINIMAL shape of an `IpPermission` (AWS SDK) that the matching function below needs.
 *
 * Declared as a structural type instead of importing the type from `@aws-sdk/client-ec2`: `shared`
 * has no dependency on the AWS SDK, and more importantly — this lets `preview-service.ts` (running in
 * the router Lambda, whose role has NO mutate permissions) share the same matching logic as
 * `security-group-action-service.ts` WITHOUT importing the module containing
 * `AuthorizeSecurityGroupIngressCommand` into the router's bundle.
 */
export interface IngressPermissionLike {
  IpProtocol?: string;
  FromPort?: number;
  ToPort?: number;
  IpRanges?: { CidrIp?: string }[];
}

/** Whether a rule (protocol, port range, CIDR) already exists in the permission list — the exact tuple AWS uses. */
export function securityGroupHasIngressRule(
  permissions: readonly IngressPermissionLike[] | undefined,
  rule: SecurityGroupIngressRule,
): boolean {
  return (permissions ?? []).some(
    (permission) =>
      permission.IpProtocol === rule.protocol &&
      (permission.FromPort ?? null) === rule.fromPort &&
      (permission.ToPort ?? null) === rule.toPort &&
      (permission.IpRanges ?? []).some((range) => range.CidrIp === rule.cidrIp),
  );
}

/** Action summary sentence, shown in the preview and written to Action_Audit_Record. */
export function describeSecurityGroupRule(actionType: string, rule: SecurityGroupIngressRule): string {
  const verb = actionType === 'SecurityGroup_AuthorizeIngress' ? 'OPEN' : 'CLOSE';
  return `${verb} ${formatPortRange(rule.protocol, rule.fromPort, rule.toPort)} for ${rule.cidrIp}`;
}
