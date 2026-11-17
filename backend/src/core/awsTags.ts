/**
 * Shared helpers for reading AWS resource tags — every AWS SDK v3 client in this project returns
 * tags as `{ Key?: string; Value?: string }[]` (EC2, ELBv2, RDS via a differently-named field,
 * etc.), and this exact shape/conversion was being hand-rolled at ~15+ call sites across
 * `modules/idle-scheduler/*`, `modules/infra/*`, `modules/governance/*` before this file existed.
 * Extracting it here means a future change to how tags are read (e.g. case-insensitive key
 * matching) only has to happen once.
 */

/** The tag shape every AWS SDK v3 client in this codebase returns — structurally compatible with
 * `@aws-sdk/client-ec2`'s `Tag`, `@aws-sdk/client-elastic-load-balancing-v2`'s `Tag`, etc. without
 * importing any of them here (this file has zero AWS SDK dependencies, so it's usable from any
 * Lambda, including lean standalone ones, with no risk of pulling in an unrelated package). */
export interface AwsTag {
  Key?: string;
  Value?: string;
}

/**
 * Converts a raw AWS tag list into a `Record<string, string>` — for when a caller needs to read
 * MULTIPLE keys off the same resource (e.g. `idle-scheduler-tick.ts` reading
 * `IdleScheduler:Managed`/`IdleScheduler:Ec2InstanceId`/`IdleScheduler:RdsInstanceId`/
 * `IdleScheduler:IdleMinutes` off the same ALB). A tag with an undefined `Key` or `Value` is
 * treated as an empty string, never dropped or thrown on — a resource's tag list should never
 * make this function throw, since a caller reading tags is almost always on a best-effort path
 * (see `getTagValue` below for the same principle applied to a single-key lookup).
 */
export function tagsToMap(tags: AwsTag[] | undefined): Record<string, string> {
  return Object.fromEntries((tags ?? []).map((t) => [t.Key ?? '', t.Value ?? ''] as const));
}

/**
 * Reads a SINGLE tag's value from a raw AWS tag list — for the common case of only needing one
 * key (e.g. the `Name` tag), where converting the whole list to a map first would be wasted work.
 * Returns `undefined` when the tag is absent OR its value is an empty string (mirrors the
 * `|| undefined` pattern already used at every existing single-tag lookup in this codebase, e.g.
 * `ec2NameResolver.ts`) — an empty-string tag value is treated the same as "not set" everywhere
 * tags are used for display/fallback purposes in this project.
 */
export function getTagValue(tags: AwsTag[] | undefined, key: string): string | undefined {
  return (tags ?? []).find((t) => t.Key === key)?.Value || undefined;
}

/** Convenience wrapper for the extremely common "Name tag, or fall back to the resource's own id"
 * display pattern (EC2 instances, NAT gateways, VPCs, subnets...) — see `ec2NameResolver.ts`'s
 * `resolveEc2DisplayName` for the pre-existing async version of this exact idea; this is the sync
 * version for callers that already have the tag list in hand (no extra API call needed). */
export function nameTagOr(tags: AwsTag[] | undefined, fallback: string): string {
  return getTagValue(tags, 'Name') ?? fallback;
}
