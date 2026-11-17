import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EC2Client } from '@aws-sdk/client-ec2';

vi.mock('@aws-sdk/client-ec2', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-ec2')>('@aws-sdk/client-ec2');
  return {
    ...actual,
    DescribeInstancesCommand: vi.fn().mockImplementation((input: unknown) => ({ __cmd: 'DescribeInstances', input })),
    DescribeNatGatewaysCommand: vi.fn().mockImplementation((input: unknown) => ({ __cmd: 'DescribeNatGateways', input })),
  };
});

const { fetchEc2NameTag, fetchNatGatewayNameTag, resolveEc2DisplayName } = await import('./ec2NameResolver.js');

function fakeClient(send: (cmd: unknown) => Promise<unknown>): EC2Client {
  return { send } as unknown as EC2Client;
}

describe('fetchEc2NameTag', () => {
  it('returns the Name tag when present', async () => {
    const client = fakeClient(async () => ({
      Reservations: [{ Instances: [{ Tags: [{ Key: 'Name', Value: 'abc-prod-ec2-gateway' }] }] }],
    }));
    await expect(fetchEc2NameTag(client, 'i-abc')).resolves.toBe('abc-prod-ec2-gateway');
  });

  it('returns undefined when the instance has no Name tag', async () => {
    const client = fakeClient(async () => ({ Reservations: [{ Instances: [{ Tags: [] }] }] }));
    await expect(fetchEc2NameTag(client, 'i-abc')).resolves.toBeUndefined();
  });

  it('returns undefined (does not throw) when the instance no longer exists', async () => {
    const client = fakeClient(async () => ({ Reservations: [] }));
    await expect(fetchEc2NameTag(client, 'i-abc')).resolves.toBeUndefined();
  });

  it('returns undefined (does not throw) on an API error', async () => {
    const client = fakeClient(async () => {
      throw new Error('AccessDenied');
    });
    await expect(fetchEc2NameTag(client, 'i-abc')).resolves.toBeUndefined();
  });
});

describe('fetchNatGatewayNameTag', () => {
  it('returns the Name tag when present', async () => {
    const client = fakeClient(async () => ({ NatGateways: [{ Tags: [{ Key: 'Name', Value: 'abc-prod-nat' }] }] }));
    await expect(fetchNatGatewayNameTag(client, 'nat-abc')).resolves.toBe('abc-prod-nat');
  });

  it('returns undefined on an API error', async () => {
    const client = fakeClient(async () => {
      throw new Error('boom');
    });
    await expect(fetchNatGatewayNameTag(client, 'nat-abc')).resolves.toBeUndefined();
  });
});

describe('resolveEc2DisplayName', () => {
  let client: EC2Client;

  beforeEach(() => {
    client = fakeClient(async () => ({
      Reservations: [{ Instances: [{ Tags: [{ Key: 'Name', Value: 'abc-prod-ec2-gateway' }] }] }],
    }));
  });

  it('returns the Name tag when available', async () => {
    await expect(resolveEc2DisplayName(client, 'i-abc')).resolves.toBe('abc-prod-ec2-gateway');
  });

  it('falls back to the raw instanceId when no Name tag is available', async () => {
    client = fakeClient(async () => ({ Reservations: [] }));
    await expect(resolveEc2DisplayName(client, 'i-abc')).resolves.toBe('i-abc');
  });
});
