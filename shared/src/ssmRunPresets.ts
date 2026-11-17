/**
 * 5 SSM Run Command presets — the HARD SECURITY BOUNDARY of sub-project #4.
 *
 * Each preset is ONE literal command string, ZERO parameters. Not "a parameter constrained by a
 * dropdown" but NO PARAMETER AT ALL — so the invariant "no user-supplied command string ever
 * touches ssm:SendCommand" can be verified by eye against the exact table below, with no need to
 * reason about an allowed-values list.
 *
 * All 5 commands are READ-ONLY. Do NOT add a mutating preset (restart a service, install a
 * package, edit a file...) here: the need to reboot already has a safer, already-audited path —
 * `EC2_Reboot` via `POST /actions/lifecycle`. Adding a mutating preset must be its own sub-project
 * with matching warnings/confirmation.
 */
/** One command variant (per platform) of a preset — also a literal constant, ZERO parameters,
 * upholding the exact same invariant as the parent preset. */
export interface SsmRunCommandVariant {
  readonly documentName: 'AWS-RunShellScript' | 'AWS-RunPowerShellScript';
  readonly commands: readonly string[];
}

export interface SsmRunPreset {
  readonly id: string;
  readonly label: string;
  /** Short explanation shown below the dropdown — helps the operator pick the right one. */
  readonly description: string;
  /** Linux/UNIX variant — always `AWS-RunShellScript`. */
  readonly linux: SsmRunCommandVariant;
  /** Windows variant — always `AWS-RunPowerShellScript`. */
  readonly windows: SsmRunCommandVariant;
}

export const SSM_RUN_PRESETS: readonly SsmRunPreset[] = [
  {
    id: 'disk-usage',
    label: 'Check disk usage',
    description: 'Lists usage for every mounted filesystem (df -h).',
    linux: { documentName: 'AWS-RunShellScript', commands: ['df -h'] },
    windows: {
      documentName: 'AWS-RunPowerShellScript',
      commands: ['Get-PSDrive -PSProvider FileSystem | Format-Table -AutoSize'],
    },
  },
  {
    id: 'memory-usage',
    label: 'Check RAM & swap usage',
    description: 'Total/used/free RAM and swap in MB (free -m).',
    linux: { documentName: 'AWS-RunShellScript', commands: ['free -m'] },
    windows: {
      documentName: 'AWS-RunPowerShellScript',
      commands: [
        "Get-CimInstance Win32_OperatingSystem | Select-Object @{N='TotalMB';E={[math]::Round($_.TotalVisibleMemorySize/1024)}},@{N='FreeMB';E={[math]::Round($_.FreePhysicalMemory/1024)}} | Format-List",
      ],
    },
  },
  {
    id: 'uptime-load',
    label: 'Check uptime & system load',
    description: 'How long the machine has been running plus the 1/5/15-minute load average (uptime).',
    linux: { documentName: 'AWS-RunShellScript', commands: ['uptime'] },
    windows: {
      documentName: 'AWS-RunPowerShellScript',
      commands: [
        "Get-CimInstance Win32_OperatingSystem | Select-Object @{N='LastBootUpTime';E={$_.LastBootUpTime}},@{N='UptimeHours';E={[math]::Round(((Get-Date)-$_.LastBootUpTime).TotalHours,2)}} | Format-List",
      ],
    },
  },
  {
    // HARD-CODED log path, NOT parameterized. The two `||` branches cover both Amazon Linux/RHEL
    // (/var/log/messages) and Ubuntu/Debian (/var/log/syslog) — both are literals in the source,
    // no part comes from input. `2>/dev/null` lets the first branch fail silently instead of
    // polluting stderr on a distro without /var/log/messages.
    id: 'system-log-tail',
    label: 'View the last 50 lines of system log',
    description: 'The last 50 lines of /var/log/messages (or /var/log/syslog on Ubuntu/Debian).',
    linux: {
      documentName: 'AWS-RunShellScript',
      commands: ['tail -n 50 /var/log/messages 2>/dev/null || tail -n 50 /var/log/syslog'],
    },
    windows: {
      documentName: 'AWS-RunPowerShellScript',
      commands: ['Get-EventLog -LogName System -Newest 50 | Format-Table TimeGenerated,EntryType,Source,Message -Wrap'],
    },
  },
  {
    // Service name is HARD-CODED directly in the preset — in the spirit of "if a service must be
    // chosen, use a fixed list", but even stricter: there's exactly one service, so it doesn't
    // even need a dropdown. `--no-pager` is REQUIRED: without it systemctl hangs waiting on a
    // pager in an environment with no TTY.
    id: 'ssm-agent-status',
    label: 'Check amazon-ssm-agent service status',
    description: "The systemd status of the SSM Agent itself (systemctl status amazon-ssm-agent).",
    linux: { documentName: 'AWS-RunShellScript', commands: ['systemctl status amazon-ssm-agent --no-pager'] },
    windows: {
      documentName: 'AWS-RunPowerShellScript',
      commands: ['Get-Service -Name AmazonSSMAgent | Select-Object Name,Status,DisplayName | Format-List'],
    },
  },
] as const;

/** Looks up a preset by id. `undefined` = invalid id → the caller MUST reject the request, never
 * guess/fall back to a different preset. */
export function findSsmRunPreset(presetId: string): SsmRunPreset | undefined {
  return SSM_RUN_PRESETS.find((p) => p.id === presetId);
}

/** Selects the correct command variant (document + commands) for the instance's platform. Both
 * variants are literal constants on the preset — this function only looks up the table, it never
 * constructs a new command string. */
export function getPresetVariant(preset: SsmRunPreset, platform: 'linux' | 'windows'): SsmRunCommandVariant {
  return platform === 'windows' ? preset.windows : preset.linux;
}

/** The `Status` values of `ssm:GetCommandInvocation` (SSM API reference). */
export type RunCommandInvocationStatus =
  | 'Pending'
  | 'InProgress'
  | 'Delayed'
  | 'Success'
  | 'Cancelled'
  | 'TimedOut'
  | 'Failed';

export const TERMINAL_RUN_COMMAND_STATUSES: readonly RunCommandInvocationStatus[] = [
  'Success',
  'Cancelled',
  'TimedOut',
  'Failed',
];

export interface RunCommandStatus {
  commandId: string;
  instanceId: string;
  status: RunCommandInvocationStatus;
  /** SSM's raw detail string ('Success', 'Failed', 'DeliveryTimedOut'...) — shown verbatim on
   * error, don't translate/reword it or the real cause gets obscured. */
  statusDetails: string;
  /** Computed by the BACKEND — the frontend must NOT enumerate terminal statuses itself, the two
   * would drift out of sync the moment SSM adds a new status, resulting in an infinitely polling UI. */
  isTerminal: boolean;
  /** Shell exit code, only present once the command has finished running. */
  responseCode?: number;
  /** ALREADY truncated to `SSM_RUN_COMMAND_MAX_OUTPUT_CHARS`. */
  stdout: string;
  stderr: string;
  /** `true` when stdout OR stderr was truncated — the UI must say so explicitly, don't let the
   * user think the command only printed that much. */
  truncated: boolean;
}

/** `TimeoutSeconds` for SendCommand: how long SSM waits for the agent to RECEIVE the command (not
 * how long it runs). */
export const SSM_RUN_COMMAND_TIMEOUT_SECONDS = 60;

/** Truncation applied separately to EACH of stdout/stderr. More generous than the Logs viewer's
 * `MAX_MESSAGE_CHARS = 4000` because `df -h`/`systemctl status` is a single block of text rather
 * than many independent lines; 8000×2 plus metadata is still far under the Function URL's response
 * limit. */
export const SSM_RUN_COMMAND_MAX_OUTPUT_CHARS = 8000;

/** The frontend stops polling past this point even if SSM hasn't returned a terminal status yet —
 * never poll forever. */
export const SSM_RUN_COMMAND_POLL_TIMEOUT_MS = 90_000;
