// backend/src/time-of-day-trigger.ts
import { DescribeInstancesCommand } from '@aws-sdk/client-ec2';
import { InvokeCommand } from '@aws-sdk/client-lambda';
import { getEc2Client, getLambdaClient } from '../../core/aws-clients.js';
// Lean_Lambda_Exception (Requirement 6.4a): direct import, not `../ec2-management/index.js` —
// see the exception comment in `ec2AutoRightsizing.ts` (same module, same reason):
// `time-of-day-trigger-fn` is a lean standalone Lambda and the barrel re-exports handler files
// that pull in `config.ts` at module scope.
import { PATCH_TIMEZONE } from '../ec2-management/tagConventions.js';
import {
  SCHEDULE_TAG_KEY,
  NO_AUTO_SIZING_TAG_KEY,
  NO_AUTO_RIGHTSIZE_TAG_KEY,
  LAST_AUTO_RIGHTSIZE_DATE_TAG_KEY,
  AUTO_RIGHTSIZE_COOLDOWN_DAYS,
  todayDateString,
} from './ec2AutoRightsizing.js';
import { areArchitecturesCompatible, fetchInstanceTypeArchitectures } from './ec2Rightsizing.js';
import { s3PolicyStore } from './s3PolicyStore.js';
import type { PeakWindow, TimeOfDaySizingDecision } from './timeOfDayPolicy.js';
import { PRE_PEAK_LEAD_MINUTES } from './timeOfDayPolicy.js';
// Lean_Lambda_Exception (Requirement 6.4a): direct imports, not `../alerting/index.js` — see the
// exception comment in `agent/ai-ops-agent.ts` (same reason): `time-of-day-trigger-fn` is a lean
// standalone Lambda.
import { postAlertEmbeds } from '../alerting/alertHook.js';
import { buildOpsNotificationEmbed } from '../alerting/opsNotification.js';
import { logger } from '../../shared-kernel/logger.js';
import type { DownsizeSchedulerEvent } from './downsize-scheduler.js';

/**
 * `time-of-day-trigger-fn` — a THIN Lambda that contains NO decision logic (that lives in
 * `lib/timeOfDayPolicy.ts`) — it only reads the pre-computed schedule from `PolicyStore`, compares
 * it against the current time in `PATCH_TIMEZONE`, and invokes `DownsizeSchedulerFunction` (REUSING
 * 100% of the Stop→Modify→Start logic) in BOTH directions: pre-peak (resize UP to `peakType` before
 * the peak hours start) AND post-peak (resize DOWN to `offPeakType` once peak hours end — the
 * cost-saving direction, which is never blocked by cooldown, see `classifyPhase`/Fix 1 in the PR
 * review). Runs on a `rate(15 minutes)` schedule (see `TimeOfDaySchedulerSchedule` in
 * `infra/ops-dashboard.yaml`, Task 7).
 */

const ec2 = getEc2Client();
const lambda = getLambdaClient();

const DOWNSIZE_SCHEDULER_FUNCTION_ARN = process.env.DOWNSIZE_SCHEDULER_FUNCTION_ARN;
if (!DOWNSIZE_SCHEDULER_FUNCTION_ARN) throw new Error('Missing required environment variable: DOWNSIZE_SCHEDULER_FUNCTION_ARN');

interface CandidateInstance {
  instanceId: string;
  instanceType: string;
  exempt: boolean;
  lastAutoRightsizeDate: string | undefined;
}

function minutesUntil(now: Date, targetHour: number, timeZone: string): number {
  const hourFormatter = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: 'numeric', hour12: false });
  const parts = hourFormatter.formatToParts(now);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  const nowMinutesOfDay = (hour === 24 ? 0 : hour) * 60 + minute;
  return targetHour * 60 - nowMinutesOfDay;
}

function dayOfWeekInTz(now: Date, timeZone: string): number {
  const weekdayFormatter = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' });
  const index: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return index[weekdayFormatter.format(now)] ?? 0;
}

/** Determines the current phase relative to the peak windows: 'pre-peak' if <= PRE_PEAK_LEAD_MINUTES
 * minutes remain before a window starts (not yet started), 'post-peak' if a window ended within the
 * last PRE_PEAK_LEAD_MINUTES minutes, otherwise 'none'. This runs on a 15-minute cycle, so the check
 * margin must be >= the run interval to avoid missing a window (PRE_PEAK_LEAD_MINUTES=20 > 15, safe
 * enough).
 *
 * MIDNIGHT BOUNDARY HANDLING (Fix 2 — review found that `endHour: 24`/`startHour: 0` NEVER triggered
 * with the original logic, because `minutesUntil(now, 24, tz)` is always positive and
 * `minutesUntil(now, 0, tz)` is always negative):
 *  - `endHour === 24` means the window ends at 00:00 THE NEXT DAY. To correctly catch post-peak right
 *    after that window closes, we must also check windows with `dayOfWeek === yesterday` (relative
 *    to `now`) and treat the end marker as hour 0 of TODAY (minutesToEnd = 0 - nowMinutesOfDay,
 *    correctly negative right after midnight).
 *  - `startHour === 0` is the symmetric case: the window starts at 00:00 THE NEXT DAY (relative to
 *    the `dayOfWeek` declared as that window's "today"). To correctly catch pre-peak right BEFORE
 *    midnight, we check windows with `dayOfWeek === tomorrow` (relative to `now`) and treat the
 *    start marker as hour 24 of TODAY (minutesToStart = 1440 - nowMinutesOfDay, positive during the
 *    last PRE_PEAK_LEAD_MINUTES minutes of the day).
 */
function classifyPhase(now: Date, windows: PeakWindow[], timeZone: string): 'pre-peak' | 'post-peak' | 'none' {
  if (!Array.isArray(windows)) return 'none'; // N1: defensive — an invalid schedule is treated as no windows at all, never throws.
  const today = dayOfWeekInTz(now, timeZone);
  const yesterday = (today + 6) % 7;
  const tomorrow = (today + 1) % 7;

  for (const w of windows) {
    // --- Normal branch: window belongs to today, hours are within the same day (no midnight boundary). ---
    if (w.dayOfWeek === today) {
      const minutesToStart = minutesUntil(now, w.startHour, timeZone);
      if (w.startHour > 0 && minutesToStart > 0 && minutesToStart <= PRE_PEAK_LEAD_MINUTES) return 'pre-peak';
      const minutesToEnd = minutesUntil(now, w.endHour, timeZone);
      if (w.endHour < 24 && minutesToEnd <= 0 && minutesToEnd > -PRE_PEAK_LEAD_MINUTES) return 'post-peak';
    }

    // --- endHour=24 boundary: "yesterday's" window ends exactly at 00:00 today -> post-peak right
    // after midnight (roughly 00:00-00:20 in `today`'s time). ---
    if (w.dayOfWeek === yesterday && w.endHour === 24) {
      const minutesToEnd = minutesUntil(now, 0, timeZone); // end marker = hour 0 of today = -nowMinutesOfDay
      if (minutesToEnd <= 0 && minutesToEnd > -PRE_PEAK_LEAD_MINUTES) return 'post-peak';
    }

    // --- startHour=0 boundary: "tomorrow's" window starts exactly at 00:00 tomorrow -> pre-peak
    // right before midnight today (roughly 23:40-24:00 in `today`'s time). ---
    if (w.dayOfWeek === tomorrow && w.startHour === 0) {
      const minutesToStart = minutesUntil(now, 24, timeZone); // start marker = hour 24 (= 00:00 tomorrow) of today
      if (minutesToStart > 0 && minutesToStart <= PRE_PEAK_LEAD_MINUTES) return 'pre-peak';
    }
  }
  return 'none';
}

function isWithinCooldown(lastAutoRightsizeDate: string | undefined, now: Date): boolean {
  if (!lastAutoRightsizeDate) return false;
  const last = new Date(`${lastAutoRightsizeDate}T00:00:00Z`);
  if (Number.isNaN(last.getTime())) return false;
  const diffDays = (now.getTime() - last.getTime()) / (24 * 60 * 60 * 1000);
  return diffDays < AUTO_RIGHTSIZE_COOLDOWN_DAYS;
}

async function discoverCandidates(): Promise<CandidateInstance[]> {
  const result: CandidateInstance[] = [];
  let nextToken: string | undefined;
  do {
    const { Reservations = [], NextToken } = await ec2.send(new DescribeInstancesCommand({ NextToken: nextToken }));
    for (const reservation of Reservations) {
      for (const instance of reservation.Instances ?? []) {
        if (instance.State?.Name !== 'running') continue;
        const instanceId = instance.InstanceId;
        if (!instanceId) continue;
        const tags = instance.Tags ?? [];
        if (!tags.some((t) => t.Key === SCHEDULE_TAG_KEY)) continue;
        result.push({
          instanceId,
          instanceType: instance.InstanceType ?? '',
          exempt: tags.some((t) => t.Key === NO_AUTO_SIZING_TAG_KEY || t.Key === NO_AUTO_RIGHTSIZE_TAG_KEY),
          lastAutoRightsizeDate: tags.find((t) => t.Key === LAST_AUTO_RIGHTSIZE_DATE_TAG_KEY)?.Value,
        });
      }
    }
    nextToken = NextToken;
  } while (nextToken);
  return result;
}

async function invokeDownsize(instanceId: string, targetType: string): Promise<void> {
  const payload: DownsizeSchedulerEvent = { ec2: { instanceId, targetType } };
  await lambda.send(
    new InvokeCommand({
      FunctionName: DOWNSIZE_SCHEDULER_FUNCTION_ARN,
      InvocationType: 'Event',
      Payload: JSON.stringify(payload),
    }),
  );
}

export interface TimeOfDayTriggerResult {
  ok: true;
  candidatesTotal: number;
  triggered: number;
}

export async function handler(): Promise<TimeOfDayTriggerResult> {
  const now = new Date();
  const candidates = await discoverCandidates();
  let triggered = 0;
  const triggeredNames: { instanceId: string; targetType: string }[] = [];

  for (const candidate of candidates) {
    if (candidate.exempt) continue;

    // N1: the whole fetch-schedule -> classify -> resize sequence is wrapped in one try/catch — an
    // instance with a broken schedule (S3 error, JSON missing `windows`, etc.) is only logged and
    // skipped, and must NEVER throw and take down the whole handler (which would skip every other
    // instance in the list).
    try {
      const decision: TimeOfDaySizingDecision | undefined = await s3PolicyStore.getComputedSchedule(candidate.instanceId);
      if (!decision || decision.action !== 'schedulePeak') continue;

      const phase = classifyPhase(now, decision.windows, PATCH_TIMEZONE);
      if (phase === 'none') continue; // Outside every window (including lead time) — nothing to trigger.

      // Fix 1: cooldown ONLY blocks the resize-UP direction (pre-peak/scale-up) — the resize-DOWN
      // direction (post-peak/scale-down) is the COST-SAVING direction and must never be allowed to
      // be blocked, otherwise an instance could get stuck permanently at the (expensive) peakType
      // for up to 7 days (AUTO_RIGHTSIZE_COOLDOWN_DAYS). Note: `downsize-scheduler.ts` (the Lambda
      // invoked below) does NOT write LAST_AUTO_RIGHTSIZE_DATE_TAG_KEY after a time-of-day resize —
      // cooldown tagging for the time-of-day mechanism is NOT yet wired up (a known gap, see the
      // note in the PR) — don't assume it already works.
      if (phase === 'pre-peak' && isWithinCooldown(candidate.lastAutoRightsizeDate, now)) continue;

      // pre-peak: resize UP to peakType before peak hours. post-peak: resize DOWN to offPeakType once peak hours end.
      const targetType = phase === 'pre-peak' ? decision.peakType : decision.offPeakType;
      if (targetType === candidate.instanceType) continue; // Already at the right type, no change needed.

      const [currentArchitectures, targetArchitectures] = await Promise.all([
        fetchInstanceTypeArchitectures(ec2, candidate.instanceType),
        fetchInstanceTypeArchitectures(ec2, targetType),
      ]);
      if (!currentArchitectures || !targetArchitectures || !areArchitecturesCompatible(currentArchitectures, targetArchitectures)) {
        logger.error(`time-of-day-trigger: ${candidate.instanceId} CPU architecture is not compatible between ${candidate.instanceType} and ${targetType} (skipping, not guessing at safety)`);
        continue;
      }

      await invokeDownsize(candidate.instanceId, targetType);
      triggered += 1;
      triggeredNames.push({ instanceId: candidate.instanceId, targetType });
    } catch (err) {
      logger.error(`time-of-day-trigger: processing failed for ${candidate.instanceId} (skipping, continuing with other instances)`, err);
    }
  }

  if (triggeredNames.length > 0) {
    try {
      const region = process.env.AWS_REGION;
      const links = region
        ? triggeredNames.slice(0, 5).map((t) => ({
            label: t.instanceId,
            url: `https://${region}.console.aws.amazon.com/ec2/home?region=${region}#InstanceDetails:instanceId=${t.instanceId}`,
          }))
        : undefined;

      const embed = buildOpsNotificationEmbed({
        what: `${triggeredNames.length} EC2 instance(s) resized on the time-of-day schedule`,
        severity: 'info',
        who: 'system:time-of-day-trigger',
        why: `Date ${todayDateString(now, PATCH_TIMEZONE)} — details for each instance below.`,
        links,
        region,
        timestampOverride: now.toISOString(),
        footer: 'ops-dashboard · Time-of-Day Sizing',
        extra: triggeredNames.slice(0, 10).map((t) => ({ name: t.instanceId, value: `Target type: \`${t.targetType}\``, inline: false })),
      });
      await postAlertEmbeds([embed]);
    } catch (err) {
      // N2: the resize was already invoked before this point — an alert hub error here must NOT be
      // thrown, otherwise the EventBridge Scheduler retry (MaximumRetryAttempts: 2) would re-run the
      // whole handler and could invoke the resize AGAIN for the same instance (duplicate resize).
      logger.error('time-of-day-trigger: postAlertEmbeds failed (resize was already invoked, not throwing to avoid a duplicate EventBridge retry)', err);
    }
  }

  logger.info(`time-of-day-trigger: candidatesTotal=${candidates.length} triggered=${triggered}`);
  return { ok: true, candidatesTotal: candidates.length, triggered };
}
