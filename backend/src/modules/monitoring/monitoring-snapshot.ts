import type { MonitoringData } from '@ops-dashboard/shared';
import { getMonitoringData } from './monitoring-service.js';
import { getAlerts } from '../alerting/index.js';

/**
 * Builds one complete `MonitoringData` snapshot (realtime metrics + CloudWatch alarm summary).
 *
 * Extracted out of `get-monitoring.ts` so the WRITER (`infra-collector.ts`, which caches
 * the snapshot into S3 on a schedule) and the READER's fallback path (`get-monitoring.ts`,
 * used only when the cache can't be read) compose the response through the EXACT same code — the
 * same reason `export-csv.ts` shares the cache read path with `get-infra.ts` (see the comment
 * there): two separate compositions of the same payload will eventually drift apart.
 *
 * IMPORTANT — this module must stay free of any transitive import of `config.ts`. It is imported by
 * `infra-collector.ts`, whose Lambda is granted only `ASSESSMENT_BUCKET_NAME`/`AWS_ACCOUNT_ID` (see
 * `infra/ops-dashboard.yaml`), while `config.ts` throws at module load when the router-only
 * variables (`ENTRA_TENANT_ID`, ...) are absent. `infra-collector.boot.test.ts` guards this.
 */
export async function buildMonitoringSnapshot(): Promise<MonitoringData> {
  const [monitoring, alerts] = await Promise.all([getMonitoringData(), getAlerts()]);
  return { ...monitoring, alerts };
}
