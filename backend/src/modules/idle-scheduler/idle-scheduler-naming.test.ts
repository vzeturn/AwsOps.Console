import { describe, it, expect } from 'vitest';
import { buildWakeAlarmName, albNameFromWakeAlarmName, WAKE_ALARM_NAME_PREFIX } from './idle-scheduler-naming.js';

describe('buildWakeAlarmName / albNameFromWakeAlarmName', () => {
  it('round-trips an ALB name through the alarm-naming convention', () => {
    const alarmName = buildWakeAlarmName('abc-stg-alb');
    expect(alarmName).toBe(`${WAKE_ALARM_NAME_PREFIX}abc-stg-alb`);
    expect(albNameFromWakeAlarmName(alarmName)).toBe('abc-stg-alb');
  });

  it('returns undefined for an alarm name that does not match the convention', () => {
    expect(albNameFromWakeAlarmName('some-other-alarm')).toBeUndefined();
  });

  it('returns undefined when the prefix matches but nothing follows it', () => {
    expect(albNameFromWakeAlarmName(WAKE_ALARM_NAME_PREFIX)).toBeUndefined();
  });
});
