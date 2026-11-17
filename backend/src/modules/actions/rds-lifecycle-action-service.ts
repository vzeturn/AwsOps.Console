import {
  DescribeDBInstancesCommand,
  StartDBInstanceCommand,
  StopDBInstanceCommand,
  RebootDBInstanceCommand,
} from '@aws-sdk/client-rds';
import type { ActionExecutionResult } from '@ops-dashboard/shared';
import { getRdsClient } from '../../core/aws-clients.js';

/**
 * Runs inside `action-execution-fn` (the dedicated mutating Lambda, role `ActionExecutionRole`).
 * Executes the 3 RDS lifecycle Resource_Actions: `RDS_Start`, `RDS_Stop`, `RDS_Reboot` — directly
 * via the RDS API (`rds:StartDBInstance`/`rds:StopDBInstance`/`rds:RebootDBInstance`). RDS has NO
 * `StateManager` equivalent — that service only supports EC2.
 */
const rds = getRdsClient();

async function readCurrentStatus(dbInstanceIdentifier: string): Promise<string | undefined> {
  const { DBInstances = [] } = await rds.send(
    new DescribeDBInstancesCommand({ DBInstanceIdentifier: dbInstanceIdentifier }),
  );
  return DBInstances[0]?.DBInstanceStatus;
}

/** `RDS_Start`: only proceeds if the instance is STILL "stopped" at execution time. */
export async function executeRdsStart(dbInstanceIdentifier: string): Promise<ActionExecutionResult> {
  let currentStatus: string | undefined;
  try {
    currentStatus = await readCurrentStatus(dbInstanceIdentifier);
  } catch (err) {
    return { outcome: 'failure', reason: `Could not read the current status of RDS instance ${dbInstanceIdentifier}: ${(err as Error).message}` };
  }
  if (currentStatus === undefined) {
    return { outcome: 'rejected', reason: `RDS instance ${dbInstanceIdentifier} was not found at execution time.` };
  }
  if (currentStatus !== 'stopped') {
    return {
      outcome: 'rejected',
      reason: `RDS instance ${dbInstanceIdentifier} is in state "${currentStatus}" at execution time — it can only be started while "stopped".`,
    };
  }

  try {
    await rds.send(new StartDBInstanceCommand({ DBInstanceIdentifier: dbInstanceIdentifier }));
  } catch (err) {
    return { outcome: 'failure', reason: `StartDBInstance failed for ${dbInstanceIdentifier}: ${(err as Error).message}` };
  }

  return { outcome: 'success', newState: 'starting' };
}

/** `RDS_Stop`: only proceeds if the instance is STILL "available" at execution time. */
export async function executeRdsStop(dbInstanceIdentifier: string): Promise<ActionExecutionResult> {
  let currentStatus: string | undefined;
  try {
    currentStatus = await readCurrentStatus(dbInstanceIdentifier);
  } catch (err) {
    return { outcome: 'failure', reason: `Could not read the current status of RDS instance ${dbInstanceIdentifier}: ${(err as Error).message}` };
  }
  if (currentStatus === undefined) {
    return { outcome: 'rejected', reason: `RDS instance ${dbInstanceIdentifier} was not found at execution time.` };
  }
  if (currentStatus !== 'available') {
    return {
      outcome: 'rejected',
      reason: `RDS instance ${dbInstanceIdentifier} is in state "${currentStatus}" at execution time — it can only be stopped while "available" (a Multi-AZ instance may be self-rejected by the RDS API).`,
    };
  }

  try {
    await rds.send(new StopDBInstanceCommand({ DBInstanceIdentifier: dbInstanceIdentifier }));
  } catch (err) {
    return { outcome: 'failure', reason: `StopDBInstance failed for ${dbInstanceIdentifier}: ${(err as Error).message}` };
  }

  return { outcome: 'success', newState: 'stopping' };
}

/** `RDS_Reboot`: only proceeds if the instance is STILL "available" at execution time. */
export async function executeRdsReboot(dbInstanceIdentifier: string): Promise<ActionExecutionResult> {
  let currentStatus: string | undefined;
  try {
    currentStatus = await readCurrentStatus(dbInstanceIdentifier);
  } catch (err) {
    return { outcome: 'failure', reason: `Could not read the current status of RDS instance ${dbInstanceIdentifier}: ${(err as Error).message}` };
  }
  if (currentStatus === undefined) {
    return { outcome: 'rejected', reason: `RDS instance ${dbInstanceIdentifier} was not found at execution time.` };
  }
  if (currentStatus !== 'available') {
    return {
      outcome: 'rejected',
      reason: `RDS instance ${dbInstanceIdentifier} is in state "${currentStatus}" at execution time — it can only be rebooted while "available".`,
    };
  }

  try {
    await rds.send(new RebootDBInstanceCommand({ DBInstanceIdentifier: dbInstanceIdentifier }));
  } catch (err) {
    return { outcome: 'failure', reason: `RebootDBInstance failed for ${dbInstanceIdentifier}: ${(err as Error).message}` };
  }

  return { outcome: 'success', newState: 'rebooting' };
}
