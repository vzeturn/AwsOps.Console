import { describe, it, expect } from 'vitest';
import { todayDateString, isEligibleForPatch, PATCH_AFTER_START_MINUTES } from './patchScheduling.js';

describe('todayDateString — YYYY-MM-DD format in the given timezone', () => {
  it('correctly converts to the Vietnam date when UTC is still on the previous day (00:00-07:00 UTC = 07:00-14:00 VN time same day, but near UTC midnight it rolls back a day)', () => {
    // 2026-08-11T18:00:00Z = 2026-08-12T01:00:00 VN time (UTC+7) -> the VN date is the 12th, not the 11th.
    const now = new Date('2026-08-11T18:00:00.000Z');
    expect(todayDateString(now, 'Asia/Ho_Chi_Minh')).toBe('2026-08-12');
  });

  it('UTC and VN time fall on the same day mid-day (no date offset)', () => {
    const now = new Date('2026-08-12T03:00:00.000Z'); // 10:00 VN time, same day 12th.
    expect(todayDateString(now, 'Asia/Ho_Chi_Minh')).toBe('2026-08-12');
  });
});

describe('isEligibleForPatch — the conditions sufficient for patch-scheduler to send a SendCommand for an instance (based on GetCommandInvocation confirmation, not just SendCommand accepted)', () => {
  const now = new Date('2026-08-12T03:00:00.000Z'); // 10:00 VN time.

  it('all 3 conditions met (online + enough uptime + not patched today, no pending/verified) -> true', () => {
    const launchTime = new Date(now.getTime() - (PATCH_AFTER_START_MINUTES + 1) * 60 * 1000);
    expect(isEligibleForPatch({ launchTime, pendingCommandDate: undefined, verifiedDate: undefined, ssmOnline: true }, now)).toBe(true);
  });

  it('SSM Agent is not online yet -> false, regardless of uptime/pendingCommandDate/verifiedDate', () => {
    const launchTime = new Date(now.getTime() - (PATCH_AFTER_START_MINUTES + 1) * 60 * 1000);
    expect(isEligibleForPatch({ launchTime, pendingCommandDate: undefined, verifiedDate: undefined, ssmOnline: false }, now)).toBe(false);
  });

  it('uptime is not yet 30 minutes -> false', () => {
    const launchTime = new Date(now.getTime() - (PATCH_AFTER_START_MINUTES - 1) * 60 * 1000);
    expect(isEligibleForPatch({ launchTime, pendingCommandDate: undefined, verifiedDate: undefined, ssmOnline: true }, now)).toBe(false);
  });

  it('launchTime undefined (AWS did not return the field) -> false, fail-safe, does not guess at uptime', () => {
    expect(isEligibleForPatch({ launchTime: undefined, pendingCommandDate: undefined, verifiedDate: undefined, ssmOnline: true }, now)).toBe(false);
  });

  it('already VERIFIED a successful patch today (verifiedDate matches todayDateString) -> false, avoids a duplicate patch', () => {
    const launchTime = new Date(now.getTime() - (PATCH_AFTER_START_MINUTES + 1) * 60 * 1000);
    expect(isEligibleForPatch({ launchTime, pendingCommandDate: undefined, verifiedDate: '2026-08-12', ssmOnline: true }, now)).toBe(false);
  });

  it('has a PENDING command today (SendCommand sent, NOT YET confirmed) -> false, avoids sending a duplicate SendCommand while awaiting verification', () => {
    const launchTime = new Date(now.getTime() - (PATCH_AFTER_START_MINUTES + 1) * 60 * 1000);
    expect(isEligibleForPatch({ launchTime, pendingCommandDate: '2026-08-12', verifiedDate: undefined, ssmOnline: true }, now)).toBe(false);
  });

  it('verifiedDate is a DIFFERENT day than today (e.g. yesterday) -> true, eligible for patching again (a new day)', () => {
    const launchTime = new Date(now.getTime() - (PATCH_AFTER_START_MINUTES + 1) * 60 * 1000);
    expect(isEligibleForPatch({ launchTime, pendingCommandDate: undefined, verifiedDate: '2026-08-11', ssmOnline: true }, now)).toBe(true);
  });

  it('pendingCommandDate is a DIFFERENT day than today (the old command has expired tracking) -> true, eligible to be sent again', () => {
    const launchTime = new Date(now.getTime() - (PATCH_AFTER_START_MINUTES + 1) * 60 * 1000);
    expect(isEligibleForPatch({ launchTime, pendingCommandDate: '2026-08-11', verifiedDate: undefined, ssmOnline: true }, now)).toBe(true);
  });
});
