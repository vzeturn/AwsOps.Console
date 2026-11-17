/**
 * Public surface of the `compliance` domain module (backend-core-foundation Task 21): the
 * Compliance tab handler/service (AWS Backup jobs, DLM policies, AWS Config compliance), the
 * `backup-collector.ts` raw-data collector used by `infra-review-collector` (Requirement 6.1),
 * and the pure backup-vault access-policy logic shared between reading (the collector) and
 * writing (the `BackupVault_ApplyProtectionPolicy` action service).
 *
 * Only re-exports symbols that have a REAL external importer today (same convention as
 * `modules/security/index.ts`/`modules/ec2-management/index.ts`). Every current external
 * importer in this codebase imports via a DIRECT relative file path rather than through this
 * barrel — that is the established pattern already in place for every other relocated module,
 * not something new here. This file exists to document the module's public surface and satisfy
 * the one-barrel-per-module requirement; it is not itself imported by any consumer yet.
 *
 * - `complianceHandler` (renamed from `handler`) — imported by `router.ts`.
 * - `getComplianceData` — imported by `infra-collector.ts` and `modules/export/export-csv.ts`.
 * - `collectBackupData` — imported by `infra-review-collector/assessment-report-builder.ts`.
 * - `policyHasDeletionProtection`/`buildProtectedVaultAccessPolicy` — imported by
 *   `modules/actions/backup-vault-protection-action-service.ts`; `policyHasDeletionProtection`
 *   alone is also imported by `modules/actions/preview-service.ts`.
 *
 * `BACKUP_VAULT_PROTECTION_STATEMENT_SID` is NOT re-exported here — it currently has no external
 * importer, it is only used within `backupVaultPolicy.ts` itself and asserted against in
 * `backupVaultPolicy.test.ts`.
 */
export { handler as complianceHandler } from './get-compliance.js';
export { getComplianceData } from './compliance-service.js';
export { collectBackupData } from './backup-collector.js';
export { policyHasDeletionProtection, buildProtectedVaultAccessPolicy } from './backupVaultPolicy.js';
