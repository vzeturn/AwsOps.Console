/** S3 object key for the cost cache in AssessmentReportBucket — shared between cost-collector.ts
 * (writer) and cost-service.ts (reader), avoiding a duplicated literal in both places. */
export const COST_CACHE_S3_KEY = 'cost-cache.json';
