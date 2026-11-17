import { describe, it, expect } from 'vitest';
import { DEFAULT_IDLE_MINUTES } from '@ops-dashboard/shared';
import { parseManagedGroupTags, decideIdleStop, hasAnyDrift } from './idle-scheduler-logic.js';

describe('parseManagedGroupTags', () => {
  it('returns undefined when the managed tag is absent', () => {
    expect(parseManagedGroupTags({})).toBeUndefined();
  });

  it('returns undefined when the managed tag is present but not exactly "true"', () => {
    expect(parseManagedGroupTags({ 'IdleScheduler:Managed': 'yes' })).toBeUndefined();
    expect(parseManagedGroupTags({ 'IdleScheduler:Managed': '' })).toBeUndefined();
  });

  it('parses ec2/rds instance ids when managed=true', () => {
    const parsed = parseManagedGroupTags({
      'IdleScheduler:Managed': 'true',
      'IdleScheduler:Ec2InstanceId': 'i-0123456789abcdef0',
      'IdleScheduler:RdsInstanceId': 'abc-stg-rds-postgres',
    });
    expect(parsed).toEqual({
      ec2InstanceId: 'i-0123456789abcdef0',
      rdsInstanceId: 'abc-stg-rds-postgres',
      idleMinutes: DEFAULT_IDLE_MINUTES,
    });
  });

  it('leaves ec2InstanceId/rdsInstanceId undefined when their companion tags are missing (misconfigured group)', () => {
    const parsed = parseManagedGroupTags({ 'IdleScheduler:Managed': 'true' });
    expect(parsed).toEqual({ ec2InstanceId: undefined, rdsInstanceId: undefined, idleMinutes: DEFAULT_IDLE_MINUTES });
  });

  it('uses the idle-minutes override tag when present and valid', () => {
    const parsed = parseManagedGroupTags({ 'IdleScheduler:Managed': 'true', 'IdleScheduler:IdleMinutes': '45' });
    expect(parsed?.idleMinutes).toBe(45);
  });

  it('falls back to the default when the idle-minutes override is unparseable or non-positive', () => {
    expect(parseManagedGroupTags({ 'IdleScheduler:Managed': 'true', 'IdleScheduler:IdleMinutes': 'abc' })?.idleMinutes).toBe(DEFAULT_IDLE_MINUTES);
    expect(parseManagedGroupTags({ 'IdleScheduler:Managed': 'true', 'IdleScheduler:IdleMinutes': '0' })?.idleMinutes).toBe(DEFAULT_IDLE_MINUTES);
    expect(parseManagedGroupTags({ 'IdleScheduler:Managed': 'true', 'IdleScheduler:IdleMinutes': '-5' })?.idleMinutes).toBe(DEFAULT_IDLE_MINUTES);
  });
});

describe('decideIdleStop', () => {
  const now = new Date('2026-09-22T02:00:00Z');
  const base = { ec2State: 'running', ec2LaunchTime: new Date('2026-09-22T01:00:00Z'), held: false, idleMinutes: 30, requestsInIdleWindow: 0, now };

  it('a hold tag always wins, regardless of state/traffic', () => {
    expect(decideIdleStop({ ...base, held: true })).toEqual({ action: 'skip', reason: 'hold' });
    expect(decideIdleStop({ ...base, held: true, ec2State: 'stopped' })).toEqual({ action: 'skip', reason: 'hold' });
  });

  it('skips when the instance is not running', () => {
    expect(decideIdleStop({ ...base, ec2State: 'stopped' })).toEqual({ action: 'skip', reason: 'not-running' });
    expect(decideIdleStop({ ...base, ec2State: 'pending' })).toEqual({ action: 'skip', reason: 'not-running' });
  });

  it('skips inside the grace period after a (re)start', () => {
    const justStarted = new Date('2026-09-22T01:55:00Z'); // 5 min before `now`, grace default is 10 min
    expect(decideIdleStop({ ...base, ec2LaunchTime: justStarted })).toEqual({ action: 'skip', reason: 'grace-period' });
  });

  it('skips when there is real traffic in the idle window', () => {
    expect(decideIdleStop({ ...base, requestsInIdleWindow: 3 })).toEqual({ action: 'skip', reason: 'active' });
  });

  it('stops when running, past grace period, and zero requests', () => {
    expect(decideIdleStop({ ...base })).toEqual({ action: 'stop' });
  });

  it('an undefined launch time never triggers the grace-period skip', () => {
    expect(decideIdleStop({ ...base, ec2LaunchTime: undefined })).toEqual({ action: 'stop' });
  });

  it('respects a custom graceMinutes override', () => {
    const justStarted = new Date('2026-09-22T01:58:00Z'); // 2 min before `now`
    expect(decideIdleStop({ ...base, ec2LaunchTime: justStarted, graceMinutes: 1 })).toEqual({ action: 'stop' });
    expect(decideIdleStop({ ...base, ec2LaunchTime: justStarted, graceMinutes: 5 })).toEqual({ action: 'skip', reason: 'grace-period' });
  });
});

describe('hasAnyDrift', () => {
  const noDrift = { tickScheduleDisabled: false, tickFunctionBlocked: false, wakeFunctionBlocked: false };

  it('false when nothing is wrong', () => {
    expect(hasAnyDrift(noDrift, [])).toBe(false);
    expect(hasAnyDrift(noDrift, [{ albName: 'x', tagMissing: false, wakeAlarmActionsDisabled: false }])).toBe(false);
  });

  it('true when any mechanism-wide check fails', () => {
    expect(hasAnyDrift({ ...noDrift, tickScheduleDisabled: true }, [])).toBe(true);
    expect(hasAnyDrift({ ...noDrift, tickFunctionBlocked: true }, [])).toBe(true);
    expect(hasAnyDrift({ ...noDrift, wakeFunctionBlocked: true }, [])).toBe(true);
  });

  it('true when any group has drift', () => {
    expect(hasAnyDrift(noDrift, [{ albName: 'x', tagMissing: true, wakeAlarmActionsDisabled: false }])).toBe(true);
    expect(hasAnyDrift(noDrift, [{ albName: 'x', tagMissing: false, wakeAlarmActionsDisabled: true }])).toBe(true);
  });
});
