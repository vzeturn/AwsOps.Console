import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../config.js', () => ({
  config: { allowedOrigins: [], awsRegion: 'ap-southeast-1' },
  corsHeaders: () => ({}),
}));

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('@aws-sdk/client-ec2', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-ec2')>('@aws-sdk/client-ec2');
  return { ...actual, EC2Client: vi.fn(() => ({ send })) };
});

import { handler } from './get-ec2-instance-types.js';
import type { LambdaFunctionURLEvent } from 'aws-lambda';

function makeEvent(instanceId?: string): LambdaFunctionURLEvent {
  return {
    queryStringParameters: instanceId ? { instanceId } : {},
  } as unknown as LambdaFunctionURLEvent;
}

describe('GET /ec2-instance-types', () => {
  beforeEach(() => send.mockReset());

  it('rejects when instanceId is missing', async () => {
    await expect(handler(makeEvent())).rejects.toThrow(/instanceId/);
  });

  it('returns compatible types filtered by architecture', async () => {
    send
      // DescribeInstances -> current instance
      .mockResolvedValueOnce({
        Reservations: [{ Instances: [{ Architecture: 'x86_64', VirtualizationType: 'hvm', Placement: { AvailabilityZone: 'ap-southeast-1a' } }] }],
      })
      // DescribeInstanceTypeOfferings -> candidate types in the AZ
      .mockResolvedValueOnce({
        InstanceTypeOfferings: [{ InstanceType: 't3.large' }, { InstanceType: 't4g.large' }],
      })
      // DescribeInstanceTypes -> arch/virtualization detail for each candidate
      .mockResolvedValueOnce({
        InstanceTypes: [
          { InstanceType: 't3.large', ProcessorInfo: { SupportedArchitectures: ['x86_64'] }, SupportedVirtualizationTypes: ['hvm'] },
          { InstanceType: 't4g.large', ProcessorInfo: { SupportedArchitectures: ['arm64'] }, SupportedVirtualizationTypes: ['hvm'] },
        ],
      });

    const result = await handler(makeEvent('i-abc123'));
    const body = JSON.parse((result as any).body as string);
    expect(body.compatibleTypes).toEqual(['t3.large']);
    expect(body.compatibleTypes).not.toContain('t4g.large');
  });
});
