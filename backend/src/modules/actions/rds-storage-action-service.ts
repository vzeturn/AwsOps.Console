import { DescribeDBInstancesCommand, ModifyDBInstanceCommand } from '@aws-sdk/client-rds';
import type { ActionExecutionResult } from '@ops-dashboard/shared';
import { getRdsClient } from '../../core/aws-clients.js';
// Lean_Lambda_Exception (Requirement 6.4a): direct import, not `../governance/index.js` — see the
// exception comment in `preview-service.ts` (same module, same reason).
import { computeRdsStorageIncreaseTarget } from '../governance/scalePlanning.js';

/**
 * `rds-storage-action-service.ts` runs inside `action-execution-fn` (the dedicated mutating
 * Lambda, role `ActionExecutionRole`). Executes Resource_Action `RDS_IncreaseStorage` — the user
 * clicks it from the "FreeStorageSpace low" runbook on Monitoring_Page (requirement: "when
 * resources run low, upgrade the resources"), increasing `AllocatedStorage` on an RDS instance.
 *
 * IMPORTANT NOTE (Reversibility_Class = 'irreversible' in Action_Catalog): AWS does NOT allow
 * decreasing `AllocatedStorage` once it has been increased ("You can't deallocate space" — RDS
 * User Guide, "Increasing DB instance storage capacity") — this is a genuinely one-way action.
 */
const rds = getRdsClient();

/** RDS statuses considered "another storage change already in progress" — no further modify is
 * possible while in these statuses (AWS returns `InvalidDBInstanceState` on a modify attempt).
 * Re-checked AT EXECUTION TIME — never trust the status shown earlier in Confirmation_Dialog. */
const BLOCKING_STATUSES = ['modifying', 'storage-optimization', 'upgrading', 'maintenance'];

/**
 * Executes `RDS_IncreaseStorage`: re-reads the current `AllocatedStorage`/`DBInstanceStatus` AT
 * EXECUTION TIME, recomputes the new target with `computeRdsStorageIncreaseTarget()` (the SAME
 * pure function `preview-service.ts` uses to render the preview), then calls `ModifyDBInstance`
 * with `ApplyImmediately: true` (applied right away — the user has deliberately chosen a
 * remediation for an incident in progress, so it should not wait for the next maintenance
 * window).
 *
 * - Instance does not exist → `'rejected'`.
 * - Currently in another blocking change state (`BLOCKING_STATUSES`) → `'rejected'` (avoids an
 *   `InvalidDBInstanceState` conflict from AWS).
 * - `ModifyDBInstance` fails → `'failure'`.
 */
export async function executeRdsIncreaseStorage(dbInstanceIdentifier: string): Promise<ActionExecutionResult> {
  let currentAllocatedStorageGb: number;
  let currentStatus: string;
  try {
    const { DBInstances = [] } = await rds.send(
      new DescribeDBInstancesCommand({ DBInstanceIdentifier: dbInstanceIdentifier }),
    );
    const db = DBInstances[0];
    if (!db) {
      return { outcome: 'rejected', reason: `RDS instance ${dbInstanceIdentifier} was not found at execution time.` };
    }
    currentAllocatedStorageGb = db.AllocatedStorage ?? 0;
    currentStatus = db.DBInstanceStatus ?? 'unknown';
  } catch (err) {
    return {
      outcome: 'failure',
      reason: `Could not read the current status of RDS instance ${dbInstanceIdentifier}: ${(err as Error).message}`,
    };
  }

  if (BLOCKING_STATUSES.includes(currentStatus)) {
    return {
      outcome: 'rejected',
      reason: `RDS instance ${dbInstanceIdentifier} is in state "${currentStatus}" — storage cannot be increased right now, please try again later.`,
    };
  }
  if (currentAllocatedStorageGb <= 0) {
    return {
      outcome: 'rejected',
      reason: `Could not determine the current allocated storage of RDS instance ${dbInstanceIdentifier}.`,
    };
  }

  const newAllocatedStorageGb = computeRdsStorageIncreaseTarget(currentAllocatedStorageGb);

  try {
    await rds.send(
      new ModifyDBInstanceCommand({
        DBInstanceIdentifier: dbInstanceIdentifier,
        AllocatedStorage: newAllocatedStorageGb,
        ApplyImmediately: true,
      }),
    );
  } catch (err) {
    return {
      outcome: 'failure',
      reason: `ModifyDBInstance failed for ${dbInstanceIdentifier}: ${(err as Error).message}`,
    };
  }

  return { outcome: 'success', newAllocatedStorageGb };
}
