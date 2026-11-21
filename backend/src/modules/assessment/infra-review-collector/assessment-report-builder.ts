import type {
  AssessmentReport,
  EbsVolumeSummary,
  LambdaSummary,
  NatGatewaySummary,
  ProtectionGap,
  RecommendationItem,
  S3BucketSummary,
} from '@ops-dashboard/shared';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import {
  buildProtectionGapFinding,
  buildSavingsPlanRecommendation,
  classifyByState,
  classifyByThreshold,
  computePriority,
  sortByPriorityDesc,
} from '../recommendations.js';
// Lean_Lambda_Exception (Requirement 6.4a): direct imports, not `../../cost/index.js`.
// `infra-review-collector-fn` is a lean standalone Lambda, and the cost barrel also re-exports
// `cost-service.ts`, which imports `config.ts` at module scope (see `lambda-boot.test.ts`).
import { findNewHighPriorityFindings } from '../../cost/costReporting.js';
import { collectSavingsPlansCoverage } from '../../cost/savings-plans-collector.js';
// Lean_Lambda_Exception (Requirement 6.4a): direct import, not `../../alerting/index.js` — see
// the exception comment in `agent/ai-ops-agent.ts` (same reason): the alerting barrel also
// re-exports `getAlerts`, which pulls in `threshold-history-service.ts` (needs
// `ASSESSMENT_BUCKET_NAME`, which this Lambda IS granted, but only incidentally — the point is
// not to depend on the whole monitoring stack).
import { postAlertEmbeds } from '../../alerting/alertHook.js';
import { logger } from '../../../shared-kernel/logger.js';
import { collectHourlyMetrics } from '../../../collectors/time-of-day-collector.js';
// Lean_Lambda_Exception (Requirement 6.4a): direct import, not `../../compliance/index.js`.
// `infra-review-collector-fn` is a lean standalone Lambda, and the compliance barrel also
// re-exports `get-compliance.ts`, which imports `../ec2-management/index.js` -> handler files
// that import `config.ts` at module scope (see `lambda-boot.test.ts`).
import { collectBackupData } from '../../compliance/backup-collector.js';
// Lean_Lambda_Exception (Requirement 6.4a): direct import, not `../../logs/index.js`.
// `infra-review-collector-fn` is a lean standalone Lambda, and the logs barrel also re-exports
// `get-log-groups.ts`/`get-log-events.ts`, which import `shared-kernel/response.ts` ->
// `config.ts` at module scope (see `lambda-boot.test.ts`).
import { collectCloudWatchLogGroups } from '../../logs/cloudwatch-logs-collector.js';
// Lean_Lambda_Exception (Requirement 6.4a): the following imports are DIRECT file paths, not
// through `../../ec2-management/index.js`/`../../governance/index.js`/`../../infra/index.js`.
// `infra-review-collector-fn` is a lean, standalone Lambda (CloudFormation grants it only
// `ASSESSMENT_BUCKET_NAME`/`AWS_ACCOUNT_ID`, see `infra/ops-dashboard.yaml` +
// `lambda-boot.test.ts`). Each of those 3 barrels ALSO re-exports at least one handler file
// (`actions-ec2-management.ts`/`instanceInInfraCache.ts`, `s3PolicyStore.ts` — which itself
// imports `../assessment/index.js`, forming a cycle back into this very module's barrel — and
// none directly, but `get-infra.ts`/`get-topology.ts`) that imports the `config.ts` singleton (or
// `shared-kernel/s3Cache.ts`, which imports `config.ts`) at module scope, throwing immediately
// when `ENTRA_TENANT_ID`/etc. are missing. Since ES modules evaluate every export of a barrel file
// when ANY symbol is imported from it, going through those barrels would make this Lambda depend
// on env vars it is never granted — exactly the class of bug `lambda-boot.test.ts` exists to catch
// (see that file's header comment for the real prior outage this caused).
import { evalThreshold, stateThreshold } from '../../ec2-management/thresholds.js';
import { evaluateAutoRightsizeCandidates, classifyComputeOptimizerDirection } from '../../governance/ec2AutoRightsizing.js';
import { decideTimeOfDaySizing, computeOffPeakType, computePeakType, type TimeOfDaySizingInput } from '../../governance/timeOfDayPolicy.js';
import { s3PolicyStore } from '../../governance/s3PolicyStore.js';
import { fetchFamilySizes, parseInstanceType } from '../../governance/ec2Rightsizing.js';
import { collectEc2 } from '../../infra/ec2-collector.js';
import { collectRds } from '../../infra/rds-collector.js';
import { collectComputeOptimizerData } from '../../infra/compute-optimizer-collector.js';
import { collectNetworkingData } from '../../infra/networking-collector.js';
import { getStorageData } from '../../infra/storage-collector.js';
import { collectServerless } from '../../infra/serverless-collector.js';
import { collectElasticIps } from '../../infra/elastic-ip-collector.js';
import {
  REPORT_SURVEY_PERIOD_DAYS,
  PAYLOAD_WARN_BYTES,
  EC2_CPU_LOW_THRESHOLD_PERCENT,
  RDS_CPU_LOW_THRESHOLD_PERCENT,
  RDS_CONNECTIONS_LOW_THRESHOLD,
  NAT_THROUGHPUT_LOW_BYTES_PER_DAY,
  SAVINGS_PLAN_COVERAGE_PERCENT_THRESHOLD,
  SAVINGS_PLAN_ESTIMATED_SAVINGS_RATE,
  LAMBDA_LOW_INVOCATIONS_THRESHOLD,
  EBS_GP2_PRICE_USD_PER_GB_MONTH,
  EBS_GP3_PRICE_USD_PER_GB_MONTH,
  EBS_TYPE_ELIGIBLE_FOR_GP3_MIGRATION,
  CLOUDWATCH_LOGS_PRICE_USD_PER_GB_MONTH,
  ELASTIC_IP_IDLE_PRICE_USD_PER_HOUR,
  HOURS_PER_MONTH_APPROX,
  isoDateDaysAgo,
} from './assessment-config.js';
import { readPreviousRecommendations } from './previous-report.js';
import { buildNewFindingsEmbed, buildAutoRightsizeQueuedEmbed } from './alert-embeds.js';
import { decideRightsizing, applyAutoRightsizeTagChanges } from './rightsize-decision.js';
import { s3, ec2, cloudwatch, ASSESSMENT_BUCKET_NAME, AWS_ACCOUNT_ID } from './clients.js';

/**
 * A dedicated Lambda, run on an EventBridge Scheduler (default: once a day — see
 * `infra/ops-dashboard.yaml`, `InfraReviewCollectorSchedule`). This is 1 of the ONLY 2 PLACES
 * (along with `cost-collector.ts`) granted permission to call CloudWatch `GetMetricData`/Cost
 * Explorer `GetSavingsPlansCoverage`/`GetReservationCoverage` (which cost money) — the router
 * (`router.ts`) NEVER calls these APIs directly, it only reads back the `assessment-report.json`
 * already written to S3 (see design.md, "Decisions to confirm before moving to Tasks" and "Why
 * S3 instead of SSM").
 *
 * Orchestrate: call 7 collectors in parallel (each collector already wraps its own errors
 * internally — see `collectors/*.ts` — but an extra `.catch()` is added here per task 7.1's
 * requirement so an unexpected throw from one collector doesn't crash the whole handler), run
 * the raw data through the pure functions in `lib/recommendations.ts` to produce
 * `recommendations`/`protectionGaps`, then write the complete `AssessmentReport` to S3
 * (Requirements 7.1, 7.2, 7.6).
 */
export async function handler(): Promise<{ ok: true }> {
  // Read the PREVIOUS run's report (to diff new findings once the new report exists) — runs in
  // parallel with the other 10 collectors, doesn't depend on any collector's result.
  const previousRecommendationsPromise = readPreviousRecommendations();

  // Call 9 collectors in parallel. Each collector already wraps its own errors internally (logs
  // + returns empty), but an extra per-call `.catch()` is added here (Requirement 7.1/7.2/7.6) in
  // case one collector throws unexpectedly — that error must not crash the whole handler/scheduled job.
  const [
    ec2Items,
    rdsItems,
    networking,
    storage,
    lambdaItems,
    savingsPlansCoverage,
    backupData,
    cloudWatchLogGroups,
    elasticIps,
    computeOptimizerData,
  ] = await Promise.all([
      collectEc2().catch((err) => {
        logger.error('infra-review-collector: collectEc2 failed (skipping, returning empty)', err);
        return [];
      }),
      collectRds().catch((err) => {
        logger.error('infra-review-collector: collectRds failed (skipping, returning empty)', err);
        return [];
      }),
      collectNetworkingData().catch((err) => {
        logger.error('infra-review-collector: collectNetworkingData failed (skipping, returning empty)', err);
        return { natGateways: [], albs: [] };
      }),
      getStorageData().catch((err) => {
        logger.error('infra-review-collector: getStorageData failed (skipping, returning empty)', err);
        return { s3Buckets: [], ebsVolumes: [] };
      }),
      collectServerless().catch((err) => {
        logger.error('infra-review-collector: collectServerless failed (skipping, returning empty)', err);
        return [];
      }),
      collectSavingsPlansCoverage().catch((err) => {
        logger.error('infra-review-collector: collectSavingsPlansCoverage failed (skipping, returning empty)', err);
        return [];
      }),
      collectBackupData().catch((err) => {
        logger.error('infra-review-collector: collectBackupData failed (skipping, returning empty)', err);
        return {
          backupPlans: [],
          recentBackupJobs: [],
          dlmPolicies: [],
          resourceArnsWithBackupPlan: [] as string[],
          resourceArnsWithDlmPolicy: [] as string[],
          backupVaults: [],
          restoreTestingPlans: [],
        };
      }),
      collectCloudWatchLogGroups().catch((err) => {
        logger.error('infra-review-collector: collectCloudWatchLogGroups failed (skipping, returning empty)', err);
        return [];
      }),
      collectElasticIps().catch((err) => {
        logger.error('infra-review-collector: collectElasticIps failed (skipping, returning empty)', err);
        return [];
      }),
      collectComputeOptimizerData().catch((err) => {
        logger.error('infra-review-collector: collectComputeOptimizerData failed (skipping, using the fallback heuristic for everything)', err);
        return {
          enrolled: false,
          ec2FindingByInstanceId: new Map<string, string>(),
          rdsFindingByDbInstanceId: new Map<string, string>(),
          ec2FindingReasonCodesByInstanceId: new Map<string, string[]>(),
        };
      }),
    ]);

  const recommendations: RecommendationItem[] = [];
  const protectionGaps: ProtectionGap[] = [];

  // ---- EC2_AutoRightsize (evaluator) — based ONLY on a real Compute Optimizer confirmation (does
  // NOT use the average-CPU heuristic, see `ec2AutoRightsizing.ts`). The tag decision does NOT
  // mutate InstanceType right away — `ec2-rightsize-applier.ts` (a dedicated Lambda, triggered by
  // EventBridge when the instance stops) is what actually changes the type, at the EXACT next
  // stop under the existing on/off schedule.
  const autoRightsizeChanges = evaluateAutoRightsizeCandidates(
    ec2Items.map((item) => ({
      instanceId: item.instanceId,
      name: item.name,
      hasScheduleTag: item.hasScheduleTag,
      exempt: item.autoRightsizeExempt,
      currentPendingDirection: item.pendingAutoRightsizeDirection,
      lastAutoRightsizeDate: item.lastAutoRightsizeDate,
      coFinding: computeOptimizerData.ec2FindingByInstanceId.get(item.instanceId),
      coFindingReasonCodes: computeOptimizerData.ec2FindingReasonCodesByInstanceId?.get(item.instanceId),
    })),
    new Date(),
  );
  const { setPending: newlyQueuedAutoRightsize } = await applyAutoRightsizeTagChanges(autoRightsizeChanges);
  if (newlyQueuedAutoRightsize.length > 0) {
    await postAlertEmbeds([buildAutoRightsizeQueuedEmbed(newlyQueuedAutoRightsize)]);
  }

  // ---- Time-of-Day Sizing: only fills the gap when Compute Optimizer has NO opinion (coDirection
  // === 'none') — the principle of giving CO absolute priority, see
  // timeOfDayPolicy.ts::decideTimeOfDaySizing. Each instance wraps its own error SEPARATELY
  // (try/catch inside the loop) — one instance's CloudWatch/S3 error must not block processing of
  // the other instances, per this task's per-instance error isolation principle.
  for (const item of ec2Items) {
    if (item.state !== 'running' || !item.hasScheduleTag) continue;
    const coFinding = computeOptimizerData.ec2FindingByInstanceId.get(item.instanceId);
    const coFindingReasonCodes = computeOptimizerData.ec2FindingReasonCodesByInstanceId?.get(item.instanceId);
    const coDirection = classifyComputeOptimizerDirection(coFinding, coFindingReasonCodes);
    if (coDirection !== 'none') continue; // CO already has an opinion -> time-of-day takes no action, bail early to avoid a needless CloudWatch call.

    try {
      const [metrics, teamOverride, previousSchedule] = await Promise.all([
        collectHourlyMetrics(cloudwatch, item.instanceId, new Date()),
        s3PolicyStore.getTeamOverride(item.instanceId, item.tagsRaw ?? []),
        s3PolicyStore.getComputedSchedule(item.instanceId),
      ]);
      if (teamOverride.optOut) continue;

      // Fix round 2: anchor the baseline to the STORED `baselineType` from the previous schedule
      // computation (the ORIGINAL size used to compute offPeakType/peakType that time), NOT
      // `item.instanceType` (the REAL current size, which may be mid-resize UP to peakType right
      // when this job runs — the 2 schedules run independently, not clock-synced), and NOT
      // `previousSchedule.offPeakType` (fix round 1 got this WRONG: offPeakType is the ORIGINAL
      // baseline already stepped down one tier, so reusing it as the new baseline makes
      // computeOffPeakType/computePeakType step down ANOTHER tier on every run -> an unbounded
      // ratchet-down, eventually hitting the family floor and stopping schedule writes entirely).
      // `baselineType` already stores the ORIGINAL size, so reading it back directly is idempotent
      // — no need to reverse-derive it. Only fall back to `item.instanceType` when there is NO
      // previous schedule yet (first run), the previous schedule's action wasn't 'schedulePeak', or
      // the previous schedule is an OLD record saved before the `baselineType` field existed (old
      // JSON on S3 -> `baselineType` is `undefined` after JSON.parse).
      const baselineType =
        previousSchedule && previousSchedule.action === 'schedulePeak' && previousSchedule.baselineType
          ? previousSchedule.baselineType
          : item.instanceType;

      const input: TimeOfDaySizingInput = {
        instanceId: item.instanceId,
        baselineType,
        currentType: item.instanceType,
        metrics,
        policy: teamOverride,
        coDirection,
      };
      const decision = decideTimeOfDaySizing(input);
      if (decision.action !== 'schedulePeak') {
        await s3PolicyStore.putComputedSchedule(item.instanceId, { action: 'none' });
        continue;
      }

      const parsed = parseInstanceType(baselineType);
      if (!parsed) continue; // Could not parse family/size -> fail-safe, don't write a schedule.
      const familySizes = await fetchFamilySizes(ec2, parsed.family);
      // The pure decision from decideTimeOfDaySizing() only has a PLACEHOLDER peakType/offPeakType
      // (equal to currentType) — it MUST be overwritten with the REAL value computed from
      // computeOffPeakType/computePeakType (needs fetchFamilySizes from AWS, which the pure
      // function can't call itself) before writing to the PolicyStore. Uses `baselineType` (not
      // `item.instanceType`) as the anchor — see the Fix 3 explanation above.
      const offPeakType = computeOffPeakType(baselineType, familySizes, teamOverride.minInstanceType);
      const peakType = computePeakType(baselineType, familySizes, teamOverride.maxInstanceType);
      if (!offPeakType || !peakType) continue; // No valid adjacent size (or blocked by min/max) -> don't write a schedule.

      await s3PolicyStore.putComputedSchedule(item.instanceId, { action: 'schedulePeak', windows: decision.windows, peakType, offPeakType, baselineType });
    } catch (err) {
      logger.error(`assessment-report-builder: failed to compute time-of-day schedule for ${item.instanceId} (skipping, continuing to the next instance)`, err);
    }
  }

  // ---- EC2 (Requirements 1.3, 1.4) ----
  // Rightsizing: PRIORITIZES a real finding from AWS Compute Optimizer, falls back to the average
  // CPU heuristic + cross-checking peak CPU when Compute Optimizer has no data for that instance —
  // see `decideRightsizing`. IMPORTANT: when Compute Optimizer confirms UNDERPROVISIONED, generate
  // the OPPOSITE WARNING finding (`ec2Underprovisioned`, high risk) instead of silently skipping —
  // a resource that's genuinely short on resources needs to be surfaced, not just "no rightsizing
  // recommended".
  for (const item of ec2Items) {
    const decision = decideRightsizing({
      coFinding: computeOptimizerData.ec2FindingByInstanceId.get(item.instanceId),
      coFindingReasonCodes: computeOptimizerData.ec2FindingReasonCodesByInstanceId?.get(item.instanceId),
      avgCpuPercent: item.avgCpuPercent,
      maxCpuPercent: item.maxCpuPercent,
      avgCpuThresholdPercent: EC2_CPU_LOW_THRESHOLD_PERCENT,
    });

    if (decision.kind === 'rightsizeCandidate') {
      recommendations.push({
        id: `compute:ec2-instance:${item.instanceId}:ec2LowCpu`,
        category: 'compute',
        resourceType: 'ec2-instance',
        resourceId: item.instanceId,
        resourceName: item.name,
        currentState: decision.currentState,
        recommendedAction: 'Consider rightsizing (reduce instance size) due to excess capacity',
        estimatedMonthlySavingsUsd: null,
        risk: 'low',
        findingType: 'ec2LowCpu',
        priority: 'high',
      });
    } else if (decision.kind === 'underprovisioned') {
      recommendations.push({
        id: `compute:ec2-instance:${item.instanceId}:ec2Underprovisioned`,
        category: 'compute',
        resourceType: 'ec2-instance',
        resourceId: item.instanceId,
        resourceName: item.name,
        currentState: decision.currentState,
        recommendedAction: 'Do NOT reduce size — consider increasing size or investigating the cause of high peak load',
        estimatedMonthlySavingsUsd: null,
        risk: 'high',
        findingType: 'ec2Underprovisioned',
        priority: 'high',
      });
    }

    const stoppedRec = classifyByState({
      resourceId: item.instanceId,
      resourceType: 'ec2-instance',
      resourceName: item.name,
      isBadState: item.state === 'stopped',
      category: 'compute',
      action: 'Consider terminating, or snapshotting then deleting, this stopped instance',
      risk: 'low',
      findingType: 'ec2Stopped',
    });
    if (stoppedRec) recommendations.push(stoppedRec);
  }

  // ---- RDS (Requirements 2.2, 2.3) ----
  // CPU rightsizing: the same Compute Optimizer priority + fallback heuristic logic as EC2 above —
  // see `decideRightsizing`. rdsLowConnections has NO corresponding Compute Optimizer data
  // (Compute Optimizer has no dedicated finding for DatabaseConnections) — keeps the old heuristic as-is.
  for (const item of rdsItems) {
    const decision = decideRightsizing({
      coFinding: computeOptimizerData.rdsFindingByDbInstanceId.get(item.dbInstanceIdentifier),
      avgCpuPercent: item.avgCpuPercent,
      maxCpuPercent: item.maxCpuPercent,
      avgCpuThresholdPercent: RDS_CPU_LOW_THRESHOLD_PERCENT,
    });

    if (decision.kind === 'rightsizeCandidate') {
      recommendations.push({
        id: `database:rds-instance:${item.dbInstanceIdentifier}:rdsLowCpu`,
        category: 'database',
        resourceType: 'rds-instance',
        resourceId: item.dbInstanceIdentifier,
        resourceName: item.dbInstanceIdentifier,
        currentState: decision.currentState,
        recommendedAction: 'Consider rightsizing (reduce instance class) due to excess capacity',
        estimatedMonthlySavingsUsd: null,
        risk: 'low',
        findingType: 'rdsLowCpu',
        priority: 'high',
      });
    } else if (decision.kind === 'underprovisioned') {
      recommendations.push({
        id: `database:rds-instance:${item.dbInstanceIdentifier}:rdsUnderprovisioned`,
        category: 'database',
        resourceType: 'rds-instance',
        resourceId: item.dbInstanceIdentifier,
        resourceName: item.dbInstanceIdentifier,
        currentState: decision.currentState,
        recommendedAction: 'Do NOT reduce class — consider increasing class or investigating the cause of high peak load',
        estimatedMonthlySavingsUsd: null,
        risk: 'high',
        findingType: 'rdsUnderprovisioned',
        priority: 'high',
      });
    }

    if (item.avgConnections !== null) {
      const rec = classifyByThreshold({
        resourceId: item.dbInstanceIdentifier,
        resourceType: 'rds-instance',
        resourceName: item.dbInstanceIdentifier,
        measuredValue: item.avgConnections,
        thresholdValue: RDS_CONNECTIONS_LOW_THRESHOLD,
        direction: 'below',
        category: 'database',
        action: 'Consider rightsizing (reduce instance class) due to low average connection count',
        risk: 'low',
        findingType: 'rdsLowConnections',
      });
      if (rec) recommendations.push(rec);
    }

    // Requirement 2.3: a production RDS instance missing Multi-AZ = high availability risk. Uses
    // classifyByState (risk 'high') to put it in `recommendations`, since this is a concrete,
    // actionable step (enable Multi-AZ) — it does NOT use buildProtectionGapFinding here (that
    // field is for a BACKUP gap, see the Backup section below) to avoid mixing 2 risk types of a
    // different nature into the same `ProtectionGap` structure (which has a `reason` field
    // describing backup/DLM, not a `risk` field).
    const multiAzRec = classifyByState({
      resourceId: item.dbInstanceIdentifier,
      resourceType: 'rds-instance',
      resourceName: item.dbInstanceIdentifier,
      isBadState: item.isProduction && !item.multiAz,
      category: 'database',
      action: 'Enable Multi-AZ for this production RDS instance to reduce availability risk',
      risk: 'high',
      findingType: 'rdsMissingMultiAz',
    });
    if (multiAzRec) recommendations.push(multiAzRec);
  }

  // ---- Networking (Requirements 3.3, 3.4) ----
  for (const nat of networking.natGateways) {
    const rec = classifyByThreshold({
      resourceId: nat.natGatewayId,
      resourceType: 'nat-gateway',
      resourceName: nat.natGatewayId,
      measuredValue: nat.avgBytesProcessedPerDay,
      thresholdValue: NAT_THROUGHPUT_LOW_BYTES_PER_DAY,
      direction: 'below',
      category: 'networking',
      action: 'Consider replacing or consolidating this NAT Gateway due to low average throughput',
      risk: 'low',
      findingType: 'natGatewayLowThroughput',
    });
    if (rec) recommendations.push(rec);
  }

  for (const alb of networking.albs) {
    const rec = classifyByState({
      resourceId: alb.name,
      resourceType: 'alb',
      resourceName: alb.name,
      isBadState: alb.totalTargets > 0 && alb.unhealthyTargets === alb.totalTargets,
      category: 'networking',
      action: 'Check immediately: every target on this load balancer is unhealthy',
      risk: 'high',
      findingType: 'albAllTargetsUnhealthy',
    });
    if (rec) recommendations.push(rec);
  }

  // ---- Storage (Requirements 4.3, 4.4) ----
  for (const volume of storage.ebsVolumes) {
    const rec = classifyByState({
      resourceId: volume.volumeId,
      resourceType: 'ebs-volume',
      resourceName: volume.volumeId,
      isBadState: !volume.attached,
      category: 'storage',
      action: 'Consider deleting, or snapshotting then deleting, this unattached EBS volume',
      risk: 'low',
      findingType: 'ebsVolumeUnattached',
    });
    if (rec) recommendations.push(rec);

    // New cost optimization: a volume CURRENTLY on gp2 -> suggest migrating to gp3 (20% cheaper per
    // GB AND higher baseline performance — not a trade-off, always beneficial unless the volume
    // needs IOPS/throughput above the gp3 baseline that was specifically provisioned on gp2, which
    // is out of scope for this simple rule). Estimated savings = (gp2 price - gp3 price) * size —
    // real figures from the AWS Pricing API.
    const gp3Rec = classifyByState({
      resourceId: volume.volumeId,
      resourceType: 'ebs-volume',
      resourceName: volume.volumeId,
      isBadState: volume.volumeType === EBS_TYPE_ELIGIBLE_FOR_GP3_MIGRATION,
      category: 'storage',
      action: 'Migrate this volume type from gp2 to gp3 to reduce storage cost (cheaper, higher baseline performance)',
      risk: 'low',
      findingType: 'ebsVolumeGp2ShouldBeGp3',
      estimatedMonthlySavingsUsd:
        volume.volumeType === EBS_TYPE_ELIGIBLE_FOR_GP3_MIGRATION
          ? (EBS_GP2_PRICE_USD_PER_GB_MONTH - EBS_GP3_PRICE_USD_PER_GB_MONTH) * volume.sizeGb
          : null,
      currentState: `gp2 volume, ${volume.sizeGb} GiB — gp3 is ${((1 - EBS_GP3_PRICE_USD_PER_GB_MONTH / EBS_GP2_PRICE_USD_PER_GB_MONTH) * 100).toFixed(0)}% cheaper per GiB in this region`,
    });
    if (gp3Rec) recommendations.push(gp3Rec);
  }

  for (const bucket of storage.s3Buckets) {
    const rec = classifyByState({
      resourceId: bucket.bucketName,
      resourceType: 's3-bucket',
      resourceName: bucket.bucketName,
      isBadState: !bucket.hasLifecyclePolicy,
      category: 'storage',
      action: 'Apply a lifecycle policy to transition storage class for old objects',
      risk: 'low',
      findingType: 's3BucketNoLifecyclePolicy',
    });
    if (rec) recommendations.push(rec);
  }

  // ---- Savings Plans/RI (Requirement 5.2) ----
  for (const coverage of savingsPlansCoverage) {
    const rec = buildSavingsPlanRecommendation({
      service: coverage.service,
      onDemandUsd: coverage.onDemandUsd,
      coveredUsd: coverage.coveredUsd,
      coveragePercent: coverage.coveragePercent,
      coveragePercentThreshold: SAVINGS_PLAN_COVERAGE_PERCENT_THRESHOLD,
      estimatedSavingsRate: SAVINGS_PLAN_ESTIMATED_SAVINGS_RATE,
      risk: 'low',
    });
    if (rec) recommendations.push(rec);
  }

  // ---- Backup (Requirements 6.2, 6.3) ----
  // Requirement 6.2: cross-reference known production resources (RDS, via `isProduction`) against
  // `resourceArnsWithBackupPlan` to find protection gaps. `resourceArnsWithDlmPolicy` only contains
  // EBS volume IDs (per the comment in backup-collector.ts) — EBS volumes have no `isProduction`
  // field in the current collector, so buildProtectionGapFinding is not applied to EBS here.
  for (const item of rdsItems) {
    const rdsArn = `arn:aws:rds:${process.env.AWS_REGION}:${AWS_ACCOUNT_ID}:db:${item.dbInstanceIdentifier}`;
    const gap = buildProtectionGapFinding({
      resourceId: item.dbInstanceIdentifier,
      resourceName: item.dbInstanceIdentifier,
      resourceType: 'rds-instance',
      isProduction: item.isProduction,
      hasProtection: backupData.resourceArnsWithBackupPlan.includes(rdsArn),
      reason: 'This production RDS instance has no AWS Backup plan applied',
    });
    if (gap) protectionGaps.push(gap);
  }

  // Requirement 6.3: a backup job in FAILED/EXPIRED/ABORTED state during the survey period = a risk.
  const FAILED_BACKUP_JOB_STATES = ['FAILED', 'EXPIRED', 'ABORTED'];
  for (const job of backupData.recentBackupJobs) {
    const rec = classifyByState({
      resourceId: job.resourceArn || job.jobId,
      resourceType: job.resourceType || 'backup-job',
      resourceName: job.resourceName || job.jobId,
      isBadState: FAILED_BACKUP_JOB_STATES.includes(job.state),
      category: 'backup',
      action: `Investigate and fix this backup job in ${job.state} state`,
      risk: 'medium',
      findingType: 'backupJobFailed',
    });
    if (rec) recommendations.push(rec);
  }

  // ---- A backup vault lacking protection against manual deletion/lifecycle changes (findingType:
  // backupVaultNotProtected) — ISO 27001 A.12.3, equivalent to the AWS Config managed rule
  // BACKUP_RECOVERY_POINT_MANUAL_DELETION_DISABLED. Only warns about a vault that CURRENTLY has
  // recovery points (an empty vault doesn't need protection yet — nothing to protect, avoids
  // meaningless noise). ----
  for (const vault of backupData.backupVaults) {
    const rec = classifyByState({
      resourceId: vault.vaultName,
      resourceType: 'backup-vault',
      resourceName: vault.vaultName,
      isBadState: vault.numberOfRecoveryPoints > 0 && !vault.hasDeletionProtection,
      category: 'backup',
      action:
        'Apply an access policy blocking backup:DeleteRecoveryPoint/UpdateRecoveryPointLifecycle for this backup vault (ISO 27001 A.12.3 — prevents unauthorized backup deletion/modification)',
      risk: 'high',
      findingType: 'backupVaultNotProtected',
      currentState: `Vault "${vault.vaultName}" has ${vault.numberOfRecoveryPoints} recovery point(s) but no access policy blocking manual deletion/lifecycle changes`,
    });
    if (rec) recommendations.push(rec);
  }

  // ---- Missing an AWS Backup Restore Testing Plan (findingType: restoreTestingNotConfigured) —
  // ISO 27001 A.17 (Business Continuity): having backups isn't enough, restore capability must be
  // tested periodically. Only 1 ACCOUNT-WIDE finding (not repeated per resource) — a restore
  // testing plan applies at the account/multi-resource level, so there's no reasonable "1 finding
  // per missing resource" here (unlike the per-RDS-instance protection gap). ----
  const restoreTestingRec = classifyByState({
    resourceId: 'account-wide',
    resourceType: 'backup-restore-testing',
    resourceName: 'AWS Backup Restore Testing',
    isBadState: backupData.restoreTestingPlans.length === 0,
    category: 'backup',
    action:
      'Create an AWS Backup Restore Testing Plan to periodically test restore capability (ISO 27001 A.17 — Business Continuity)',
    risk: 'high',
    findingType: 'restoreTestingNotConfigured',
    currentState: 'No Restore Testing Plan exists yet — actual restore capability from existing backups has not been confirmed',
  });
  if (restoreTestingRec) recommendations.push(restoreTestingRec);

  // ---- A CloudWatch Log Group with no retention policy (findingType: cloudWatchLogGroupNoRetention) ----
  // "Never Expire" (retentionInDays === null) means logs accumulate INDEFINITELY, needlessly
  // driving up ongoing storage cost — standard enterprise best practice under AWS Well-Architected
  // (Cost Optimization Pillar) is to always set an explicit retention for every log group.
  for (const logGroup of cloudWatchLogGroups) {
    const storedGb = logGroup.storedBytes / 1024 ** 3;
    const rec = classifyByState({
      resourceId: logGroup.logGroupName,
      resourceType: 'cloudwatch-log-group',
      resourceName: logGroup.logGroupName,
      isBadState: logGroup.retentionInDays === null,
      category: 'compute',
      action: 'Set a retention policy on this log group (e.g. 30-90 days) instead of keeping logs indefinitely',
      risk: 'low',
      findingType: 'cloudWatchLogGroupNoRetention',
      // The log group's CURRENT storage cost/month — a reasonable upper bound on the amount that
      // could be saved if retention is set and old logs are gradually deleted (does NOT assume
      // 100% would be deleted immediately).
      estimatedMonthlySavingsUsd: logGroup.retentionInDays === null ? storedGb * CLOUDWATCH_LOGS_PRICE_USD_PER_GB_MONTH : null,
      currentState: `Log group "Never Expire" — currently storing ${storedGb.toFixed(2)} GiB, storage cost ~$${(storedGb * CLOUDWATCH_LOGS_PRICE_USD_PER_GB_MONTH).toFixed(2)}/month`,
    });
    if (rec) recommendations.push(rec);
  }

  // ---- An Elastic IP not attached to any resource (findingType: elasticIpUnused) ----
  // AWS charges for an Elastic IP NOT attached to a running resource at the exact same rate as one
  // in use — there's no "free while idle" exemption like before 2024. Releasing it immediately is
  // pure cost savings with no trade-off (other than losing that specific IP address — already
  // marked irreversible in the Action_Catalog).
  for (const eip of elasticIps) {
    const rec = classifyByState({
      resourceId: eip.allocationId,
      resourceType: 'elastic-ip',
      resourceName: eip.publicIp,
      isBadState: !eip.associated,
      category: 'networking',
      action: 'Release this Elastic IP, which is not attached to any resource, to avoid ongoing charges',
      risk: 'low',
      findingType: 'elasticIpUnused',
      estimatedMonthlySavingsUsd: !eip.associated ? ELASTIC_IP_IDLE_PRICE_USD_PER_HOUR * HOURS_PER_MONTH_APPROX : null,
      currentState: `Elastic IP ${eip.publicIp} is not attached to any resource`,
    });
    if (rec) recommendations.push(rec);
  }

  // Task 7.1, the step that integrates `computePriority` into the real pipeline: overwrites the
  // temporary `priority` (`priorityFromRisk`) assigned by the classify/build functions with the
  // value computed from `estimatedMonthlySavingsUsd` + `risk` (Requirement 7.3), then sorts descending (Requirement 7.4).
  const recommendationsWithPriority = recommendations.map((item) => ({
    ...item,
    priority: computePriority(item.estimatedMonthlySavingsUsd, item.risk),
  }));
  const sortedRecommendations = sortByPriorityDesc(recommendationsWithPriority);

  // ---- Map the remaining raw data onto the AssessmentReport Summary types ----

  const lambdaSummaries: LambdaSummary[] = lambdaItems.map((item) => ({
    functionName: item.functionName,
    region: item.region,
    memoryMb: item.memoryMb,
    avgDurationMs: item.avgDurationMs ?? 0,
    invocationsInPeriod: item.invocationsInPeriod ?? 0,
    threshold: evalThreshold(item.invocationsInPeriod ?? 0, {
      warnAt: LAMBDA_LOW_INVOCATIONS_THRESHOLD,
      criticalAt: -1, // no explicit critical threshold for Lambda at this stage — only warns on low invocation counts.
      direction: 'below',
      okReason: 'Invocations during the survey period are at a normal level',
      warnReason: 'Invocations during the survey period are low — review whether this function is still needed',
      criticalReason: 'Invocations during the survey period are low — review whether this function is still needed',
    }),
  }));

  const natGatewaySummaries: NatGatewaySummary[] = networking.natGateways.map((nat) => ({
    natGatewayId: nat.natGatewayId,
    region: nat.region,
    avgBytesProcessedPerDay: nat.avgBytesProcessedPerDay,
    threshold: evalThreshold(nat.avgBytesProcessedPerDay, {
      warnAt: NAT_THROUGHPUT_LOW_BYTES_PER_DAY,
      criticalAt: -1, // no separate critical threshold — low throughput is warn-level only (see the recommendation above).
      direction: 'below',
      okReason: 'Average processed throughput is at a normal level',
      warnReason: 'Average processed throughput is low — a candidate for NAT Gateway replacement/consolidation',
      criticalReason: 'Average processed throughput is low — a candidate for NAT Gateway replacement/consolidation',
    }),
  }));

  const s3BucketSummaries: S3BucketSummary[] = storage.s3Buckets.map((bucket) => ({
    bucketName: bucket.bucketName,
    region: bucket.region,
    sizeByStorageClassGb: bucket.sizeByStorageClassGb,
    hasLifecyclePolicy: bucket.hasLifecyclePolicy,
    threshold: bucket.hasLifecyclePolicy
      ? { level: 'ok', reason: 'Already has a lifecycle policy' }
      : { level: 'warn', reason: 'No lifecycle policy to transition storage class for old objects' },
  }));

  const ebsVolumeSummaries: EbsVolumeSummary[] = storage.ebsVolumes.map((volume) => ({
    volumeId: volume.volumeId,
    region: volume.region,
    volumeType: volume.volumeType,
    sizeGb: volume.sizeGb,
    attached: volume.attached,
    threshold: stateThreshold(volume.attached ? 'attached' : 'unattached', ['unattached']),
  }));

  const report: AssessmentReport = {
    account: AWS_ACCOUNT_ID,
    region: process.env.AWS_REGION ?? '',
    periodStart: isoDateDaysAgo(REPORT_SURVEY_PERIOD_DAYS),
    periodEnd: isoDateDaysAgo(0),
    generatedAt: new Date().toISOString(),
    compute: { lambda: lambdaSummaries },
    database: {},
    networking: { natGateways: natGatewaySummaries },
    storage: { s3Buckets: s3BucketSummaries, ebsVolumes: ebsVolumeSummaries },
    savingsPlans: { coverageByService: savingsPlansCoverage },
    backup: { protectionGaps },
    recommendations: sortedRecommendations,
  };

  const payload = JSON.stringify(report);
  const payloadBytes = Buffer.byteLength(payload, 'utf8');
  if (payloadBytes > PAYLOAD_WARN_BYTES) {
    logger.warn(
      `infra-review-collector: assessment-report.json payload exceeds the safe threshold of ${PAYLOAD_WARN_BYTES} bytes (actual: ${payloadBytes} bytes) — check for unnecessary raw data being included in the report.`,
    );
  }

  await s3.send(
    new PutObjectCommand({
      Bucket: ASSESSMENT_BUCKET_NAME,
      Key: 'assessment-report.json',
      Body: payload,
      ContentType: 'application/json',
    }),
  );

  logger.info(
    `infra-review-collector: wrote assessment-report.json (${payloadBytes} bytes, ${sortedRecommendations.length} recommendations, ${protectionGaps.length} protection gaps)`,
  );

  // Proactively notify alert hub when a NEW 'high' priority finding has appeared compared to the
  // previous run (see the comment on `buildNewFindingsEmbed`/`modules/cost/costReporting.ts`) — does NOT
  // throw/block the handler's result if sending fails (postAlertEmbeds wraps its own errors internally).
  const previousRecommendations = await previousRecommendationsPromise;
  const newHighPriorityFindings = findNewHighPriorityFindings(sortedRecommendations, previousRecommendations);
  if (newHighPriorityFindings.length > 0) {
    await postAlertEmbeds([buildNewFindingsEmbed(newHighPriorityFindings)]);
  }

  return { ok: true };
}
