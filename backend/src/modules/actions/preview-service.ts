import {
  DescribeVolumesCommand,
  DescribeAddressesCommand,
  DescribeInstancesCommand,
  DescribeSecurityGroupsCommand,
} from '@aws-sdk/client-ec2';
import { GetBucketLifecycleConfigurationCommand } from '@aws-sdk/client-s3';
import { DescribeServicesCommand } from '@aws-sdk/client-ecs';
import { DescribeDBInstancesCommand } from '@aws-sdk/client-rds';
import { DescribeLogGroupsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { DescribeScalableTargetsCommand } from '@aws-sdk/client-application-auto-scaling';
import { GetBackupVaultAccessPolicyCommand, ListBackupJobsCommand, ListRestoreTestingPlansCommand } from '@aws-sdk/client-backup';
import {
  ACTION_CATALOG,
  matchActionCatalog,
  matchActionCatalogForFinding,
  getCostImpactWarning,
  parseSecurityGroupIngressRule,
  buildSecurityImpactWarning,
  describeSecurityGroupRule,
  securityGroupHasIngressRule,
  findSsmRunPreset,
  getPresetVariant,
  parseSecurityGroupEgressRule,
  securityGroupHasEgressRule,
  describeSecurityGroupEgressRule,
  buildEgressSecurityImpactWarning,
  type ActionPreview,
  type ActionType,
  type ReversibilityClass,
} from '@ops-dashboard/shared';
import { config } from '../../config.js';
import { badRequest, notFound, HttpError } from '../../shared-kernel/errors.js';
import { getAssessmentData } from '../assessment/index.js';
// Lean_Lambda_Exception (Requirement 6.4a): direct imports, not `../governance/index.js`. That
// barrel also re-exports `s3PolicyStore.ts`, which imports `../assessment/infra-review-collector/
// clients.ts` -> throws at module scope unless `ASSESSMENT_BUCKET_NAME` is set. This file (running
// inside `action-execution-fn`) IS granted that variable in production (see
// `ActionExecutionFunction` in infra/ops-dashboard.yaml), so this is not a production outage risk
// — but going through the barrel needlessly couples every test of this file to mocking
// `clients.ts`/`ASSESSMENT_BUCKET_NAME` for symbols that have nothing to do with `s3PolicyStore`.
// Found via `npm run test --workspaces` (the exact gate `infra/deploy.sh` runs before every
// deploy) failing on `preview-service.securityGroup.test.ts`/`ecs-scale-action-service.test.ts`/
// `rds-storage-action-service.test.ts` when run in isolation.
import {
  computeEcsScaleOutTarget,
  computeRdsStorageIncreaseTarget,
} from '../governance/scalePlanning.js';
import { areArchitecturesCompatible, computeEc2RightsizeTarget } from '../governance/ec2Rightsizing.js';
import { detectEngineFamily, computeResourceGovernanceTargetParameters, RDS_INSTANCE_VCPU } from '../governance/rdsResourceGovernance.js';
import { policyHasDeletionProtection } from '../compliance/index.js';
// Lean_Lambda_Exception (Requirement 6.4a): direct import, not `../monitoring/index.js` — that
// barrel also re-exports `buildConsoleLink` from `monitoring-service.js`, which transitively loads
// `monitoring-service/get-monitoring-data.ts` -> `threshold-history-service.ts`, which throws at
// module scope unless `ASSESSMENT_BUCKET_NAME` is set. Same class of issue as the governance
// barrel above — found the same way (an isolated `npm run test --workspaces` run, not the full
// suite, where module-scope side effects from an unrelated test file can mask this).
import { RDS_INSTANCE_RAM_GIB } from '../monitoring/monitoringThresholds.js';
import { logger } from '../../shared-kernel/logger.js';
import {
  getEc2Client,
  getS3Client,
  getEcsClient,
  getRdsClient,
  getApplicationAutoScalingClient,
  getCloudWatchLogsClient,
  getBackupClient,
} from '../../core/aws-clients.js';

const ec2 = getEc2Client();
const s3 = getS3Client();
const ecs = getEcsClient();
const rds = getRdsClient();
const autoscaling = getApplicationAutoScalingClient();
const cloudwatchLogs = getCloudWatchLogsClient();
const backup = getBackupClient();

/** Same default constant used by `cloudwatch-log-retention-action-service.ts` at real execution
 * time — display the ACTUAL value that will be applied in the Confirmation_Dialog, not some other
 * illustrative number. */
const CLOUDWATCH_LOG_DEFAULT_RETENTION_DAYS = 90;

/**
 * Temporary defaults for the `Apply_S3_Lifecycle_Policy` lifecycle preview — this preview does NOT
 * yet have the value the user will choose (that only exists in the `POST /actions/execute` body,
 * Requirement 5.1). This is only an illustrative value shown in the Confirmation_Dialog before the
 * user confirms the real parameters; the final execution value is decided by the execution request
 * (Task 7.2), not by this preview.
 */
const PREVIEW_LIFECYCLE_DAYS = 90;
const PREVIEW_LIFECYCLE_STORAGE_CLASS = 'Glacier';

/** Fast Action_Catalog lookup by `actionType` — used by `buildActionPreviewDirect()`. */
const ACTION_CATALOG_BY_TYPE = new Map(ACTION_CATALOG.map((entry) => [entry.actionType, entry] as const));

/**
 * Re-reads `assessment-report.json` (same as `assessment-service.ts`), finds the
 * `RecommendationItem` by `recommendationId`, matches it against `Action_Catalog`, then calls the
 * corresponding AWS Describe/Get API (strictly READ-ONLY — this file contains no mutating call
 * whatsoever) to return an `ActionPreview` that reflects the freshest real AWS state at the moment
 * the Confirmation_Dialog is opened (Design decision 4).
 *
 * Throws `notFound` when the recommendation isn't found, `badRequest` when it doesn't match any
 * Action_Catalog entry or there isn't enough data to display all 4 required fields (Requirement 3.5).
 */
export async function buildActionPreview(recommendationId: string): Promise<ActionPreview> {
  const report = await getAssessmentData();
  const item = report.recommendations.find((r) => r.id === recommendationId);
  if (!item) {
    throw notFound('Recommendation not found');
  }

  // Try the findingType override FIRST — needed for findings that SHARE the same (category,
  // resourceType) as another finding but need different automation (ebsVolumeUnattached vs
  // ebsVolumeGp2ShouldBeGp3, both storage/ebs-volume — matchActionCatalog by category/resourceType
  // alone would always return the FIRST entry found, which is wrong for the second finding).
  // Findings with NO explicit override (EC2, S3, EBS unattached — unchanged old behavior) fall back
  // to matchActionCatalog() as before.
  const entry = matchActionCatalogForFinding(item.findingType) ?? matchActionCatalog({ category: item.category, resourceType: item.resourceType });
  if (!entry) {
    throw badRequest('Recommendation is manual-only, no matching Action_Catalog entry');
  }

  // The recommendation flow does NOT pass params: `RecommendationItem` carries no Security Group
  // rule parameters. The 2 Security Group actionTypes will therefore self-reject with `badRequest`
  // right at the parse step — which is intentional (they can only be reached from the Security
  // Group tab), failing loud instead of silently.
  return buildPreviewForCatalogEntry(entry.actionType, item.resourceId, report.account, entry.reversibilityClass);
}

/**
 * "Direct" variant of `buildActionPreview` — used by the quick-action opened FROM Monitoring_Page
 * (a 1-click runbook, e.g. "high CPU on an ECS_Service" -> `ECS_ScaleOut`), where there is NO
 * corresponding `RecommendationItem`/`recommendationId` (Monitoring_Page detects issues from a
 * real-time CloudWatch metric/alarm, not from `infra-review-collector`, which runs once a day).
 * Validates that `actionType` matches exactly one known Action_Catalog entry before building the
 * preview — never trust an arbitrary `actionType` coming from the client.
 */
export async function buildActionPreviewDirect(
  actionType: string,
  resourceId: string,
  /** Action-specific parameters, taken from the query string (every value is a string). Currently
   * only the 2 Security Group actionTypes need this — every other action ignores it. Defaults to
   * `{}` so every existing call site is unaffected. */
  params: Record<string, string> = {},
): Promise<ActionPreview> {
  const entry = ACTION_CATALOG_BY_TYPE.get(actionType as ActionType);
  if (!entry) {
    throw badRequest(`Unknown or unsupported actionType: ${actionType}`);
  }
  // Fixed abc-prod account id (123456789012) — same constant used in `infra-review-collector.ts`
  // (there is no other "account" source for the direct preview flow, unlike `buildActionPreview`,
  // which reads `report.account` from assessment-report.json).
  const account = '123456789012';
  return buildPreviewForCatalogEntry(actionType as ActionType, resourceId, account, entry.reversibilityClass, params);
}

async function buildPreviewForCatalogEntry(
  actionType: ActionType,
  resourceId: string,
  account: string,
  reversibilityClass: ReversibilityClass,
  params: Record<string, string> = {},
): Promise<ActionPreview> {
  const region = config.awsRegion;
  const preview = await buildPreviewForActionType(actionType, resourceId, account, region, params);

  return {
    actionType,
    awsApiCall: preview.awsApiCall,
    resource: preview.resource,
    params: preview.params,
    reversibilityClass,
    costImpactWarning: getCostImpactWarning(actionType),
    // Only attach the field when there ACTUALLY is a warning — an explicit `undefined` would leak
    // into the JSON response as a key with no value and pollute the `ActionPreview` contract.
    ...(preview.securityImpactWarning !== undefined
      ? { securityImpactWarning: preview.securityImpactWarning }
      : {}),
  };
}

interface PreviewCore {
  awsApiCall: string;
  resource: { id: string; arn: string; region: string };
  params: Record<string, string | number>;
  /** ONLY the Security Group builder sets this field — see `buildSecurityImpactWarning()` (shared). */
  securityImpactWarning?: string;
}

async function buildPreviewForActionType(
  actionType: ActionType,
  resourceId: string,
  account: string,
  region: string,
  params: Record<string, string>,
): Promise<PreviewCore> {
  switch (actionType) {
    case 'Snapshot_And_Delete_EBS_Volume':
      return buildEbsPreview(resourceId, account, region);
    case 'Apply_S3_Lifecycle_Policy':
      return buildS3LifecyclePreview(resourceId, region);
    case 'EC2_Start':
      return buildEc2StatePreview(resourceId, account, region, 'start');
    case 'EC2_Stop':
      return buildEc2StatePreview(resourceId, account, region, 'stop');
    case 'ECS_ScaleOut':
      return buildEcsScaleOutPreview(resourceId, account, region);
    case 'RDS_IncreaseStorage':
      return buildRdsIncreaseStoragePreview(resourceId, account, region);
    case 'EBS_ModifyVolumeType':
      return buildEbsModifyVolumeTypePreview(resourceId, account, region);
    case 'CloudWatchLogGroup_SetRetention':
      return buildCloudWatchLogRetentionPreview(resourceId, region);
    case 'ElasticIp_Release':
      return buildElasticIpReleasePreview(resourceId, account, region);
    case 'EC2_Rightsize':
      return buildEc2RightsizePreview(resourceId, account, region);
    case 'BackupVault_ApplyProtectionPolicy':
      return buildBackupVaultApplyProtectionPolicyPreview(resourceId, region);
    case 'BackupRestoreTesting_CreatePlan':
      return buildBackupRestoreTestingCreatePlanPreview(region);
    case 'Backup_RetryJob':
      return buildBackupRetryJobPreview(resourceId, region);
    case 'RDS_ApplyResourceGovernance':
      return buildRdsApplyResourceGovernancePreview(resourceId, account, region);
    case 'EC2_AutoRightsize':
      // There is no Confirmation_Dialog for this actionType — `ec2-rightsize-applier.ts` performs it
      // itself when the instance stops, bypassing the router/preview-service (see
      // action-execution-handler.ts). There is no findingType override for `EC2_AutoRightsize` in
      // `FINDING_TYPE_ACTION_OVERRIDES` (shared/src/action-catalog.ts), so
      // `matchActionCatalogForFinding()` never returns this actionType for any RecommendationItem —
      // this branch exists only to satisfy the exhaustiveness check.
      throw badRequest('EC2_AutoRightsize does not support preview via the router.');
    case 'EC2_Reboot':
      return buildEc2RebootPreview(resourceId, account, region);

    case 'RDS_Start':
      return buildRdsStartPreview(resourceId, account, region);

    case 'RDS_Stop':
      return buildRdsStopPreview(resourceId, account, region);

    case 'RDS_Reboot':
      return buildRdsRebootPreview(resourceId, account, region);

    case 'SecurityGroup_AuthorizeIngress':
    case 'SecurityGroup_RevokeIngress':
      return buildSecurityGroupIngressPreview(actionType, resourceId, params, account, region);

    case 'SSM_RunPreset':
      return buildSsmRunPresetPreview(resourceId, params, account, region);

    case 'Ec2_ChangeInstanceType':
      return buildEc2ChangeInstanceTypePreview(resourceId, params, account, region);

    case 'Ec2_UpdateTags':
      return buildEc2UpdateTagsPreview(resourceId, params, account, region);

    case 'SecurityGroup_AuthorizeEgress':
    case 'SecurityGroup_RevokeEgress':
      return buildSecurityGroupEgressPreview(actionType, resourceId, params, account, region);
    case 'Ec2_ModifySecurityGroups':
      return buildEc2ModifySecurityGroupsPreview(resourceId, params, account, region);
    case 'SecurityGroup_Create':
      return buildSecurityGroupCreatePreview(params, region);
    case 'SecurityGroup_Delete':
      return buildSecurityGroupDeletePreview(resourceId, account, region);
    default: {
      // Exhaustiveness guard — Action_Catalog currently has only 9 values; if shared adds a new
      // actionType that preview-service hasn't handled yet, fail loud (badRequest) instead of
      // returning a preview with missing fields.
      const _exhaustive: never = actionType;
      throw badRequest(`Unsupported action type: ${_exhaustive as string}`);
    }
  }
}

/**
 * Preview for `SSM_RunPreset`. Calls NO AWS API: everything that needs to be shown (the command
 * that will run) already lives in the `SSM_RUN_PRESETS` constant — calling SSM here would only cost
 * money and latency.
 *
 * Showing the EXACT command that is about to run is a SAFETY FEATURE — the operator sees precisely
 * what will be executed before confirming. Note the data direction: `params.command` flows FROM the
 * constant TO the UI, and there is NO path for it to flow back into `ssm:SendCommand`.
 *
 * Does NOT set `securityImpactWarning`: all 5 presets are read-only. Forcing the user to type the
 * instance id to run `df -h` would dilute the meaning of that mechanism for genuinely dangerous
 * actions.
 */
function buildSsmRunPresetPreview(
  instanceId: string,
  params: Record<string, string>,
  account: string,
  region: string,
): PreviewCore {
  const preset = findSsmRunPreset(params.presetId ?? '');
  if (!preset) {
    throw badRequest(`Invalid preset: ${params.presetId ?? '(empty)'}`);
  }
  // The preview defaults to showing the Linux variant (no extra AWS API call to look up the real
  // platform — consistent with "calls NO AWS API" above). `runSsmPreset` at execution time ALWAYS
  // re-determines the real platform via a DescribeInstanceInformation preflight, never reading or
  // trusting the value displayed here.
  const variant = getPresetVariant(preset, 'linux');
  return {
    awsApiCall: `ssm:SendCommand (${variant.documentName})`,
    resource: { id: instanceId, arn: `arn:aws:ec2:${region}:${account}:instance/${instanceId}`, region },
    params: { presetId: preset.id, preset: preset.label, command: variant.commands.join('; ') },
  };
}

async function buildEbsPreview(volumeId: string, account: string, region: string): Promise<PreviewCore> {
  let volumeFound = false;
  try {
    const { Volumes = [] } = await ec2.send(new DescribeVolumesCommand({ VolumeIds: [volumeId] }));
    volumeFound = Volumes.length > 0;
  } catch (err) {
    logger.error(`preview-service: DescribeVolumes(${volumeId}) failed`, err);
    throw badRequest('Unable to verify EBS volume state');
  }

  if (!volumeFound) {
    throw badRequest('Unable to verify EBS volume state');
  }

  return {
    awsApiCall: 'ec2:CreateSnapshot + ec2:DeleteVolume',
    resource: {
      id: volumeId,
      arn: `arn:aws:ec2:${region}:${account}:volume/${volumeId}`,
      region,
    },
    params: { volumeId },
  };
}

async function buildS3LifecyclePreview(bucketName: string, region: string): Promise<PreviewCore> {
  try {
    await s3.send(new GetBucketLifecycleConfigurationCommand({ Bucket: bucketName }));
  } catch (err) {
    const errorName = (err as { name?: string }).name;
    // NoSuchLifecycleConfiguration is a normal outcome (the bucket has no lifecycle policy yet) —
    // not an error, so continue building the preview normally (same pattern as storage-collector.ts).
    if (errorName !== 'NoSuchLifecycleConfiguration') {
      logger.error(`preview-service: GetBucketLifecycleConfiguration(${bucketName}) failed`, err);
      throw badRequest('Unable to verify S3 lifecycle configuration');
    }
  }

  return {
    awsApiCall: 's3:PutBucketLifecycleConfiguration',
    resource: {
      id: bucketName,
      arn: `arn:aws:s3:::${bucketName}`,
      region,
    },
    // Illustrative value — see the PREVIEW_LIFECYCLE_DAYS/PREVIEW_LIFECYCLE_STORAGE_CLASS note above.
    params: { days: PREVIEW_LIFECYCLE_DAYS, storageClass: PREVIEW_LIFECYCLE_STORAGE_CLASS },
  };
}

function buildEc2StatePreview(
  instanceId: string,
  account: string,
  region: string,
  action: 'start' | 'stop',
): PreviewCore {
  return {
    awsApiCall: `StateManager: POST /instances/{region}/{id}/${action}`,
    resource: {
      id: instanceId,
      arn: `arn:aws:ec2:${region}:${account}:instance/${instanceId}`,
      region,
    },
    params: { instanceId },
  };
}

/**
 * Preview for `SecurityGroup_AuthorizeIngress` / `SecurityGroup_RevokeIngress`.
 *
 * Re-reads the REAL Security Group state to preempt 2 common AWS errors right at the preview step
 * (`InvalidPermission.Duplicate` when adding a rule that already exists, `InvalidPermission.NotFound`
 * when removing a rule that doesn't) — seeing the error BEFORE opening the confirmation dialog is
 * far better than seeing it after clicking "Confirm". The execution layer STILL re-checks again:
 * there is always a race window between preview and execute.
 */
async function buildSecurityGroupIngressPreview(
  actionType: 'SecurityGroup_AuthorizeIngress' | 'SecurityGroup_RevokeIngress',
  groupId: string,
  params: Record<string, string>,
  account: string,
  region: string,
): Promise<PreviewCore> {
  const parsed = parseSecurityGroupIngressRule(params);
  if (!parsed.ok) {
    throw badRequest(parsed.message);
  }
  const rule = parsed.rule;

  let group;
  try {
    const { SecurityGroups = [] } = await ec2.send(new DescribeSecurityGroupsCommand({ GroupIds: [groupId] }));
    group = SecurityGroups[0];
  } catch (err) {
    if (err instanceof HttpError) throw err;
    if (err instanceof Error && err.name.startsWith('InvalidGroup.NotFound')) {
      throw notFound(`Security Group ${groupId} not found`);
    }
    logger.error(`preview-service: DescribeSecurityGroups(${groupId}) failed`, err);
    throw badRequest('Unable to verify Security Group state');
  }
  if (!group) {
    throw notFound(`Security Group ${groupId} not found`);
  }

  const exists = securityGroupHasIngressRule(group.IpPermissions, rule);
  const summary = describeSecurityGroupRule(actionType, rule);
  if (actionType === 'SecurityGroup_AuthorizeIngress' && exists) {
    throw badRequest(`Rule already exists on ${groupId} — no need to add it again: ${summary}`);
  }
  if (actionType === 'SecurityGroup_RevokeIngress' && !exists) {
    throw badRequest(`Rule to remove not found on ${groupId}: ${summary}`);
  }

  return {
    awsApiCall:
      actionType === 'SecurityGroup_AuthorizeIngress'
        ? 'ec2:AuthorizeSecurityGroupIngress'
        : 'ec2:RevokeSecurityGroupIngress',
    resource: {
      id: groupId,
      arn: `arn:aws:ec2:${region}:${account}:security-group/${groupId}`,
      region,
    },
    params: {
      securityGroupName: group.GroupName ?? '',
      vpcId: group.VpcId ?? '',
      protocol: rule.protocol,
      fromPort: rule.fromPort,
      toPort: rule.toPort,
      cidrIp: rule.cidrIp,
      ...(rule.description ? { description: rule.description } : {}),
      summary,
    },
    securityImpactWarning: buildSecurityImpactWarning(actionType, rule),
  };
}

/**
 * Preview for `SecurityGroup_AuthorizeEgress`/`SecurityGroup_RevokeEgress` — mirrors the structure of
 * `buildSecurityGroupIngressPreview()` above, only differing in the AWS field read
 * (`IpPermissionsEgress` instead of `IpPermissions`) and the shared function used (egress instead of
 * ingress).
 */
async function buildSecurityGroupEgressPreview(
  actionType: 'SecurityGroup_AuthorizeEgress' | 'SecurityGroup_RevokeEgress',
  groupId: string,
  params: Record<string, string>,
  account: string,
  region: string,
): Promise<PreviewCore> {
  const parsed = parseSecurityGroupEgressRule(params);
  if (!parsed.ok) throw badRequest(parsed.message);
  const rule = parsed.rule;

  let group;
  try {
    const { SecurityGroups = [] } = await ec2.send(new DescribeSecurityGroupsCommand({ GroupIds: [groupId] }));
    group = SecurityGroups[0];
  } catch (err) {
    if (err instanceof HttpError) throw err;
    if (err instanceof Error && err.name.startsWith('InvalidGroup.NotFound')) {
      throw notFound(`Security Group ${groupId} not found`);
    }
    logger.error(`preview-service: DescribeSecurityGroups(${groupId}) failed`, err);
    throw badRequest('Unable to verify Security Group state');
  }
  if (!group) throw notFound(`Security Group ${groupId} not found`);

  const exists = securityGroupHasEgressRule(group.IpPermissionsEgress, rule);
  const summary = describeSecurityGroupEgressRule(actionType, rule);
  if (actionType === 'SecurityGroup_AuthorizeEgress' && exists) {
    throw badRequest(`Rule already exists on ${groupId} — no need to add it again: ${summary}`);
  }
  if (actionType === 'SecurityGroup_RevokeEgress' && !exists) {
    throw badRequest(`Rule to remove not found on ${groupId}: ${summary}`);
  }

  return {
    awsApiCall: actionType === 'SecurityGroup_AuthorizeEgress' ? 'ec2:AuthorizeSecurityGroupEgress' : 'ec2:RevokeSecurityGroupEgress',
    resource: { id: groupId, arn: `arn:aws:ec2:${region}:${account}:security-group/${groupId}`, region },
    params: {
      securityGroupName: group.GroupName ?? '',
      vpcId: group.VpcId ?? '',
      protocol: rule.protocol,
      fromPort: rule.fromPort,
      toPort: rule.toPort,
      cidrIp: rule.cidrIp,
      ...(rule.description ? { description: rule.description } : {}),
      summary,
    },
    securityImpactWarning: buildEgressSecurityImpactWarning(actionType, rule),
  };
}

/**
 * Preview for `Ec2_ModifySecurityGroups` — reads the instance's live state (current SGs) to compute
 * `added`/`removed` so the operator sees them BEFORE confirming, not just the final list.
 */
async function buildEc2ModifySecurityGroupsPreview(
  instanceId: string,
  params: Record<string, string>,
  account: string,
  region: string,
): Promise<PreviewCore> {
  let groupIds: string[];
  try {
    groupIds = params.groupIds ? (JSON.parse(params.groupIds) as string[]) : [];
  } catch {
    throw badRequest('Invalid groupIds parameter (must be a JSON array)');
  }
  if (groupIds.length === 0) {
    throw badRequest('Cannot remove all Security Groups from an instance — at least 1 Security Group is required.');
  }

  let currentGroupIds: string[] = [];
  try {
    const { Reservations = [] } = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
    const instance = Reservations[0]?.Instances?.[0];
    if (!instance) throw badRequest(`EC2 instance ${instanceId} not found.`);
    currentGroupIds = (instance.SecurityGroups ?? []).map((g) => g.GroupId).filter((id): id is string => !!id);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    logger.error(`preview-service: DescribeInstances(${instanceId}) failed`, err);
    throw badRequest('Unable to verify EC2 instance state');
  }

  const added = groupIds.filter((id) => !currentGroupIds.includes(id));
  const removed = currentGroupIds.filter((id) => !groupIds.includes(id));

  return {
    awsApiCall: 'ec2:ModifyInstanceAttribute',
    resource: { id: instanceId, arn: `arn:aws:ec2:${region}:${account}:instance/${instanceId}`, region },
    params: { instanceId, groupIds: JSON.stringify(groupIds), added: added.join(','), removed: removed.join(',') },
  };
}

/**
 * Preview for `SecurityGroup_Create` — calls NO AWS API: the resource doesn't exist yet to read live
 * state, so this only validates that the params are complete/valid. `resource.id`/`arn` use the
 * `'pending'` placeholder (matching the router's resourceId convention — see
 * `actions-security-group.ts`).
 */
async function buildSecurityGroupCreatePreview(params: Record<string, string>, region: string): Promise<PreviewCore> {
  if (!params.groupName || !params.description || !params.vpcId) {
    throw badRequest('Missing required parameter: groupName, description, vpcId');
  }
  return {
    awsApiCall: 'ec2:CreateSecurityGroup',
    resource: { id: 'pending', arn: 'pending', region },
    params: { groupName: params.groupName, description: params.description, vpcId: params.vpcId },
  };
}

/**
 * Preview for `SecurityGroup_Delete` — a real pre-flight check (not a static warning): reads live
 * `DescribeInstances` filtered by `instance.group-id` to warn upfront if the SG is still in use,
 * instead of letting the operator confirm and only then see the error at execution.
 */
async function buildSecurityGroupDeletePreview(groupId: string, account: string, region: string): Promise<PreviewCore> {
  let group;
  let referencingCount = 0;
  try {
    const { SecurityGroups = [] } = await ec2.send(new DescribeSecurityGroupsCommand({ GroupIds: [groupId] }));
    group = SecurityGroups[0];
    if (!group) throw notFound(`Security Group ${groupId} not found`);
    const { Reservations = [] } = await ec2.send(
      new DescribeInstancesCommand({ Filters: [{ Name: 'instance.group-id', Values: [groupId] }] }),
    );
    referencingCount = Reservations.flatMap((r) => r.Instances ?? []).length;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    logger.error(`preview-service: checking SecurityGroup_Delete(${groupId}) failed`, err);
    throw badRequest('Unable to verify Security Group usage');
  }

  if (referencingCount > 0) {
    throw badRequest(`Cannot delete Security Group ${groupId} — it is still in use by ${referencingCount} instance(s).`);
  }

  return {
    awsApiCall: 'ec2:DeleteSecurityGroup',
    resource: { id: groupId, arn: `arn:aws:ec2:${region}:${account}:security-group/${groupId}`, region },
    params: { groupId, securityGroupName: group.GroupName ?? '' },
  };
}

async function buildEc2RebootPreview(instanceId: string, account: string, region: string): Promise<PreviewCore> {
  let currentState: string;
  try {
    const { Reservations = [] } = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
    const instance = Reservations[0]?.Instances?.[0];
    if (!instance) {
      throw badRequest(`EC2 instance ${instanceId} not found.`);
    }
    currentState = instance.State?.Name ?? 'unknown';
  } catch (err) {
    if (err instanceof HttpError) throw err;
    logger.error(`preview-service: DescribeInstances(${instanceId}) failed`, err);
    throw badRequest('Unable to verify EC2 instance state');
  }

  if (currentState !== 'running') {
    throw badRequest(
      `Instance ${instanceId} is currently "${currentState}" — it can only be rebooted while "running".`,
    );
  }

  return {
    awsApiCall: 'ec2:RebootInstances',
    resource: { id: instanceId, arn: `arn:aws:ec2:${region}:${account}:instance/${instanceId}`, region },
    params: { instanceId },
  };
}

async function buildEc2ChangeInstanceTypePreview(
  instanceId: string,
  params: Record<string, string>,
  account: string,
  region: string,
): Promise<PreviewCore> {
  const targetInstanceType = params.targetInstanceType;
  if (!targetInstanceType) {
    throw badRequest('Missing required parameter: targetInstanceType');
  }

  let currentState: string;
  let currentType: string;
  try {
    const { Reservations = [] } = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
    const instance = Reservations[0]?.Instances?.[0];
    if (!instance) throw badRequest(`EC2 instance ${instanceId} not found.`);
    currentState = instance.State?.Name ?? 'unknown';
    currentType = instance.InstanceType ?? 'unknown';
  } catch (err) {
    if (err instanceof HttpError) throw err;
    logger.error(`preview-service: DescribeInstances(${instanceId}) failed`, err);
    throw badRequest('Unable to verify EC2 instance state');
  }

  if (currentState !== 'stopped') {
    throw badRequest(
      `Instance ${instanceId} is currently "${currentState}" — the instance type can only be changed while "stopped". Stop the instance first (see the 3-step guide in the UI).`,
    );
  }

  return {
    awsApiCall: 'ec2:ModifyInstanceAttribute',
    resource: { id: instanceId, arn: `arn:aws:ec2:${region}:${account}:instance/${instanceId}`, region },
    params: { instanceId, currentInstanceType: currentType, targetInstanceType },
  };
}

async function buildEc2UpdateTagsPreview(
  instanceId: string,
  params: Record<string, string>,
  account: string,
  region: string,
): Promise<PreviewCore> {
  return {
    awsApiCall: 'ec2:DeleteTags + ec2:CreateTags',
    resource: { id: instanceId, arn: `arn:aws:ec2:${region}:${account}:instance/${instanceId}`, region },
    params: { instanceId, set: params.set ?? '{}', remove: params.remove ?? '[]' },
  };
}

async function readRdsStatusForPreview(dbInstanceIdentifier: string): Promise<string> {
  try {
    const { DBInstances = [] } = await rds.send(
      new DescribeDBInstancesCommand({ DBInstanceIdentifier: dbInstanceIdentifier }),
    );
    const db = DBInstances[0];
    if (!db) throw badRequest(`RDS instance ${dbInstanceIdentifier} not found.`);
    return db.DBInstanceStatus ?? 'unknown';
  } catch (err) {
    if (err instanceof HttpError) throw err;
    logger.error(`preview-service: DescribeDBInstances(${dbInstanceIdentifier}) failed`, err);
    throw badRequest('Unable to verify RDS instance state');
  }
}

async function buildRdsStartPreview(dbInstanceIdentifier: string, account: string, region: string): Promise<PreviewCore> {
  const status = await readRdsStatusForPreview(dbInstanceIdentifier);
  if (status !== 'stopped') {
    throw badRequest(
      `RDS instance ${dbInstanceIdentifier} is currently "${status}" — it can only be started while "stopped".`,
    );
  }
  return {
    awsApiCall: 'rds:StartDBInstance',
    resource: { id: dbInstanceIdentifier, arn: `arn:aws:rds:${region}:${account}:db:${dbInstanceIdentifier}`, region },
    params: { dbInstanceIdentifier },
  };
}

async function buildRdsStopPreview(dbInstanceIdentifier: string, account: string, region: string): Promise<PreviewCore> {
  const status = await readRdsStatusForPreview(dbInstanceIdentifier);
  if (status !== 'available') {
    throw badRequest(
      `RDS instance ${dbInstanceIdentifier} is currently "${status}" — it can only be stopped while "available".`,
    );
  }
  return {
    awsApiCall: 'rds:StopDBInstance',
    resource: { id: dbInstanceIdentifier, arn: `arn:aws:rds:${region}:${account}:db:${dbInstanceIdentifier}`, region },
    params: { dbInstanceIdentifier },
  };
}

async function buildRdsRebootPreview(dbInstanceIdentifier: string, account: string, region: string): Promise<PreviewCore> {
  const status = await readRdsStatusForPreview(dbInstanceIdentifier);
  if (status !== 'available') {
    throw badRequest(
      `RDS instance ${dbInstanceIdentifier} is currently "${status}" — it can only be rebooted while "available".`,
    );
  }
  return {
    awsApiCall: 'rds:RebootDBInstance',
    resource: { id: dbInstanceIdentifier, arn: `arn:aws:rds:${region}:${account}:db:${dbInstanceIdentifier}`, region },
    params: { dbInstanceIdentifier },
  };
}

/** `resourceId` shares the same format as `ecsResourceId()` in `monitoring-service.ts`:
 * `<clusterName>/<serviceName>`. */
function parseEcsResourceId(resourceId: string): { clusterName: string; serviceName: string } | undefined {
  const slashIndex = resourceId.indexOf('/');
  if (slashIndex === -1) return undefined;
  const clusterName = resourceId.slice(0, slashIndex);
  const serviceName = resourceId.slice(slashIndex + 1);
  if (!clusterName || !serviceName) return undefined;
  return { clusterName, serviceName };
}

/**
 * Preview for `ECS_ScaleOut` — reads the current `desiredCount` + `MaxCapacity` (if the service has
 * registered an Application Auto Scaling target) AT THE MOMENT the Confirmation_Dialog is opened,
 * computing the new target with the EXACT SAME pure function `computeEcsScaleOutTarget()` that
 * `ecs-scale-action-service.ts` (real execution) also uses — preview and execution always compute
 * the SAME result for the SAME input, with no formula drift.
 */
async function buildEcsScaleOutPreview(resourceId: string, account: string, region: string): Promise<PreviewCore> {
  const parsed = parseEcsResourceId(resourceId);
  if (!parsed) {
    throw badRequest(`resourceId is not in the "<clusterName>/<serviceName>" format: ${resourceId}`);
  }
  const { clusterName, serviceName } = parsed;

  let currentDesiredCount: number;
  try {
    const { services = [] } = await ecs.send(
      new DescribeServicesCommand({ cluster: clusterName, services: [serviceName] }),
    );
    const service = services[0];
    if (!service || service.status !== 'ACTIVE') {
      throw badRequest(`ECS service ${resourceId} does not exist or is not ACTIVE.`);
    }
    currentDesiredCount = service.desiredCount ?? 0;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    logger.error(`preview-service: DescribeServices(${resourceId}) failed`, err);
    throw badRequest('Unable to verify ECS service state');
  }

  let maxCapacity: number | undefined;
  try {
    const { ScalableTargets = [] } = await autoscaling.send(
      new DescribeScalableTargetsCommand({
        ServiceNamespace: 'ecs',
        ResourceIds: [`service/${clusterName}/${serviceName}`],
        ScalableDimension: 'ecs:service:DesiredCount',
      }),
    );
    maxCapacity = ScalableTargets[0]?.MaxCapacity;
  } catch (err) {
    logger.error(`preview-service: DescribeScalableTargets(${resourceId}) failed (ignored, preview can still be shown)`, err);
  }

  const newDesiredCount = computeEcsScaleOutTarget(currentDesiredCount, maxCapacity);

  return {
    awsApiCall: 'ecs:UpdateService (desiredCount)',
    resource: {
      id: resourceId,
      arn: `arn:aws:ecs:${region}:${account}:service/${clusterName}/${serviceName}`,
      region,
    },
    params: { clusterName, serviceName, currentDesiredCount, newDesiredCount },
  };
}

/**
 * Preview for `RDS_IncreaseStorage` — reads the current `AllocatedStorage` AT THE MOMENT the
 * Confirmation_Dialog is opened, computing the new target with the EXACT SAME pure function
 * `computeRdsStorageIncreaseTarget()` that `rds-storage-action-service.ts` (real execution) also uses.
 */
async function buildRdsIncreaseStoragePreview(dbInstanceIdentifier: string, account: string, region: string): Promise<PreviewCore> {
  let currentAllocatedStorageGb: number;
  try {
    const { DBInstances = [] } = await rds.send(
      new DescribeDBInstancesCommand({ DBInstanceIdentifier: dbInstanceIdentifier }),
    );
    const db = DBInstances[0];
    if (!db) {
      throw badRequest(`RDS instance ${dbInstanceIdentifier} not found.`);
    }
    currentAllocatedStorageGb = db.AllocatedStorage ?? 0;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    logger.error(`preview-service: DescribeDBInstances(${dbInstanceIdentifier}) failed`, err);
    throw badRequest('Unable to verify RDS instance state');
  }

  if (currentAllocatedStorageGb <= 0) {
    throw badRequest(`Unable to determine the current allocated storage for RDS instance ${dbInstanceIdentifier}.`);
  }

  const newAllocatedStorageGb = computeRdsStorageIncreaseTarget(currentAllocatedStorageGb);

  return {
    awsApiCall: 'rds:ModifyDBInstance (AllocatedStorage)',
    resource: {
      id: dbInstanceIdentifier,
      arn: `arn:aws:rds:${region}:${account}:db:${dbInstanceIdentifier}`,
      region,
    },
    params: { currentAllocatedStorageGb, newAllocatedStorageGb },
  };
}

/**
 * Preview for `RDS_ApplyResourceGovernance` — reads the current `Engine`/`DBInstanceClass`/
 * `DBParameterGroupName` AT THE MOMENT the Confirmation_Dialog is opened, computing the target
 * parameter set with the EXACT SAME pure function `computeResourceGovernanceTargetParameters()`
 * that `rds-resource-governance-action-service.ts` (real execution) also uses — clearly showing the
 * parameter name + reason (bilingual) for each change in the Confirmation_Dialog before the user
 * confirms.
 */
async function buildRdsApplyResourceGovernancePreview(dbInstanceIdentifier: string, account: string, region: string): Promise<PreviewCore> {
  let engine: string;
  let dbInstanceClass: string;
  let parameterGroupName: string;
  try {
    const { DBInstances = [] } = await rds.send(
      new DescribeDBInstancesCommand({ DBInstanceIdentifier: dbInstanceIdentifier }),
    );
    const db = DBInstances[0];
    if (!db) {
      throw badRequest(`RDS instance ${dbInstanceIdentifier} not found.`);
    }
    engine = db.Engine ?? '';
    dbInstanceClass = db.DBInstanceClass ?? '';
    parameterGroupName = db.DBParameterGroups?.[0]?.DBParameterGroupName ?? '';
  } catch (err) {
    if (err instanceof HttpError) throw err;
    logger.error(`preview-service: DescribeDBInstances(${dbInstanceIdentifier}) failed`, err);
    throw badRequest('Unable to verify RDS instance state');
  }

  if (parameterGroupName.startsWith('default.')) {
    throw badRequest(
      `RDS instance ${dbInstanceIdentifier} is using the default DB Parameter Group ("${parameterGroupName}") — the default parameter group cannot be modified.`,
    );
  }

  const engineFamily = detectEngineFamily(engine);
  if (!engineFamily) {
    throw badRequest(`Engine "${engine}" is not yet supported for RDS_ApplyResourceGovernance.`);
  }

  const vcpuCount = RDS_INSTANCE_VCPU[dbInstanceClass];
  const memoryGib = RDS_INSTANCE_RAM_GIB[dbInstanceClass];
  if (vcpuCount === undefined || memoryGib === undefined) {
    throw badRequest(`No vCPU/RAM lookup data available for DBInstanceClass "${dbInstanceClass}".`);
  }

  const targetChanges = computeResourceGovernanceTargetParameters(engineFamily, vcpuCount, memoryGib);

  return {
    awsApiCall: 'rds:DescribeDBParameters -> rds:ModifyDBParameterGroup',
    resource: {
      id: dbInstanceIdentifier,
      arn: `arn:aws:rds:${region}:${account}:db:${dbInstanceIdentifier}`,
      region,
    },
    params: {
      engineFamily,
      parameterGroupName,
      parameterNames: targetChanges.map((c) => c.parameterName).join(', '),
    },
  };
}

/**
 * Preview for `EBS_ModifyVolumeType` — reads the current `VolumeType` AT THE MOMENT the
 * Confirmation_Dialog is opened, only valid when the volume IS CURRENTLY gp2 (same condition
 * re-checked by `ebs-modify-volume-type-action-service.ts` at real execution time).
 */
async function buildEbsModifyVolumeTypePreview(volumeId: string, account: string, region: string): Promise<PreviewCore> {
  let currentVolumeType: string;
  try {
    const { Volumes = [] } = await ec2.send(new DescribeVolumesCommand({ VolumeIds: [volumeId] }));
    const volume = Volumes[0];
    if (!volume) {
      throw badRequest(`EBS volume ${volumeId} not found.`);
    }
    currentVolumeType = volume.VolumeType ?? '';
  } catch (err) {
    if (err instanceof HttpError) throw err;
    logger.error(`preview-service: DescribeVolumes(${volumeId}) failed`, err);
    throw badRequest('Unable to verify EBS volume state');
  }

  if (currentVolumeType !== 'gp2') {
    throw badRequest(`Volume ${volumeId} is currently "${currentVolumeType}", not gp2 — EBS_ModifyVolumeType cannot be applied.`);
  }

  return {
    awsApiCall: 'ec2:ModifyVolume (VolumeType: gp2 -> gp3)',
    resource: {
      id: volumeId,
      arn: `arn:aws:ec2:${region}:${account}:volume/${volumeId}`,
      region,
    },
    params: { currentVolumeType, newVolumeType: 'gp3' },
  };
}

/**
 * Preview for `CloudWatchLogGroup_SetRetention` — reads the current `retentionInDays` AT THE MOMENT
 * the Confirmation_Dialog is opened, only valid when the log group STILL has no retention policy
 * (same condition re-checked by `cloudwatch-log-retention-action-service.ts` at real execution time).
 */
async function buildCloudWatchLogRetentionPreview(logGroupName: string, region: string): Promise<PreviewCore> {
  let currentRetention: number | undefined;
  try {
    const { logGroups = [] } = await cloudwatchLogs.send(
      new DescribeLogGroupsCommand({ logGroupNamePrefix: logGroupName }),
    );
    const logGroup = logGroups.find((lg) => lg.logGroupName === logGroupName);
    if (!logGroup) {
      throw badRequest(`CloudWatch Log Group ${logGroupName} not found.`);
    }
    currentRetention = logGroup.retentionInDays;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    logger.error(`preview-service: DescribeLogGroups(${logGroupName}) failed`, err);
    throw badRequest('Unable to verify CloudWatch Log Group retention state');
  }

  if (currentRetention !== undefined) {
    throw badRequest(`Log group ${logGroupName} already has a retention policy (${currentRetention} days) — no need to reapply.`);
  }

  return {
    awsApiCall: 'logs:PutRetentionPolicy',
    resource: {
      id: logGroupName,
      arn: `arn:aws:logs:${region}:*:log-group:${logGroupName}`,
      region,
    },
    params: { newRetentionDays: CLOUDWATCH_LOG_DEFAULT_RETENTION_DAYS },
  };
}

/**
 * Preview for `ElasticIp_Release` — reads the current `AssociationId` AT THE MOMENT the
 * Confirmation_Dialog is opened, only valid when the EIP is STILL not associated with any resource
 * (same condition re-checked by `elastic-ip-release-action-service.ts` at real execution time).
 */
async function buildElasticIpReleasePreview(allocationId: string, account: string, region: string): Promise<PreviewCore> {
  let associated: boolean;
  let publicIp: string | undefined;
  try {
    const { Addresses = [] } = await ec2.send(new DescribeAddressesCommand({ AllocationIds: [allocationId] }));
    const address = Addresses[0];
    if (!address) {
      throw badRequest(`Elastic IP with allocationId ${allocationId} not found.`);
    }
    associated = !!address.AssociationId;
    publicIp = address.PublicIp;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    logger.error(`preview-service: DescribeAddresses(${allocationId}) failed`, err);
    throw badRequest('Unable to verify Elastic IP state');
  }

  if (associated) {
    throw badRequest(`Elastic IP ${allocationId} is already associated with a resource — it cannot be released.`);
  }

  return {
    awsApiCall: 'ec2:ReleaseAddress',
    resource: {
      id: allocationId,
      arn: `arn:aws:ec2:${region}:${account}:elastic-ip/${allocationId}`,
      region,
    },
    params: { publicIp: publicIp ?? '' },
  };
}

/**
 * Preview for `EC2_Rightsize` — reads the current `InstanceType` AT THE MOMENT the
 * Confirmation_Dialog is opened, computing the target with the EXACT SAME pure function
 * `computeEc2RightsizeTarget()` that `ec2-rightsize-action-service.ts` (real execution) also uses,
 * then checks REAL CPU architecture compatibility via `DescribeInstanceTypes` — clearly showing in
 * the Confirmation_Dialog when incompatible (instead of letting the user confirm and only then
 * discover it at execution).
 */
async function buildEc2RightsizePreview(instanceId: string, account: string, region: string): Promise<PreviewCore> {
  let currentInstanceType: string;
  try {
    const { Reservations = [] } = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
    const instance = Reservations[0]?.Instances?.[0];
    if (!instance) {
      throw badRequest(`EC2 instance ${instanceId} not found.`);
    }
    currentInstanceType = instance.InstanceType ?? '';
  } catch (err) {
    if (err instanceof HttpError) throw err;
    logger.error(`preview-service: DescribeInstances(${instanceId}) failed`, err);
    throw badRequest('Unable to verify EC2 instance state');
  }

  let rightsizeTarget: Awaited<ReturnType<typeof computeEc2RightsizeTarget>>;
  try {
    rightsizeTarget = await computeEc2RightsizeTarget(ec2, currentInstanceType);
  } catch (err) {
    logger.error(`preview-service: DescribeInstanceTypes(family of ${currentInstanceType}) failed`, err);
    throw badRequest(`Unable to determine safe rightsize target for "${currentInstanceType}"`);
  }

  if (!rightsizeTarget) {
    throw badRequest(
      `Unable to determine a safe target instance type to rightsize from "${currentInstanceType}" (already at the smallest size, or the type format is unrecognized).`,
    );
  }

  const { instanceType: targetInstanceType, currentArchitectures, targetArchitectures } = rightsizeTarget;

  const architectureCompatible = areArchitecturesCompatible(currentArchitectures, targetArchitectures);
  if (!architectureCompatible) {
    throw badRequest(
      `Target instance type "${targetInstanceType}" is not CPU-architecture compatible with the current "${currentInstanceType}" (${currentArchitectures.join('/') || 'unknown'} vs ${targetArchitectures.join('/') || 'unknown'}) — cannot rightsize.`,
    );
  }

  return {
    awsApiCall: 'StateManager: stop -> ec2:ModifyInstanceAttribute (InstanceType) -> StateManager: start',
    resource: {
      id: instanceId,
      arn: `arn:aws:ec2:${region}:${account}:instance/${instanceId}`,
      region,
    },
    params: { currentInstanceType, newInstanceType: targetInstanceType },
  };
}

/**
 * Preview for `BackupVault_ApplyProtectionPolicy` — reads the vault's current access policy AT THE
 * MOMENT the Confirmation_Dialog is opened, clearly showing whether the vault is already sufficiently
 * protected (if it is, the user can still confirm — the action is idempotent and does nothing more —
 * see `backup-vault-protection-action-service.ts`).
 */
async function buildBackupVaultApplyProtectionPolicyPreview(vaultName: string, region: string): Promise<PreviewCore> {
  let alreadyProtected: boolean;
  try {
    const { Policy } = await backup.send(new GetBackupVaultAccessPolicyCommand({ BackupVaultName: vaultName }));
    alreadyProtected = policyHasDeletionProtection(Policy);
  } catch (err) {
    const errorName = (err as { name?: string }).name;
    if (errorName === 'ResourceNotFoundException') {
      alreadyProtected = false;
    } else {
      logger.error(`preview-service: GetBackupVaultAccessPolicy(${vaultName}) failed`, err);
      throw badRequest('Unable to verify Backup vault access policy state');
    }
  }

  return {
    awsApiCall: 'backup:GetBackupVaultAccessPolicy -> backup:PutBackupVaultAccessPolicy',
    resource: {
      id: vaultName,
      arn: `arn:aws:backup:${region}:*:backup-vault:${vaultName}`,
      region,
    },
    params: { currentlyProtected: alreadyProtected ? 'yes' : 'no' },
  };
}

/**
 * Preview for `BackupRestoreTesting_CreatePlan` — an account-wide finding (`resourceId` is always
 * 'account-wide', not a specific resource), reads the list of existing Restore Testing Plans to
 * clearly show if the standard plan ALREADY exists (the action is idempotent, see
 * `backup-restore-testing-action-service.ts`).
 */
async function buildBackupRestoreTestingCreatePlanPreview(region: string): Promise<PreviewCore> {
  let alreadyExists = false;
  try {
    const { RestoreTestingPlans = [] } = await backup.send(new ListRestoreTestingPlansCommand({}));
    alreadyExists = RestoreTestingPlans.some((plan) => plan.RestoreTestingPlanName === 'abc_prod_restore_testing_plan');
  } catch (err) {
    logger.error('preview-service: ListRestoreTestingPlans failed', err);
    throw badRequest('Unable to verify existing AWS Backup Restore Testing Plans');
  }

  return {
    awsApiCall: 'backup:CreateRestoreTestingPlan -> backup:CreateRestoreTestingSelection (RDS) -> backup:CreateRestoreTestingSelection (EC2)',
    resource: {
      id: 'account-wide',
      arn: `arn:aws:backup:${region}:*:restore-testing-plan/abc_prod_restore_testing_plan`,
      region,
    },
    params: { planAlreadyExists: alreadyExists ? 'yes' : 'no' },
  };
}

/**
 * Preview for `Backup_RetryJob` — `resourceId` IS the full `resourceArn` (see
 * `backup-retry-job-action-service.ts`). Reads the resource's most recent backup job to clearly show
 * which vault/role will be reused for the new on-demand invocation.
 */
async function buildBackupRetryJobPreview(resourceArn: string, region: string): Promise<PreviewCore> {
  let backupVaultName: string | undefined;
  try {
    const { BackupJobs = [] } = await backup.send(new ListBackupJobsCommand({ ByResourceArn: resourceArn, MaxResults: 1 }));
    backupVaultName = BackupJobs[0]?.BackupVaultName;
  } catch (err) {
    logger.error(`preview-service: ListBackupJobs(${resourceArn}) failed`, err);
    throw badRequest('Unable to verify prior backup job history for this resource');
  }

  if (!backupVaultName) {
    throw badRequest(`No prior backup job found for ${resourceArn} — cannot safely retry.`);
  }

  return {
    awsApiCall: 'backup:ListBackupJobs -> backup:StartBackupJob',
    resource: {
      id: resourceArn,
      arn: resourceArn,
      region,
    },
    params: { backupVaultName },
  };
}
