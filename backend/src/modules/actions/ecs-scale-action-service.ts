import { DescribeServicesCommand, UpdateServiceCommand } from '@aws-sdk/client-ecs';
import { DescribeScalableTargetsCommand } from '@aws-sdk/client-application-auto-scaling';
import type { ActionExecutionResult } from '@ops-dashboard/shared';
// Lean_Lambda_Exception (Requirement 6.4a): direct import, not `../governance/index.js` — see the
// exception comment in `preview-service.ts` (same module, same reason): that barrel also
// re-exports `s3PolicyStore.ts`, which throws at module scope unless `ASSESSMENT_BUCKET_NAME` is
// set (this file's own Lambda IS granted it in production, but going through the barrel needlessly
// couples every test of this file to mocking an unrelated dependency).
import { computeEcsScaleOutTarget } from '../governance/scalePlanning.js';
import { logger } from '../../shared-kernel/logger.js';
import { getEcsClient, getApplicationAutoScalingClient } from '../../core/aws-clients.js';

/**
 * `ecs-scale-action-service.ts` runs inside `action-execution-fn` (a dedicated mutate Lambda,
 * `ActionExecutionRole`). Executes the `ECS_ScaleOut` Resource_Action — the user clicks a 1-click
 * action from a "high CPU/Memory" runbook on Monitoring_Page (requirement: "if resources are
 * insufficient, scale up resources"), increasing `desiredCount` on an ECS service to reduce the
 * load on each existing task.
 */
const ecs = getEcsClient();
const autoscaling = getApplicationAutoScalingClient();

/** `resourceId` shares its format with `ecsResourceId()` in `monitoring-service.ts` —
 * `<clusterName>/<serviceName>` (EXACTLY one `/`; ECS cluster/service names cannot contain `/`). */
function parseEcsResourceId(resourceId: string): { clusterName: string; serviceName: string } | undefined {
  const slashIndex = resourceId.indexOf('/');
  if (slashIndex === -1) return undefined;
  const clusterName = resourceId.slice(0, slashIndex);
  const serviceName = resourceId.slice(slashIndex + 1);
  if (!clusterName || !serviceName) return undefined;
  return { clusterName, serviceName };
}

/** Reads `MaxCapacity` from Application Auto Scaling if the service has a registered scalable
 * target — `undefined` if not registered (not an error; many services don't use autoscaling). */
async function readMaxCapacity(clusterName: string, serviceName: string): Promise<number | undefined> {
  const { ScalableTargets = [] } = await autoscaling.send(
    new DescribeScalableTargetsCommand({
      ServiceNamespace: 'ecs',
      ResourceIds: [`service/${clusterName}/${serviceName}`],
      ScalableDimension: 'ecs:service:DesiredCount',
    }),
  );
  return ScalableTargets[0]?.MaxCapacity;
}

/**
 * Executes `ECS_ScaleOut`: re-reads the current `desiredCount` AND `maxCapacity` (if any) AT
 * EXECUTION TIME (don't trust the value shown in Confirmation_Dialog, which may be stale — the
 * same principle `ebs-action-service.ts` uses to re-check right before mutating), recomputes the
 * new target with `computeEcsScaleOutTarget()` (the SAME pure function `preview-service.ts` uses
 * to render the preview — no duplicating the formula), then calls `UpdateService`.
 *
 * - Service doesn't exist or isn't `ACTIVE` at execution time -> `'rejected'`.
 * - Already at `maxCapacity` (can't scale out further) -> `'rejected'` (skip the useless
 *   `UpdateService` call).
 * - `UpdateService` fails -> `'failure'`.
 */
export async function executeEcsScaleOut(resourceId: string): Promise<ActionExecutionResult> {
  const parsed = parseEcsResourceId(resourceId);
  if (!parsed) {
    return { outcome: 'rejected', reason: `resourceId is not in the "<clusterName>/<serviceName>" format: ${resourceId}` };
  }
  const { clusterName, serviceName } = parsed;

  let currentDesiredCount: number;
  try {
    const { services = [] } = await ecs.send(
      new DescribeServicesCommand({ cluster: clusterName, services: [serviceName] }),
    );
    const service = services[0];
    if (!service || service.status !== 'ACTIVE') {
      return { outcome: 'rejected', reason: `Service ${resourceId} is no longer ACTIVE at execution time.` };
    }
    currentDesiredCount = service.desiredCount ?? 0;
  } catch (err) {
    return { outcome: 'failure', reason: `Failed to read the current state of service ${resourceId}: ${(err as Error).message}` };
  }

  let maxCapacity: number | undefined;
  try {
    maxCapacity = await readMaxCapacity(clusterName, serviceName);
  } catch (err) {
    // Failing to read the autoscaling config does NOT block the action — it just loses one extra
    // limit layer; `computeEcsScaleOutTarget()` still has MAX_DESIRED_COUNT_HARD_CAP as a final
    // safeguard.
    logger.error(`ecs-scale-action-service: DescribeScalableTargets(${resourceId}) failed (ignored, no extra maxCapacity limit applied)`, err);
  }

  const newDesiredCount = computeEcsScaleOutTarget(currentDesiredCount, maxCapacity);
  if (newDesiredCount <= currentDesiredCount) {
    return {
      outcome: 'rejected',
      reason: `Service ${resourceId} is already at its maximum limit (desiredCount=${currentDesiredCount}, maxCapacity=${maxCapacity ?? 'unlimited'}) — cannot scale out further.`,
    };
  }

  try {
    await ecs.send(
      new UpdateServiceCommand({ cluster: clusterName, service: serviceName, desiredCount: newDesiredCount }),
    );
  } catch (err) {
    return { outcome: 'failure', reason: `UpdateService failed for ${resourceId}: ${(err as Error).message}` };
  }

  return { outcome: 'success', newDesiredCount };
}
