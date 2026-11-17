import { SendCommandCommand, DescribeInstanceInformationCommand } from '@aws-sdk/client-ssm';
import {
  findSsmRunPreset,
  getPresetVariant,
  SSM_RUN_COMMAND_TIMEOUT_SECONDS,
  type ActionExecutionRequest,
  type ActionExecutionResult,
} from '@ops-dashboard/shared';
import { getSsmClient } from '../../core/aws-clients.js';
import { EC2_INSTANCE_ID_PATTERN } from './instanceInInfraCache.js';

const ssm = getSsmClient();

/** Read `err.name` instead of `instanceof`: AWS SDK v3 error classes are generated at runtime (and
 * mocked in tests), so `instanceof` isn't reliable here. Same helper as the other action-services. */
function awsErrorName(err: unknown): string {
  return typeof err === 'object' && err !== null && 'name' in err ? String((err as { name: unknown }).name) : '';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'unknown error';
}

/**
 * `SSM_RunPreset` — runs 1 READ-ONLY diagnostic preset on 1 EC2 instance.
 *
 * `DocumentName` and `Parameters.commands` ALWAYS come from `SSM_RUN_PRESETS` (a constant in
 * source), NEVER from `req`. `req.params` only carries `presetId` — a lookup key.
 *
 * action-execution-fn is its OWN trust boundary: it re-validates `presetId` and `resourceId` again
 * rather than assuming the router (caller) is trustworthy — the same principle already applied in
 * `security-group-action-service.ts`.
 */
export async function runSsmPreset(req: ActionExecutionRequest): Promise<ActionExecutionResult> {
  const presetId = typeof req.params.presetId === 'string' ? req.params.presetId : '';
  const preset = findSsmRunPreset(presetId);
  if (!preset) {
    return { outcome: 'rejected', reason: `Invalid preset: ${presetId || '(empty)'}` };
  }
  if (!EC2_INSTANCE_ID_PATTERN.test(req.resourceId)) {
    return { outcome: 'rejected', reason: `Invalid instance id: ${req.resourceId}` };
  }

  // Preflight. action-execution-fn CANNOT read the infra cache (no S3 permission for that key), so
  // it can't repeat the router's "instance belongs to the dashboard" check. In exchange,
  // DescribeInstanceInformation both proves the instance is a REAL SSM-managed node in this exact
  // account + region, and produces a specific error message ("SSM Agent not Online") instead of
  // leaving the operator to face a confusing raw SSM error after the command has already been sent.
  // It also reads `PlatformType` to pick the right Linux/Windows document — this is the ONLY
  // trusted platform source at this layer (never trust `req`), separate from the preview platform
  // shown in the frontend.
  let platform: 'linux' | 'windows' = 'linux';
  try {
    const info = await ssm.send(
      new DescribeInstanceInformationCommand({
        Filters: [{ Key: 'InstanceIds', Values: [req.resourceId] }],
      }),
    );
    const node = info.InstanceInformationList?.[0];
    if (!node) {
      return {
        outcome: 'rejected',
        reason: `Instance ${req.resourceId} is not registered with SSM — check that the instance profile has AmazonSSMManagedInstanceCore and that the SSM Agent is running`,
      };
    }
    if (node.PingStatus !== 'Online') {
      return {
        outcome: 'rejected',
        reason: `SSM Agent on ${req.resourceId} is not Online (PingStatus=${node.PingStatus ?? 'unknown'}) — the instance may be shut down or disconnected`,
      };
    }
    // Bash-leaning fail-safe: any value other than 'Windows' (including 'Linux', 'MacOS', or an
    // unrecognized/unknown value) is treated as 'linux' — the most common platform in this fleet.
    platform = node.PlatformType === 'Windows' ? 'windows' : 'linux';
  } catch (err) {
    return { outcome: 'failure', reason: `Could not check the instance's SSM status: ${errorMessage(err)}` };
  }

  const variant = getPresetVariant(preset, platform);

  try {
    const response = await ssm.send(
      new SendCommandCommand({
        // BOTH fields below are preset constants (varying by platform), never data from the
        // request.
        DocumentName: variant.documentName,
        Parameters: { commands: [...variant.commands] },
        InstanceIds: [req.resourceId],
        TimeoutSeconds: SSM_RUN_COMMAND_TIMEOUT_SECONDS,
        // Do NOT enable CloudWatchOutputConfig: it would auto-create a billable log group, against
        // the "$0" architecture. Reading output directly via GetCommandInvocation is enough for
        // these 5 short presets.
        Comment: `ops-dashboard preset ${preset.id}`.slice(0, 100),
      }),
    );
    const commandId = response.Command?.CommandId;
    if (!commandId) {
      return { outcome: 'failure', reason: 'SSM SendCommand did not return a CommandId' };
    }
    return { outcome: 'success', commandId };
  } catch (err) {
    const name = awsErrorName(err);
    // `InvalidInstanceId` means "the instance isn't eligible to run commands" (not managed/not
    // online) — a valid business outcome, NOT a system failure, so 'rejected' rather than 'failure'.
    if (name === 'InvalidInstanceId') {
      return { outcome: 'rejected', reason: `SSM rejected instance ${req.resourceId}: ${errorMessage(err)}` };
    }
    return { outcome: 'failure', reason: `SSM SendCommand failed: ${errorMessage(err)}` };
  }
}
