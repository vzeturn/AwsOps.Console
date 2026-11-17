import type { BusinessUnit, CostAllocationSummary, CostByDepartment } from '@ops-dashboard/shared';
import { BUSINESS_UNITS } from '@ops-dashboard/shared';

/**
 * `costAllocation.ts` — PURE functions (no AWS calls) implementing the PROPORTIONAL split-charge
 * method for the `SHARED` cost pool, following the same shape as AWS Cost Categories' own
 * "Proportional" split-charge rule (see AWS docs, "Splitting charges within cost categories") —
 * reimplemented here in application code because Cost Categories/Cost Allocation Tags can only be
 * activated from the AWS Organizations PAYER account, and this account (123456789012) is a member
 * account without that access (`ce:ListCostAllocationTags` returns AccessDeniedException:
 * "Linked account doesn't have access to cost allocation tags" — confirmed 2026-09-08). This is a
 * deliberate, documented fallback, not a workaround masking a bug: `GetCostAndUsage GroupBy
 * Type=TAG` still works from a member account (it is a query, not a tag-catalog operation), so the
 * raw numbers are real Cost Explorer data — only the automatic AWS-side split-charge step is
 * unavailable here and is computed in this module instead.
 *
 * Kept separate from `cost-collector.ts` (which only orchestrates AWS SDK calls) so this can be
 * unit-tested without mocking Cost Explorer, following the same pattern as `costReporting.ts`.
 */

/** One raw group from `GetCostAndUsage GroupBy Type=TAG,Key=Department` — `tagValue` is the raw
 * string AWS returns after the `Department$` prefix (e.g. `'SALE'`, `'SHARED'`, or `''` for a
 * resource/cost line with no `Department` tag value at all). */
export interface RawDepartmentCostEntry {
  tagValue: string;
  amountUsd: number;
}

/**
 * Splits the `SHARED` pool proportionally across the 4 `BusinessUnit`s based on each unit's own
 * direct-cost share of the period, then returns the full allocation summary with
 * `unallocatedUsd` (untagged cost) called out separately — see the interface comments in
 * `shared/src/index.ts` for the full reasoning.
 *
 * Matching rule for `tagValue` (case-INsensitive, since the tag was originally applied with
 * exact-case `SALE`/`MKT`/`HR`/`SERVICE`/`SHARED` but Cost Explorer's TAG groupby has been
 * observed to also return pre-existing legacy values like `'Sales'`/`'IT'` for cost incurred
 * before the migration tag was applied — see `unallocatedUsd`):
 *   - exactly one of the 4 `BUSINESS_UNITS` (case-insensitive) -> direct cost for that unit
 *   - `'SHARED'` (case-insensitive) -> added to the shared pool
 *   - anything else (empty string, a legacy value like `'Sales'`/`'IT'`/`'Services'`, or an
 *     unrecognized value) -> `unallocatedUsd` — deliberately NOT guessed into a bucket, so a
 *     report is never silently short of what it claims to cover.
 *
 * When the shared pool is > 0 but every business unit has $0 direct cost (a degenerate case — no
 * real workload cost this period, only shared infra), the pool is left entirely inside
 * `sharedPoolUsd`/`unallocatedUsd` is untouched and NO unit receives a share: there is no direct
 * cost to be proportional TO, so an even-split would misrepresent the intent (proportional was
 * chosen specifically over even-split) — that edge case is called out via `sharedPoolUsd` staying
 * visible rather than silently vanishing into one unit.
 */
export function allocateDepartmentCost(entries: RawDepartmentCostEntry[]): CostAllocationSummary {
  const directByUnit = new Map<BusinessUnit, number>(BUSINESS_UNITS.map((u) => [u, 0]));
  let sharedPoolUsd = 0;
  let unallocatedUsd = 0;

  for (const entry of entries) {
    const normalized = entry.tagValue.trim().toUpperCase();
    const matchedUnit = BUSINESS_UNITS.find((u) => u === normalized);
    if (matchedUnit) {
      directByUnit.set(matchedUnit, (directByUnit.get(matchedUnit) ?? 0) + entry.amountUsd);
    } else if (normalized === 'SHARED') {
      sharedPoolUsd += entry.amountUsd;
    } else {
      unallocatedUsd += entry.amountUsd;
    }
  }

  const totalDirectUsd = [...directByUnit.values()].reduce((sum, v) => sum + v, 0);

  const byDepartment: CostByDepartment[] = BUSINESS_UNITS.map((department) => {
    const directUsd = directByUnit.get(department) ?? 0;
    const sharedShareUsd = totalDirectUsd > 0 ? (directUsd / totalDirectUsd) * sharedPoolUsd : 0;
    return { department, directUsd, sharedShareUsd, totalUsd: directUsd + sharedShareUsd };
  });

  return { byDepartment, sharedPoolUsd, unallocatedUsd };
}
