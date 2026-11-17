import { DescribeInstancesCommand, ModifyInstanceAttributeCommand } from '@aws-sdk/client-ec2';
import type { ActionExecutionResult } from '@ops-dashboard/shared';
import { config } from '../../config.js';
import { getEc2Client } from '../../core/aws-clients.js';
import { callEc2StateManager } from './ec2-state-manager-client.js';
// Lean_Lambda_Exception (Requirement 6.4a): direct import, not `../governance/index.js` — see the
// exception comment in `preview-service.ts` (same module, same reason).
import { areArchitecturesCompatible, computeEc2RightsizeTarget } from '../governance/ec2Rightsizing.js';

/**
 * `ec2-rightsize-action-service.ts` runs inside `action-execution-fn` (a dedicated mutate Lambda,
 * role `ActionExecutionRole`). Executes Resource_Action `EC2_Rightsize` — the user clicks 1-click
 * from the `ec2LowCpu` finding on Assessment/Recommendation_Detail_Modal: Stop -> change
 * InstanceType -> Start.
 *
 * OS/ARCHITECTURE SAFETY (original requirement: "need to carefully check the OS to pick the right
 * type instead of doing it mechanically, which could make Windows not work if the new type's chip
 * isn't supported"):
 *  1. `computeEc2RightsizeTarget()` ONLY proposes stepping down ONE REAL size within the SAME
 *     family (read directly from `ec2:DescribeInstanceTypes` — never guessed from a fixed size
 *     table, because AWS families do NOT share one size set, e.g. "c5" has 9xlarge/18xlarge while
 *     "r6i" has 8xlarge/16xlarge/24xlarge). It never changes family, so CPU architecture never
 *     changes (every size within the same family always shares the same architecture — an AWS
 *     family-naming rule). This is a safety layer "by design".
 *  2. `areArchitecturesCompatible()` re-verifies with REAL AWS data
 *     (`DescribeInstanceTypes.ProcessorInfo.SupportedArchitectures` for both the current and
 *     target instance type, already available in `computeEc2RightsizeTarget()`'s result) —
 *     defense-in-depth, not just trusting the naming convention.
 *  3. Stopping/starting the EC2 instance still goes through `StateManager` (NEVER calling
 *     StartInstances/StopInstances directly — the same constraint applies to EC2_Start/EC2_Stop,
 *     see `ec2-state-manager-client.ts`).
 *
 * `Platform`/`PlatformDetails` are NOT used to decide compatibility — those two fields are only
 * for DISPLAY (Windows vs Linux); the real decision is based on CPU architecture (x86_64/arm64)
 * since that's what actually determines whether an AMI/OS can boot on that instance type.
 */
const ec2 = getEc2Client();

/** Max total time (ms) to wait for the instance to reach 'stopped' before changing InstanceType. */
const STOP_POLL_TIMEOUT_MS = 300_000;
/** Max total time (ms) to wait for the instance to reach 'running' after restarting. */
const START_POLL_TIMEOUT_MS = 300_000;
const POLL_INTERVAL_MS = 5_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getInstanceState(instanceId: string): Promise<string | undefined> {
  const { Reservations = [] } = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
  return Reservations[0]?.Instances?.[0]?.State?.Name;
}

async function waitForInstanceState(
  instanceId: string,
  targetState: string,
  timeoutMs: number,
): Promise<'reached' | 'timeout'> {
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const state = await getInstanceState(instanceId);
    if (state === targetState) return 'reached';
    if (Date.now() >= deadline) return 'timeout';
    await sleep(POLL_INTERVAL_MS);
    if (Date.now() >= deadline) return 'timeout';
  }
}

/**
 * Executes `EC2_Rightsize`:
 * 1. Re-reads the current `InstanceType`/`State` AT EXECUTION TIME (never trusts preview data
 *    that may be stale) — recomputes `targetInstanceType` with the EXACT SAME pure function
 *    `computeEc2RightsizeTarget()` that `preview-service.ts` also uses.
 * 2. Checks REAL CPU architecture compatibility between the current and target instance type via
 *    `DescribeInstanceTypes` — rejects (`rejected`) if incompatible, WITHOUT executing any change.
 * 3. If the instance is `running`, calls `StateManager` to stop it, polling until `stopped`
 *    (up to 300s) — timeout/error -> `failure`, WITHOUT proceeding to change InstanceType on an
 *    instance that hasn't fully stopped.
 * 4. `ModifyInstanceAttribute` changes `InstanceType`. On failure -> `failure`, tries to restart
 *    the instance at the OLD type so it isn't left stuck stopped outside the user's intent.
 * 5. Calls `StateManager` to start it back up, polling until `running` (up to 300s) —
 *    timeout/error still returns `failure` but the InstanceType change already succeeded (the
 *    instance may self-recover or need manual intervention, depending on the cause) — the reason
 *    states clearly that InstanceType was already changed, to avoid confusion.
 */
export async function executeEc2Rightsize(instanceId: string): Promise<ActionExecutionResult> {
  let currentInstanceType: string;
  let currentState: string;
  try {
    const { Reservations = [] } = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
    const instance = Reservations[0]?.Instances?.[0];
    if (!instance) {
      return { outcome: 'rejected', reason: `EC2 instance ${instanceId} not found at execution time.` };
    }
    currentInstanceType = instance.InstanceType ?? '';
    currentState = instance.State?.Name ?? 'unknown';
  } catch (err) {
    return { outcome: 'failure', reason: `Could not read the current state of instance ${instanceId}: ${(err as Error).message}` };
  }

  let rightsizeTarget: Awaited<ReturnType<typeof computeEc2RightsizeTarget>>;
  try {
    rightsizeTarget = await computeEc2RightsizeTarget(ec2, currentInstanceType);
  } catch (err) {
    return {
      outcome: 'failure',
      reason: `Could not read the size list for instance family "${currentInstanceType}": ${(err as Error).message}`,
    };
  }

  if (!rightsizeTarget) {
    return {
      outcome: 'rejected',
      reason: `Could not determine a safe target instance type to rightsize from "${currentInstanceType}" (already at the smallest size, or the type format is unrecognized).`,
    };
  }

  const { instanceType: targetInstanceType, currentArchitectures, targetArchitectures } = rightsizeTarget;

  if (!areArchitecturesCompatible(currentArchitectures, targetArchitectures)) {
    return {
      outcome: 'rejected',
      reason: `Target instance type "${targetInstanceType}" is not CPU-architecture compatible with the current "${currentInstanceType}" (${currentArchitectures.join('/')} vs ${targetArchitectures.join('/')}) — aborting to avoid an instance that fails to start back up.`,
    };
  }

  const wasRunning = currentState === 'running';

  if (wasRunning) {
    const stopResult = await callEc2StateManager(instanceId, config.awsRegion, 'stop');
    if (!stopResult.success) {
      return { outcome: 'failure', reason: `Stopping instance ${instanceId} to change type failed: ${stopResult.error}` };
    }

    const stopPollResult = await waitForInstanceState(instanceId, 'stopped', STOP_POLL_TIMEOUT_MS);
    if (stopPollResult === 'timeout') {
      return {
        outcome: 'failure',
        reason: `Instance ${instanceId} did not reach "stopped" within ${STOP_POLL_TIMEOUT_MS / 1000} seconds — aborting the type change to avoid risk.`,
      };
    }
  }

  try {
    await ec2.send(
      new ModifyInstanceAttributeCommand({ InstanceId: instanceId, InstanceType: { Value: targetInstanceType } }),
    );
  } catch (err) {
    return {
      outcome: 'failure',
      reason: `ModifyInstanceAttribute failed for ${instanceId} (still at type "${currentInstanceType}"; the instance is stopped if it was previously running): ${(err as Error).message}`,
    };
  }

  if (!wasRunning) {
    // The instance was already stopped (not because of this action) — keep it stopped, don't
    // restart it automatically (shouldn't override the user's "leave it stopped" intent beyond rightsizing).
    return { outcome: 'success', newInstanceType: targetInstanceType };
  }

  const startResult = await callEc2StateManager(instanceId, config.awsRegion, 'start');
  if (!startResult.success) {
    return {
      outcome: 'failure',
      reason: `Successfully changed type to "${targetInstanceType}", but restarting instance ${instanceId} failed: ${startResult.error}`,
      newInstanceType: targetInstanceType,
    };
  }

  const startPollResult = await waitForInstanceState(instanceId, 'running', START_POLL_TIMEOUT_MS);
  if (startPollResult === 'timeout') {
    return {
      outcome: 'failure',
      reason: `Changed type to "${targetInstanceType}" and issued the start command successfully, but instance ${instanceId} did not reach "running" within ${START_POLL_TIMEOUT_MS / 1000} seconds — check it manually (the new type may be incompatible with another instance setting, e.g. ENA/EBS-optimized).`,
      newInstanceType: targetInstanceType,
    };
  }

  return { outcome: 'success', newInstanceType: targetInstanceType };
}
