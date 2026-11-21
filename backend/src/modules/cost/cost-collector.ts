import { GetCostAndUsageCommand, GetCostForecastCommand } from '@aws-sdk/client-cost-explorer';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getCostExplorerClient, getS3Client } from '../../core/aws-clients.js';
import type { CostData, CostServiceMover, DailyCost, MonthlyCostSummary } from '@ops-dashboard/shared';
import { buildMonthlyCostSummaries, computeTopServiceMovers, type RawMonthlyCostEntry } from './costReporting.js';
import { allocateDepartmentCost, type RawDepartmentCostEntry } from './costAllocation.js';
import { evalCostThreshold } from './costThreshold.js';
// Lean_Lambda_Exception (Requirement 6.4a): direct imports, not `../alerting/index.js` — see the
// exception comment in `agent/ai-ops-agent.ts` (same reason): `cost-collector-fn` is a lean
// standalone Lambda and the alerting barrel also re-exports `getAlerts`, which pulls in
// `monitoring-service.ts`.
import { postAlertEmbeds, type AlertEmbedField } from '../alerting/alertHook.js';
import { buildOpsNotificationEmbed, type OpsNotificationSeverity } from '../alerting/opsNotification.js';
import { monthStart, today, prevMonthRange, last30DaysRange, monthlyHistoryRange } from './costDateRanges.js';
// Lean_Lambda_Exception (Requirement 6.4a): direct import, not `../ec2-management/index.js` —
// see the exception comment in `alerting/alarm-baseline-manager.ts` (same reason):
// `cost-collector-fn` is a lean standalone Lambda and the barrel also re-exports handler files
// that pull in `config.ts` at module scope.
import { PATCH_TIMEZONE, DEPARTMENT_TAG_KEY } from '../ec2-management/tagConventions.js';
import { logger } from '../../shared-kernel/logger.js';
import { COST_CACHE_S3_KEY } from './costCacheKey.js';

/**
 * Standalone Lambda, run on an EventBridge Schedule (every 6h — see infra/ops-dashboard.yaml).
 * This is the ONLY PLACE that calls Cost Explorer (`GetCostAndUsage`/`GetCostForecast`, each API
 * call costs $0.01/request). The router (router.ts) NEVER calls Cost Explorer directly — it only
 * reads the S3 cache (cost-cache.json in AssessmentReportBucket) that this Lambda writes, so the
 * frontend's 60s auto-refresh doesn't incur real cost. Cost Explorer only exists in region us-east-1.
 *
 * The cache used to be SSM Parameter Store — moved to S3 because the Standard tier only allows UP
 * TO 4096 bytes/value (not 32KB as originally assumed), while the cache payload (byService
 * + dailyCostUsd + monthlyHistory) routinely exceeds that limit by a wide margin, causing cache
 * writes to ALWAYS fail. S3 has no practical size limit for this payload and is cheaper than the
 * SSM Advanced tier ($0.05/month/parameter).
 *
 * EXTENSION (requirement: "monthly/period-style reporting with a full comparison so you can see
 * increases and decreases"): added a `GetCostAndUsage` call (MONTHLY, GroupBy SERVICE, last 13
 * months — 12 closed months + the currently running month) to have enough data to compute $/%
 * deltas between consecutive months and "top services with the biggest cost increase/decrease"
 * (see `lib/costReporting.ts`, pure functions, tested separately without mocking Cost Explorer).
 * This is 1 extra BILLED API call ($0.01/run, same 6h cycle — an extra ~$0.04/day, comparable to
 * cost-collector's existing cost).
 *
 * EXTENSION (requirement: "cost optimization needs to be rolled out effectively and quickly ...
 * to avoid unnecessary cost"): after writing the new cache, compares the NEW `ThresholdMeta` with
 * the OLD `ThresholdMeta` (read back from cache before overwriting) — if the level got worse
 * (ok->warn/critical, warn->critical), proactively sends an alert embed IMMEDIATELY instead of
 * waiting for an operator to check the dashboard. This is the first PROACTIVE alert channel for
 * cost, in the same spirit as the existing the alert hub for infra CloudWatch Alarms
 * (`alarm-notifier.ts`) — an abnormal cost deserves the same treatment as an infra alarm,
 * not just a number sitting on the dashboard.
 *
 * EXTENSION (requirement: all AWS cost must be fully allocated to SALE/MKT/HR/SERVICE, with
 * shared services split in a reasonable proportion): added a `GetCostAndUsage GroupBy Type=TAG,Key=
 * Department` call — 1 extra billed API call, same 6h cycle. Billable resources are expected to
 * carry `Department=SALE|MKT|HR|SERVICE|SHARED`. The natural next step — activating
 * `Department` as an AWS Cost Allocation Tag and building an AWS Cost Category with a
 * Split Charge Rule so AWS itself redistributes the `SHARED` pool — is NOT possible from this
 * account: `ce:ListCostAllocationTags`/`ce:UpdateCostAllocationTagsStatus` both return
 * AccessDeniedException ("Linked account doesn't have access to cost allocation tags"), because
 * a MEMBER account in an AWS Organization cannot do this (the capability is
 * PAYER-account-only). `GetCostAndUsage GroupBy Type=TAG` itself has no such restriction (it is a
 * query, not a tag-catalog write), so the proportional split is instead computed here in
 * application code — see `lib/costAllocation.ts`, `allocateDepartmentCost` (pure function, unit
 * tested, mirrors AWS Cost Categories' own "Proportional" split-charge method).
 */
const ce = getCostExplorerClient();
const s3 = getS3Client();

/** Cost Explorer MONTHLY's `TimePeriod.Start` is always the first day of the month (format
 * "YYYY-MM-DD") — slice out "YYYY-MM" as the unified month key for `MonthlyCostSummary.month`. */
function monthKeyFromPeriodStart(periodStart: string | undefined): string {
  return (periodStart ?? '').slice(0, 7);
}

async function readCachedCostData(bucketName: string): Promise<Omit<CostData, 'threshold'> | undefined> {
  try {
    const { Body } = await s3.send(new GetObjectCommand({ Bucket: bucketName, Key: COST_CACHE_S3_KEY }));
    const raw = await Body?.transformToString();
    if (!raw) return undefined;
    return JSON.parse(raw) as Omit<CostData, 'threshold'>;
  } catch (err) {
    // First run (object doesn't exist yet) or a corrupted cache — treat it as "no old cache",
    // don't throw (an error reading the OLD cache must not break writing the NEW cache).
    logger.error('cost-collector: could not read old cache to compare threshold (treating as none, not throwing)', err);
    return undefined;
  }
}

/** Severity scale — used to determine whether the threshold "increased" (got worse) or not, when
 * comparing any 2 `ThresholdLevel` values. */
const LEVEL_SEVERITY: Record<string, number> = { ok: 0, warn: 1, critical: 2 };

/**
 * `true` when the cost situation got WORSE enough to be worth a proactive alert:
 * - There's an old cache (`oldLevel` is defined) AND the new severity is HIGHER than the old one
 *   (ok->warn, ok->critical, warn->critical) — this is a real CHANGE worth reporting.
 * - OR there's no old cache (first run — `oldLevel === undefined`, e.g. the Lambda was just
 *   deployed) BUT the current level is already 'warn'/'critical' from the start — still worth
 *   letting the operator know right away, rather than staying silent just because "there was no
 *   previous run to compare against".
 *
 * Does NOT send when: the level stays the same, improves (critical->warn/ok, warn->ok — the
 * dashboard showing it is enough, no need for alert hub), OR it's the first run and the level is
 * already 'ok' (nothing abnormal to report — avoids sending an alert on the Lambda's very
 * first run even though nothing is wrong). Pure function.
 */
export function shouldNotifyCostThresholdWorsened(oldLevel: string | undefined, newLevel: string): boolean {
  const newSeverity = LEVEL_SEVERITY[newLevel] ?? -1;
  if (oldLevel === undefined) return newSeverity > 0;
  const oldSeverity = LEVEL_SEVERITY[oldLevel] ?? -1;
  return newSeverity > oldSeverity;
}

/**
 * The exact standard `evalCostThreshold` (`lib/costThreshold.ts`) enforces — restated here in
 * plain language so the notification explains WHY it fired, not just that it fired. Kept as a
 * literal string (not derived from `evalCostThreshold`'s internals) because it describes the
 * STANDARD itself, which only changes when someone deliberately edits the threshold function —
 * if that ever drifts, `costThreshold.test.ts` pins the actual percentages, so a silent mismatch
 * would be caught there, not here.
 */
const COST_THRESHOLD_STANDARD_TEXT =
  'Standard: WARNING when the end-of-month forecast is more than 10% above last month, CRITICAL when more than 30% above last month (see lib/costThreshold.ts).';

function buildCostThresholdEmbed(params: {
  level: string;
  reason: string;
  forecastMonthUsd: number;
  previousMonthUsd: number;
  monthToDateUsd: number;
  /** Services whose cost increased the most since the LAST collector run (compares the current
   * `byService` against the previous cached `byService`, see the call site) — the concrete
   * "what actually got more expensive" an operator needs to act, since "forecast is 32% higher"
   * alone doesn't say where to look. Empty when there's no previous cache to compare against, or
   * when computeTopServiceMovers found no service that grew. */
  topIncreasedServices: CostServiceMover[];
}) {
  const fmt = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  const severity: OpsNotificationSeverity = params.level === 'critical' ? 'critical' : 'warning';
  const deltaVsPreviousMonthUsd = params.forecastMonthUsd - params.previousMonthUsd;

  const extra: AlertEmbedField[] = [
    { name: 'Month-to-date cost', value: fmt(params.monthToDateUsd), inline: true },
    { name: 'End-of-month forecast', value: fmt(params.forecastMonthUsd), inline: true },
    { name: 'Previous month', value: fmt(params.previousMonthUsd), inline: true },
  ];
  if (params.topIncreasedServices.length > 0) {
    extra.push({
      name: 'Biggest cost increases since the last check (6h)',
      value: params.topIncreasedServices
        .slice(0, 5)
        .map((m) => `**${m.service}**: ${fmt(m.previousMonthUsd)} → ${fmt(m.currentMonthUsd)} (+${fmt(m.deltaUsd)})`)
        .join('\n'),
      inline: false,
    });
  }

  const region = process.env.AWS_REGION;
  return buildOpsNotificationEmbed({
    what: `Abnormal AWS cost — ${params.level.toUpperCase()}`,
    severity,
    impact: `Forecast end-of-month spend is ${fmt(Math.abs(deltaVsPreviousMonthUsd))} ${deltaVsPreviousMonthUsd >= 0 ? 'higher' : 'lower'} than last month (${fmt(params.previousMonthUsd)} → ${fmt(params.forecastMonthUsd)}), if this trend continues for the rest of the month.`,
    why: params.reason,
    who: 'system:cost-collector',
    how: COST_THRESHOLD_STANDARD_TEXT,
    links: region ? [{ label: 'Cost Explorer', url: `https://${region}.console.aws.amazon.com/cost-management/home?region=${region}#/cost-explorer` }] : undefined,
    region,
    footer: 'ops-dashboard · Cost Explorer',
    extra,
  });
}

export async function handler(): Promise<{ ok: true }> {
  const now = new Date();
  const [prevStart, prevEnd] = prevMonthRange(now, PATCH_TIMEZONE);
  const [dailyStart, dailyEnd] = last30DaysRange(now, PATCH_TIMEZONE);
  const [historyStart, historyEnd] = monthlyHistoryRange(now, PATCH_TIMEZONE);

  const bucketName = process.env.ASSESSMENT_BUCKET_NAME;
  if (!bucketName) throw new Error('Missing required environment variable: ASSESSMENT_BUCKET_NAME');
  const accountId = process.env.AWS_ACCOUNT_ID;
  if (!accountId) throw new Error('Missing required environment variable: AWS_ACCOUNT_ID');

  // abc-prod is a member account in the AWS Organization — calling Cost Explorer without this
  // filter would aggregate the cost of the WHOLE ORGANIZATION, not just this account (skewed,
  // inflated numbers).
  const linkedAccountFilter = { Dimensions: { Key: 'LINKED_ACCOUNT' as const, Values: [accountId] } };

  const [mtd, prevMonth, forecast, daily, monthlyByService, byDepartmentTag, previousCache] = await Promise.all([
    ce.send(
      new GetCostAndUsageCommand({
        TimePeriod: { Start: monthStart(now, PATCH_TIMEZONE), End: today(now, PATCH_TIMEZONE) },
        Granularity: 'MONTHLY',
        Metrics: ['UnblendedCost'],
        GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }],
        Filter: linkedAccountFilter,
      }),
    ),
    ce.send(
      new GetCostAndUsageCommand({
        TimePeriod: { Start: prevStart, End: prevEnd },
        Granularity: 'MONTHLY',
        Metrics: ['UnblendedCost'],
        Filter: linkedAccountFilter,
      }),
    ),
    ce.send(
      new GetCostForecastCommand({
        TimePeriod: { Start: today(now, PATCH_TIMEZONE), End: monthStart(new Date(now.getFullYear(), now.getMonth() + 1, 1), PATCH_TIMEZONE) },
        Granularity: 'MONTHLY',
        Metric: 'UNBLENDED_COST',
        Filter: linkedAccountFilter,
      }),
    )
      .then((res) => ({ ...res, __forecastAvailable: true }))
      .catch((err) => {
        // Forecast can fail when there isn't enough history — don't let the whole job fail over 1
        // secondary source. Flag __forecastAvailable=false so the UI does NOT show a misleading
        // $0.00 as if "AWS forecasts $0" (see CostTab.tsx, StatCard "End-of-month forecast").
        logger.error('cost-collector: GetCostForecast failed (falling back to MTD as forecast)', err);
        return { Total: undefined, __forecastAvailable: false };
      }),
    ce.send(
      new GetCostAndUsageCommand({
        TimePeriod: { Start: dailyStart, End: dailyEnd },
        Granularity: 'DAILY',
        Metrics: ['UnblendedCost'],
        Filter: linkedAccountFilter,
      }),
    ).catch((err) => {
      // Same pattern as GetCostForecast: 1 secondary source failing doesn't break the whole job.
      logger.error('GetCostAndUsage (DAILY) failed (skipping, dailyCostUsd=[])', err);
      return { ResultsByTime: undefined };
    }),
    ce.send(
      new GetCostAndUsageCommand({
        TimePeriod: { Start: historyStart, End: historyEnd },
        Granularity: 'MONTHLY',
        Metrics: ['UnblendedCost'],
        GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }],
        Filter: linkedAccountFilter,
      }),
    ).catch((err) => {
      // New secondary source (monthly Period_Report) — same pattern: a failure doesn't break the
      // whole job, an empty monthlyHistory is a safe fallback (frontend already handles empty arrays).
      logger.error('GetCostAndUsage (MONTHLY history) failed (skipping, monthlyHistory=[])', err);
      return { ResultsByTime: undefined };
    }),
    ce.send(
      new GetCostAndUsageCommand({
        TimePeriod: { Start: monthStart(now, PATCH_TIMEZONE), End: today(now, PATCH_TIMEZONE) },
        Granularity: 'MONTHLY',
        Metrics: ['UnblendedCost'],
        GroupBy: [{ Type: 'TAG', Key: DEPARTMENT_TAG_KEY }],
        Filter: linkedAccountFilter,
      }),
    ).catch((err) => {
      // Same pattern as the other secondary sources: a failure here must not break the whole job
      // (byService/dailyCostUsd/monthlyHistory are still useful even with no department
      // breakdown) — departmentAllocation is simply left undefined by allocateDepartmentCost
      // receiving an empty array below.
      logger.error('GetCostAndUsage (MONTHLY, GroupBy TAG Department) failed (skipping, departmentAllocation=undefined)', err);
      return { ResultsByTime: undefined };
    }),
    readCachedCostData(bucketName),
  ]);

  const byService = (mtd.ResultsByTime?.[0]?.Groups ?? [])
    .map((g) => ({
      service: g.Keys?.[0] ?? 'unknown',
      amountUsd: Number(g.Metrics?.UnblendedCost?.Amount ?? '0'),
    }))
    .filter((s) => s.amountUsd > 0.01)
    .sort((a, b) => b.amountUsd - a.amountUsd);

  const monthToDateUsd = byService.reduce((sum, s) => sum + s.amountUsd, 0);
  const previousMonthUsd = Number(prevMonth.ResultsByTime?.[0]?.Total?.UnblendedCost?.Amount ?? '0');
  const forecastMonthUsd = Number(forecast.Total?.Amount ?? '0') + monthToDateUsd;

  const dailyCostUsd: DailyCost[] = (daily.ResultsByTime ?? []).map((r) => ({
    date: r.TimePeriod?.Start ?? '',
    amountUsd: Number(r.Total?.UnblendedCost?.Amount ?? '0'),
  }));

  const rawMonthlyEntries: RawMonthlyCostEntry[] = (monthlyByService.ResultsByTime ?? []).map((r) => ({
    month: monthKeyFromPeriodStart(r.TimePeriod?.Start),
    byService: (r.Groups ?? [])
      .map((g) => ({ service: g.Keys?.[0] ?? 'unknown', amountUsd: Number(g.Metrics?.UnblendedCost?.Amount ?? '0') }))
      .filter((s) => s.amountUsd > 0.01),
  }));
  const monthlyHistory: MonthlyCostSummary[] = buildMonthlyCostSummaries(rawMonthlyEntries);

  // `GroupBy Type=TAG` returns keys shaped "<TagKey>$<TagValue>" (e.g. "Department$SALE"), and
  // "<TagKey>$" with an empty value for cost with no Department tag at all — strip the
  // "<TagKey>$" prefix to get the raw tag value `allocateDepartmentCost` expects. `undefined`
  // ResultsByTime (the GetCostAndUsage TAG call failed above) becomes an empty entries array,
  // which makes `allocateDepartmentCost` return an all-zero summary rather than throwing — still
  // written to the cache so the frontend has a consistent shape to render (all $0, not a missing
  // field) instead of needing a special "this feature isn't available" code path.
  const tagPrefix = `${DEPARTMENT_TAG_KEY}$`;
  const rawDepartmentEntries: RawDepartmentCostEntry[] = (byDepartmentTag.ResultsByTime?.[0]?.Groups ?? []).map((g) => {
    const rawKey = g.Keys?.[0] ?? '';
    const tagValue = rawKey.startsWith(tagPrefix) ? rawKey.slice(tagPrefix.length) : rawKey;
    return { tagValue, amountUsd: Number(g.Metrics?.UnblendedCost?.Amount ?? '0') };
  });
  const departmentAllocation = allocateDepartmentCost(rawDepartmentEntries);

  const cached: Omit<CostData, 'threshold'> = {
    monthToDateUsd,
    forecastMonthUsd,
    forecastAvailable: (forecast as { __forecastAvailable?: boolean }).__forecastAvailable ?? true,
    previousMonthUsd,
    byService,
    cachedAt: new Date().toISOString(),
    dailyCostUsd,
    monthlyHistory,
    departmentAllocation,
  };

  await s3.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: COST_CACHE_S3_KEY,
      Body: JSON.stringify(cached),
      ContentType: 'application/json',
    }),
  );

  // Proactive alert hub notify when the threshold got WORSE compared to the previous run (see the
  // comment at the top of the file) — must NOT throw/block the main job if sending fails
  // (postAlertEmbeds already catches its own internal errors).
  const newThreshold = evalCostThreshold(forecastMonthUsd, previousMonthUsd);
  const oldThreshold = previousCache ? evalCostThreshold(previousCache.forecastMonthUsd, previousCache.previousMonthUsd) : undefined;
  if (shouldNotifyCostThresholdWorsened(oldThreshold?.level, newThreshold.level)) {
    // "What actually got more expensive" — compares THIS run's byService against the previous
    // cache's byService (not a month-over-month history entry, which only updates once/month) so
    // the notification points at a concrete cause even mid-month, within hours of it happening.
    const topIncreasedServices: CostServiceMover[] = previousCache
      ? computeTopServiceMovers(byService, previousCache.byService).increased
      : [];
    await postAlertEmbeds([
      buildCostThresholdEmbed({
        level: newThreshold.level,
        reason: newThreshold.reason,
        forecastMonthUsd,
        previousMonthUsd,
        monthToDateUsd,
        topIncreasedServices,
      }),
    ]);
  }

  logger.info(`cost-collector: cached monthToDate=$${monthToDateUsd.toFixed(2)} forecast=$${forecastMonthUsd.toFixed(2)}`);
  return { ok: true };
}
