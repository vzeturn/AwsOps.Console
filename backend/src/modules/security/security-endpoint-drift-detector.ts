import { DescribeInstancesCommand } from '@aws-sdk/client-ec2';
import { DescribeInstanceInformationCommand, SendCommandCommand, GetCommandInvocationCommand } from '@aws-sdk/client-ssm';
import { getEc2Client, getSsmClient } from '../../core/aws-clients.js';
// Lean_Lambda_Exception (Requirement 6.4a): direct imports, not `../alerting/index.js` — see the
// exception comment in `agent/ai-ops-agent.ts` (same reason):
// `security-endpoint-drift-detector-fn` is a lean standalone Lambda.
import { postAlertEmbeds } from '../alerting/alertHook.js';
import { buildOpsNotificationEmbed } from '../alerting/opsNotification.js';
import { logger } from '../../shared-kernel/logger.js';
import type { DriftFinding } from './endpoint-drift-report.js';
export type { DriftFinding } from './endpoint-drift-report.js';

/**
 * `security-endpoint-drift-detector.ts` — a NEW Lambda, scheduled (EventBridge Scheduler
 * `rate(1 day)`, see `infra/ops-dashboard.yaml`).
 *
 * WHAT THIS AUTOMATES
 *
 * On 2026-09-17, an investigation into 3 GuardDuty DNS-related findings (triggered by unusual
 * DoH/DoT/DNS-resolver traffic) took an SSM RunCommand session to discover the ROOT cause: 2 EC2
 * instances were running BOTH Tailscale AND Netbird at once (2 separate always-on VPN mesh
 * clients), installed via `apt-get install` under a real interactive session — a sanctioned test,
 * but one GuardDuty only ever sees indirectly (as anomalous DNS traffic), never directly (as "a
 * second remote-access tool got installed"). This Lambda runs that same SSM diagnostic proactively
 * every day, so a NEW VPN/tunnel install is caught the moment it happens instead of days later via
 * an indirect GuardDuty DNS finding that then needs manual SSM investigation to explain.
 *
 * WHY THIS MATTERS MORE THAN THE DNS SYMPTOM ITSELF
 *
 * The investigation also found `netbird up --allow-server-ssh --enable-ssh-root` had been run on
 * one of the 2 instances 3 days before this audit (confirmed to have been turned back off by the
 * time of the audit, via `netbird status` -> `SSH Server: Disabled` — but it COULD have still been
 * on). A VPN/tunnel client with an embedded SSH server is a root-access path that lives entirely
 * outside AWS IAM/Security Groups/SSM visibility — exactly the class of risk this Lambda exists to
 * surface early, regardless of whether GuardDuty happens to notice a DNS side-effect that week.
 *
 * SCOPE: every SSM-managed (`PingStatus: Online`) instance — an instance without the SSM Agent
 * running cannot be checked this way at all, and is silently skipped (same fail-safe-by-omission
 * as `alarm-baseline-manager.ts`'s host-metric alarms, which only alarm on instances actually
 * publishing CWAgent metrics rather than guessing about ones that aren't).
 *
 * EXEMPTION: an instance already carrying a `SecurityException` tag (the SAME tag
 * `security-guardduty-triage.ts`/`governance-exemption-auditor.ts` read) is still SCANNED, but a
 * VPN/tunnel process found there is reported at `info` severity (informational — "here's what's
 * running, matches the documented exception") instead of `warning` (needs review) — an operator
 * scanning alert hub should be able to tell "already known and sanctioned" apart from "new,
 * unexplained" without opening the tag on every instance by hand.
 */

const ec2 = getEc2Client();
const ssm = getSsmClient();

const SECURITY_EXCEPTION_TAG_KEY = 'SecurityException';

/** Process names this check looks for — the exact 3 remote-access tools this project has actually
 * found running (Tailscale/Netbird on 2026-09-17) plus Cloudflare Tunnel, which was ALSO found
 * running on one of those same 2 instances (see `security-guardduty-triage.ts`'s file header).
 * `pgrep -f` (substring match against the FULL command line, not just argv[0]) is deliberate: the
 * real processes observed were `/usr/sbin/tailscaled --state=... --socket=...`, `/usr/bin/netbird
 * service run --log-level info ...`, `cloudflared --no-autoupdate tunnel --no-autoupdate run
 * --token ...` — matching only the binary name would still work for these 3, but `-f` also catches
 * a renamed/relocated binary invoked with a recognizable flag, which a bare argv[0] match would miss. */
const WATCHED_PROCESS_PATTERNS = ['tailscaled', 'netbird', 'cloudflared'];

interface OnlineInstance {
  instanceId: string;
  hasSecurityExceptionTag: boolean;
}

async function discoverOnlineInstances(): Promise<OnlineInstance[]> {
  const onlineIds = new Set<string>();
  let nextToken: string | undefined;
  do {
    const { InstanceInformationList = [], NextToken } = await ssm.send(new DescribeInstanceInformationCommand({ NextToken: nextToken }));
    for (const info of InstanceInformationList) {
      if (info.InstanceId && info.PingStatus === 'Online') onlineIds.add(info.InstanceId);
    }
    nextToken = NextToken;
  } while (nextToken);

  if (onlineIds.size === 0) return [];

  // A single DescribeInstances covers every online instance's tags in one call (Filters accepts
  // up to 200 instance-ids — well within range at this account's scale, matching the assumption
  // `alarm-baseline-manager.ts`'s DELETE_ALARMS_BATCH_SIZE comments make about this account's size).
  const { Reservations = [] } = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [...onlineIds] }));
  const result: OnlineInstance[] = [];
  for (const reservation of Reservations) {
    for (const instance of reservation.Instances ?? []) {
      const instanceId = instance.InstanceId;
      if (!instanceId) continue;
      const hasSecurityExceptionTag = (instance.Tags ?? []).some((t) => t.Key === SECURITY_EXCEPTION_TAG_KEY);
      result.push({ instanceId, hasSecurityExceptionTag });
    }
  }
  return result;
}

/** Builds the single shell command sent via SSM RunCommand — 1 line per watched pattern, each
 * prefixed with its own pattern name so the output can be parsed back per-pattern without a
 * second round-trip. `|| true` on the `pgrep` keeps a "process not found" (`pgrep`'s normal exit
 * code 1) from marking the whole SSM command Failed. */
function buildDetectionScript(): string {
  return WATCHED_PROCESS_PATTERNS.map((pattern) => `echo "${pattern}:$(pgrep -f -c '${pattern}' || echo 0)"`).join('\n');
}

/** Parses the `pattern:count` lines `buildDetectionScript()`'s output produces back into the
 * subset of `WATCHED_PROCESS_PATTERNS` that had at least 1 matching process. Tolerant of extra/
 * missing lines (an instance where the script partially failed still reports what it could). */
export function parseDetectedProcesses(stdout: string): string[] {
  const found: string[] = [];
  for (const line of stdout.split('\n')) {
    const [pattern, countRaw] = line.split(':');
    if (!pattern || !WATCHED_PROCESS_PATTERNS.includes(pattern)) continue;
    if (Number(countRaw) > 0) found.push(pattern);
  }
  return found;
}

/** Sends the detection script and polls for completion — SSM RunCommand is asynchronous
 * (`SendCommand` returns immediately with a CommandId, the actual execution happens out-of-band),
 * so this polls `GetCommandInvocation` with a bounded number of attempts rather than assuming the
 * command already finished. Returns `undefined` on any failure (offline instance, IAM error,
 * command never reached a terminal state within the poll budget) — never throws, matching the
 * "one instance's failure must not break the whole scan" contract every other collector in this
 * codebase already follows (e.g. `alarm-baseline-manager.ts`'s per-alarm try/catch). */
async function runDetectionOnInstance(instanceId: string): Promise<string[] | undefined> {
  try {
    const { Command } = await ssm.send(
      new SendCommandCommand({
        DocumentName: 'AWS-RunShellScript',
        InstanceIds: [instanceId],
        Parameters: { commands: [buildDetectionScript()] },
        Comment: 'ops-dashboard security-endpoint-drift-detector: daily VPN/tunnel process scan',
      }),
    );
    const commandId = Command?.CommandId;
    if (!commandId) return undefined;

    const maxAttempts = 6;
    const delayMs = 2000;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      const invocation = await ssm.send(new GetCommandInvocationCommand({ CommandId: commandId, InstanceId: instanceId }));
      if (invocation.Status === 'Success') return parseDetectedProcesses(invocation.StandardOutputContent ?? '');
      if (invocation.Status === 'Failed' || invocation.Status === 'Cancelled' || invocation.Status === 'TimedOut') {
        logger.error(`security-endpoint-drift-detector: SSM command ${commandId} on ${instanceId} ended with status ${invocation.Status}`);
        return undefined;
      }
      // Pending/InProgress/Delayed -> keep polling.
    }
    logger.error(`security-endpoint-drift-detector: SSM command ${commandId} on ${instanceId} did not complete within the poll budget`);
    return undefined;
  } catch (err) {
    logger.error(`security-endpoint-drift-detector: failed to run detection on ${instanceId} (skipping)`, err);
    return undefined;
  }
}

function formatFindingLine(finding: DriftFinding): string {
  const status = finding.hasSecurityExceptionTag ? '(sanctioned — has SecurityException tag)' : '(⚠ NOT tagged as an exception)';
  return `**${finding.instanceId}**: ${finding.detectedProcesses.join(', ')} ${status}`;
}

export async function handler(): Promise<{ ok: true; scanned: number; withDrift: number; unexplained: number }> {
  const instances = await discoverOnlineInstances();

  const results = await Promise.all(
    instances.map(async (instance): Promise<DriftFinding | undefined> => {
      const detected = await runDetectionOnInstance(instance.instanceId);
      if (!detected || detected.length === 0) return undefined;
      return { instanceId: instance.instanceId, detectedProcesses: detected, hasSecurityExceptionTag: instance.hasSecurityExceptionTag };
    }),
  );
  const findings = results.filter((r): r is DriftFinding => r !== undefined);
  const unexplained = findings.filter((f) => !f.hasSecurityExceptionTag);

  logger.info(`security-endpoint-drift-detector: scanned=${instances.length} withDrift=${findings.length} unexplained=${unexplained.length}`);

  if (findings.length > 0) {
    const region = process.env.AWS_REGION;
    // Deep-links only for the UNTAGGED instances — a sanctioned, already-tagged instance needs no
    // one-click follow-up, matching this project's own "only link when it takes the reader
    // directly to something actionable" convention (see health-report.ts). Capped at 5.
    const links = region
      ? unexplained.slice(0, 5).map((f) => ({
          label: f.instanceId,
          url: `https://${region}.console.aws.amazon.com/ec2/home?region=${region}#InstanceDetails:instanceId=${f.instanceId}`,
        }))
      : undefined;

    const embed = buildOpsNotificationEmbed({
      what: `VPN/tunnel process(es) found on ${findings.length} instance(s)`,
      severity: unexplained.length > 0 ? 'warning' : 'info',
      who: 'system:security-endpoint-drift-detector',
      // Impact is only stated for the untagged case — an already-sanctioned finding (info
      // severity) has no unresolved consequence to describe, matching the file header's own
      // "info notification carries no SEV tier" principle applied at the data level too.
      impact:
        unexplained.length > 0
          ? `${unexplained.length} instance(s) have a remote-access tool running with NO documented justification — this is an access path completely invisible to AWS IAM/Security Groups/CloudTrail, and it is not currently confirmed to be sanctioned.`
          : undefined,
      why: 'A VPN mesh client or tunnel (Tailscale/Netbird/Cloudflare Tunnel) is a remote-access path that lives outside AWS IAM/Security Group/SSM visibility — worth confirming it is expected.',
      how: unexplained.length > 0
        ? 'For each untagged instance below, confirm the process is sanctioned and tag it SecurityException, or remove the process if it is not.'
        : 'No action needed — every instance below already carries a SecurityException tag.',
      links,
      region,
      extra: [
        {
          name: 'Instances',
          value: findings.map(formatFindingLine).join('\n').slice(0, 1024),
          inline: false,
        },
      ],
    });
    await postAlertEmbeds([embed]);
  }

  return { ok: true, scanned: instances.length, withDrift: findings.length, unexplained: unexplained.length };
}
