import type {
  ProtectionGap,
  RecommendationFindingType,
  RecommendationItem,
  RecommendationPriority,
  RiskLevel,
  ServiceCategory,
} from '@ops-dashboard/shared';

/**
 * Classifies by a measured threshold — shared by EC2 CPU, RDS CPU/connections, and NAT throughput.
 *
 * `direction`:
 *  - 'below': a measured value below (or equal to) the threshold is "bad" (e.g. low average CPU -> a rightsizing candidate).
 *  - 'above': a measured value above (or equal to) the threshold is "bad" (e.g. high throughput/errors).
 *
 * Returns a `RecommendationItem` when the measured value crosses the threshold in the configured
 * bad direction, otherwise returns `null`. Pure function, no AWS calls.
 *
 * Validates: Requirements 1.3, 2.2, 3.3, 5.1
 */
export function classifyByThreshold(input: {
  resourceId: string;
  resourceType: string;
  resourceName: string;
  measuredValue: number;
  thresholdValue: number;
  direction: 'below' | 'above';
  category: ServiceCategory;
  action: string;
  risk: RiskLevel;
  findingType: RecommendationFindingType;
}): RecommendationItem | null {
  const {
    resourceId,
    resourceType,
    resourceName,
    measuredValue,
    thresholdValue,
    direction,
    category,
    action,
    risk,
    findingType,
  } = input;

  const isBad =
    direction === 'below' ? measuredValue <= thresholdValue : measuredValue >= thresholdValue;

  if (!isBad) return null;

  return {
    id: `${category}:${resourceType}:${resourceId}:${action}`,
    category,
    resourceType,
    resourceId,
    resourceName,
    currentState: `Measured value ${measuredValue} (threshold ${direction === 'below' ? 'below' : 'above'} ${thresholdValue})`,
    recommendedAction: action,
    estimatedMonthlySavingsUsd: null,
    risk,
    findingType,
    // No savings information at this stage (fixed null) — priority is temporarily decided by risk
    // alone, monotonic on the low < medium < high scale (lower risk -> priority no lower).
    priority: priorityFromRisk(risk),
  };
}

/**
 * Classifies by a bad resource state — shared by EC2 stopped, EBS unattached, ALB with all
 * targets unhealthy, and an S3 bucket missing a lifecycle policy.
 *
 * Returns a `RecommendationItem` when `isBadState` is `true`, otherwise returns `null`. Pure
 * function, no AWS calls.
 *
 * Validates: Requirements 1.4, 3.4, 4.3, 4.4
 */
export function classifyByState(input: {
  resourceId: string;
  resourceType: string;
  resourceName: string;
  isBadState: boolean;
  category: ServiceCategory;
  action: string;
  risk: RiskLevel;
  findingType: RecommendationFindingType;
  /** Estimated monthly savings in USD based on real AWS pricing (NEVER a made-up number) —
   * `null` (default) when there is no concrete $ estimate for this finding. */
  estimatedMonthlySavingsUsd?: number | null;
  /** A more specific current-state description than the generic "Current resource state does not
   * meet requirements" label — used when the caller has enough context to describe it precisely
   * (e.g. "gp2 20 GiB volume — should migrate to gp3 to save cost"). `undefined` (default) keeps
   * the old generic label, preserving existing behavior. */
  currentState?: string;
}): RecommendationItem | null {
  const {
    resourceId,
    resourceType,
    resourceName,
    isBadState,
    category,
    action,
    risk,
    findingType,
    estimatedMonthlySavingsUsd = null,
    currentState,
  } = input;

  if (!isBadState) return null;

  return {
    id: `${category}:${resourceType}:${resourceId}:${action}`,
    category,
    resourceType,
    resourceId,
    resourceName,
    currentState: currentState ?? 'Current resource state does not meet requirements (bad state)',
    recommendedAction: action,
    estimatedMonthlySavingsUsd,
    risk,
    findingType,
    // Same priority logic as classifyByThreshold, for consistency across all classifier functions.
    priority: priorityFromRisk(risk),
  };
}

/**
 * Priority temporarily based on risk alone (monotonic on the low < medium < high scale: lower
 * risk -> priority no lower). Shared by `classifyByThreshold` and `classifyByState` for consistency.
 */
function priorityFromRisk(risk: RiskLevel): RecommendationItem['priority'] {
  return risk === 'low' ? 'high' : risk === 'medium' ? 'medium' : 'low';
}

// Savings threshold (USD/month) used to bucket the savings score in `computePriority` — a hard
// configuration value, affecting only how savings feeds into priority (unrelated to the resource
// classification thresholds in `classifyByThreshold`/`buildSavingsPlanRecommendation`).
const COMPUTE_PRIORITY_SAVINGS_HIGH_THRESHOLD_USD = 100;

// Risk score on the low < medium < high scale, inverted so lower risk -> higher (better) score.
const RISK_SCORE: Record<RiskLevel, number> = { high: 0, medium: 1, low: 2 };

/**
 * Assigns `RecommendationPriority` based on `estimatedMonthlySavingsUsd` (null treated as 0) and
 * `risk`. Monotonic in both directions: `savings` increasing (or staying equal) OR `risk`
 * decreasing (or staying equal, on the low < medium < high scale) must never make `priority`
 * decrease — because the combined score is the sum of two components that are each non-decreasing
 * in their own variable, and the score -> priority mapping is also non-decreasing.
 *
 * How it's computed:
 *  - `savingsScore` (0-2): 0 when savings is null or <= 0; 1 when 0 < savings < the high
 *    threshold; 2 when savings >= the high threshold (`COMPUTE_PRIORITY_SAVINGS_HIGH_THRESHOLD_USD`).
 *  - `riskScore` (0-2): looked up from `RISK_SCORE` (lower risk -> higher score).
 *  - `totalScore = savingsScore + riskScore` (0-4) -> mapped: 0-1 = 'low', 2-3 = 'medium', 4 = 'high'.
 *
 * Pure function, no AWS calls.
 *
 * Validates: Requirements 7.3
 */
export function computePriority(
  estimatedMonthlySavingsUsd: number | null,
  risk: RiskLevel,
): RecommendationPriority {
  const savings = estimatedMonthlySavingsUsd ?? 0;

  const savingsScore =
    savings <= 0
      ? 0
      : savings < COMPUTE_PRIORITY_SAVINGS_HIGH_THRESHOLD_USD
        ? 1
        : 2;

  const riskScore = RISK_SCORE[risk];

  const totalScore = savingsScore + riskScore;

  if (totalScore >= 4) return 'high';
  if (totalScore >= 2) return 'medium';
  return 'low';
}

/**
 * A commitment-purchase candidate (Savings Plans/Reserved Instances) for a service whose coverage
 * is below the configured threshold. Pure function, no AWS calls.
 *
 * Returns `null` when `coveragePercent >= coveragePercentThreshold` (coverage is already
 * sufficient, no recommendation needed). Otherwise returns a `RecommendationItem` whose
 * `estimatedMonthlySavingsUsd` is always `>= 0` and increases monotonically with `onDemandUsd`
 * (a simple linear formula: `onDemandUsd * estimatedSavingsRate`).
 *
 * `priority` currently depends only on `risk` (same as `classifyByThreshold`/`classifyByState`) —
 * folding `estimatedMonthlySavingsUsd` into priority is `computePriority`'s job (a separate task).
 *
 * Validates: Requirements 5.2, 5.3
 */
export function buildSavingsPlanRecommendation(input: {
  service: string;
  onDemandUsd: number;
  coveredUsd: number;
  coveragePercent: number;
  coveragePercentThreshold: number;
  estimatedSavingsRate: number;
  risk: RiskLevel;
}): RecommendationItem | null {
  const {
    service,
    onDemandUsd,
    coveragePercent,
    coveragePercentThreshold,
    estimatedSavingsRate,
    risk,
  } = input;

  if (coveragePercent >= coveragePercentThreshold) return null;

  const estimatedMonthlySavingsUsd = Math.max(0, onDemandUsd * estimatedSavingsRate);

  return {
    id: `savingsPlans:service:${service}:purchase-commitment`,
    category: 'savingsPlans',
    resourceType: 'service',
    resourceId: service,
    resourceName: service,
    currentState: `Current coverage ${coveragePercent}% (threshold ${coveragePercentThreshold}%), uncovered on-demand spend ${onDemandUsd} USD/month`,
    recommendedAction: 'Consider purchasing Savings Plans/Reserved Instances for the uncovered on-demand spend',
    estimatedMonthlySavingsUsd,
    risk,
    findingType: 'savingsPlanCoverageLow',
    priority: priorityFromRisk(risk),
  };
}

// Priority score on the low < medium < high scale, used for comparison when sorting descending.
const PRIORITY_SCORE: Record<RecommendationPriority, number> = { low: 0, medium: 1, high: 2 };

/**
 * Sorts `RecommendationItem[]` by `priority` descending (high -> medium -> low). A STABLE sort —
 * preserves the relative order between elements of the same priority (relies on
 * `Array.prototype.sort` guaranteeing a stable sort per the ES2019+/modern-Node.js spec). Does not
 * mutate the input `items` (makes a new copy before sorting). Pure function, no AWS calls.
 *
 * Validates: Requirements 7.4
 */
export function sortByPriorityDesc(items: RecommendationItem[]): RecommendationItem[] {
  return [...items].sort((a, b) => PRIORITY_SCORE[b.priority] - PRIORITY_SCORE[a.priority]);
}

/**
 * Records a protection gap / availability risk for a production resource missing a protection
 * attribute (e.g. no AWS Backup plan, a FAILED backup job, Multi-AZ disabled on a production RDS
 * instance).
 *
 * Returns `null` when `!isProduction || hasProtection` (not production, or already protected).
 * Otherwise (a production resource missing protection) returns a `ProtectionGap` referencing the
 * correct resource, using the `reason` from the input. Pure function, no AWS calls.
 *
 * Validates: Requirements 2.3, 6.2, 6.3
 */
export function buildProtectionGapFinding(input: {
  resourceId: string;
  resourceName: string;
  resourceType: string;
  isProduction: boolean;
  hasProtection: boolean;
  reason: string;
}): ProtectionGap | null {
  const { resourceId, resourceName, resourceType, isProduction, hasProtection, reason } = input;

  if (!isProduction || hasProtection) return null;

  return {
    resourceId,
    resourceName,
    resourceType,
    reason,
  };
}
