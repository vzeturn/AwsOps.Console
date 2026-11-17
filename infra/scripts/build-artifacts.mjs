import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const infraRoot = path.join(__dirname, '..');
const repoRoot = path.join(infraRoot, '..');

/**
 * Packages ZIP-ready artifacts under infra/build/. The local FOLDER names are kept (they match
 * `Code: ./build/<name>` in ops-dashboard.yaml); only the AWS-facing names
 * (FunctionName/RoleName/AlarmName) follow the domain naming (web-, collector-, alerting-,
 * governance-, agent-, action- prefix), see ops-dashboard.yaml for the full mapping:
 *
 *   router -> web-router-fn                        static-server -> web-static-fn
 *   cost-collector -> collector-cost-fn             infra-collector -> collector-infra-fn
 *   infra-review-collector -> collector-compliance-fn
 *   discord-alarm-notifier -> alerting-notifier-fn  alarm-baseline-manager -> alerting-baseline-manager-fn
 *   health-report -> alerting-health-report-fn
 *   patch-scheduler -> governance-patch-scheduler-fn
 *   ec2-rightsize-applier -> governance-rightsize-applier-fn
 *   downsize-scheduler -> governance-downsize-scheduler-fn
 *   time-of-day-trigger -> governance-timeofday-trigger-fn
 *   ai-ops-agent -> agent-ai-ops-fn
 *   scheduled-actions-mutate -> action-schedule-mutate-fn
 *   approval-mutate -> action-approval-mutate-fn    action-execution -> action-execution-fn (unchanged)
 *   idle-scheduler-tick -> idle-scheduler-tick-fn    idle-scheduler-wake -> idle-scheduler-wake-fn
 *   idle-scheduler-watchdog -> idle-scheduler-watchdog-fn
 *   idle-scheduler-mutate -> idle-scheduler-mutate-fn
 *
 * Folders: router/, static-server/, cost-collector/, infra-review-collector/, infra-collector/,
 * action-execution/, discord-alarm-notifier/, alarm-baseline-manager/, health-report/,
 * patch-scheduler/, ec2-rightsize-applier/, downsize-scheduler/, scheduled-actions-mutate/,
 * approval-mutate/, time-of-day-trigger/, ai-ops-agent/, the 5 automation Lambdas:
 * alerting-topic-guardian/, security-guardduty-triage/, security-public-bucket-guardian/,
 * governance-exemption-auditor/, security-endpoint-drift-detector/, plus the 4 Idle-to-Zero
 * Lambdas:
 * idle-scheduler-tick/, idle-scheduler-wake/, idle-scheduler-watchdog/, idle-scheduler-mutate/.
 */
const buildDir = path.join(infraRoot, 'build');
rmSync(buildDir, { recursive: true, force: true });
mkdirSync(buildDir, { recursive: true });

async function bundle(entry, outfile) {
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
  });
}

// router (backend API)
await bundle(path.join(repoRoot, 'backend/src/modules/web/router.ts'), path.join(buildDir, 'router/index.mjs'));

// cost-collector
await bundle(path.join(repoRoot, 'backend/src/modules/cost/cost-collector.ts'), path.join(buildDir, 'cost-collector/index.mjs'));

// infra-review-collector
await bundle(path.join(repoRoot, 'backend/src/modules/assessment/infra-review-collector.ts'), path.join(buildDir, 'infra-review-collector/index.mjs'));

// infra-collector (caches InfraData/ComplianceData in S3 on a schedule, see infra/ops-dashboard.yaml)
await bundle(path.join(repoRoot, 'backend/src/infra-collector.ts'), path.join(buildDir, 'infra-collector/index.mjs'));

// action-execution-fn
await bundle(path.join(repoRoot, 'backend/src/modules/actions/action-execution-handler.ts'), path.join(buildDir, 'action-execution/index.mjs'));

// discord-alarm-notifier (the only subscriber of the CloudWatch Alarm SNS topic)
await bundle(path.join(repoRoot, 'backend/src/modules/alerting/discord-alarm-notifier.ts'), path.join(buildDir, 'discord-alarm-notifier/index.mjs'));

// alarm-baseline-manager (standard alarm set per resource type, runs on a schedule)
await bundle(path.join(repoRoot, 'backend/src/modules/alerting/alarm-baseline-manager.ts'), path.join(buildDir, 'alarm-baseline-manager/index.mjs'));

// health-report (posts a Discord embed summarizing system health every 15 minutes, re-reading DescribeAlarms independently of the SNS path)
await bundle(path.join(repoRoot, 'backend/src/modules/alerting/health-report.ts'), path.join(buildDir, 'health-report/index.mjs'));

// patch-scheduler (patches instances carrying the on/off schedule tag >= 30 minutes after start, runs on a short schedule)
await bundle(path.join(repoRoot, 'backend/src/modules/governance/patch-scheduler.ts'), path.join(buildDir, 'patch-scheduler/index.mjs'));

// ec2-rightsize-applier (execution half of EC2_AutoRightsize, triggered by an EventBridge Rule when an EC2 instance stops)
await bundle(path.join(repoRoot, 'backend/src/modules/governance/ec2-rightsize-applier.ts'), path.join(buildDir, 'ec2-rightsize-applier/index.mjs'));

// downsize-scheduler (reusable Lambda for one-off manual RDS/EC2 downsizes, triggered by a one-time EventBridge Scheduler schedule created through the API)
await bundle(path.join(repoRoot, 'backend/src/modules/governance/downsize-scheduler.ts'), path.join(buildDir, 'downsize-scheduler/index.mjs'));

// time-of-day-trigger (reads the PolicyStore schedule, invokes DownsizeSchedulerFunction before/after peak hours, triggered by EventBridge Scheduler rate(15 minutes))
await bundle(path.join(repoRoot, 'backend/src/modules/governance/time-of-day-trigger.ts'), path.join(buildDir, 'time-of-day-trigger/index.mjs'));

// ai-ops-agent (reads assessment-report.json, prioritizes among a pre-filtered list of safe actions
// using the Anthropic Claude API, executes through action-execution-fn; triggered by EventBridge
// Scheduler rate(30 minutes), OFF by default through the AGENT_AUTO_EXECUTE_ENABLED kill switch)
await bundle(path.join(repoRoot, 'backend/src/modules/agent/ai-ops-agent.ts'), path.join(buildDir, 'ai-ops-agent/index.mjs'));

// scheduled-actions-mutate (dedicated mutating Lambda for the dashboard's Scheduled Actions feature:
// creates/cancels one-time EventBridge Scheduler schedules, invoked through lambda:InvokeFunction from the router)
await bundle(path.join(repoRoot, 'backend/src/modules/scheduled-actions/scheduled-actions-mutate-handler.ts'), path.join(buildDir, 'scheduled-actions-mutate/index.mjs'));

// approval-mutate (dedicated mutating Lambda for the maker-checker Approval workflow: creates/decides/
// marks as executed an Approval_Request in S3, invoked through lambda:InvokeFunction from the router)
await bundle(path.join(repoRoot, 'backend/src/modules/actions/approval-mutate-handler.ts'), path.join(buildDir, 'approval-mutate/index.mjs'));

// alerting-topic-guardian (rate(1 day): every SNS topic must have >=1 subscriber, else it's a silent alerting gap)
await bundle(path.join(repoRoot, 'backend/src/modules/alerting/alerting-topic-guardian.ts'), path.join(buildDir, 'alerting-topic-guardian/index.mjs'));

// security-guardduty-triage (2nd target on GuardDutyFindingsRule: auto-archives a finding when the affected resource already carries a SecurityException tag)
await bundle(path.join(repoRoot, 'backend/src/modules/security/security-guardduty-triage.ts'), path.join(buildDir, 'security-guardduty-triage/index.mjs'));

// security-public-bucket-guardian (rate(1 day): flags a publicly-accessible S3 bucket with no DataClass=public tag)
await bundle(path.join(repoRoot, 'backend/src/modules/security/security-public-bucket-guardian.ts'), path.join(buildDir, 'security-public-bucket-guardian/index.mjs'));

// governance-exemption-auditor (rate(1 day): flags a monitoring/security exception whose SecurityExceptionReviewDate has passed)
await bundle(path.join(repoRoot, 'backend/src/modules/governance/governance-exemption-auditor.ts'), path.join(buildDir, 'governance-exemption-auditor/index.mjs'));

// security-endpoint-drift-detector (rate(1 day), SSM RunCommand: flags an untagged VPN/tunnel process on any SSM-managed instance)
await bundle(path.join(repoRoot, 'backend/src/modules/security/security-endpoint-drift-detector.ts'), path.join(buildDir, 'security-endpoint-drift-detector/index.mjs'));

// idle-scheduler-tick (rate(5 minutes): discovers every ALB tagged idle-scheduler:managed=true, stops EC2+RDS after N idle minutes)
await bundle(path.join(repoRoot, 'backend/src/modules/idle-scheduler/idle-scheduler-tick.ts'), path.join(buildDir, 'idle-scheduler-tick/index.mjs'));

// idle-scheduler-wake (SNS subscriber: starts EC2+RDS in parallel on a managed group's own wake alarm)
await bundle(path.join(repoRoot, 'backend/src/modules/idle-scheduler/idle-scheduler-wake.ts'), path.join(buildDir, 'idle-scheduler-wake/index.mjs'));

// idle-scheduler-watchdog (rate(60 minutes): re-asserts the idle-to-zero mechanism cannot be silently disabled)
await bundle(path.join(repoRoot, 'backend/src/modules/idle-scheduler/idle-scheduler-watchdog.ts'), path.join(buildDir, 'idle-scheduler-watchdog/index.mjs'));

// idle-scheduler-mutate (dedicated mutating Lambda for Idle-to-Zero: tags ALBs + creates/deletes each group's wake alarm, invoked through lambda:InvokeFunction from the router)
await bundle(path.join(repoRoot, 'backend/src/modules/idle-scheduler/idle-scheduler-mutate-handler.ts'), path.join(buildDir, 'idle-scheduler-mutate/index.mjs'));

// rds-nightly-scheduler (2x EventBridge Scheduler cron, Asia/Ho_Chi_Minh: 00:00 stop / 06:30 start; replaces Idle-to-Zero traffic-based stop/wake for RDS to avoid flapping)
await bundle(path.join(repoRoot, 'backend/src/modules/governance/rds-nightly-scheduler.ts'), path.join(buildDir, 'rds-nightly-scheduler/index.mjs'));

// static-server + copy frontend/dist -> site/
await bundle(path.join(infraRoot, 'static-server/index.ts'), path.join(buildDir, 'static-server/index.mjs'));
const frontendDist = path.join(repoRoot, 'frontend/dist');
if (!existsSync(frontendDist)) {
  throw new Error('frontend/dist does not exist: run `npm run build --workspace frontend` first.');
}
cpSync(frontendDist, path.join(buildDir, 'static-server/site'), { recursive: true });

console.log(
  'Packaged artifacts into infra/build/{router,cost-collector,infra-review-collector,infra-collector,' +
    'action-execution,discord-alarm-notifier,alarm-baseline-manager,health-report,patch-scheduler,' +
    'ec2-rightsize-applier,downsize-scheduler,time-of-day-trigger,ai-ops-agent,scheduled-actions-mutate,' +
    'approval-mutate,alerting-topic-guardian,security-guardduty-triage,security-public-bucket-guardian,' +
    'governance-exemption-auditor,security-endpoint-drift-detector,idle-scheduler-tick,idle-scheduler-wake,' +
    'idle-scheduler-watchdog,idle-scheduler-mutate,rds-nightly-scheduler,static-server}/',
);
