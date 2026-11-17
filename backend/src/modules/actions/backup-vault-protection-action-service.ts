import { GetBackupVaultAccessPolicyCommand, PutBackupVaultAccessPolicyCommand } from '@aws-sdk/client-backup';
import type { ActionExecutionResult } from '@ops-dashboard/shared';
import { config } from '../../config.js';
import { buildProtectedVaultAccessPolicy, policyHasDeletionProtection } from '../compliance/index.js';
import { getBackupClient } from '../../core/aws-clients.js';

/**
 * `backup-vault-protection-action-service.ts` runs inside `action-execution-fn` (a separate
 * mutating Lambda, role `ActionExecutionRole`). Executes Resource_Action
 * `BackupVault_ApplyProtectionPolicy` — the user clicks it from the `backupVaultNotProtected`
 * finding on the Assessment/Recommendation_Detail_Modal (ISO 27001 A.12.3).
 *
 * SAFETY DECISION: `backup:PutBackupVaultAccessPolicy` OVERWRITES THE VAULT'S ENTIRE EXISTING
 * POLICY (no merge at the AWS API level) — so we MUST re-read the current policy IMMEDIATELY
 * BEFORE writing, then use `buildProtectedVaultAccessPolicy()` (a pure function, shared with
 * `backup-collector.ts`) to PRESERVE every other statement already present and only add/replace
 * the ONE protection statement managed by Ops_Dashboard (identified by a fixed `Sid`). After
 * writing, READ BACK once more and confirm `policyHasDeletionProtection()` returns `true` —
 * otherwise treat it as `failure` (never blindly trust that `PutBackupVaultAccessPolicy` returning
 * 200 is enough).
 *
 * Account ID is read from `config.awsAccountId` (env var `AWS_ACCOUNT_ID`, CloudFormation
 * pseudo-param `${AWS::AccountId}` — see `config.ts`) — NOT hardcoded, so this action works
 * correctly on WHATEVER AWS account the stack is deployed into.
 */
const backup = getBackupClient();

async function readExistingPolicy(vaultName: string): Promise<string | undefined> {
  try {
    const { Policy } = await backup.send(new GetBackupVaultAccessPolicyCommand({ BackupVaultName: vaultName }));
    return Policy;
  } catch (err) {
    // ResourceNotFoundException is a NORMAL result when the vault has no access policy yet —
    // treat it as an empty policy (NOT an error that should fail the whole action).
    const errorName = (err as { name?: string }).name;
    if (errorName === 'ResourceNotFoundException') return undefined;
    throw err;
  }
}

/**
 * Executes `BackupVault_ApplyProtectionPolicy`:
 * 1. Re-read the vault's current access policy AT EXECUTION TIME (don't trust preview data,
 *    which may be stale).
 * 2. If the vault is ALREADY sufficiently protected (`policyHasDeletionProtection` returns
 *    `true`) — treat the goal as already met, return `success` IMMEDIATELY without writing
 *    (idempotent, avoids an unnecessary overwrite if someone already applied an equivalent
 *    policy on their own).
 * 3. Build the new policy (keeping other statements, only adding/replacing the protection
 *    statement) and write it via `PutBackupVaultAccessPolicy`.
 * 4. Read back ONE MORE TIME and confirm `policyHasDeletionProtection` returns `true` —
 *    otherwise `failure` (never blindly trust a 200 response from Put).
 */
export async function executeBackupVaultApplyProtectionPolicy(vaultName: string): Promise<ActionExecutionResult> {
  let existingPolicy: string | undefined;
  try {
    existingPolicy = await readExistingPolicy(vaultName);
  } catch (err) {
    return { outcome: 'failure', reason: `Could not read the current access policy for vault ${vaultName}: ${(err as Error).message}` };
  }

  if (policyHasDeletionProtection(existingPolicy)) {
    return { outcome: 'success', protectedVaultName: vaultName };
  }

  const newPolicy = buildProtectedVaultAccessPolicy(existingPolicy, config.awsAccountId);

  try {
    await backup.send(new PutBackupVaultAccessPolicyCommand({ BackupVaultName: vaultName, Policy: newPolicy }));
  } catch (err) {
    return { outcome: 'failure', reason: `PutBackupVaultAccessPolicy failed for vault ${vaultName}: ${(err as Error).message}` };
  }

  let verifiedPolicy: string | undefined;
  try {
    verifiedPolicy = await readExistingPolicy(vaultName);
  } catch (err) {
    return {
      outcome: 'failure',
      reason: `Wrote the access policy for vault ${vaultName}, but could not read it back to confirm: ${(err as Error).message}`,
    };
  }

  if (!policyHasDeletionProtection(verifiedPolicy)) {
    return {
      outcome: 'failure',
      reason: `Wrote the access policy for vault ${vaultName}, but reading it back COULD NOT confirm sufficient protection — check manually.`,
    };
  }

  return { outcome: 'success', protectedVaultName: vaultName };
}
