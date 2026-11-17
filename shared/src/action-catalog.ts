/**
 * Action_Catalog — pure logic shared between the backend (validate) and frontend (display).
 * This is the single source of truth for matching/classifying Resource_Action, split out from
 * `index.ts` to keep the type/data-model file lean, per Requirement 1-2/17.
 */

import {
  ACTION_CATALOG,
  type ActionCatalogEntry,
  type RecommendationFindingType,
  type ReversibilityClass,
  type ServiceCategory,
} from './index.js';

/**
 * Exact case-sensitive match between a Recommendation_Item's (category, resourceType) and the
 * Action_Catalog — not case-insensitive, no partial matching (Requirement 1.2/1.3). Returns
 * `undefined` when nothing matches (that Recommendation_Item is manual-only, Requirement 1.4).
 *
 * KNOWN LIMITATION: this function matches on (category, resourceType) — it CANNOT distinguish 2
 * different findings that SHARE the same (category, resourceType) but need different automation
 * (e.g. `ebsVolumeUnattached` needs `Snapshot_And_Delete_EBS_Volume`, while `ebsVolumeGp2ShouldBeGp3`
 * needs `EBS_ModifyVolumeType` — both are `storage`/`ebs-volume`). For NEW findings that could collide
 * this way, use `matchActionCatalogForFinding()` instead of this function (see
 * `FINDING_TYPE_ACTION_OVERRIDES` below). This function is kept unchanged so as not to break the
 * existing behavior of EC2 Start/Stop (Requirement 1.5/1.6, via `chooseEc2Action`) — that is OUT of
 * scope for needing a findingType override.
 */
export function matchActionCatalog(item: { category: ServiceCategory; resourceType: string }): ActionCatalogEntry | undefined {
  return ACTION_CATALOG.find((entry) => entry.category === item.category && entry.resourceType === item.resourceType);
}

/**
 * Explicit overrides for `RecommendationFindingType`s where (category, resourceType) alone is
 * NOT enough to determine the correct `ActionType` (see the known limitation on `matchActionCatalog`).
 * A finding not present in this map (or mapped to a value that doesn't exist in `ACTION_CATALOG`) is
 * treated as manual-only — there is NO silent fallback to `matchActionCatalog`, to prevent a new
 * cost-optimization finding from accidentally "borrowing" another finding's action just because they
 * share the same category/resourceType.
 */
const FINDING_TYPE_ACTION_OVERRIDES: Partial<Record<RecommendationFindingType, string>> = {
  ebsVolumeUnattached: 'Snapshot_And_Delete_EBS_Volume',
  s3BucketNoLifecyclePolicy: 'Apply_S3_Lifecycle_Policy',
  ebsVolumeGp2ShouldBeGp3: 'EBS_ModifyVolumeType',
  cloudWatchLogGroupNoRetention: 'CloudWatchLogGroup_SetRetention',
  elasticIpUnused: 'ElasticIp_Release',
  // ec2LowCpu (category 'compute', resourceType 'ec2-instance') SHARES (category, resourceType)
  // with EC2_Start/EC2_Stop — an explicit override here is REQUIRED, otherwise matchActionCatalog()
  // (used when there's no override) would always return the EC2_Start entry (first match), which is
  // completely wrong for this finding. EC2_Rightsize computes its own target type (one size down,
  // same family) and checks real CPU architecture compatibility itself at execution time — see
  // `ec2Rightsizing.ts`.
  ec2LowCpu: 'EC2_Rightsize',
  // backupVaultNotProtected (category 'backup', resourceType 'backup-vault') — the ONLY
  // Action_Catalog entry with this (category, resourceType), so plain matchActionCatalog() would
  // also give the right result, but it's declared explicitly here per the principle "every finding
  // with automation MUST have an explicit override, never rely on category/resourceType happening
  // not to collide with anything else" — to avoid repeating the ec2LowCpu mistake if another finding
  // with the same resourceType is added later.
  backupVaultNotProtected: 'BackupVault_ApplyProtectionPolicy',
  // restoreTestingNotConfigured (category 'backup', resourceType 'backup-restore-testing') — an
  // account-wide finding (resourceId is always 'account-wide'); the corresponding action creates a
  // Restore Testing Plan + 2 standard selections (RDS/EC2, wildcard ProtectedResourceArns) — see
  // `backup-restore-testing-action-service.ts`.
  restoreTestingNotConfigured: 'BackupRestoreTesting_CreatePlan',
  // backupJobFailed (category 'backup', resourceType varies with the real AWS resource type of the
  // backup job — 'RDS'/'EC2'/'EBS'...) — the action retriggers an on-demand backup job for the EXACT
  // resourceArn recorded in the finding (this finding's resourceId IS the resourceArn, not a short
  // name — see `infra-review-collector.ts`).
  backupJobFailed: 'Backup_RetryJob',
  // rdsResourceGovernanceMissing (category 'database', resourceType 'rds-instance') SHARES
  // (category, resourceType) with rdsLowCpu/rdsMissingMultiAz — an explicit override is REQUIRED,
  // same reason as ec2LowCpu above (plain matchActionCatalog() would return the wrong entry without one).
  rdsResourceGovernanceMissing: 'RDS_ApplyResourceGovernance',
};

/**
 * Matches a Resource_Action by a `RecommendationItem`'s EXACT `findingType` (the most accurate
 * source of truth — see `RecommendationFindingType`), instead of inferring via (category,
 * resourceType) like `matchActionCatalog()`. A finding not in `FINDING_TYPE_ACTION_OVERRIDES` (e.g.
 * `ec2LowCpu`, `rdsMissingMultiAz`, `savingsPlanCoverageLow`...) returns `undefined` — THIS IS BY
 * DESIGN (manual-only, no corresponding safe automation exists), not a bug or an omission.
 */
export function matchActionCatalogForFinding(findingType: RecommendationFindingType): ActionCatalogEntry | undefined {
  const actionType = FINDING_TYPE_ACTION_OVERRIDES[findingType];
  if (!actionType) return undefined;
  return ACTION_CATALOG.find((entry) => entry.actionType === actionType);
}

/**
 * Chooses which EC2 button to display based on the current currentState: 'EC2_Start' when
 * currentState === 'stopped', otherwise 'EC2_Stop' — a total function, it never returns both or
 * neither (Requirement 1.5/1.6).
 */
export function chooseEc2Action(currentState: string): 'EC2_Start' | 'EC2_Stop' {
  return currentState === 'stopped' ? 'EC2_Start' : 'EC2_Stop';
}

/**
 * Looks up the Reversibility_Class from the Action_Catalog by actionType. Defaults to
 * 'irreversible' for any unrecognized actionType (including an empty string or an unexpected
 * value) — a safe default for when a new Resource_Action is added without an explicit
 * Reversibility_Class assigned yet (Requirement 2.1/2.2).
 */
export function getReversibilityClass(actionType: string): ReversibilityClass {
  const entry = ACTION_CATALOG.find((e) => e.actionType === actionType);
  return entry?.reversibilityClass ?? 'irreversible';
}

/**
 * Reverse allowlist: only EC2_Stop and Apply_S3_Lifecycle_Policy are confirmed to NOT increase
 * ongoing operating cost, so they skip the warning. Every other actionType — including EC2_Start,
 * Snapshot_And_Delete_EBS_Volume, and any unrecognized actionType in the future — defaults to
 * returning the generic warning, so the confirmation flow never silently skips a possible cost
 * warning (Requirement 17.4/17.5).
 */
const NO_COST_WARNING_ACTIONS: ReadonlySet<string> = new Set(['EC2_Stop', 'Apply_S3_Lifecycle_Policy']);

export function getCostImpactWarning(actionType: string): string | undefined {
  if (NO_COST_WARNING_ACTIONS.has(actionType)) return undefined;
  return 'This action may affect operating cost — please confirm you understand the impact before continuing.';
}

/**
 * Maps an RDS `DBInstanceStatus` → 3 independent lifecycle actions (Start/Stop/Reboot) that can be
 * clicked right now — used for the action buttons on InfraTab (`InfraTab.tsx`). Does NOT use a
 * 2-value union like `chooseEc2Action()` because an RDS instance may be eligible for EXACTLY 1 or
 * NO action depending on its state — Stop/Reboot are only valid when "available", Start is only
 * valid when "stopped", and every other transient state (starting/stopping/rebooting/modifying/
 * backing-up...) allows no action at all (keeps the UI stable, avoids double-submit).
 */
export interface RdsLifecycleActions {
  canStart: boolean;
  canStop: boolean;
  canReboot: boolean;
}

export function rdsLifecycleActionsForStatus(status: string): RdsLifecycleActions {
  return {
    canStart: status === 'stopped',
    canStop: status === 'available',
    canReboot: status === 'available',
  };
}
