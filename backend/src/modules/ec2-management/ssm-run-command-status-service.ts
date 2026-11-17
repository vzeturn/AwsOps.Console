import { GetCommandInvocationCommand } from '@aws-sdk/client-ssm';
import {
  SSM_RUN_COMMAND_MAX_OUTPUT_CHARS,
  TERMINAL_RUN_COMMAND_STATUSES,
  type RunCommandInvocationStatus,
  type RunCommandStatus,
} from '@ops-dashboard/shared';
import { getSsmClient } from '../../core/aws-clients.js';
import { tooManyRequests } from '../../shared-kernel/errors.js';

const ssm = getSsmClient();

/** Same suffix as `cloudwatch-logs-viewer-service.ts` — users are already used to what it means. */
const TRUNCATION_SUFFIX = '… [truncated]';

function awsErrorName(err: unknown): string {
  return typeof err === 'object' && err !== null && 'name' in err ? String((err as { name: unknown }).name) : '';
}

function truncate(text: string): { text: string; truncated: boolean } {
  if (text.length <= SSM_RUN_COMMAND_MAX_OUTPUT_CHARS) return { text, truncated: false };
  return {
    text: text.slice(0, SSM_RUN_COMMAND_MAX_OUTPUT_CHARS - TRUNCATION_SUFFIX.length) + TRUNCATION_SUFFIX,
    truncated: true,
  };
}

/**
 * `ssm:GetCommandInvocation` — READ-ONLY so it runs directly in the router, NOT through
 * `action-execution-fn`: the frontend polls every 2 seconds, and routing that through the mutate
 * Lambda would spawn a junk `Action_Audit_Record` on every poll and pay for an extra invoke on
 * every poll.
 */
export async function getRunCommandStatus(commandId: string, instanceId: string): Promise<RunCommandStatus> {
  try {
    const res = await ssm.send(new GetCommandInvocationCommand({ CommandId: commandId, InstanceId: instanceId }));
    const stdout = truncate(res.StandardOutputContent ?? '');
    const stderr = truncate(res.StandardErrorContent ?? '');
    const status = (res.Status ?? 'Pending') as RunCommandInvocationStatus;
    return {
      commandId,
      instanceId,
      status,
      statusDetails: res.StatusDetails ?? status,
      isTerminal: TERMINAL_RUN_COMMAND_STATUSES.includes(status),
      ...(typeof res.ResponseCode === 'number' ? { responseCode: res.ResponseCode } : {}),
      stdout: stdout.text,
      stderr: stderr.text,
      truncated: stdout.truncated || stderr.truncated,
    };
  } catch (err) {
    const name = awsErrorName(err);
    // SSM has a consistent few-hundred-ms lag: the very first poll right after SendCommand can
    // easily hit `InvocationDoesNotExist`. That is NOT an error — return 'Pending' so the UI keeps
    // polling, instead of showing "command not found" only for it to appear 2 seconds later (users
    // would think the system is broken). A commandId that truly doesn't exist is handled on the
    // frontend via the 90-second poll-stop cutoff.
    if (name === 'InvocationDoesNotExist') {
      return {
        commandId,
        instanceId,
        status: 'Pending',
        statusDetails: 'Pending',
        isTerminal: false,
        stdout: '',
        stderr: '',
        truncated: false,
      };
    }
    if (name === 'ThrottlingException' || name === 'LimitExceededException') {
      throw tooManyRequests('SSM is rate-limiting queries right now — try again in a few seconds');
    }
    throw err;
  }
}
