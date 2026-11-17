import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from 'aws-lambda';
import type { ComplianceData, ExportableTab, InfraData } from '@ops-dashboard/shared';
import { corsHeaders } from '../../config.js';
import { notFound } from '../../shared-kernel/errors.js';
import { getInfraData } from '../infra/index.js';
import { getComplianceData } from '../compliance/index.js';
import { getCostData } from '../cost/index.js';
import { INFRA_CACHE_S3_KEY, COMPLIANCE_CACHE_S3_KEY } from '../ec2-management/index.js';
import { readCachedJson } from '../../shared-kernel/s3Cache.js';

function toCsvRow(fields: (string | number | boolean)[]): string {
  return fields
    .map((f) => {
      const s = String(f);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    })
    .join(',');
}

/**
 * Reads from the EXACT SAME SOURCE that `GET /infra` / `GET /compliance` display (the S3 cache
 * written by `infra-collector.ts`, falling back to calling AWS directly just like those
 * handlers) — if export called AWS live while the table reads from cache, the downloaded CSV
 * could be a DIFFERENT snapshot than what the user is looking at, with nothing to reconcile them.
 * That's why every CSV also writes out the `as_of` of the exact snapshot it used.
 */
async function buildInfraCsv(): Promise<string> {
  const data = (await readCachedJson<InfraData>(INFRA_CACHE_S3_KEY)) ?? (await getInfraData());
  const lines = [toCsvRow(['type', 'id', 'name', 'state', 'threshold_level', 'threshold_reason'])];
  for (const e of data.ec2) {
    lines.push(toCsvRow(['ec2', e.instanceId, e.name, e.state, e.threshold.level, e.threshold.reason]));
  }
  for (const r of data.rds) {
    lines.push(
      toCsvRow(['rds', r.dbInstanceIdentifier, r.engine, r.status, r.threshold.level, r.threshold.reason]),
    );
  }
  for (const a of data.alb) {
    lines.push(toCsvRow(['alb', a.name, '', a.state, a.threshold.level, a.threshold.reason]));
  }
  lines.push('');
  lines.push(toCsvRow(['as_of', data.asOf]));
  return lines.join('\n');
}

async function buildComplianceCsv(): Promise<string> {
  const data = (await readCachedJson<ComplianceData>(COMPLIANCE_CACHE_S3_KEY)) ?? (await getComplianceData());
  const lines = [toCsvRow(['type', 'id', 'state', 'threshold_level', 'threshold_reason'])];
  for (const j of data.recentBackupJobs) {
    lines.push(toCsvRow(['backup_job', j.resourceName, j.state, j.threshold.level, j.threshold.reason]));
  }
  for (const p of data.dlmPolicies) {
    lines.push(toCsvRow(['dlm_policy', p.description, p.state, '', '']));
  }
  for (const c of data.configRules) {
    lines.push(toCsvRow(['config_rule', c.ruleName, c.complianceType, c.threshold.level, c.threshold.reason]));
  }
  lines.push('');
  lines.push(toCsvRow(['as_of', data.asOf]));
  return lines.join('\n');
}

async function buildCostCsv(): Promise<string> {
  const data = await getCostData();
  const lines = [toCsvRow(['service', 'amount_usd'])];
  for (const s of data.byService) {
    lines.push(toCsvRow([s.service, s.amountUsd]));
  }
  lines.push('');
  lines.push(toCsvRow(['month_to_date_usd', data.monthToDateUsd]));
  lines.push(toCsvRow(['forecast_month_usd', data.forecastMonthUsd]));
  lines.push(toCsvRow(['previous_month_usd', data.previousMonthUsd]));
  return lines.join('\n');
}

export async function handler(
  event: LambdaFunctionURLEvent,
  tab: ExportableTab,
): Promise<LambdaFunctionURLResult> {
  const origin = event.headers?.origin ?? event.headers?.Origin;
  const csv = await (tab === 'infra' ? buildInfraCsv() : tab === 'compliance' ? buildComplianceCsv() : tab === 'cost' ? buildCostCsv() : Promise.reject(notFound(`Unknown export tab: ${tab}`)));

  return {
    statusCode: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="ops-dashboard-${tab}-${new Date().toISOString().slice(0, 10)}.csv"`,
      ...corsHeaders(origin),
    },
    body: csv,
  };
}
