import { ACCOUNT_SCOPE } from '@ops-dashboard/shared';
import { attributeResource } from '../../attribution.js';
import { arnFor } from '../../finding-id.js';
import { findUnexplainedPublicBuckets } from '../../../security/security-public-bucket-status.js';
import { arnContext, makeDraft, type CheckDefinition } from '../types.js';

/** Adapter over security-public-bucket-status (the guardian's logic). */
export const PUBLIC_BUCKET_UNEXPLAINED: CheckDefinition = {
  checkId: 'sec.public-bucket-unexplained',
  source: 'network',
  kpi: 'security',
  isoControls: ['A.8.12'],
  requires: ['topology', 'public-buckets'],
  title: 'S3 bucket is public without a DataClass=public tag',
  impact: 'Anyone on the internet can read (or write) this bucket and nothing states that this is intentional.',
  remediation: ['If intentional (static assets), tag the bucket DataClass=public.', 'Otherwise restrict the bucket policy/ACL and enable Block Public Access.'],
  run: (snapshot) =>
    findUnexplainedPublicBuckets(snapshot.publicBuckets ?? []).map((bucket) =>
      makeDraft(PUBLIC_BUCKET_UNEXPLAINED, {
        resourceType: 's3-bucket',
        resourceId: bucket.bucketName,
        resourceName: bucket.bucketName,
        resourceArn: arnFor('s3-bucket', bucket.bucketName, arnContext(snapshot)),
        placement: { vpcId: ACCOUNT_SCOPE },
        severity: 'critical',
        description: `${bucket.bucketName} is public (DataClass=${bucket.dataClassTagValue ?? 'none'})`,
        observedAt: snapshot.observedAt['public-buckets'] ?? snapshot.now,
        data: { bucketName: bucket.bucketName, isPublic: bucket.isPublic, dataClassTagValue: bucket.dataClassTagValue },
      }),
    ),
};

/** Adapter over endpoint-drift.json (written daily by security-endpoint-drift-detector). */
export const ENDPOINT_REMOTE_ACCESS_TOOL: CheckDefinition = {
  checkId: 'sec.endpoint-remote-access-tool',
  source: 'network',
  kpi: 'security',
  isoControls: ['A.8.1', 'A.8.20'],
  requires: ['topology', 'endpoint-drift'],
  title: 'Unsanctioned VPN/tunnel process on instance',
  impact: 'A remote-access path outside IAM, Security Groups and CloudTrail - invisible to every other control.',
  remediation: ['Confirm with the instance owner whether the tool is sanctioned.', 'Tag the instance SecurityException if sanctioned, otherwise remove the process.'],
  run: (snapshot) =>
    (snapshot.endpointDrift?.findings ?? [])
      .filter((f) => !f.hasSecurityExceptionTag)
      .map((f) =>
        makeDraft(ENDPOINT_REMOTE_ACCESS_TOOL, {
          resourceType: 'ec2-instance',
          resourceId: f.instanceId,
          resourceArn: arnFor('ec2-instance', f.instanceId, arnContext(snapshot)),
          placement: attributeResource(snapshot.topologyIndex, f.instanceId),
          severity: 'high',
          description: `Detected: ${f.detectedProcesses.join(', ')}`,
          observedAt: snapshot.observedAt['endpoint-drift'] ?? snapshot.now,
          data: { instanceId: f.instanceId, detectedProcesses: f.detectedProcesses },
        }),
      ),
};
