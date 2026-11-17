import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../config.js', () => ({
  config: { awsRegion: 'ap-southeast-1' },
}));

const ec2SendMock = vi.fn();
vi.mock('@aws-sdk/client-ec2', () => ({
  EC2Client: vi.fn().mockImplementation(() => ({ send: ec2SendMock })),
  DescribeInstancesCommand: vi.fn().mockImplementation((input) => ({ __type: 'DescribeInstances', input })),
  RebootInstancesCommand: vi.fn().mockImplementation((input) => ({ __type: 'RebootInstances', input })),
}));

const { executeEc2Reboot } = await import('./ec2-reboot-action-service.js');

beforeEach(() => {
  ec2SendMock.mockReset();
});

describe('executeEc2Reboot', () => {
  it('reboots successfully when the instance is running', async () => {
    ec2SendMock
      .mockResolvedValueOnce({ Reservations: [{ Instances: [{ State: { Name: 'running' } }] }] })
      .mockResolvedValueOnce({});

    const result = await executeEc2Reboot('i-abc123');

    expect(result).toEqual({ outcome: 'success', newState: 'rebooting' });
    expect(ec2SendMock).toHaveBeenCalledTimes(2);
  });

  it('rejected when the instance is not in the running state', async () => {
    ec2SendMock.mockResolvedValueOnce({ Reservations: [{ Instances: [{ State: { Name: 'stopped' } }] }] });

    const result = await executeEc2Reboot('i-abc123');

    expect(result.outcome).toBe('rejected');
    expect(ec2SendMock).toHaveBeenCalledTimes(1);
  });

  it('rejected when the instance does not exist', async () => {
    ec2SendMock.mockResolvedValueOnce({ Reservations: [] });

    const result = await executeEc2Reboot('i-missing');

    expect(result.outcome).toBe('rejected');
  });

  it('failure when DescribeInstances errors', async () => {
    ec2SendMock.mockRejectedValueOnce(new Error('boom'));

    const result = await executeEc2Reboot('i-abc123');

    expect(result.outcome).toBe('failure');
  });

  it('failure when RebootInstances errors', async () => {
    ec2SendMock
      .mockResolvedValueOnce({ Reservations: [{ Instances: [{ State: { Name: 'running' } }] }] })
      .mockRejectedValueOnce(new Error('AccessDenied'));

    const result = await executeEc2Reboot('i-abc123');

    expect(result.outcome).toBe('failure');
  });
});
