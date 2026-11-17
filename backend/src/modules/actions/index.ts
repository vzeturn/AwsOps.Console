/**
 * Public surface of the `actions` domain module (backend-core-foundation Task 25): the LARGEST
 * module relocated so far — the entire Resource_Action / maker-checker Approval subsystem. Covers
 * 8 router-facing handlers (`actions-audit.ts`, `actions-decide-approval.ts`,
 * `actions-execute-approval.ts`, `actions-execute.ts`, `actions-lifecycle.ts`,
 * `actions-preview.ts`, `actions-request-approval.ts`, `get-approvals.ts`), the 2 core
 * cross-cutting services (`action-audit-service.ts`, `approval-service.ts`), the
 * Confirmation_Dialog preview builder (`preview-service.ts`), the 2 dedicated mutate Lambda
 * entrypoints (`action-execution-handler.ts` for `action-execution-fn`,
 * `approval-mutate-handler.ts` for `approval-mutate-fn`), the `StateManager` HTTPS client
 * (`ec2-state-manager-client.ts`), and the ~18 individual per-actionType execution services
 * (`ebs-action-service.ts`, `s3-lifecycle-action-service.ts`, `ecs-scale-action-service.ts`,
 * `rds-storage-action-service.ts`, `ebs-modify-volume-type-action-service.ts`,
 * `cloudwatch-log-retention-action-service.ts`, `elastic-ip-release-action-service.ts`,
 * `ec2-rightsize-action-service.ts`, `backup-vault-protection-action-service.ts`,
 * `backup-restore-testing-action-service.ts`, `backup-retry-job-action-service.ts`,
 * `rds-resource-governance-action-service.ts`, `ec2-reboot-action-service.ts`,
 * `rds-lifecycle-action-service.ts`, `ec2-instance-type-change-service.ts`,
 * `ec2-tags-action-service.ts`, `ec2-modify-security-groups-service.ts`).
 *
 * `action-execution-handler.ts` (the `action-execution-fn` dispatch table) and `preview-service.ts`
 * (the Confirmation_Dialog preview builder) both have the widest fan-out of any file relocated so
 * far — they call into almost every OTHER Domain_Module: `assessment` (`getAssessmentData`),
 * `governance` (`scalePlanning.ts`/`ec2Rightsizing.ts`/`rdsResourceGovernance.ts`),
 * `compliance` (`backupVaultPolicy.ts`), and `security`/`ec2-management` (the Security Group and
 * SSM Run Command execution services, which stay in THEIR OWN modules — `action-execution-handler.ts`
 * only calls into them as a cross-module sibling reference, same relationship it already had before
 * this relocation).
 *
 * Only re-exports symbols that have a REAL external importer today (same convention as every
 * other relocated module) — verified via a full-codebase search, not assumed:
 *
 * - `handler` from each of the 8 router-facing handlers, each renamed to avoid collisions since
 *   `router.ts` imports all 8 in the same file: `actionsAuditHandler` (actions-audit.ts),
 *   `actionsDecideApprovalHandler` (actions-decide-approval.ts), `actionsExecuteApprovalHandler`
 *   (actions-execute-approval.ts), `actionsExecuteHandler` (actions-execute.ts),
 *   `actionsLifecycleHandler` (actions-lifecycle.ts), `actionsPreviewHandler`
 *   (actions-preview.ts), `actionsRequestApprovalHandler` (actions-request-approval.ts),
 *   `getApprovalsHandler` (get-approvals.ts) — all 8 imported by `router.ts`.
 *
 * Every other symbol in this module (`writeAuditRecord`/`listAuditRecordsForResource`
 * (action-audit-service.ts), `createApprovalRequest`/`getApproval`/`listApprovals`/
 * `decideApproval`/`markApprovalExecuted` (approval-service.ts), `buildActionPreview`/
 * `buildActionPreviewDirect` (preview-service.ts), `callEc2StateManager`
 * (ec2-state-manager-client.ts), and every `execute*` function in the ~18 action-service files)
 * has NO external importer outside this module today — each is only called by another file that
 * now lives INSIDE `modules/actions/` (mainly `action-execution-handler.ts`'s dispatch table and
 * the 8 handlers themselves), so none of them are re-exported here. In particular,
 * `modules/governance/ec2-rightsize-applier.ts` does NOT import `callEc2StateManager` — it
 * self-executes EC2_AutoRightsize via the plain EC2 API and its own local
 * `writeAuditRecordMinimal()`, not this module's `writeAuditRecord`/`callEc2StateManager`
 * (confirmed by reading that file — an earlier assumption to the contrary was incorrect).
 *
 * `action-execution-handler.ts`/`approval-mutate-handler.ts` (the 2 dedicated Lambda entrypoints)
 * are NOT re-exported here — `lambda-boot.test.ts` (the only thing that references them outside
 * this module) references them as bundling/table entries by FILE PATH
 * (`'./modules/actions/action-execution-handler.js'`/`'./modules/actions/approval-mutate-handler.js'`),
 * not by importing the function BY NAME through this barrel — the same established pattern already
 * used for every other standalone Lambda entrypoint in this codebase (e.g. `cost-collector.ts`,
 * `infra-review-collector.ts`).
 */
export { handler as actionsAuditHandler } from './actions-audit.js';
export { handler as actionsDecideApprovalHandler } from './actions-decide-approval.js';
export { handler as actionsExecuteApprovalHandler } from './actions-execute-approval.js';
export { handler as actionsExecuteHandler } from './actions-execute.js';
export { handler as actionsLifecycleHandler } from './actions-lifecycle.js';
export { handler as actionsPreviewHandler } from './actions-preview.js';
export { handler as actionsRequestApprovalHandler } from './actions-request-approval.js';
export { handler as getApprovalsHandler } from './get-approvals.js';
