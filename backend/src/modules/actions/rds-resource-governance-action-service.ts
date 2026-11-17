import {
  DescribeDBInstancesCommand,
  DescribeDBParametersCommand,
  ModifyDBParameterGroupCommand,
  type Parameter,
} from '@aws-sdk/client-rds';
import type { ActionExecutionResult } from '@ops-dashboard/shared';
import { getRdsClient } from '../../core/aws-clients.js';
// Lean_Lambda_Exception (Requirement 6.4a): direct import, not `../governance/index.js` — see the
// exception comment in `preview-service.ts` (same module, same reason).
import {
  detectEngineFamily,
  computeResourceGovernanceTargetParameters,
  RDS_INSTANCE_VCPU,
} from '../governance/rdsResourceGovernance.js';
// Lean_Lambda_Exception (Requirement 6.4a): direct import, not `../monitoring/index.js` — see the
// exception comment in `preview-service.ts` (same module, same reason).
import { RDS_INSTANCE_RAM_GIB } from '../monitoring/monitoringThresholds.js';

/**
 * `rds-resource-governance-action-service.ts` runs inside `action-execution-fn` (the dedicated
 * mutating Lambda, role `ActionExecutionRole`). Executes Resource_Action
 * `RDS_ApplyResourceGovernance` — the user clicks it from the `rdsResourceGovernanceMissing`
 * finding: re-reads the current `Engine`/`DBInstanceClass`/`DBParameterGroupName` AT EXECUTION
 * TIME, computes the target parameter set with the SAME pure function
 * `computeResourceGovernanceTargetParameters()` (shared with the preview), then calls
 * `rds:ModifyDBParameterGroup` applying ONLY the parameters that ACTUALLY need to change (versus
 * their current value — idempotent, never rewrites a value that's already correct).
 *
 * SAFETY — NEVER modifies the default DB Parameter Group (`default.*`): AWS's default parameter
 * group CANNOT be edited (`ModifyDBParameterGroup` returns `InvalidParameterValue` on an attempt)
 * and is typically SHARED across multiple instances — this action ACTIVELY refuses to apply when
 * the instance is using the default parameter group, requiring the operator to first create/attach
 * a CUSTOM parameter group dedicated to that instance (outside the scope of this 1-click
 * automation — deciding to create a new parameter group and attach it to the instance carries a
 * downtime/restart risk that falls outside the scope of this "parameter-only change" action). Both
 * instances currently in `AWS_Account` (`acme-rds-production-env`/`abc-prod-rds-postgres`) ALREADY
 * use their own custom parameter groups (`sqlserver-se-15-pg`/`prod-logging-group-18`), so this
 * case hasn't occurred in practice yet, but it still MUST be checked to stay safe for similar
 * resources in the future.
 */
const rds = getRdsClient();

/** Prefix of AWS's DEFAULT parameter group names — must NEVER be modified. */
const DEFAULT_PARAMETER_GROUP_PREFIX = 'default.';

/**
 * Reads the current value of the parameters to check within a parameter group — only parameters
 * whose NAME is in `parameterNames` (paginates via `Marker` if needed, though in practice each
 * engine has only a few hundred parameters, so more than one page is rarely needed for a
 * known-in-advance name set).
 */
async function fetchCurrentParameterValues(
  parameterGroupName: string,
  parameterNames: readonly string[],
): Promise<Map<string, string | undefined>> {
  const result = new Map<string, string | undefined>();
  let marker: string | undefined;

  do {
    const response = await rds.send(
      new DescribeDBParametersCommand({ DBParameterGroupName: parameterGroupName, Marker: marker }),
    );
    for (const param of response.Parameters ?? []) {
      if (param.ParameterName && parameterNames.includes(param.ParameterName)) {
        result.set(param.ParameterName, param.ParameterValue);
      }
    }
    marker = response.Marker;
  } while (marker && result.size < parameterNames.length);

  return result;
}

export async function executeRdsApplyResourceGovernance(dbInstanceIdentifier: string): Promise<ActionExecutionResult> {
  let engine: string;
  let dbInstanceClass: string;
  let parameterGroupName: string;
  try {
    const { DBInstances = [] } = await rds.send(
      new DescribeDBInstancesCommand({ DBInstanceIdentifier: dbInstanceIdentifier }),
    );
    const db = DBInstances[0];
    if (!db) {
      return { outcome: 'rejected', reason: `RDS instance ${dbInstanceIdentifier} was not found at execution time.` };
    }
    engine = db.Engine ?? '';
    dbInstanceClass = db.DBInstanceClass ?? '';
    const group = db.DBParameterGroups?.[0]?.DBParameterGroupName;
    if (!group) {
      return { outcome: 'rejected', reason: `Could not determine the current DB Parameter Group of ${dbInstanceIdentifier}.` };
    }
    parameterGroupName = group;
  } catch (err) {
    return { outcome: 'failure', reason: `Could not read the current status of RDS instance ${dbInstanceIdentifier}: ${(err as Error).message}` };
  }

  if (parameterGroupName.startsWith(DEFAULT_PARAMETER_GROUP_PREFIX)) {
    return {
      outcome: 'rejected',
      reason: `RDS instance ${dbInstanceIdentifier} is using the DEFAULT DB Parameter Group ("${parameterGroupName}") — AWS does not allow editing the default parameter group (it is typically shared by multiple instances). A custom parameter group must be created for this instance first (outside the scope of this 1-click action).`,
    };
  }

  const engineFamily = detectEngineFamily(engine);
  if (!engineFamily) {
    return {
      outcome: 'rejected',
      reason: `Engine "${engine}" is not yet supported for RDS_ApplyResourceGovernance (only SQL Server and PostgreSQL are supported — the parameter formulas have been verified for these 2 engines).`,
    };
  }

  const vcpuCount = RDS_INSTANCE_VCPU[dbInstanceClass];
  const memoryGib = RDS_INSTANCE_RAM_GIB[dbInstanceClass];
  if (vcpuCount === undefined || memoryGib === undefined) {
    return {
      outcome: 'rejected',
      reason: `No vCPU/RAM lookup data for DBInstanceClass "${dbInstanceClass}" — cannot safely compute the target parameter set (fail-safe, no guessing). Add an entry for this instance class to RDS_INSTANCE_VCPU/RDS_INSTANCE_RAM_GIB first.`,
    };
  }

  const targetChanges = computeResourceGovernanceTargetParameters(engineFamily, vcpuCount, memoryGib);

  let currentValues: Map<string, string | undefined>;
  try {
    currentValues = await fetchCurrentParameterValues(
      parameterGroupName,
      targetChanges.map((c) => c.parameterName),
    );
  } catch (err) {
    return { outcome: 'failure', reason: `Could not read the current parameter values of "${parameterGroupName}": ${(err as Error).message}` };
  }

  // Idempotent — ONLY changes parameters whose value ACTUALLY differs from the current one, avoiding a
  // pointless ModifyDBParameterGroup call for parameters that are already correct (e.g. re-running this action a second time after it already succeeded).
  const changesToApply = targetChanges.filter((change) => currentValues.get(change.parameterName) !== change.newValue);

  if (changesToApply.length === 0) {
    return { outcome: 'success', appliedParameterNames: [], requiresReboot: false };
  }

  const parametersPayload: Parameter[] = changesToApply.map((change) => ({
    ParameterName: change.parameterName,
    ParameterValue: change.newValue,
    // 'immediate' for dynamic parameters (applied right away, no reboot needed) — all 6 parameters
    // across both engines (see rdsResourceGovernance.ts) have been confirmed as ApplyType='dynamic'
    // via DescribeDBParameters on the 2 real instances currently in use. If a future parameter has
    // ApplyType='static' (requires reboot), AWS will surface a clear error at
    // ModifyDBParameterGroup rather than silently misapplying it — no need to check ApplyType
    // ourselves here before calling.
    ApplyMethod: 'immediate',
  }));

  try {
    await rds.send(
      new ModifyDBParameterGroupCommand({ DBParameterGroupName: parameterGroupName, Parameters: parametersPayload }),
    );
  } catch (err) {
    return {
      outcome: 'failure',
      reason: `ModifyDBParameterGroup failed for "${parameterGroupName}": ${(err as Error).message}`,
    };
  }

  return {
    outcome: 'success',
    appliedParameterNames: changesToApply.map((c) => c.parameterName),
    requiresReboot: false,
  };
}
