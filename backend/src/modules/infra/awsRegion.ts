/**
 * The AWS region is read DIRECTLY from `process.env.AWS_REGION` (the Lambda runtime always sets
 * this variable automatically), NOT through `config.js`.
 *
 * WHY (not redundant duplication of `config.awsRegion`): `config.ts` is a fail-loud singleton —
 * `loadConfig()` runs as soon as the module is imported and throws if ANY required router variable
 * is MISSING (ENTRA_TENANT_ID, ACTION_EXECUTION_FUNCTION_NAME, ...). Modules shared between the
 * router and the scheduled Lambda collector (`infra-service.ts`/`compliance-service.ts`, imported
 * by `infra-collector.ts`) therefore must NOT import `config.js`: CloudFormation only grants the
 * collector `ASSESSMENT_BUCKET_NAME` + `AWS_ACCOUNT_ID`, so merely importing it would be enough to
 * kill the Lambda right in the module initializer on EVERY run (see `infra-collector.boot.test.ts`).
 *
 * This is exactly the convention `cost-collector.ts` already uses (constructing its S3 client with
 * `region: process.env.AWS_REGION` directly) — this file just names it so shared modules can
 * reference it in one place.
 */
export const AWS_REGION = process.env.AWS_REGION ?? '';
