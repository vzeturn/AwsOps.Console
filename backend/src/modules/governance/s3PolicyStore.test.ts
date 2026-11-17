import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.AWS_REGION = 'ap-southeast-1';
process.env.AWS_ACCOUNT_ID = '123456789012';
process.env.ASSESSMENT_BUCKET_NAME = 'test-assessment-bucket';

const s3SendMock = vi.fn();

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({ send: s3SendMock })),
  GetObjectCommand: vi.fn().mockImplementation((input: unknown) => ({ __cmd: 'GetObject', input })),
  PutObjectCommand: vi.fn().mockImplementation((input: unknown) => ({ __cmd: 'PutObject', input })),
}));

vi.mock('@aws-sdk/client-ec2', () => ({
  EC2Client: vi.fn().mockImplementation(() => ({ send: vi.fn() })),
}));

const { s3PolicyStore } = await import('./s3PolicyStore.js');

beforeEach(() => {
  s3SendMock.mockReset();
});

describe('s3PolicyStore.getComputedSchedule', () => {
  it('object exists -> parses JSON, returns the correct decision', async () => {
    const decision = { action: 'schedulePeak', windows: [{ dayOfWeek: 1, startHour: 8, endHour: 9 }], peakType: 't3.large', offPeakType: 't3.medium' };
    s3SendMock.mockResolvedValueOnce({
      Body: { transformToString: async () => JSON.stringify(decision) },
    });
    const result = await s3PolicyStore.getComputedSchedule('i-1');
    expect(result).toEqual(decision);
    expect(s3SendMock).toHaveBeenCalledWith(
      expect.objectContaining({ __cmd: 'GetObject', input: expect.objectContaining({ Bucket: 'test-assessment-bucket', Key: 'timeofday-schedule/i-1.json' }) }),
    );
  });

  it('object does not exist (NoSuchKey) -> returns undefined, does not throw', async () => {
    const err = Object.assign(new Error('not found'), { name: 'NoSuchKey' });
    s3SendMock.mockRejectedValueOnce(err);
    const result = await s3PolicyStore.getComputedSchedule('i-missing');
    expect(result).toBeUndefined();
  });

  it('other S3 error (not NoSuchKey) -> returns undefined, does not throw (fail-safe, logs)', async () => {
    s3SendMock.mockRejectedValueOnce(new Error('AccessDenied'));
    const result = await s3PolicyStore.getComputedSchedule('i-err');
    expect(result).toBeUndefined();
  });
});

describe('s3PolicyStore.putComputedSchedule', () => {
  it('writes with the correct key, correct bucket, body is the JSON of the decision', async () => {
    s3SendMock.mockResolvedValueOnce({});
    const decision = { action: 'none' as const };
    await s3PolicyStore.putComputedSchedule('i-1', decision);
    expect(s3SendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        __cmd: 'PutObject',
        input: expect.objectContaining({
          Bucket: 'test-assessment-bucket',
          Key: 'timeofday-schedule/i-1.json',
          Body: JSON.stringify(decision),
          ContentType: 'application/json',
        }),
      }),
    );
  });

  it('S3 error -> does not throw (fail-safe, logs, caller still continues processing other instances)', async () => {
    s3SendMock.mockRejectedValueOnce(new Error('AccessDenied'));
    await expect(s3PolicyStore.putComputedSchedule('i-1', { action: 'none' })).resolves.toBeUndefined();
  });
});

describe('s3PolicyStore.getTeamOverride', () => {
  it('reads directly from the tags param, does not call the S3/EC2 API', async () => {
    const tags = [
      { Key: 'OpsDashboard:MinInstanceType', Value: 't3.medium' },
      { Key: 'OpsDashboard:MaxInstanceType', Value: 't3.xlarge' },
      { Key: 'OpsDashboard:ScaleMarginPercent', Value: '15' },
    ];
    const result = await s3PolicyStore.getTeamOverride('i-1', tags);
    expect(result).toEqual({ scaleMarginPercent: 15, minInstanceType: 't3.medium', maxInstanceType: 't3.xlarge', optOut: false });
    expect(s3SendMock).not.toHaveBeenCalled();
  });

  it('the no-auto-sizing tag OR the (legacy) no-auto-rightsize tag present -> optOut=true', async () => {
    expect((await s3PolicyStore.getTeamOverride('i-1', [{ Key: 'OpsDashboard:NoAutoSizing', Value: '' }])).optOut).toBe(true);
    expect((await s3PolicyStore.getTeamOverride('i-1', [{ Key: 'OpsDashboard:NoAutoRightsize', Value: '' }])).optOut).toBe(true);
  });

  it('no override tag present -> default values (scaleMarginPercent=0, min/max undefined, optOut=false)', async () => {
    const result = await s3PolicyStore.getTeamOverride('i-1', []);
    expect(result).toEqual({ scaleMarginPercent: 0, minInstanceType: undefined, maxInstanceType: undefined, optOut: false });
  });

  it('scale-margin-percent that fails to parse as a number -> fail-safe to 0', async () => {
    const result = await s3PolicyStore.getTeamOverride('i-1', [{ Key: 'OpsDashboard:ScaleMarginPercent', Value: 'not-a-number' }]);
    expect(result.scaleMarginPercent).toBe(0);
  });
});
