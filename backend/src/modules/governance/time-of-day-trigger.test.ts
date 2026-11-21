// backend/src/time-of-day-trigger.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.AWS_REGION = 'ap-southeast-1';
process.env.AWS_ACCOUNT_ID = '123456789012';
process.env.ASSESSMENT_BUCKET_NAME = 'test-assessment-bucket';
process.env.TAG_PREFIX = 'OpsDashboard';
process.env.SCHEDULE_TAG_KEY = 'Schedule:Start';
process.env.PATCH_TIMEZONE = 'Asia/Ho_Chi_Minh';
process.env.DOWNSIZE_SCHEDULER_FUNCTION_ARN = 'arn:aws:lambda:ap-southeast-1:123456789012:function:abc-ops-dashboard-prod-downsize-scheduler-fn';

const ec2SendMock = vi.fn();
const lambdaSendMock = vi.fn();
const postAlertEmbedsMock = vi.fn();

vi.mock('@aws-sdk/client-ec2', () => ({
  EC2Client: vi.fn().mockImplementation(() => ({ send: ec2SendMock })),
  DescribeInstancesCommand: vi.fn().mockImplementation((input: unknown) => ({ __cmd: 'DescribeInstances', input })),
  DescribeInstanceTypesCommand: vi.fn().mockImplementation((input: unknown) => ({ __cmd: 'DescribeInstanceTypes', input })),
}));
vi.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: vi.fn().mockImplementation(() => ({ send: lambdaSendMock })),
  InvokeCommand: vi.fn().mockImplementation((input: unknown) => ({ __cmd: 'Invoke', input })),
}));
vi.mock('../alerting/alertHook.js', () => ({ postAlertEmbeds: postAlertEmbedsMock }));

const getComputedScheduleMock = vi.fn();
vi.mock('./s3PolicyStore.js', () => ({
  s3PolicyStore: { getComputedSchedule: getComputedScheduleMock, putComputedSchedule: vi.fn(), getTeamOverride: vi.fn() },
}));

const { handler } = await import('./time-of-day-trigger.js');

beforeEach(() => {
  ec2SendMock.mockReset();
  lambdaSendMock.mockReset();
  postAlertEmbedsMock.mockReset();
  getComputedScheduleMock.mockReset();
  postAlertEmbedsMock.mockResolvedValue(undefined);
  lambdaSendMock.mockResolvedValue({ StatusCode: 202 });
});

function instanceEntry(instanceId: string, instanceType: string, tags: { Key: string; Value: string }[]) {
  return { InstanceId: instanceId, InstanceType: instanceType, State: { Name: 'running' }, Tags: [{ Key: 'Schedule:Start', Value: '08:00' }, ...tags] };
}

function instanceTypeInfo(instanceType: string, architectures: string[]) {
  return { InstanceType: instanceType, ProcessorInfo: { SupportedArchitectures: architectures } };
}

describe('time-of-day-trigger handler', () => {
  it('is within the pre-peak window, current type differs from peakType, same architecture -> invokes DownsizeSchedulerFunction with peakType', async () => {
    const fixedNow = new Date('2026-08-24T00:50:00Z'); // 07:50 Asia/Ho_Chi_Minh, Thu Hai
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);

    const instanceTypes = [instanceTypeInfo('t3.medium', ['x86_64']), instanceTypeInfo('t3.large', ['x86_64'])];
    ec2SendMock.mockImplementation((cmd: { __cmd: string; input?: { Filters?: { Values?: string[] }[] } }) => {
      if (cmd.__cmd === 'DescribeInstances') {
        return Promise.resolve({ Reservations: [{ Instances: [instanceEntry('i-1', 't3.medium', [])] }] });
      }
      if (cmd.__cmd === 'DescribeInstanceTypes') {
        const requestedType = cmd.input?.Filters?.[0]?.Values?.[0];
        return Promise.resolve({ InstanceTypes: instanceTypes.filter((t) => t.InstanceType === requestedType) });
      }
      return Promise.resolve({});
    });
    getComputedScheduleMock.mockResolvedValueOnce({
      action: 'schedulePeak',
      windows: [{ dayOfWeek: 1, startHour: 8, endHour: 10 }],
      peakType: 't3.large',
      offPeakType: 't3.medium',
    });

    const result = await handler();

    expect(lambdaSendMock).toHaveBeenCalledWith(
      expect.objectContaining({ __cmd: 'Invoke', input: expect.objectContaining({ Payload: expect.stringContaining('"targetType":"t3.large"') }) }),
    );
    expect(result.triggered).toBe(1);
    vi.useRealTimers();
  });

  it('has not yet reached the pre-peak window (still > PRE_PEAK_LEAD_MINUTES before peak) -> does not invoke', async () => {
    const fixedNow = new Date('2026-08-24T00:00:00Z'); // 07:00 Asia/Ho_Chi_Minh, still 1h before the 08:00 peak
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);
    ec2SendMock.mockImplementation((cmd: { __cmd: string }) =>
      cmd.__cmd === 'DescribeInstances' ? Promise.resolve({ Reservations: [{ Instances: [instanceEntry('i-1', 't3.medium', [])] }] }) : Promise.resolve({}),
    );
    getComputedScheduleMock.mockResolvedValueOnce({ action: 'schedulePeak', windows: [{ dayOfWeek: 1, startHour: 8, endHour: 10 }], peakType: 't3.large', offPeakType: 't3.medium' });

    const result = await handler();

    expect(lambdaSendMock).not.toHaveBeenCalled();
    expect(result.triggered).toBe(0);
    vi.useRealTimers();
  });

  it('instance has the no-auto-sizing tag -> skips, does not read the schedule', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-24T00:50:00Z'));
    ec2SendMock.mockImplementation((cmd: { __cmd: string }) =>
      cmd.__cmd === 'DescribeInstances'
        ? Promise.resolve({ Reservations: [{ Instances: [instanceEntry('i-1', 't3.medium', [{ Key: 'OpsDashboard:NoAutoSizing', Value: '' }])] }] })
        : Promise.resolve({}),
    );

    const result = await handler();

    expect(getComputedScheduleMock).not.toHaveBeenCalled();
    expect(result.triggered).toBe(0);
    vi.useRealTimers();
  });

  it('within cooldown (last-auto-rightsize-date < 7 days ago) -> does not invoke even during pre-peak', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-24T00:50:00Z'));
    const instanceTypes = [instanceTypeInfo('t3.medium', ['x86_64']), instanceTypeInfo('t3.large', ['x86_64'])];
    ec2SendMock.mockImplementation((cmd: { __cmd: string; input?: { Filters?: { Values?: string[] }[] } }) => {
      if (cmd.__cmd === 'DescribeInstances') {
        return Promise.resolve({
          Reservations: [{ Instances: [instanceEntry('i-1', 't3.medium', [{ Key: 'OpsDashboard:LastAutoRightsizeDate', Value: '2026-08-23' }])] }],
        });
      }
      if (cmd.__cmd === 'DescribeInstanceTypes') {
        const requestedType = cmd.input?.Filters?.[0]?.Values?.[0];
        return Promise.resolve({ InstanceTypes: instanceTypes.filter((t) => t.InstanceType === requestedType) });
      }
      return Promise.resolve({});
    });
    getComputedScheduleMock.mockResolvedValueOnce({ action: 'schedulePeak', windows: [{ dayOfWeek: 1, startHour: 8, endHour: 10 }], peakType: 't3.large', offPeakType: 't3.medium' });

    const result = await handler();

    // Fix 1: the cooldown check runs AFTER reading the schedule + classifying the phase (only blocks
    // the pre-peak direction) — getComputedSchedule IS STILL called (different from the old behavior),
    // but the resize invoke is still blocked exactly as before.
    expect(getComputedScheduleMock).toHaveBeenCalledWith('i-1');
    expect(lambdaSendMock).not.toHaveBeenCalled();
    expect(result.triggered).toBe(0);
    vi.useRealTimers();
  });

  it('CPU architecture differs between current and peakType -> does not invoke, logs, does not guess at safety', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-24T00:50:00Z'));
    const instanceTypes = [instanceTypeInfo('t4g.medium', ['arm64']), instanceTypeInfo('t3.large', ['x86_64'])];
    ec2SendMock.mockImplementation((cmd: { __cmd: string; input?: { Filters?: { Values?: string[] }[] } }) => {
      if (cmd.__cmd === 'DescribeInstances') return Promise.resolve({ Reservations: [{ Instances: [instanceEntry('i-1', 't4g.medium', [])] }] });
      if (cmd.__cmd === 'DescribeInstanceTypes') {
        const requestedType = cmd.input?.Filters?.[0]?.Values?.[0];
        return Promise.resolve({ InstanceTypes: instanceTypes.filter((t) => t.InstanceType === requestedType) });
      }
      return Promise.resolve({});
    });
    getComputedScheduleMock.mockResolvedValueOnce({ action: 'schedulePeak', windows: [{ dayOfWeek: 1, startHour: 8, endHour: 10 }], peakType: 't3.large', offPeakType: 't4g.medium' });

    const result = await handler();

    expect(lambdaSendMock).not.toHaveBeenCalled();
    expect(result.triggered).toBe(0);
    vi.useRealTimers();
  });

  it('is within the post-peak window (peak just ended within PRE_PEAK_LEAD_MINUTES), current type is peakType -> invokes DownsizeSchedulerFunction with offPeakType', async () => {
    const fixedNow = new Date('2026-08-24T03:10:00Z'); // 10:10 Asia/Ho_Chi_Minh, Monday - 10 minutes past endHour=10
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);

    const instanceTypes = [instanceTypeInfo('t3.large', ['x86_64']), instanceTypeInfo('t3.medium', ['x86_64'])];
    ec2SendMock.mockImplementation((cmd: { __cmd: string; input?: { Filters?: { Values?: string[] }[] } }) => {
      if (cmd.__cmd === 'DescribeInstances') {
        return Promise.resolve({ Reservations: [{ Instances: [instanceEntry('i-1', 't3.large', [])] }] });
      }
      if (cmd.__cmd === 'DescribeInstanceTypes') {
        const requestedType = cmd.input?.Filters?.[0]?.Values?.[0];
        return Promise.resolve({ InstanceTypes: instanceTypes.filter((t) => t.InstanceType === requestedType) });
      }
      return Promise.resolve({});
    });
    getComputedScheduleMock.mockResolvedValueOnce({
      action: 'schedulePeak',
      windows: [{ dayOfWeek: 1, startHour: 8, endHour: 10 }],
      peakType: 't3.large',
      offPeakType: 't3.medium',
    });

    const result = await handler();

    expect(lambdaSendMock).toHaveBeenCalledWith(
      expect.objectContaining({ __cmd: 'Invoke', input: expect.objectContaining({ Payload: expect.stringContaining('"targetType":"t3.medium"') }) }),
    );
    expect(result.triggered).toBe(1);
    vi.useRealTimers();
  });

  it('action=none (no schedule) -> skips the instance, does not invoke', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-24T00:50:00Z'));
    ec2SendMock.mockImplementation((cmd: { __cmd: string }) =>
      cmd.__cmd === 'DescribeInstances' ? Promise.resolve({ Reservations: [{ Instances: [instanceEntry('i-1', 't3.medium', [])] }] }) : Promise.resolve({}),
    );
    getComputedScheduleMock.mockResolvedValueOnce({ action: 'none' });

    const result = await handler();

    expect(lambdaSendMock).not.toHaveBeenCalled();
    expect(result.triggered).toBe(0);
    vi.useRealTimers();
  });

  // --- Fix 1: cooldown must not be allowed to block the resize-DOWN direction (post-peak/scale-down) ---
  it('Fix 1: is within post-peak, instance is at peakType AND within cooldown -> resize down to offPeakType MUST STILL fire (not blocked by cooldown)', async () => {
    const fixedNow = new Date('2026-08-24T03:10:00Z'); // 10:10 Asia/Ho_Chi_Minh, Monday - 10 minutes past endHour=10
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);

    const instanceTypes = [instanceTypeInfo('t3.large', ['x86_64']), instanceTypeInfo('t3.medium', ['x86_64'])];
    ec2SendMock.mockImplementation((cmd: { __cmd: string; input?: { Filters?: { Values?: string[] }[] } }) => {
      if (cmd.__cmd === 'DescribeInstances') {
        // instance is at peakType (t3.large) AND has lastAutoRightsizeDate within the cooldown window (< 7 days).
        return Promise.resolve({
          Reservations: [{ Instances: [instanceEntry('i-1', 't3.large', [{ Key: 'OpsDashboard:LastAutoRightsizeDate', Value: '2026-08-23' }])] }],
        });
      }
      if (cmd.__cmd === 'DescribeInstanceTypes') {
        const requestedType = cmd.input?.Filters?.[0]?.Values?.[0];
        return Promise.resolve({ InstanceTypes: instanceTypes.filter((t) => t.InstanceType === requestedType) });
      }
      return Promise.resolve({});
    });
    getComputedScheduleMock.mockResolvedValueOnce({
      action: 'schedulePeak',
      windows: [{ dayOfWeek: 1, startHour: 8, endHour: 10 }],
      peakType: 't3.large',
      offPeakType: 't3.medium',
    });

    const result = await handler();

    expect(lambdaSendMock).toHaveBeenCalledWith(
      expect.objectContaining({ __cmd: 'Invoke', input: expect.objectContaining({ Payload: expect.stringContaining('"targetType":"t3.medium"') }) }),
    );
    expect(result.triggered).toBe(1);
    vi.useRealTimers();
  });

  // --- Fix 2: midnight boundary endHour=24 / startHour=0 ---
  it('Fix 2: window endHour=24 (23:xx-24:00 Monday) -> fires post-peak right after midnight (00:10 Tuesday)', async () => {
    const fixedNow = new Date('2026-08-24T17:10:00Z'); // 00:10 Asia/Ho_Chi_Minh Tuesday (8/25) - Monday's 22:00-24:00 window ended 10 minutes ago
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);

    const instanceTypes = [instanceTypeInfo('t3.large', ['x86_64']), instanceTypeInfo('t3.medium', ['x86_64'])];
    ec2SendMock.mockImplementation((cmd: { __cmd: string; input?: { Filters?: { Values?: string[] }[] } }) => {
      if (cmd.__cmd === 'DescribeInstances') {
        return Promise.resolve({ Reservations: [{ Instances: [instanceEntry('i-1', 't3.large', [])] }] });
      }
      if (cmd.__cmd === 'DescribeInstanceTypes') {
        const requestedType = cmd.input?.Filters?.[0]?.Values?.[0];
        return Promise.resolve({ InstanceTypes: instanceTypes.filter((t) => t.InstanceType === requestedType) });
      }
      return Promise.resolve({});
    });
    getComputedScheduleMock.mockResolvedValueOnce({
      action: 'schedulePeak',
      windows: [{ dayOfWeek: 1, startHour: 22, endHour: 24 }], // Monday 22:00-24:00 (23:59)
      peakType: 't3.large',
      offPeakType: 't3.medium',
    });

    const result = await handler();

    expect(lambdaSendMock).toHaveBeenCalledWith(
      expect.objectContaining({ __cmd: 'Invoke', input: expect.objectContaining({ Payload: expect.stringContaining('"targetType":"t3.medium"') }) }),
    );
    expect(result.triggered).toBe(1);
    vi.useRealTimers();
  });

  it('Fix 2: window startHour=0 (00:00-02:00 Tuesday) -> fires pre-peak right before midnight (23:50 Monday)', async () => {
    const fixedNow = new Date('2026-08-24T16:50:00Z'); // 23:50 Asia/Ho_Chi_Minh Monday (8/24) - 10 minutes before Tuesday's 00:00-02:00 window starts
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);

    const instanceTypes = [instanceTypeInfo('t3.medium', ['x86_64']), instanceTypeInfo('t3.large', ['x86_64'])];
    ec2SendMock.mockImplementation((cmd: { __cmd: string; input?: { Filters?: { Values?: string[] }[] } }) => {
      if (cmd.__cmd === 'DescribeInstances') {
        return Promise.resolve({ Reservations: [{ Instances: [instanceEntry('i-1', 't3.medium', [])] }] });
      }
      if (cmd.__cmd === 'DescribeInstanceTypes') {
        const requestedType = cmd.input?.Filters?.[0]?.Values?.[0];
        return Promise.resolve({ InstanceTypes: instanceTypes.filter((t) => t.InstanceType === requestedType) });
      }
      return Promise.resolve({});
    });
    getComputedScheduleMock.mockResolvedValueOnce({
      action: 'schedulePeak',
      windows: [{ dayOfWeek: 2, startHour: 0, endHour: 2 }], // Tuesday 00:00-02:00
      peakType: 't3.large',
      offPeakType: 't3.medium',
    });

    const result = await handler();

    expect(lambdaSendMock).toHaveBeenCalledWith(
      expect.objectContaining({ __cmd: 'Invoke', input: expect.objectContaining({ Payload: expect.stringContaining('"targetType":"t3.large"') }) }),
    );
    expect(result.triggered).toBe(1);
    vi.useRealTimers();
  });
});
