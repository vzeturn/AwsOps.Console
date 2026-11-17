/**
 * `backupVaultPolicy.ts` — pure logic (no AWS API calls) for reading/building the access policy
 * of an AWS Backup vault (ISO 27001 A.12.3 — prevents unauthorized deletion/lifecycle changes to
 * recovery points). Split out from `backup-collector.ts` (READ + evaluate only) and
 * `backup-vault-protection-action-service.ts` (EXECUTES `BackupVault_ApplyProtectionPolicy`) so
 * both places share EXACTLY ONE definition of "what counts as sufficiently protected" / "the
 * standard statement to apply" — no duplicated logic, same principle as
 * `scalePlanning.ts`/`ec2Rightsizing.ts` (preview and execution independently recompute using the
 * same pure function).
 */

/** Fixed Sid of the protection statement managed by Ops_Dashboard itself — used to identify and
 * REPLACE (not duplicate) this statement if the vault already has it, when rebuilding the policy;
 * any OTHER statements in the policy (if the vault already served some other purpose) are kept
 * as-is. */
export const BACKUP_VAULT_PROTECTION_STATEMENT_SID = 'OpsDashboardDenyDeleteAndLifecycleChangeExceptBreakGlass';

/** The 2 actions that MUST be present in a Deny statement to count as "protected" — the minimum
 * condition to pass the AWS Config managed rule `backup-recovery-point-manual-deletion-disabled`. */
const REQUIRED_DENY_ACTIONS = ['backup:DeleteRecoveryPoint', 'backup:UpdateRecoveryPointLifecycle'] as const;

/** 2 extra actions Ops_Dashboard adds itself when APPLYING the protection statement (not required
 * to count as "protected" when READING — a vault protected against the 2 required actions by some
 * other means is still valid — but whenever Ops_Dashboard creates a new statement, these are
 * always added to also block removal of this very access policy). */
const PROTECTION_STATEMENT_ACTIONS = [
  'backup:DeleteRecoveryPoint',
  'backup:UpdateRecoveryPointLifecycle',
  'backup:PutBackupVaultAccessPolicy',
  'backup:DeleteBackupVaultAccessPolicy',
] as const;

interface BackupVaultPolicyStatement {
  Sid?: string;
  Effect?: string;
  Principal?: unknown;
  Action?: string | string[];
  Resource?: unknown;
  Condition?: unknown;
}

interface BackupVaultPolicyDocument {
  Version?: string;
  Statement?: BackupVaultPolicyStatement | BackupVaultPolicyStatement[];
}

/**
 * Checks whether a vault access policy JSON (a string, in the same format as
 * `GetBackupVaultAccessPolicy.Policy`) has AT LEAST 1 `Effect: Deny` statement blocking BOTH
 * `backup:DeleteRecoveryPoint` AND `backup:UpdateRecoveryPointLifecycle`. Pure function, no AWS
 * calls — `policy` being `undefined` (the vault has no access policy at all) or unparseable JSON
 * both return `false` (fail-safe: unable to determine protection = treat as unprotected).
 *
 * Moved here from `backup-collector.ts` (NO behavior change) so it can be shared with
 * `buildProtectedVaultAccessPolicy` below — both reading (collector) and writing (action service)
 * use the same definition of "sufficiently protected".
 */
export function policyHasDeletionProtection(policy: string | undefined): boolean {
  const parsed = parsePolicy(policy);
  if (!parsed) return false;

  const statements = toStatementArray(parsed.Statement);
  return statements.some((stmt) => {
    if (stmt.Effect !== 'Deny') return false;
    const actions = toActionArray(stmt.Action);
    return REQUIRED_DENY_ACTIONS.every((required) => actions.includes(required));
  });
}

function parsePolicy(policy: string | undefined): BackupVaultPolicyDocument | undefined {
  if (!policy) return undefined;
  try {
    return JSON.parse(policy) as BackupVaultPolicyDocument;
  } catch {
    return undefined;
  }
}

function toStatementArray(statement: BackupVaultPolicyStatement | BackupVaultPolicyStatement[] | undefined): BackupVaultPolicyStatement[] {
  if (!statement) return [];
  return Array.isArray(statement) ? statement : [statement];
}

function toActionArray(action: string | string[] | undefined): string[] {
  if (!action) return [];
  return Array.isArray(action) ? action : [action];
}

/**
 * Builds a NEW access policy JSON for `BackupVault_ApplyProtectionPolicy` — PRESERVES every other
 * statement already present in `existingPolicy` (if the vault's access policy already serves
 * another purpose, e.g. restricting by resource type/team), and ONLY adds/replaces the ONE
 * statement with `Sid === BACKUP_VAULT_PROTECTION_STATEMENT_SID` — avoiding
 * `PutBackupVaultAccessPolicy` (which overwrites the whole policy, no merge at the AWS API level)
 * accidentally wiping out other existing access policy configuration.
 *
 * The protection statement always excludes (`StringNotLike` on `aws:PrincipalArn`) exactly 2
 * principals: the account root (`accountId`) and that account's own AWSServiceRoleForBackup
 * service-linked role — the same configuration manually applied to `ACME_Vault`/`Default`
 * (excluding the service-linked role so it doesn't block the automatic deletion of expired
 * recovery points under lifecycle retention).
 *
 * Pure function — no AWS calls, it just builds the JSON string for the caller (the action
 * service) to pass into `PutBackupVaultAccessPolicyCommand`.
 */
export function buildProtectedVaultAccessPolicy(existingPolicy: string | undefined, accountId: string): string {
  const parsed = parsePolicy(existingPolicy);
  const otherStatements = toStatementArray(parsed?.Statement).filter(
    (stmt) => stmt.Sid !== BACKUP_VAULT_PROTECTION_STATEMENT_SID,
  );

  const protectionStatement: BackupVaultPolicyStatement = {
    Sid: BACKUP_VAULT_PROTECTION_STATEMENT_SID,
    Effect: 'Deny',
    Principal: '*',
    Action: [...PROTECTION_STATEMENT_ACTIONS],
    Resource: '*',
    Condition: {
      StringNotLike: {
        'aws:PrincipalArn': [
          `arn:aws:iam::${accountId}:root`,
          `arn:aws:iam::${accountId}:role/aws-service-role/backup.amazonaws.com/AWSServiceRoleForBackup`,
        ],
      },
    },
  };

  const document: BackupVaultPolicyDocument = {
    Version: '2012-10-17',
    Statement: [...otherStatements, protectionStatement],
  };

  return JSON.stringify(document);
}
