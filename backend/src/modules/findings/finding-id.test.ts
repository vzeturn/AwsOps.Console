import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { FINDING_SOURCES } from '@ops-dashboard/shared';
import { findingId, arnFor, arnKindForResourceType } from './finding-id.js';

const CTX = { region: 'ap-southeast-1', accountId: '123456789012' };

describe('findingId', () => {
  it('is sha1(source#resourceArn#checkId) - golden value never changes across releases', () => {
    expect(findingId('network', 'arn:aws:ec2:ap-southeast-1:123456789012:vpc/vpc-0abc1234', 'net.vpc-flow-logs-disabled')).toBe(
      '7d4746385f7f0dd57bd1991a5bfadd441f99666a',
    );
  });

  it('is deterministic 40-hex and sensitive to every component', () => {
    fc.assert(
      fc.property(fc.constantFrom(...FINDING_SOURCES), fc.string({ minLength: 1 }), fc.string({ minLength: 1 }), (source, arn, checkId) => {
        const id = findingId(source, arn, checkId);
        return /^[0-9a-f]{40}$/.test(id) && id === findingId(source, arn, checkId) && id !== findingId(source, arn, `${checkId}x`);
      }),
    );
  });
});

describe('arnFor', () => {
  it('builds real ARNs for ARN-bearing kinds', () => {
    expect(arnFor('ec2-instance', 'i-0abc', CTX)).toBe('arn:aws:ec2:ap-southeast-1:123456789012:instance/i-0abc');
    expect(arnFor('rds-instance', 'prod-db', CTX)).toBe('arn:aws:rds:ap-southeast-1:123456789012:db:prod-db');
    expect(arnFor('security-group', 'sg-1', CTX)).toBe('arn:aws:ec2:ap-southeast-1:123456789012:security-group/sg-1');
    expect(arnFor('s3-bucket', 'my-bucket', CTX)).toBe('arn:aws:s3:::my-bucket');
    expect(arnFor('nat-gateway', 'nat-1', CTX)).toBe('arn:aws:ec2:ap-southeast-1:123456789012:natgateway/nat-1');
    expect(arnFor('log-group', '/aws/lambda/x', CTX)).toBe('arn:aws:logs:ap-southeast-1:123456789012:log-group:/aws/lambda/x');
  });

  it('passes an existing ARN through unchanged (ALB ids are already ARNs)', () => {
    const alb = 'arn:aws:elasticloadbalancing:ap-southeast-1:123456789012:loadbalancer/app/web/abc';
    expect(arnFor('load-balancer', alb, CTX)).toBe(alb);
  });

  it('uses a deterministic URN for kinds without an ARN', () => {
    expect(arnFor('backup-resource', 'web-1', CTX)).toBe('urn:ops-dashboard:ap-southeast-1:123456789012:backup-resource/web-1');
  });

  it('maps recommendation/monitoring resource types to ARN kinds', () => {
    expect(arnKindForResourceType('ec2-instance')).toBe('ec2-instance');
    expect(arnKindForResourceType('ec2')).toBe('ec2-instance');
    expect(arnKindForResourceType('cloudwatch-log-group')).toBe('log-group');
    expect(arnKindForResourceType('alb')).toBe('load-balancer');
    expect(arnKindForResourceType('service')).toBe('resource');
  });
});
