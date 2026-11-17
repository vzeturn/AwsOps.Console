import type {
  AlarmSummary,
  AssessmentReport,
  ComplianceData,
  FindingDraft,
  FindingSource,
  Kpi,
  MonitoringData,
  SecurityGroupSummary,
  Severity,
  SourceId,
  TopologyData,
} from '@ops-dashboard/shared';
import type { Placement, TopologyIndex } from '../attribution.js';
import { findingId, type ArnContext } from '../finding-id.js';
import { redactEvidence } from '../redact.js';
import type { BucketPublicStatus } from '../../security/security-public-bucket-status.js';
import type { EndpointDriftReport } from '../../security/endpoint-drift-report.js';

export interface GuardDutyFindingSummary {
  id: string;
  arn: string;
  type: string;
  title: string;
  severity: number;
  instanceId?: string;
  vpcId?: string;
  resourceType?: string;
  updatedAt?: string;
  count?: number;
}

export interface RdsExposure {
  dbInstanceIdentifier: string;
  dbInstanceArn: string;
  publiclyAccessible: boolean;
  vpcId?: string;
  /** Subnets of the DB subnet group. */
  subnetIds: string[];
}

/** Everything the checks may read. Optional parts are present only when their source was `ok`. */
export interface FindingsSnapshot {
  now: string;
  region: string;
  accountId: string;
  topology: TopologyData;
  topologyIndex: TopologyIndex;
  observedAt: Partial<Record<SourceId, string>>;
  alarms?: AlarmSummary[];
  monitoring?: MonitoringData;
  securityGroups?: SecurityGroupSummary[];
  guardDuty?: GuardDutyFindingSummary[];
  compliance?: ComplianceData;
  assessment?: AssessmentReport;
  publicBuckets?: BucketPublicStatus[];
  endpointDrift?: EndpointDriftReport;
  /** Resource ids (VPC/subnet/ENI) that have at least one ACTIVE flow log. */
  flowLogResourceIds?: string[];
  rdsInstances?: RdsExposure[];
}

export interface CheckMeta {
  /** `<kpi-prefix>.<kebab-name>`, e.g. 'net.vpc-flow-logs-disabled'. */
  checkId: string;
  source: FindingSource;
  kpi: Kpi;
  /** ISO/IEC 27001:2022 Annex A ids, e.g. 'A.8.20'. */
  isoControls: string[];
  /** Sources that must ALL be `ok` for this check to run and for its findings to be resolvable. */
  requires: SourceId[];
  title: string;
  impact: string;
  remediation: string[];
}

/** Pure function over a pre-fetched snapshot - no AWS calls (spec §2). */
export interface CheckDefinition extends CheckMeta {
  run: (snapshot: FindingsSnapshot) => FindingDraft[];
}

export interface DraftInput {
  resourceType: string;
  resourceId: string;
  resourceName?: string;
  resourceArn: string;
  placement: Placement;
  severity: Severity;
  description: string;
  title?: string;
  remediationSteps?: string[];
  observedAt: string;
  data: Record<string, unknown>;
}

export function arnContext(snapshot: Pick<FindingsSnapshot, 'region' | 'accountId'>): ArnContext {
  return { region: snapshot.region, accountId: snapshot.accountId };
}

/** The ONLY way a check builds a draft: kpi/source/iso come from the check's meta (cannot drift),
 * id is the stable hash, evidence is always redacted. */
export function makeDraft(meta: CheckMeta, input: DraftInput): FindingDraft {
  return {
    id: findingId(meta.source, input.resourceArn, meta.checkId),
    checkId: meta.checkId,
    source: meta.source,
    kpi: meta.kpi,
    severity: input.severity,
    vpcId: input.placement.vpcId,
    subnetId: input.placement.subnetId,
    az: input.placement.az,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    resourceName: input.resourceName,
    resourceArn: input.resourceArn,
    title: input.title ?? meta.title,
    description: input.description,
    impact: meta.impact,
    evidence: { observedAt: input.observedAt, data: redactEvidence(input.data) },
    remediation: { steps: input.remediationSteps ?? [...meta.remediation] },
    isoControls: [...meta.isoControls],
  };
}
