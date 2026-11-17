import { createHash } from 'node:crypto';
import type { FindingSource } from '@ops-dashboard/shared';

/** Spec §3.1: stable across scans, so the SAME resource/check always maps to the SAME item. */
export function findingId(source: FindingSource, resourceArn: string, checkId: string): string {
  return createHash('sha1').update(`${source}#${resourceArn}#${checkId}`).digest('hex');
}

export type ArnKind =
  | 'ec2-instance'
  | 'rds-instance'
  | 'security-group'
  | 'vpc'
  | 'subnet'
  | 'nat-gateway'
  | 's3-bucket'
  | 'ebs-volume'
  | 'elastic-ip'
  | 'log-group'
  | 'cloudwatch-alarm'
  | 'backup-vault'
  | 'load-balancer'
  | 'guardduty-finding'
  | 'backup-resource'
  | 'resource';

export interface ArnContext {
  region: string;
  accountId: string;
}

/**
 * Deterministic resource ARN. `resourceArn` feeds `findingId`, so the SAME resource must always
 * yield the SAME string: never read an ARN from a source that may or may not provide one.
 * Kinds without a stable ARN get a URN in our own namespace (still deterministic).
 */
export function arnFor(kind: ArnKind, id: string, ctx: ArnContext): string {
  if (id.startsWith('arn:')) return id;
  const { region, accountId } = ctx;
  switch (kind) {
    case 'ec2-instance':
      return `arn:aws:ec2:${region}:${accountId}:instance/${id}`;
    case 'security-group':
      return `arn:aws:ec2:${region}:${accountId}:security-group/${id}`;
    case 'vpc':
      return `arn:aws:ec2:${region}:${accountId}:vpc/${id}`;
    case 'subnet':
      return `arn:aws:ec2:${region}:${accountId}:subnet/${id}`;
    case 'nat-gateway':
      return `arn:aws:ec2:${region}:${accountId}:natgateway/${id}`;
    case 'ebs-volume':
      return `arn:aws:ec2:${region}:${accountId}:volume/${id}`;
    case 'elastic-ip':
      return `arn:aws:ec2:${region}:${accountId}:elastic-ip/${id}`;
    case 'rds-instance':
      return `arn:aws:rds:${region}:${accountId}:db:${id}`;
    case 's3-bucket':
      return `arn:aws:s3:::${id}`;
    case 'log-group':
      return `arn:aws:logs:${region}:${accountId}:log-group:${id}`;
    case 'cloudwatch-alarm':
      return `arn:aws:cloudwatch:${region}:${accountId}:alarm:${id}`;
    case 'backup-vault':
      return `arn:aws:backup:${region}:${accountId}:backup-vault:${id}`;
    default:
      return `urn:ops-dashboard:${region}:${accountId}:${kind}/${id}`;
  }
}

const ARN_KIND_BY_RESOURCE_TYPE: Readonly<Record<string, ArnKind>> = {
  'ec2-instance': 'ec2-instance',
  ec2: 'ec2-instance',
  'rds-instance': 'rds-instance',
  rds: 'rds-instance',
  'ebs-volume': 'ebs-volume',
  ebs: 'ebs-volume',
  'elastic-ip': 'elastic-ip',
  'nat-gateway': 'nat-gateway',
  natgw: 'nat-gateway',
  's3-bucket': 's3-bucket',
  s3: 's3-bucket',
  'cloudwatch-log-group': 'log-group',
  alb: 'load-balancer',
  nlb: 'load-balancer',
  'backup-vault': 'backup-vault',
};

export function arnKindForResourceType(resourceType: string): ArnKind {
  return ARN_KIND_BY_RESOURCE_TYPE[resourceType] ?? 'resource';
}
