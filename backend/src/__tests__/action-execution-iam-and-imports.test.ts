import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, basename } from 'path';
import { fileURLToPath } from 'url';

// Feature: resource-actions-and-aurora-ui, Task 16.5
// Static structural test for the IAM policy (`infra/ops-dashboard.yaml`) and the import allowlist of
// `action-execution-fn`. The YAML is not parsed into a structured object (to avoid adding a new
// dependency for a single test file): the checks use plain regex/text extraction on the raw
// content, the same pattern as the existing `no-paid-api-in-request-path.test.ts` (read the file
// with readFileSync, assert with regex).

const SRC_DIR = fileURLToPath(new URL('..', import.meta.url));
const INFRA_YAML_PATH = fileURLToPath(new URL('../../../infra/ops-dashboard.yaml', import.meta.url));

const infraYamlContent = readFileSync(INFRA_YAML_PATH, 'utf-8');

/**
 * Extracts the text block of one top-level resource (2-space indentation) in
 * `infra/ops-dashboard.yaml`, from the `<resourceName>:` line (2-space indent) up to the line before
 * the next top-level resource (also 2-space indent). If the resource is not found, throws so the
 * test fails loudly instead of silently producing a false negative.
 */
function extractTopLevelResourceBlock(yamlContent: string, resourceName: string): string {
  const lines = yamlContent.split('\n');
  const startIndex = lines.findIndex((line) => /^ {2}\S/.test(line) && line.trim() === `${resourceName}:`);
  if (startIndex === -1) {
    throw new Error(`Resource '${resourceName}' not found in infra/ops-dashboard.yaml`);
  }
  let endIndex = lines.length;
  for (let i = startIndex + 1; i < lines.length; i++) {
    // Next top-level resource line: exactly 2-space indent, not blank/comment, ends with ':'.
    if (/^ {2}\S.*:\s*$/.test(lines[i]) && !/^ {4}/.test(lines[i])) {
      endIndex = i;
      break;
    }
  }
  return lines.slice(startIndex, endIndex).join('\n');
}

/**
 * Splits an IAM policy block into one chunk per statement, by splitting on the markers
 * `- Sid:` or `- Effect:` (a statement without a Sid). The first chunk (before the first marker)
 * is dropped because it does not belong to any statement.
 */
function splitIntoStatementChunks(policyBlockText: string): string[] {
  const parts = policyBlockText.split(/\n(?=\s*- (?:Sid|Effect):)/);
  return parts.filter((part) => /- (?:Sid|Effect):/.test(part));
}

/** Extracts the chunk of one statement by its Sid from a block of text. */
function extractStatementChunkBySid(blockText: string, sid: string): string {
  const chunks = splitIntoStatementChunks(blockText);
  const found = chunks.find((chunk) => new RegExp(`Sid:\\s*${sid}\\b`).test(chunk));
  if (!found) {
    throw new Error(`Statement with Sid '${sid}' not found`);
  }
  return found;
}

/**
 * Extracts the list of action strings from one statement chunk. Supports all 3 valid YAML forms:
 *   - single scalar:   `Action: ec2:DescribeSecurityGroups`
 *   - flow sequence:   `Action: [ec2:CreateSnapshot, ec2:DeleteVolume]`
 *   - block sequence:  `Action:` followed by lines like `- ec2:AuthorizeSecurityGroupIngress`
 * The block sequence form MUST be handled explicitly: if it were missed, check 1 (forbid
 * Resource: '*') would silently skip every statement written in block style, which means a gate
 * that is always green for the wrong reason.
 */
function extractActionsFromChunk(chunk: string): string[] {
  // Split on /\r?\n/: this YAML file uses CRLF, and '\r' is a line terminator in JS regex so '.'
  // does NOT match it. A leftover '\r' would make every '...$' regex below fail silently.
  const lines = chunk.split(/\r?\n/);
  const actionLineIndex = lines.findIndex((line) => /^\s*Action:/.test(line));
  if (actionLineIndex === -1) return [];
  const rawValue = lines[actionLineIndex].replace(/^\s*Action:/, '').trim();

  if (rawValue === '') {
    const blockActions: string[] = [];
    for (const line of lines.slice(actionLineIndex + 1)) {
      const itemMatch = line.match(/^\s*-\s*(\S.*)$/);
      if (!itemMatch) break;
      blockActions.push(itemMatch[1].trim());
    }
    return blockActions;
  }

  if (rawValue.startsWith('[')) {
    // Form: [ec2:CreateSnapshot, ec2:DeleteVolume]
    return rawValue
      .replace(/^\[|\]$/g, '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [rawValue];
}

/**
 * Removes YAML comment lines (lines that start with '#' after trimming) before substring checks,
 * to avoid false positives from explanatory comments (for example a comment saying RouterRole does
 * NOT have permission X contains the string 'X' itself and would make the substring check fail
 * wrongly).
 */
function stripYamlComments(text: string): string {
  return text
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
}

const actionExecutionRoleBlock = extractTopLevelResourceBlock(infraYamlContent, 'ActionExecutionRole');
const routerRoleBlockRaw = extractTopLevelResourceBlock(infraYamlContent, 'RouterRole');
const routerRoleBlock = stripYamlComments(routerRoleBlockRaw);
const approvalMutateRoleBlockRaw = extractTopLevelResourceBlock(infraYamlContent, 'ApprovalMutateRole');
const approvalMutateRoleBlock = stripYamlComments(approvalMutateRoleBlockRaw);

// The CORRECT IAM action name is "s3:PutLifecycleConfiguration" (NO "Bucket" between "Put" and
// "Lifecycle"). Using "s3:PutBucketLifecycleConfiguration" instead (it matches the SDK API call
// name but is NOT the real IAM action name) causes AccessDenied in practice.
// This list is extended with the newer mutating action types (Ec2_UpdateTags,
// SecurityGroup_AuthorizeEgress/RevokeEgress, SecurityGroup_Delete). Test 1 walks EVERY statement
// in ActionExecutionRole, so it automatically covers these AWS actions without knowing in advance
// which statement/Sid grants them. Do NOT add ec2:CreateSecurityGroup here: AWS does not support
// resource-level scoping for that action (the GroupId does not exist yet when IAM evaluates the
// request), so Resource: '*' is required by AWS (like DescribeInstanceTypeOfferings/
// DescribeInstanceTypes in RouterRole). Adding it here would make test 1 fail wrongly on a
// correct statement.
const MUTATING_ACTIONS = [
  'ec2:CreateSnapshot',
  'ec2:DeleteVolume',
  's3:PutLifecycleConfiguration',
  'ec2:CreateTags',
  'ec2:DeleteTags',
  'ec2:AuthorizeSecurityGroupEgress',
  'ec2:RevokeSecurityGroupEgress',
  'ec2:DeleteSecurityGroup',
  'ec2:ModifyInstanceAttribute',
];

describe('Static IAM structure of infra/ops-dashboard.yaml and backend import allowlist', () => {
  it('1. No ActionExecutionRole statement grants ec2:CreateSnapshot/ec2:DeleteVolume/s3:PutLifecycleConfiguration with Resource: \'*\'', () => {
    const statementChunks = splitIntoStatementChunks(actionExecutionRoleBlock);
    expect(statementChunks.length, 'must extract at least 1 statement chunk from ActionExecutionRole').toBeGreaterThan(0);

    for (const chunk of statementChunks) {
      const actions = extractActionsFromChunk(chunk);
      const hasMutatingAction = actions.some((action) => MUTATING_ACTIONS.includes(action));
      if (!hasMutatingAction) continue;

      const resourceMatch = chunk.match(/Resource:\s*(.+)/);
      const resourceValue = resourceMatch ? resourceMatch[1].trim() : '';
      expect(
        resourceValue === `'*'` || resourceValue === '"*"' || resourceValue === '*',
        `statement with mutating actions (${actions.join(', ')}) must not have Resource: '*', but found Resource: ${resourceValue}`,
      ).toBe(false);
    }
  });

  it('2. The 3 mutating statements (EbsSnapshotAndDelete, S3LifecycleApply, Ec2StateManagerServiceToken) have no overlapping actions', () => {
    const ebsSnapshotAndDelete = extractActionsFromChunk(
      extractStatementChunkBySid(actionExecutionRoleBlock, 'EbsSnapshotAndDelete'),
    );
    const s3LifecycleApply = extractActionsFromChunk(
      extractStatementChunkBySid(actionExecutionRoleBlock, 'S3LifecycleApply'),
    );
    const ec2StateManagerServiceToken = extractActionsFromChunk(
      extractStatementChunkBySid(actionExecutionRoleBlock, 'Ec2StateManagerServiceToken'),
    );

    expect(ebsSnapshotAndDelete.length, 'EbsSnapshotAndDelete must have actions').toBeGreaterThan(0);
    expect(s3LifecycleApply.length, 'S3LifecycleApply must have actions').toBeGreaterThan(0);
    expect(ec2StateManagerServiceToken.length, 'Ec2StateManagerServiceToken must have actions').toBeGreaterThan(0);

    const namedSets: Array<[string, string[]]> = [
      ['EbsSnapshotAndDelete', ebsSnapshotAndDelete],
      ['S3LifecycleApply', s3LifecycleApply],
      ['Ec2StateManagerServiceToken', ec2StateManagerServiceToken],
    ];

    for (let i = 0; i < namedSets.length; i++) {
      for (let j = i + 1; j < namedSets.length; j++) {
        const [nameA, actionsA] = namedSets[i];
        const [nameB, actionsB] = namedSets[j];
        const overlap = actionsA.filter((action) => actionsB.includes(action));
        expect(overlap, `${nameA} and ${nameB} must not share actions, but found: ${overlap.join(', ')}`).toEqual([]);
      }
    }
  });

  it('3. RouterRole has no ec2:CreateSnapshot/ec2:DeleteVolume/s3:PutLifecycleConfiguration/ssm:GetParameter (for the service-token parameter) anywhere', () => {
    const forbiddenSubstrings = [
      'ec2:CreateSnapshot',
      'ec2:DeleteVolume',
      's3:PutLifecycleConfiguration',
    ];
    for (const forbidden of forbiddenSubstrings) {
      expect(
        routerRoleBlock.includes(forbidden),
        `RouterRole must not contain '${forbidden}' anywhere`,
      ).toBe(false);
    }

    // ssm:GetParameter for Ec2StateManagerServiceTokenParameter specifically: RouterRole may have
    // other ssm:GetParameter grants (for example CostCacheParameter, which predates this), so the
    // check is that RouterRole does not reference the ARN of Ec2StateManagerServiceTokenParameter.
    expect(
      routerRoleBlock.includes('Ec2StateManagerServiceTokenParameter'),
      'RouterRole must not reference Ec2StateManagerServiceTokenParameter (only ActionExecutionRole may read this secret)',
    ).toBe(false);
  });

  it('4. ActionExecutionRole has no lambda:InvokeFunctionUrl statement for the state manager', () => {
    expect(
      actionExecutionRoleBlock.includes('lambda:InvokeFunctionUrl'),
      'ActionExecutionRole must not have lambda:InvokeFunctionUrl - calling the state manager is a plain HTTPS POST, not an AWS_IAM invoke of a Function URL',
    ).toBe(false);
  });

  // Security Group: RouterRole may only READ (ec2:DescribeSecurityGroups) to build the Security
  // Group tab and previews; every MUTATE permission lives in ActionExecutionRole, a separate Lambda
  // reachable only through POST /actions/security-group, which is behind the operator gate. If
  // someone "made it convenient" by adding mutate permissions directly to RouterRole, every signed-in
  // user could open ports through the Function URL.
  const SG_MUTATING_ACTIONS = ['ec2:AuthorizeSecurityGroupIngress', 'ec2:RevokeSecurityGroupIngress'];

  it('7. RouterRole has no Security Group mutate permission; it lives only in ActionExecutionRole and is scoped by Resource', () => {
    for (const forbidden of SG_MUTATING_ACTIONS) {
      expect(
        routerRoleBlock.includes(forbidden),
        `RouterRole must not contain '${forbidden}' - Security Group mutation must go through action-execution-fn`,
      ).toBe(false);
    }

    const mutateChunk = extractStatementChunkBySid(actionExecutionRoleBlock, 'SecurityGroupIngressMutate');
    const actions = extractActionsFromChunk(mutateChunk);
    for (const required of SG_MUTATING_ACTIONS) {
      expect(actions, `SecurityGroupIngressMutate must grant '${required}'`).toContain(required);
    }

    // Resource must be a security-group ARN of this account/region, never '*'.
    const resourceMatch = mutateChunk.match(/Resource:\s*(.+)/);
    const resourceValue = resourceMatch ? resourceMatch[1].trim() : '';
    expect(
      resourceValue === `'*'` || resourceValue === '"*"' || resourceValue === '*',
      `SecurityGroupIngressMutate must not have Resource: '*', but found: ${resourceValue}`,
    ).toBe(false);
    expect(resourceValue).toContain(':security-group/');
  });

  // SSM Run Command (including the Windows extension): RouterRole may only POLL results
  // (ssm:GetCommandInvocation); the permission to SEND commands (ssm:SendCommand) lives only in
  // ActionExecutionRole and is scoped to EXACTLY 2 fixed documents: AWS-RunShellScript (linux) and
  // AWS-RunPowerShellScript (windows). If someone widens Resource to '*' or adds a third document,
  // IAM stops being the second line of defense for the invariant "there is never a free-text
  // command".
  it('9. RouterRole has no ssm:SendCommand; ActionExecutionRole can only send the 2 documents AWS-RunShellScript/AWS-RunPowerShellScript', () => {
    expect(
      routerRoleBlock.includes('ssm:SendCommand'),
      "RouterRole must not contain 'ssm:SendCommand' - sending commands must go through action-execution-fn",
    ).toBe(false);

    const sendChunk = extractStatementChunkBySid(actionExecutionRoleBlock, 'SsmSendCommandRunShellScriptOnly');
    expect(extractActionsFromChunk(sendChunk)).toEqual(['ssm:SendCommand']);

    // Resource is a block sequence -> read each '- ...' line instead of a single-line regex.
    const resourceLines = sendChunk
      .split(/\r?\n/)
      .slice(sendChunk.split(/\r?\n/).findIndex((line) => /^\s*Resource:/.test(line)) + 1)
      .map((line) => line.match(/^\s*-\s*(\S.*)$/)?.[1]?.trim())
      .filter((value): value is string => Boolean(value));

    expect(resourceLines.length, 'SsmSendCommandRunShellScriptOnly must list specific Resources').toBeGreaterThan(0);
    for (const resource of resourceLines) {
      expect(resource, `Resource of SsmSendCommandRunShellScriptOnly must not be '*': ${resource}`).not.toMatch(
        /^['"]?\*['"]?$/,
      );
    }
    expect(resourceLines.some((resource) => resource.includes(':document/AWS-RunShellScript'))).toBe(true);
    expect(resourceLines.some((resource) => resource.includes(':document/AWS-RunPowerShellScript'))).toBe(true);
    // No document other than the 2 fixed ones above may be allowed.
    const documentResources = resourceLines.filter((resource) => resource.includes(':document/'));
    expect(documentResources).toHaveLength(2);
  });

  // Security Group egress: mirrors check 7 (ingress) with exactly the same logic - RouterRole must
  // not mutate, ActionExecutionRole scopes Resource to security-group ARNs.
  const SG_EGRESS_MUTATING_ACTIONS = ['ec2:AuthorizeSecurityGroupEgress', 'ec2:RevokeSecurityGroupEgress'];

  it('11. RouterRole has no Security Group egress mutate permission; it lives only in ActionExecutionRole and is scoped by Resource', () => {
    for (const forbidden of SG_EGRESS_MUTATING_ACTIONS) {
      expect(
        routerRoleBlock.includes(forbidden),
        `RouterRole must not contain '${forbidden}' - Security Group egress mutation must go through action-execution-fn`,
      ).toBe(false);
    }

    const mutateChunk = extractStatementChunkBySid(actionExecutionRoleBlock, 'SecurityGroupEgressMutate');
    const actions = extractActionsFromChunk(mutateChunk);
    for (const required of SG_EGRESS_MUTATING_ACTIONS) {
      expect(actions, `SecurityGroupEgressMutate must grant '${required}'`).toContain(required);
    }

    const resourceMatch = mutateChunk.match(/Resource:\s*(.+)/);
    const resourceValue = resourceMatch ? resourceMatch[1].trim() : '';
    expect(
      resourceValue === `'*'` || resourceValue === '"*"' || resourceValue === '*',
      `SecurityGroupEgressMutate must not have Resource: '*', but found: ${resourceValue}`,
    ).toBe(false);
    expect(resourceValue).toContain(':security-group/');
  });

  // Security Group lifecycle: CreateSecurityGroup REQUIRES Resource: '*' (AWS does not support
  // resource-level scoping - the GroupId does not exist yet at evaluation time), but
  // DeleteSecurityGroup MUST be scoped to a specific security-group ARN (AWS supports this).
  it('12. RouterRole cannot create/delete Security Groups; ActionExecutionRole grants CreateSecurityGroup with Resource:* (required by AWS) and DeleteSecurityGroup scoped to an ARN', () => {
    for (const forbidden of ['ec2:CreateSecurityGroup', 'ec2:DeleteSecurityGroup']) {
      expect(
        routerRoleBlock.includes(forbidden),
        `RouterRole must not contain '${forbidden}' - creating/deleting Security Groups must go through action-execution-fn`,
      ).toBe(false);
    }

    const createChunk = extractStatementChunkBySid(actionExecutionRoleBlock, 'Ec2CreateSecurityGroup');
    expect(extractActionsFromChunk(createChunk)).toContain('ec2:CreateSecurityGroup');
    const createResourceMatch = createChunk.match(/Resource:\s*(.+)/);
    const createResourceValue = createResourceMatch ? createResourceMatch[1].trim() : '';
    expect(
      createResourceValue === `'*'` || createResourceValue === '"*"' || createResourceValue === '*',
      `Ec2CreateSecurityGroup MUST use Resource: '*' (AWS does not support resource-level scoping for this action), but found: ${createResourceValue}`,
    ).toBe(true);

    const deleteChunk = extractStatementChunkBySid(actionExecutionRoleBlock, 'Ec2DeleteSecurityGroup');
    expect(extractActionsFromChunk(deleteChunk)).toContain('ec2:DeleteSecurityGroup');
    const deleteResourceMatch = deleteChunk.match(/Resource:\s*(.+)/);
    const deleteResourceValue = deleteResourceMatch ? deleteResourceMatch[1].trim() : '';
    expect(
      deleteResourceValue === `'*'` || deleteResourceValue === '"*"' || deleteResourceValue === '*',
      `Ec2DeleteSecurityGroup must not have Resource: '*', but found: ${deleteResourceValue}`,
    ).toBe(false);
    expect(deleteResourceValue).toContain(':security-group/');
  });

  // EC2 tag management: CreateTags/DeleteTags must be scoped to instance ARNs, never Resource: '*'.
  // Mirrors check 1 but targets the specific Sid.
  it('13. RouterRole has no CreateTags/DeleteTags permission; ActionExecutionRole scopes Resource to instance ARNs', () => {
    for (const forbidden of ['ec2:CreateTags', 'ec2:DeleteTags']) {
      expect(
        routerRoleBlock.includes(forbidden),
        `RouterRole must not contain '${forbidden}' - tag edits must go through action-execution-fn`,
      ).toBe(false);
    }

    const tagsChunk = extractStatementChunkBySid(actionExecutionRoleBlock, 'Ec2CreateDeleteTags');
    const actions = extractActionsFromChunk(tagsChunk);
    expect(actions).toContain('ec2:CreateTags');
    expect(actions).toContain('ec2:DeleteTags');

    const resourceMatch = tagsChunk.match(/Resource:\s*(.+)/);
    const resourceValue = resourceMatch ? resourceMatch[1].trim() : '';
    expect(
      resourceValue === `'*'` || resourceValue === '"*"' || resourceValue === '*',
      `Ec2CreateDeleteTags must not have Resource: '*', but found: ${resourceValue}`,
    ).toBe(false);
    expect(resourceValue).toContain(':instance/');
  });

  // Ec2_ModifySecurityGroups: shares the Ec2RightsizeModifyAttribute statement
  // (ec2:ModifyInstanceAttribute, intentionally - see the comment in infra/ops-dashboard.yaml).
  // Checks that RouterRole does not have this mutate permission and that the statement is scoped to
  // instance ARNs.
  it('14. RouterRole has no ec2:ModifyInstanceAttribute; ActionExecutionRole scopes Resource to instance ARNs', () => {
    expect(
      routerRoleBlock.includes('ec2:ModifyInstanceAttribute'),
      "RouterRole must not contain 'ec2:ModifyInstanceAttribute' - changing an instance type or its security groups must go through action-execution-fn",
    ).toBe(false);

    const modifyChunk = extractStatementChunkBySid(actionExecutionRoleBlock, 'Ec2RightsizeModifyAttribute');
    expect(extractActionsFromChunk(modifyChunk)).toContain('ec2:ModifyInstanceAttribute');

    const resourceMatch = modifyChunk.match(/Resource:\s*(.+)/);
    const resourceValue = resourceMatch ? resourceMatch[1].trim() : '';
    expect(
      resourceValue === `'*'` || resourceValue === '"*"' || resourceValue === '*',
      `Ec2RightsizeModifyAttribute must not have Resource: '*', but found: ${resourceValue}`,
    ).toBe(false);
    expect(resourceValue).toContain(':instance/');
  });

  // Maker-checker Approval workflow (shared/src/approval.ts): ApprovalMutateRole is the ONLY role
  // that may write an Approval_Request — mirrors the same invariant test 3 already guards for
  // action-audit/* (RouterRole never mutates its own bucket prefixes, only invokes a dedicated
  // Lambda). approval-mutate-handler.ts's own header comment and the ApprovalMutateRole comment in
  // infra/ops-dashboard.yaml BOTH claim this test exists — it did not, until now.
  it('15. No RouterRole s3:PutObject statement references approvals/*; ApprovalMutateRole is the ONLY role that can write an Approval_Request', () => {
    // RouterRole legitimately holds s3:PutObject for OTHER prefixes it owns end-to-end
    // (monitoring-cache.json/threshold-history/* — written directly by the router itself, not a
    // mutate-fn split) — a blanket "no PutObject anywhere" ban would be a false positive on those.
    // The actual invariant to guard is narrower: no PutObject statement may target approvals/*.
    const statementChunks = splitIntoStatementChunks(routerRoleBlock);
    for (const chunk of statementChunks) {
      const actions = extractActionsFromChunk(chunk);
      if (!actions.includes('s3:PutObject')) continue;
      expect(
        chunk.includes('approvals/'),
        "An s3:PutObject statement in RouterRole references 'approvals/' - writing an Approval_Request must go through approval-mutate-fn, not RouterRole",
      ).toBe(false);
    }

    const approvalReadWriteChunk = extractStatementChunkBySid(approvalMutateRoleBlock, 'ApprovalReadWrite');
    const actions = extractActionsFromChunk(approvalReadWriteChunk);
    expect(actions, 'ApprovalReadWrite must grant s3:PutObject').toContain('s3:PutObject');
    expect(actions, 'ApprovalReadWrite must grant s3:GetObject').toContain('s3:GetObject');
    expect(actions, 'ApprovalReadWrite must grant s3:ListBucket').toContain('s3:ListBucket');
  });

  // Mirrors checks 3/7/9 (RouterRole must not mutate directly): RouterRole may still READ
  // approvals/* (GET /actions/approvals, see the ApprovalsReadOnly statement) but must NOT mutate.
  // Both directions are checked to avoid a silent false negative if that statement is deleted by
  // mistake.
  it('16. RouterRole has read-only s3:GetObject/s3:ListBucket on approvals/* (ApprovalsReadOnly) and no s3:PutObject', () => {
    const approvalsReadOnlyChunk = extractStatementChunkBySid(routerRoleBlock, 'ApprovalsReadOnly');
    const actions = extractActionsFromChunk(approvalsReadOnlyChunk);
    expect(actions, 'ApprovalsReadOnly must grant s3:GetObject').toContain('s3:GetObject');
    expect(actions, 'ApprovalsReadOnly must grant s3:ListBucket').toContain('s3:ListBucket');
    expect(actions, 'ApprovalsReadOnly must NOT grant s3:PutObject').not.toContain('s3:PutObject');

    const resourceLines = approvalsReadOnlyChunk
      .split(/\r?\n/)
      .slice(approvalsReadOnlyChunk.split(/\r?\n/).findIndex((line) => /^\s*Resource:/.test(line)) + 1)
      .map((line) => line.match(/^\s*-\s*(\S.*)$/)?.[1]?.trim())
      .filter((value): value is string => Boolean(value));
    expect(resourceLines.some((resource) => resource.includes('/approvals/*'))).toBe(true);
  });

  // RouterRole MUST have lambda:InvokeFunction on exactly ApprovalMutateFunction (not
  // Resource: '*') so it can call request/decide-approval - mirrors InvokeActionExecution/
  // InvokeScheduledActionsMutate, which already existed.
  it("17. RouterRole has lambda:InvokeFunction scoped to ApprovalMutateFunction.Arn (statement InvokeApprovalMutate)", () => {
    const invokeChunk = extractStatementChunkBySid(routerRoleBlock, 'InvokeApprovalMutate');
    expect(extractActionsFromChunk(invokeChunk)).toEqual(['lambda:InvokeFunction']);

    const resourceMatch = invokeChunk.match(/Resource:\s*(.+)/);
    const resourceValue = resourceMatch ? resourceMatch[1].trim() : '';
    expect(
      resourceValue === `'*'` || resourceValue === '"*"' || resourceValue === '*',
      `InvokeApprovalMutate must not have Resource: '*', but found: ${resourceValue}`,
    ).toBe(false);
    expect(resourceValue).toContain('ApprovalMutateFunction');
  });
});

describe('Static backend architecture - import allowlist for action-execution-fn', () => {
  const EC2_MUTATING_COMMANDS = ['StartInstancesCommand', 'StopInstancesCommand'];
  const PAID_API_PACKAGES = ['@aws-sdk/client-cost-explorer', '@aws-sdk/client-cloudwatch'];

  /** Files that belong to action-execution-fn (it calls the state manager over HTTPS and must not
   * call the mutating AWS EC2 API directly) — the allowlist is checked ONLY on these files. Other
   * Lambdas in `src/` (for example `downsize-scheduler.ts`, a manual one-time downsize that
   * INTENTIONALLY calls StartInstancesCommand/StopInstancesCommand directly) are outside the scope
   * of this architecture rule. */
  const actionExecutionFnFiles = [
    join(SRC_DIR, 'modules', 'actions', 'action-execution-handler.ts'),
    join(SRC_DIR, 'modules', 'actions', 'ebs-action-service.ts'),
    join(SRC_DIR, 'modules', 'actions', 's3-lifecycle-action-service.ts'),
    join(SRC_DIR, 'modules', 'actions', 'ec2-state-manager-client.ts'),
    join(SRC_DIR, 'modules', 'actions', 'action-audit-service.ts'),
  ];

  function importsAnyFromPackage(fileContent: string, pkg: string, namedImports: string[]): boolean {
    const importRegex = new RegExp(`from\\s+['"]${pkg.replace(/[/.]/g, '\\$&')}['"]`);
    if (!importRegex.test(fileContent)) return false;
    return namedImports.some((name) => new RegExp(`\\b${name}\\b`).test(fileContent));
  }

  function importsPackage(fileContent: string, pkg: string): boolean {
    const importRegex = new RegExp(`from\\s+['"]${pkg.replace(/[/.]/g, '\\$&')}['"]`);
    return importRegex.test(fileContent);
  }

  it('5. No action-execution-fn file imports StartInstancesCommand/StopInstancesCommand from @aws-sdk/client-ec2', () => {
    const violatingFiles = actionExecutionFnFiles
      .filter((filePath) =>
        importsAnyFromPackage(readFileSync(filePath, 'utf-8'), '@aws-sdk/client-ec2', EC2_MUTATING_COMMANDS),
      )
      .map((filePath) => basename(filePath));

    expect(
      violatingFiles,
      `No action-execution-fn file may import StartInstancesCommand/StopInstancesCommand from @aws-sdk/client-ec2 (the state manager is called over HTTPS, not the AWS EC2 API directly), but found: ${violatingFiles.join(', ')}`,
    ).toEqual([]);
  });

  it('6. No action-execution-fn file imports @aws-sdk/client-cost-explorer/@aws-sdk/client-cloudwatch', () => {
    for (const filePath of actionExecutionFnFiles) {
      const content = readFileSync(filePath, 'utf-8');
      for (const pkg of PAID_API_PACKAGES) {
        expect(
          importsPackage(content, pkg),
          `${basename(filePath)} must not import ${pkg} (action-execution-fn must not call paid AWS APIs)`,
        ).toBe(false);
      }
    }
  });

  // Mirrors check 7 at the IAM layer: RouterRole has no Security Group mutate permission, so the
  // router code must not carry mutate commands either. The router only READS (DescribeSecurityGroups)
  // and delegates to action-execution-fn through lambda:InvokeFunction.
  const SG_MUTATING_COMMANDS = ['AuthorizeSecurityGroupIngressCommand', 'RevokeSecurityGroupIngressCommand'];
  const routerSecurityGroupFiles = [
    join(SRC_DIR, 'modules', 'security', 'security-group-service.ts'),
    join(SRC_DIR, 'modules', 'security', 'get-security-groups.ts'),
    join(SRC_DIR, 'modules', 'security', 'actions-security-group.ts'),
  ];

  it('8. No router bundle file imports a Security Group mutate command from @aws-sdk/client-ec2', () => {
    const violatingFiles = routerSecurityGroupFiles
      .filter((filePath) =>
        importsAnyFromPackage(readFileSync(filePath, 'utf-8'), '@aws-sdk/client-ec2', SG_MUTATING_COMMANDS),
      )
      .map((filePath) => basename(filePath));

    expect(
      violatingFiles,
      `The router may only READ Security Groups; mutation must go through action-execution-fn, but found: ${violatingFiles.join(', ')}`,
    ).toEqual([]);
  });

  // Mirrors check 9 at the IAM layer: the router only POLLS results and never sends commands itself.
  const routerRunCommandFiles = [
    join(SRC_DIR, 'modules', 'ec2-management', 'actions-run-command.ts'),
    join(SRC_DIR, 'modules', 'ec2-management', 'get-run-command-status.ts'),
    join(SRC_DIR, 'modules', 'ec2-management', 'ssm-run-command-status-service.ts'),
  ];

  it('10. No router bundle file imports SendCommandCommand from @aws-sdk/client-ssm', () => {
    const violatingFiles = routerRunCommandFiles
      .filter((filePath) =>
        importsAnyFromPackage(readFileSync(filePath, 'utf-8'), '@aws-sdk/client-ssm', ['SendCommandCommand']),
      )
      .map((filePath) => basename(filePath));

    expect(
      violatingFiles,
      `The router may only poll GetCommandInvocation; SendCommand must go through action-execution-fn, but found: ${violatingFiles.join(', ')}`,
    ).toEqual([]);
  });

  // Mirrors checks 8/10 above: approval-service.ts RUNS IN BOTH (the router reads, and
  // approval-mutate-fn writes - see that file's own header comment), so it is the ONLY file allowed
  // to import PutObjectCommand for the Approval flow. The router-side files (handlers that call
  // through lambda:InvokeFunction) must not import PutObjectCommand themselves.
  const routerApprovalFiles = [
    join(SRC_DIR, 'modules', 'actions', 'get-approvals.ts'),
    join(SRC_DIR, 'modules', 'actions', 'actions-request-approval.ts'),
    join(SRC_DIR, 'modules', 'actions', 'actions-decide-approval.ts'),
    join(SRC_DIR, 'modules', 'actions', 'actions-execute-approval.ts'),
  ];

  it('18. No Approval flow handler file (request/decide/execute-approval, get-approvals) imports PutObjectCommand from @aws-sdk/client-s3', () => {
    const violatingFiles = routerApprovalFiles
      .filter((filePath) => importsAnyFromPackage(readFileSync(filePath, 'utf-8'), '@aws-sdk/client-s3', ['PutObjectCommand']))
      .map((filePath) => basename(filePath));

    expect(
      violatingFiles,
      `These handlers may only read/forward through lambda:InvokeFunction; writing an Approval_Request must go through approval-mutate-fn (approval-service.ts), but a direct PutObjectCommand import was found in: ${violatingFiles.join(', ')}`,
    ).toEqual([]);
  });
});
