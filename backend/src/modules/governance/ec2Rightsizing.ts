import type { EC2Client } from '@aws-sdk/client-ec2';
import { DescribeInstanceTypesCommand } from '@aws-sdk/client-ec2';

/**
 * `ec2Rightsizing.ts` — logic for Resource_Action `EC2_Rightsize`. Split out of
 * `preview-service.ts`/`ec2-rightsize-action-service.ts` following the SAME principle already
 * applied in `scalePlanning.ts` (ECS_ScaleOut/RDS_IncreaseStorage): BOTH the preview (reads real
 * AWS state and computes, shown in the Confirmation_Dialog) AND execution (`action-execution-fn`,
 * recomputes independently at run time, never trusts the value sent by the client) use the EXACT
 * SAME piece of logic.
 *
 * SAFE DESIGN DECISION (meeting the requirement "need to carefully check the OS to pick the right
 * type instead of doing it mechanically, which could make Windows not work if the new type's chip
 * isn't supported"): `EC2_Rightsize` does NOT let the user pick an arbitrary instance type — it
 * ONLY auto-suggests dropping EXACTLY one size step within the SAME instance family (e.g.
 * t3.large -> t3.medium, m6g.xlarge -> m6g.large). Because every instance type within the same
 * family ALWAYS shares the same CPU architecture (family with "g" = Graviton/arm64, family
 * without "g" = x86_64 — AWS never mixes two architectures within the same family), changing only
 * the size within the same family means the CPU architecture NEVER changes — this eliminates the
 * risk of "suggesting the wrong architecture" by design, not just by naming convention.
 *
 * DESIGN BUG FIX (found during build/test): the FIRST VERSION used a single "global fixed size
 * table" (nano < micro < ... < large < xlarge < 2xlarge < ... < 96xlarge) applied uniformly to
 * EVERY family — WRONG, because AWS families do NOT all use the same set of sizes. For example
 * family "c5" uses 9xlarge/18xlarge (no 8xlarge/16xlarge), while "m5"/"r6i" use
 * 8xlarge/16xlarge/24xlarge (no 9xlarge/18xlarge) — a single global fixed table would compute a
 * size that DOES NOT EXIST for many real families. Fixed by calling `ec2:DescribeInstanceTypes`
 * with `Filters: [{Name:'instance-type', Values: ['<family>.*']}]` to get the REAL SIZE LIST for
 * that family (with real vCPU/memory/CPU architecture), then picking the size that is TRULY the
 * next size down by vCPU/memory — never guessed from the name.
 */

/**
 * Compute Optimizer's `findingReasonCodes` can relate ONLY to EBS bandwidth/throughput, with NO
 * relation at all to the instance's compute size (CPU/Memory) — DISCOVERED IN PRACTICE via case
 * `i-0a1b2c3d4e5f60003` (abc-uat-ec2-saleapp): Compute Optimizer returned `finding: OVER_PROVISIONED`
 * with EXACTLY one reason, `EBSThroughputOverprovisioned`, and `recommendationOptions: []` (no
 * concrete size suggestion — because the issue isn't "the instance is too large"). When the ENTIRE
 * `findingReasonCodes` of a finding contains only codes from this list (no CPU/Memory code at
 * all), it should NOT be treated as a reliable "downsize" rightsizing candidate — used SHARED by
 * both the display rule (`infra-review-collector.ts`, findingType `ec2LowCpu`) AND the automatic
 * evaluator (`ec2AutoRightsizing.ts`, `EC2_AutoRightsize`), to avoid the two places' logic drifting
 * apart.
 */
export const EBS_ONLY_FINDING_REASON_CODES = new Set([
  'EBSIOPSOverprovisioned',
  'EBSIOPSUnderprovisioned',
  'EBSThroughputOverprovisioned',
  'EBSThroughputUnderprovisioned',
]);

/** `true` when `reasonCodes` has AT LEAST one code AND ALL of them are EBS codes (no CPU/Memory/
 * Network code among them) — see `EBS_ONLY_FINDING_REASON_CODES`. An empty/undefined array returns
 * `false` (fail-safe: when there isn't enough data to exclude, do NOT exclude, so the fallback to
 * the old heuristic behavior stays unchanged). */
export function isEbsOnlyReason(reasonCodes: string[] | undefined): boolean {
  if (!reasonCodes || reasonCodes.length === 0) return false;
  return reasonCodes.every((code) => EBS_ONLY_FINDING_REASON_CODES.has(code));
}

export interface FamilySizeInfo {
  instanceType: string;
  size: string;
  vcpus: number;
  memoryMiB: number;
  architectures: string[];
}

export interface RightsizeTarget {
  instanceType: string;
  currentArchitectures: string[];
  targetArchitectures: string[];
}

/** Pure: parse "<family>.<size>" -> {family, size}, or `undefined` if the format is invalid. */
export function parseInstanceType(instanceType: string): { family: string; size: string } | undefined {
  const dotIndex = instanceType.indexOf('.');
  if (dotIndex <= 0 || dotIndex === instanceType.length - 1) return undefined;
  return { family: instanceType.slice(0, dotIndex), size: instanceType.slice(dotIndex + 1) };
}

/**
 * Pure: picks the NEXT SMALLER size for `currentInstanceType`, based on `familySizes` — the REAL
 * size list of that SAME family (obtained from AWS `DescribeInstanceTypes`, see
 * `fetchFamilySizes`), sorted ascending by vCPU (then memory). Returns `undefined` if
 * `currentInstanceType` is not found in the list, or if it's already the smallest size (no size
 * is truly smaller — neither vCPU nor memory is smaller).
 */
export function pickSmallerFamilySize(
  currentInstanceType: string,
  familySizes: readonly FamilySizeInfo[],
): FamilySizeInfo | undefined {
  const currentEntry = familySizes.find((entry) => entry.instanceType === currentInstanceType);
  if (!currentEntry) return undefined;

  const smaller = familySizes.filter(
    (entry) =>
      entry.vcpus < currentEntry.vcpus || (entry.vcpus === currentEntry.vcpus && entry.memoryMiB < currentEntry.memoryMiB),
  );
  if (smaller.length === 0) return undefined;

  // The next step DOWN = the largest element in the "smaller than current" set (closest to current).
  smaller.sort((a, b) => b.vcpus - a.vcpus || b.memoryMiB - a.memoryMiB);
  return smaller[0];
}

/**
 * Pure: picks the NEXT LARGER size for `currentInstanceType` — symmetric to
 * `pickSmallerFamilySize`, used for Resource_Action `EC2_AutoRightsize` when AWS Compute Optimizer
 * confirms `UNDERPROVISIONED` (the resource is UNDERSIZED, needs a bigger size — see
 * `ec2AutoRightsizing.ts`). Same SAFETY principle as `pickSmallerFamilySize`: ONLY reads the REAL
 * size list of the SAME family (from `fetchFamilySizes`), NEVER guesses from name/a fixed size
 * table — not every family shares the same set of sizes (e.g. "c5" uses 9xlarge/18xlarge, "r6i"
 * uses 8xlarge/16xlarge/24xlarge). Returns `undefined` if `currentInstanceType` is not found, or
 * if it's already the LARGEST size in the family (no larger step exists).
 */
export function pickLargerFamilySize(
  currentInstanceType: string,
  familySizes: readonly FamilySizeInfo[],
): FamilySizeInfo | undefined {
  const currentEntry = familySizes.find((entry) => entry.instanceType === currentInstanceType);
  if (!currentEntry) return undefined;

  const larger = familySizes.filter(
    (entry) =>
      entry.vcpus > currentEntry.vcpus || (entry.vcpus === currentEntry.vcpus && entry.memoryMiB > currentEntry.memoryMiB),
  );
  if (larger.length === 0) return undefined;

  // The next step UP = the smallest element in the "larger than current" set (closest to current).
  larger.sort((a, b) => a.vcpus - b.vcpus || a.memoryMiB - b.memoryMiB);
  return larger[0];
}

/**
 * Checks whether two CPU architecture lists (`ProcessorInfo.SupportedArchitectures` from a REAL
 * `ec2:DescribeInstanceTypes` call — NOT inferred from the family name) share AT LEAST one
 * architecture. This is the REAL safety check layer (defense-in-depth) for the requirement "need
 * to carefully check the OS to pick the right type" — uses the data AWS returns at check time,
 * never trusting the family/size naming convention alone. Pure function, does not call AWS.
 *
 * Returns `false` if either list is empty (architecture could not be confirmed = not safe to
 * proceed, fail-safe).
 */
export function areArchitecturesCompatible(currentArchitectures: string[], targetArchitectures: string[]): boolean {
  if (currentArchitectures.length === 0 || targetArchitectures.length === 0) return false;
  return currentArchitectures.some((arch) => targetArchitectures.includes(arch));
}

/**
 * Calls `ec2:DescribeInstanceTypes` with `Filters: [{Name: 'instance-type', Values: ['<family>.*']}]`
 * to get ALL real sizes currently available for a family in the current region (paginating via
 * `NextToken` if needed — some old/legacy families can have many sizes). `Filters.Values` accepts
 * an arbitrary string (not constrained by the SDK's literal union type like the `InstanceTypes`
 * field), so no type cast is needed here.
 */
export async function fetchFamilySizes(ec2: EC2Client, family: string): Promise<FamilySizeInfo[]> {
  const results: FamilySizeInfo[] = [];
  let nextToken: string | undefined;

  do {
    const response = await ec2.send(
      new DescribeInstanceTypesCommand({
        Filters: [{ Name: 'instance-type', Values: [`${family}.*`] }],
        NextToken: nextToken,
      }),
    );

    for (const info of response.InstanceTypes ?? []) {
      if (!info.InstanceType) continue;
      const parsed = parseInstanceType(info.InstanceType);
      if (!parsed) continue;
      results.push({
        instanceType: info.InstanceType,
        size: parsed.size,
        vcpus: info.VCpuInfo?.DefaultVCpus ?? 0,
        memoryMiB: info.MemoryInfo?.SizeInMiB ?? 0,
        architectures: info.ProcessorInfo?.SupportedArchitectures ?? [],
      });
    }

    nextToken = response.NextToken;
  } while (nextToken);

  return results;
}

/**
 * Gets the REAL CPU architecture (`ProcessorInfo.SupportedArchitectures`) of EXACTLY one specific
 * instance type — used to check architecture compatibility for a recommendation that MAY BE FROM
 * A DIFFERENT FAMILY (e.g. an instance type recommended directly by Compute Optimizer, see
 * `ec2AutoRightsizing.ts#pickSafeCrossFamilyRecommendation`), unlike `fetchFamilySizes()` (which
 * only lists sizes within the SAME family). Returns `undefined` if AWS doesn't return this
 * instance type (already retired/doesn't exist in the current region).
 */
export async function fetchInstanceTypeArchitectures(ec2: EC2Client, instanceType: string): Promise<string[] | undefined> {
  // Uses `Filters` (accepts an arbitrary string, not constrained by the SDK's literal union type
  // `InstanceTypes` — which may not yet be updated with the NEW instance types Compute Optimizer
  // recommends) — the same approach as `fetchFamilySizes()`, just with the filter value being
  // EXACTLY one specific type (not the `<family>.*` wildcard).
  const response = await ec2.send(new DescribeInstanceTypesCommand({ Filters: [{ Name: 'instance-type', Values: [instanceType] }] }));
  const info = response.InstanceTypes?.[0];
  return info?.ProcessorInfo?.SupportedArchitectures;
}

/**
 * Computes the REAL target instance type for `EC2_Rightsize` — reads the family's real size list
 * (via `fetchFamilySizes`), picks the next smaller size (via `pickSmallerFamilySize`), and returns
 * it along with the REAL CPU architecture of both the current instance and the target (already
 * available from the same API call, no need to call `DescribeInstanceTypes` again just for the
 * architecture check).
 *
 * Returns `undefined` when:
 *  - `currentInstanceType` doesn't match the `<family>.<size>` format.
 *  - `currentInstanceType` is not found in that family's `DescribeInstanceTypes` result (unknown
 *    instance type/doesn't exist in the current region).
 *  - `currentInstanceType` is already the smallest size in the family (no smaller step exists).
 */
export async function computeEc2RightsizeTarget(
  ec2: EC2Client,
  currentInstanceType: string,
): Promise<RightsizeTarget | undefined> {
  return computeEc2RightsizeTargetInDirection(ec2, currentInstanceType, 'down');
}

/**
 * Directional variant of `computeEc2RightsizeTarget()` — used for `EC2_AutoRightsize` (automatic
 * evaluation, see `ec2AutoRightsizing.ts`), which needs BOTH directions: `'down'` when Compute
 * Optimizer confirms OVERPROVISIONED (excess resources, same as the existing manual
 * `EC2_Rightsize`), `'up'` when it confirms UNDERPROVISIONED (insufficient resources). Shares the
 * SAME `fetchFamilySizes()` call + real CPU architecture check logic with
 * `computeEc2RightsizeTarget()`, differing only in which size-picking function
 * (`pickSmallerFamilySize`/`pickLargerFamilySize`) is used based on `direction`.
 */
export async function computeEc2RightsizeTargetInDirection(
  ec2: EC2Client,
  currentInstanceType: string,
  direction: 'up' | 'down',
): Promise<RightsizeTarget | undefined> {
  const parsed = parseInstanceType(currentInstanceType);
  if (!parsed) return undefined;

  const familySizes = await fetchFamilySizes(ec2, parsed.family);
  const currentEntry = familySizes.find((entry) => entry.instanceType === currentInstanceType);
  if (!currentEntry) return undefined;

  const target = direction === 'down' ? pickSmallerFamilySize(currentInstanceType, familySizes) : pickLargerFamilySize(currentInstanceType, familySizes);
  if (!target) return undefined;

  return {
    instanceType: target.instanceType,
    currentArchitectures: currentEntry.architectures,
    targetArchitectures: target.architectures,
  };
}
