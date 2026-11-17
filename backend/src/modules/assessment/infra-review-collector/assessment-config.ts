/** Report survey period — the last 30 days (Requirement 7.6: state the survey period explicitly). */
export const REPORT_SURVEY_PERIOD_DAYS = 30;

/** S3 payload size warning threshold — see design.md, "Error Handling" section. */
export const PAYLOAD_WARN_BYTES = 200 * 1024;

// ---- Recommendation classification thresholds (constant config, see the comment for each group below) ----

/** EC2 average CPU below 10% during the survey period -> rightsizing candidate (Requirement 1.3). */
export const EC2_CPU_LOW_THRESHOLD_PERCENT = 10;

/** RDS average CPU below 10% -> rightsizing candidate (Requirement 2.2), same threshold as EC2 for consistency. */
export const RDS_CPU_LOW_THRESHOLD_PERCENT = 10;

/**
 * A SECOND SAFETY LAYER for the rightsizing rule based on our own heuristic (`ec2LowCpu`/
 * `rdsLowCpu`, used when Compute Optimizer has NO data for that resource — see the "Compute
 * Optimizer" section below): low average CPU is NOT ENOUGH on its own to recommend rightsizing if
 * peak CPU (MAXIMUM) during the SAME survey period is also high — that's a sign of a burst-style
 * workload (batch job, DMS, cron) that genuinely needs its current capacity at peak, even though
 * the average is low because it's idle most of the time. The 40% threshold was chosen
 * SIGNIFICANTLY WIDER than the AVERAGE threshold (10%) — wide enough to exclude workloads with
 * real spikes (e.g. the real case `i-0a1b2c3d4e5f60001`: CPU MAX 100%) but not so wide that it
 * also excludes a stably-low workload with a few negligible small spikes.
 */
export const RIGHTSIZE_FALLBACK_MAX_CPU_THRESHOLD_PERCENT = 40;

/**
 * RDS average DatabaseConnections below 5 connections during the survey period -> rightsizing
 * candidate (Requirement 2.2). ASSUMPTION: 5 is a reasonable low threshold for an instance with
 * near-zero real traffic; there's no standard AWS figure for this threshold, so it should be
 * adjusted based on real operational data.
 */
export const RDS_CONNECTIONS_LOW_THRESHOLD = 5;

/**
 * NAT Gateway processing under 1MB/day on average during the survey period -> candidate for
 * replacement/consolidation (Requirement 3.3). 1MB/day is considered near-zero usage for a NAT
 * Gateway (it has a fixed hourly cost + a per-GB processed cost, so low throughput no longer
 * justifies the fixed cost).
 */
export const NAT_THROUGHPUT_LOW_BYTES_PER_DAY = 1 * 1024 * 1024;

/** Savings Plans/RI coverage below 70% -> candidate for purchasing a commitment (Requirement 5.2). */
export const SAVINGS_PLAN_COVERAGE_PERCENT_THRESHOLD = 70;

/**
 * Estimated savings rate when moving uncovered on-demand usage to Savings Plans/RI — 20%,
 * approximating the typical savings of a 1-year no-upfront Compute Savings Plan versus on-demand.
 * This is a simple estimate (Requirement 5.2 only requires "including an estimated savings
 * amount", not high precision); the actual figure depends on the instance type/commitment term chosen.
 */
export const SAVINGS_PLAN_ESTIMATED_SAVINGS_RATE = 0.2;

/**
 * Lambda invocations below 10 over the 30-day survey period -> treated as near-unused (warn) for
 * the purpose of displaying a threshold in `LambdaSummary`. ASSUMPTION: there's no explicit
 * threshold in the requirements for Lambda (Requirement 1.2 only asks for a survey, not a separate
 * recommendation classification) — this threshold is used ONLY to display a visual `threshold` in
 * `AssessmentReport.compute.lambda`, and does NOT generate a `RecommendationItem` for Lambda at this stage.
 */
export const LAMBDA_LOW_INVOCATIONS_THRESHOLD = 10;

// ---- REAL AWS prices in ap-southeast-1 (Asia Pacific - Singapore), confirmed via the AWS Pricing
// API (`aws pricing get-products`) on the day this code was written — NOT made-up numbers. Used to
// compute `estimatedMonthlySavingsUsd` ONLY for the 3 new rules that have enough data to estimate a
// concrete dollar figure; the older rules (EC2/RDS rightsizing, low NAT Gateway throughput) still
// keep `estimatedMonthlySavingsUsd: null` because there isn't enough data to estimate (e.g.
// rightsizing needs to know the target instance type, not just "low CPU") — we don't infer figures
// without a basis. ----

/** EBS gp2: $0.12/GB-month in ap-southeast-1. */
export const EBS_GP2_PRICE_USD_PER_GB_MONTH = 0.12;
/** EBS gp3: $0.096/GB-month in ap-southeast-1 (does NOT add IOPS/throughput beyond the free
 * baseline tier — gp3's baseline 3000 IOPS/125 MiB/s is free, enough for most workloads currently
 * on gp2's default 100-3000 IOPS, so this is a reasonable estimate that doesn't assume the
 * customer needs to provision extra). */
export const EBS_GP3_PRICE_USD_PER_GB_MONTH = 0.096;
/** gp2 volume type check — only applies to volumes that ARE CURRENTLY gp2 (doesn't touch
 * gp3/io1/io2/st1/sc1, which are already optimized or have specific performance requirements that
 * make them unsuitable for automatic migration). */
export const EBS_TYPE_ELIGIBLE_FOR_GP3_MIGRATION = 'gp2';

/** CloudWatch Logs storage: $0.03/GB-month in ap-southeast-1 — used to estimate the current
 * storage cost of a log group with NO retention policy (accumulating indefinitely). Doesn't
 * estimate "savings" by assuming a specific retention (that 100% of old logs would be deleted
 * immediately) — only reports the log group's CURRENT storage cost/month as a reasonable upper
 * bound on the amount that could be saved by setting retention and deleting old logs. */
export const CLOUDWATCH_LOGS_PRICE_USD_PER_GB_MONTH = 0.03;

/** An Elastic IP not attached to any resource: $0.005/hour in EVERY region (a globally uniform
 * price, confirmed via AWS VPC Pricing — "Hourly charge for Idle Public IPv4 Address $0.005"). */
export const ELASTIC_IP_IDLE_PRICE_USD_PER_HOUR = 0.005;
export const HOURS_PER_MONTH_APPROX = 730; // 365*24/12, AWS's standard way of computing an average month.

export function isoDateDaysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
