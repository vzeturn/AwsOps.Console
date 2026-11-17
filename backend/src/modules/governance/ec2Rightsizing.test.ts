import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EC2Client } from '@aws-sdk/client-ec2';
import {
  areArchitecturesCompatible,
  computeEc2RightsizeTarget,
  computeEc2RightsizeTargetInDirection,
  fetchFamilySizes,
  fetchInstanceTypeArchitectures,
  isEbsOnlyReason,
  parseInstanceType,
  pickLargerFamilySize,
  pickSmallerFamilySize,
  type FamilySizeInfo,
} from './ec2Rightsizing.js';

/** Fake EC2Client — only implements `send()`, returns a `DescribeInstanceTypes` result per the mock. */
function fakeEc2Client(sendImpl: (command: unknown) => Promise<unknown>): EC2Client {
  return { send: vi.fn(sendImpl) } as unknown as EC2Client;
}

/** Builds a minimal `InstanceTypeInfo`-like object with just the fields `fetchFamilySizes` reads. */
function instanceTypeInfo(instanceType: string, vcpus: number, memoryMiB: number, architectures: string[]) {
  return {
    InstanceType: instanceType,
    VCpuInfo: { DefaultVCpus: vcpus },
    MemoryInfo: { SizeInMiB: memoryMiB },
    ProcessorInfo: { SupportedArchitectures: architectures },
  };
}

describe('parseInstanceType', () => {
  it('parses family/size correctly for a valid format', () => {
    expect(parseInstanceType('t3.large')).toEqual({ family: 't3', size: 'large' });
    expect(parseInstanceType('r6i.24xlarge')).toEqual({ family: 'r6i', size: '24xlarge' });
  });

  it('returns undefined for an invalid format', () => {
    expect(parseInstanceType('t3large')).toBeUndefined();
    expect(parseInstanceType('t3.')).toBeUndefined();
    expect(parseInstanceType('')).toBeUndefined();
    expect(parseInstanceType('.large')).toBeUndefined();
  });
});

describe('pickSmallerFamilySize', () => {
  const r6iFamily: FamilySizeInfo[] = [
    { instanceType: 'r6i.large', size: 'large', vcpus: 2, memoryMiB: 16384, architectures: ['x86_64'] },
    { instanceType: 'r6i.xlarge', size: 'xlarge', vcpus: 4, memoryMiB: 32768, architectures: ['x86_64'] },
    { instanceType: 'r6i.16xlarge', size: '16xlarge', vcpus: 64, memoryMiB: 524288, architectures: ['x86_64'] },
    { instanceType: 'r6i.24xlarge', size: '24xlarge', vcpus: 96, memoryMiB: 786432, architectures: ['x86_64'] },
    { instanceType: 'r6i.32xlarge', size: '32xlarge', vcpus: 128, memoryMiB: 1048576, architectures: ['x86_64'] },
  ];

  it('picks the REAL next-smaller size by vCPU (not guessed from the name) — r6i.24xlarge -> r6i.16xlarge', () => {
    // This is exactly the case that broke the version using a global fixed size table: "24xlarge"
    // sat right before "32xlarge" in that table, so it was wrongly guessed as '18xlarge' (which
    // doesn't exist in the r6i family). Using the family's REAL size list, the correct result is
    // '16xlarge' (the closest real size).
    expect(pickSmallerFamilySize('r6i.24xlarge', r6iFamily)?.instanceType).toBe('r6i.16xlarge');
  });

  it('returns undefined when instanceType is already the smallest size in the family', () => {
    expect(pickSmallerFamilySize('r6i.large', r6iFamily)).toBeUndefined();
  });

  it('returns undefined when instanceType is not in the family list (cannot be determined)', () => {
    expect(pickSmallerFamilySize('r6i.metal', r6iFamily)).toBeUndefined();
  });

  it('a family using 9xlarge/18xlarge (like c5) picks the correct real size, not mixed with 8/16/24 (like r6i)', () => {
    const c5Family: FamilySizeInfo[] = [
      { instanceType: 'c5.xlarge', size: 'xlarge', vcpus: 4, memoryMiB: 8192, architectures: ['x86_64'] },
      { instanceType: 'c5.9xlarge', size: '9xlarge', vcpus: 36, memoryMiB: 73728, architectures: ['x86_64'] },
      { instanceType: 'c5.18xlarge', size: '18xlarge', vcpus: 72, memoryMiB: 147456, architectures: ['x86_64'] },
    ];
    expect(pickSmallerFamilySize('c5.18xlarge', c5Family)?.instanceType).toBe('c5.9xlarge');
  });
});

describe('pickLargerFamilySize', () => {
  const r6iFamily: FamilySizeInfo[] = [
    { instanceType: 'r6i.large', size: 'large', vcpus: 2, memoryMiB: 16384, architectures: ['x86_64'] },
    { instanceType: 'r6i.xlarge', size: 'xlarge', vcpus: 4, memoryMiB: 32768, architectures: ['x86_64'] },
    { instanceType: 'r6i.16xlarge', size: '16xlarge', vcpus: 64, memoryMiB: 524288, architectures: ['x86_64'] },
    { instanceType: 'r6i.24xlarge', size: '24xlarge', vcpus: 96, memoryMiB: 786432, architectures: ['x86_64'] },
    { instanceType: 'r6i.32xlarge', size: '32xlarge', vcpus: 128, memoryMiB: 1048576, architectures: ['x86_64'] },
  ];

  it('picks the REAL next-larger size by vCPU — r6i.16xlarge -> r6i.24xlarge (not guessed from the name)', () => {
    expect(pickLargerFamilySize('r6i.16xlarge', r6iFamily)?.instanceType).toBe('r6i.24xlarge');
  });

  it('returns undefined when instanceType is already the largest size in the family', () => {
    expect(pickLargerFamilySize('r6i.32xlarge', r6iFamily)).toBeUndefined();
  });

  it('returns undefined when instanceType is not in the family list', () => {
    expect(pickLargerFamilySize('r6i.metal', r6iFamily)).toBeUndefined();
  });

  it('a family using 9xlarge/18xlarge (like c5) picks the correct real next-larger size', () => {
    const c5Family: FamilySizeInfo[] = [
      { instanceType: 'c5.xlarge', size: 'xlarge', vcpus: 4, memoryMiB: 8192, architectures: ['x86_64'] },
      { instanceType: 'c5.9xlarge', size: '9xlarge', vcpus: 36, memoryMiB: 73728, architectures: ['x86_64'] },
      { instanceType: 'c5.18xlarge', size: '18xlarge', vcpus: 72, memoryMiB: 147456, architectures: ['x86_64'] },
    ];
    expect(pickLargerFamilySize('c5.xlarge', c5Family)?.instanceType).toBe('c5.9xlarge');
  });
});

describe('isEbsOnlyReason', () => {
  it('true when ALL reasonCodes are EBS codes', () => {
    expect(isEbsOnlyReason(['EBSThroughputOverprovisioned'])).toBe(true);
    expect(isEbsOnlyReason(['EBSIOPSOverprovisioned', 'EBSThroughputUnderprovisioned'])).toBe(true);
  });

  it('false when AT LEAST one code is not EBS', () => {
    expect(isEbsOnlyReason(['EBSThroughputOverprovisioned', 'CPUOverprovisioned'])).toBe(false);
    expect(isEbsOnlyReason(['CPUUnderprovisioned'])).toBe(false);
  });

  it('false (fail-safe) when empty or undefined', () => {
    expect(isEbsOnlyReason([])).toBe(false);
    expect(isEbsOnlyReason(undefined)).toBe(false);
  });
});

describe('fetchInstanceTypeArchitectures', () => {
  it('calls DescribeInstanceTypes with Filters instance-type=<specific type>, returns the correct SupportedArchitectures', async () => {
    const sendMock = vi.fn().mockResolvedValue({ InstanceTypes: [instanceTypeInfo('m6i.large', 2, 8192, ['x86_64'])] });
    const ec2 = fakeEc2Client(sendMock);

    const result = await fetchInstanceTypeArchitectures(ec2, 'm6i.large');

    expect(result).toEqual(['x86_64']);
    const sentCommand = sendMock.mock.calls[0][0] as { input: { Filters: { Name: string; Values: string[] }[] } };
    expect(sentCommand.input.Filters).toEqual([{ Name: 'instance-type', Values: ['m6i.large'] }]);
  });

  it('returns undefined when AWS does not return this instance type (retired/does not exist)', async () => {
    const ec2 = fakeEc2Client(async () => ({ InstanceTypes: [] }));
    expect(await fetchInstanceTypeArchitectures(ec2, 'unknown.type')).toBeUndefined();
  });
});

describe('computeEc2RightsizeTargetInDirection', () => {
  it('direction "down" -> behaves like computeEc2RightsizeTarget (drops one size)', async () => {
    const ec2 = fakeEc2Client(async () => ({
      InstanceTypes: [instanceTypeInfo('r6i.16xlarge', 64, 524288, ['x86_64']), instanceTypeInfo('r6i.24xlarge', 96, 786432, ['x86_64'])],
    }));
    const result = await computeEc2RightsizeTargetInDirection(ec2, 'r6i.24xlarge', 'down');
    expect(result?.instanceType).toBe('r6i.16xlarge');
  });

  it('direction "up" -> increases by one REAL size step within the same family, with real CPU architecture', async () => {
    const ec2 = fakeEc2Client(async () => ({
      InstanceTypes: [instanceTypeInfo('m6g.large', 2, 8192, ['arm64']), instanceTypeInfo('m6g.xlarge', 4, 16384, ['arm64'])],
    }));
    const result = await computeEc2RightsizeTargetInDirection(ec2, 'm6g.large', 'up');
    expect(result).toEqual({ instanceType: 'm6g.xlarge', currentArchitectures: ['arm64'], targetArchitectures: ['arm64'] });
  });

  it('direction "up" but already at the largest size -> undefined', async () => {
    const ec2 = fakeEc2Client(async () => ({ InstanceTypes: [instanceTypeInfo('m6g.xlarge', 4, 16384, ['arm64'])] }));
    expect(await computeEc2RightsizeTargetInDirection(ec2, 'm6g.xlarge', 'up')).toBeUndefined();
  });
});

describe('areArchitecturesCompatible', () => {
  it('returns true when there is at least one shared architecture', () => {
    expect(areArchitecturesCompatible(['x86_64'], ['x86_64'])).toBe(true);
    expect(areArchitecturesCompatible(['x86_64', 'i386'], ['x86_64'])).toBe(true);
    expect(areArchitecturesCompatible(['arm64'], ['arm64', 'x86_64'])).toBe(true);
  });

  it('returns false when there is no shared architecture (x86_64 vs arm64)', () => {
    expect(areArchitecturesCompatible(['x86_64'], ['arm64'])).toBe(false);
    expect(areArchitecturesCompatible(['arm64'], ['x86_64'])).toBe(false);
  });

  it('returns false (fail-safe) when either list is empty', () => {
    expect(areArchitecturesCompatible([], ['x86_64'])).toBe(false);
    expect(areArchitecturesCompatible(['x86_64'], [])).toBe(false);
    expect(areArchitecturesCompatible([], [])).toBe(false);
  });
});

describe('fetchFamilySizes', () => {
  it('calls DescribeInstanceTypes with Filters instance-type=<family>.* and maps fields correctly', async () => {
    const sendMock = vi.fn().mockResolvedValue({
      InstanceTypes: [
        instanceTypeInfo('t3.medium', 2, 4096, ['x86_64']),
        instanceTypeInfo('t3.large', 2, 8192, ['x86_64']),
      ],
    });
    const ec2 = fakeEc2Client(sendMock);

    const result = await fetchFamilySizes(ec2, 't3');

    expect(result).toEqual([
      { instanceType: 't3.medium', size: 'medium', vcpus: 2, memoryMiB: 4096, architectures: ['x86_64'] },
      { instanceType: 't3.large', size: 'large', vcpus: 2, memoryMiB: 8192, architectures: ['x86_64'] },
    ]);
    const sentCommand = sendMock.mock.calls[0][0] as { input: { Filters: { Name: string; Values: string[] }[] } };
    expect(sentCommand.input.Filters).toEqual([{ Name: 'instance-type', Values: ['t3.*'] }]);
  });

  it('paginates via NextToken until there are no more pages', async () => {
    const sendMock = vi
      .fn()
      .mockResolvedValueOnce({ InstanceTypes: [instanceTypeInfo('t3.medium', 2, 4096, ['x86_64'])], NextToken: 'page2' })
      .mockResolvedValueOnce({ InstanceTypes: [instanceTypeInfo('t3.large', 2, 8192, ['x86_64'])] });
    const ec2 = fakeEc2Client(sendMock);

    const result = await fetchFamilySizes(ec2, 't3');

    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(result.map((r) => r.instanceType)).toEqual(['t3.medium', 't3.large']);
  });
});

describe('computeEc2RightsizeTarget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('drops exactly one REAL size step within the same family (r6i.24xlarge -> r6i.16xlarge, not the nonexistent 18xlarge)', async () => {
    const ec2 = fakeEc2Client(async () => ({
      InstanceTypes: [
        instanceTypeInfo('r6i.16xlarge', 64, 524288, ['x86_64']),
        instanceTypeInfo('r6i.24xlarge', 96, 786432, ['x86_64']),
        instanceTypeInfo('r6i.32xlarge', 128, 1048576, ['x86_64']),
      ],
    }));

    const result = await computeEc2RightsizeTarget(ec2, 'r6i.24xlarge');

    expect(result).toEqual({
      instanceType: 'r6i.16xlarge',
      currentArchitectures: ['x86_64'],
      targetArchitectures: ['x86_64'],
    });
  });

  it('returns undefined when the current size is already the smallest step in the family', async () => {
    const ec2 = fakeEc2Client(async () => ({
      InstanceTypes: [instanceTypeInfo('t4g.nano', 2, 512, ['arm64'])],
    }));

    expect(await computeEc2RightsizeTarget(ec2, 't4g.nano')).toBeUndefined();
  });

  it('returns undefined when instanceType does not match the "<family>.<size>" format (does not call AWS)', async () => {
    const sendMock = vi.fn();
    const ec2 = fakeEc2Client(sendMock);

    expect(await computeEc2RightsizeTarget(ec2, 't3large')).toBeUndefined();
    expect(await computeEc2RightsizeTarget(ec2, '')).toBeUndefined();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('returns undefined when currentInstanceType is not in the family\'s DescribeInstanceTypes result', async () => {
    const ec2 = fakeEc2Client(async () => ({
      InstanceTypes: [instanceTypeInfo('t3.medium', 2, 4096, ['x86_64'])],
    }));

    expect(await computeEc2RightsizeTarget(ec2, 't3.unknown-size')).toBeUndefined();
  });

  it('includes the real CPU architecture of both current and target in the result', async () => {
    const ec2 = fakeEc2Client(async () => ({
      InstanceTypes: [
        instanceTypeInfo('m6g.large', 2, 8192, ['arm64']),
        instanceTypeInfo('m6g.xlarge', 4, 16384, ['arm64']),
      ],
    }));

    const result = await computeEc2RightsizeTarget(ec2, 'm6g.xlarge');

    expect(result?.instanceType).toBe('m6g.large');
    expect(result?.currentArchitectures).toEqual(['arm64']);
    expect(result?.targetArchitectures).toEqual(['arm64']);
  });
});
