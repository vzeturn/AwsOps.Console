// Lean_Lambda_Exception (Requirement 6.4a): direct imports, not `../alerting/index.js` — see the
// exception comment in `agent/ai-ops-agent.ts` (same reason):
// `security-public-bucket-guardian-fn` is a lean standalone Lambda.
import { postAlertEmbeds } from '../alerting/alertHook.js';
import { buildOpsNotificationEmbed } from '../alerting/opsNotification.js';
import { logger } from '../../shared-kernel/logger.js';
import { collectBucketPublicStatuses, findUnexplainedPublicBuckets } from './security-public-bucket-status.js';
export { findUnexplainedPublicBuckets } from './security-public-bucket-status.js';
export type { BucketPublicStatus } from './security-public-bucket-status.js';

/**
 * `security-public-bucket-guardian.ts` — a NEW Lambda, scheduled (EventBridge Scheduler
 * `rate(1 day)`, see `infra/ops-dashboard.yaml`).
 *
 * THE INCIDENT THIS PREVENTS FROM RECURRING SILENTLY
 *
 * A manual audit on 2026-09-17 found 2 GuardDuty findings (`Policy:S3/BucketAnonymousAccessGranted`)
 * for `acmeew-prod-assets` and `acme.s3.services.bot` — both confirmed genuinely public
 * (`s3api get-bucket-policy-status` -> `IsPublic: true`, a `Principal: "*"` `PublicReadGetObject`
 * statement). Both turned out to be INTENTIONAL (serving static assets publicly for
 * EWarranty/services), evidenced by both already carrying `DataClass=public` — but that
 * confirmation required a human reading GuardDuty findings, checking bucket policy status by hand,
 * and cross-referencing tags. This Lambda automates exactly that cross-reference so the NEXT bucket
 * that becomes public (by policy, ACL, or a Block Public Access setting being disabled) is flagged
 * within 24h UNLESS it already carries the same `DataClass=public` tag stating that's intentional.
 *
 * WHY THE `DataClass=public` TAG, NOT A HARDCODED BUCKET-NAME ALLOWLIST
 *
 * A hardcoded list of "buckets that are OK to be public" would need to be remembered and updated
 * by hand every time a new intentionally-public bucket is created — exactly the kind of drift this
 * whole feature exists to catch. Reusing the tag convention already established for EC2/ALB
 * exemptions (`ops-dashboard:monitoring-exempt`, `SecurityException`) keeps the same principle:
 * the justification travels WITH the resource, visible to anyone running `s3api get-bucket-tagging`,
 * not hidden inside this Lambda's source code.
 *
 * WHAT COUNTS AS "PUBLIC" HERE: `GetBucketPolicyStatus.PolicyStatus.IsPublic` — the SAME field
 * S3's own console "Public" badge is derived from, and the field this project's own manual
 * investigation used to confirm both buckets above (`aws s3api get-bucket-policy-status`). Does
 * NOT separately check the 4 individual `PublicAccessBlockConfiguration` booleans or bucket ACLs —
 * `IsPublic` already accounts for the net effect of policy + ACL + account/bucket-level Block
 * Public Access, which is the actual question ("can the internet read/write this bucket"), not
 * any one contributing setting in isolation.
 */

export async function handler(): Promise<{ ok: true; checked: number; unexplainedPublic: number }> {
  const { statuses, undetermined } = await collectBucketPublicStatuses();
  const flagged = findUnexplainedPublicBuckets(statuses);
  const bucketCount = statuses.length + undetermined.length;

  logger.info(`security-public-bucket-guardian: checked=${statuses.length}/${bucketCount} unexplainedPublic=${flagged.length}`);

  if (flagged.length > 0) {
    // S3's bucket-policy console page (Permissions tab) is where an operator confirms/fixes the
    // exact setting this Lambda checked (IsPublic) — a generic "open S3" link would leave the
    // reader to re-navigate there by hand for every flagged bucket. Capped at 5, same reasoning
    // as every other Links list in this project.
    const links = flagged
      .slice(0, 5)
      .map((b) => ({ label: b.bucketName, url: `https://s3.console.aws.amazon.com/s3/buckets/${b.bucketName}?tab=permissions` }));

    const embed = buildOpsNotificationEmbed({
      what: `${flagged.length} S3 bucket(s) are publicly accessible without a DataClass=public tag`,
      severity: 'critical',
      who: 'system:security-public-bucket-guardian',
      impact: `${flagged.length} bucket(s) are readable/writable by anyone on the internet with NO stated justification — if this is not intentional, this is an active data-exposure risk right now, not a future one.`,
      why: 'A bucket policy/ACL grants public access, but nothing on the bucket states whether that is intentional — this could be a genuine misconfiguration or simply a missing tag on an already-sanctioned bucket.',
      how: 'If this is intentional (e.g. serving static assets), tag the bucket `DataClass=public`. If not, restrict the bucket policy/enable Block Public Access.',
      links,
      extra: [
        {
          name: 'Buckets',
          value: flagged.map((b) => `\`${b.bucketName}\` (DataClass=${b.dataClassTagValue ?? '(none)'})`).join('\n').slice(0, 1024),
          inline: false,
        },
      ],
    });
    await postAlertEmbeds([embed]);
  }

  return { ok: true, checked: statuses.length, unexplainedPublic: flagged.length };
}
