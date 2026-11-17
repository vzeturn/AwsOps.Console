import { describe, it, expect } from 'vitest';
import { ymd, monthStart, today, prevMonthRange, last30DaysRange, monthlyHistoryRange } from './costDateRanges.js';

// Fixed timezone for the whole test suite: Asia/Ho_Chi_Minh (UTC+7, no DST).
const TZ = 'Asia/Ho_Chi_Minh';

describe('ymd — converts a Date to YYYY-MM-DD in the given timezone (not via local-time Date arithmetic)', () => {
  it('UTC near midnight, VN time has already crossed into the next day (UTC is 1 day behind VN)', () => {
    // 2026-02-28T18:00:00Z = 2026-03-01T01:00:00 VN time (UTC+7) -> the VN date is 03/01, not 02/28.
    const d = new Date('2026-02-28T18:00:00.000Z');
    expect(ymd(d, TZ)).toBe('2026-03-01');
  });

  it('UTC and VN time are the same day mid-day (no date offset)', () => {
    // 2026-03-01T00:30:00Z = 07:30 VN time, same day 03/01.
    const d = new Date('2026-03-01T00:30:00.000Z');
    expect(ymd(d, TZ)).toBe('2026-03-01');
  });
});

describe('monthStart — the first day of the month for a Date, computed in the given timezone', () => {
  it('start of March in VN time while UTC is still late February (the most important boundary — the reason for the original bug)', () => {
    const d = new Date('2026-02-28T18:00:00.000Z'); // = 01:00 VN time on 03/01.
    expect(monthStart(d, TZ)).toBe('2026-03-01');
  });

  it('mid-month -> still returns day 01 of that month in VN time', () => {
    const d = new Date('2026-03-15T10:00:00.000Z'); // = 17:00 VN time on 03/15.
    expect(monthStart(d, TZ)).toBe('2026-03-01');
  });
});

describe('today — alias for ymd, used for call sites where "today" reads more clearly (in the TimePeriod.End parameter)', () => {
  it('returns the same value as ymd at the UTC/VN date-offset boundary', () => {
    const d = new Date('2026-02-28T18:00:00.000Z');
    expect(today(d, TZ)).toBe(ymd(d, TZ));
    expect(today(d, TZ)).toBe('2026-03-01');
  });
});

describe('prevMonthRange — [start of previous month, start of current month) in the given timezone', () => {
  it('currently at the start of March in VN time (even though UTC is still late February) -> the previous-month range is 02/01..03/01', () => {
    const d = new Date('2026-02-28T18:00:00.000Z'); // 01:00 VN time on 03/01.
    expect(prevMonthRange(d, TZ)).toEqual(['2026-02-01', '2026-03-01']);
  });

  it('currently in January -> the previous month is December of the prior year (crossing the year boundary)', () => {
    const d = new Date('2026-01-15T10:00:00.000Z'); // 17:00 VN time on 01/15.
    expect(prevMonthRange(d, TZ)).toEqual(['2025-12-01', '2026-01-01']);
  });
});

describe('last30DaysRange — [today - 30 days, today] in the given timezone', () => {
  it('correctly computes "today" in VN time at the UTC/VN date-offset boundary, End = ymd(d)', () => {
    const d = new Date('2026-02-28T18:00:00.000Z'); // today in VN time = 03/01.
    const [start, end] = last30DaysRange(d, TZ);
    expect(end).toBe('2026-03-01');
    // start = 30 days before 03/01 = 01/30 (January has 31 days: 03-01 = 2 days back into Feb, then
    // 28 more days back into January -> 2026-01-30). Not asserting via manual arithmetic, which is
    // error-prone — assert via the ms difference instead.
    const startDate = new Date(`${start}T00:00:00.000Z`);
    const endDate = new Date(`${end}T00:00:00.000Z`);
    expect((endDate.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000)).toBe(30);
  });
});

describe('monthlyHistoryRange — [13 months ago (start of month), today] in the given timezone', () => {
  it('returns the correct start of month 13 months ago and today, in VN time', () => {
    const d = new Date('2026-03-15T10:00:00.000Z'); // 17:00 VN time on 2026-03-15.
    const [start, end] = monthlyHistoryRange(d, TZ);
    expect(start).toBe('2025-03-01'); // 12 months back from 2026-03 = March 2025 (13 months counting the current month).
    expect(end).toBe('2026-03-15');
  });
});

describe('Mutation check — confirms the test actually catches the original timezone bug (local-time Date arithmetic)', () => {
  it('the old logic (Date.getFullYear/getMonth local-time, NOT using Intl.DateTimeFormat) gives a WRONG result at the UTC/VN date-offset boundary', () => {
    // Reproduce the old logic here to prove this test catches the bug — not imported from source,
    // just replicated here for comparison. The old logic used local-time Date arithmetic (based on
    // the runtime's local timezone), so its result depends on whatever TZ the runtime is set to. To
    // make the mutation check work, we test that: (1) the new logic always returns '2026-03-01'
    // (CORRECT per VN time), and (2) the old logic DIFFERS from the new logic (proving the test
    // catches the discrepancy).
    const d = new Date('2026-02-28T18:00:00.000Z'); // the actual VN time is 01:00 on 03/01.

    // Old logic: builds a Date from UTC components, then converts to an ISO string (this will vary
    // depending on the runtime TZ, but will be WRONG relative to "correct per VN time").
    const oldMonthStart = new Date(d.getUTCFullYear(), d.getUTCMonth(), 1).toISOString().slice(0, 10);

    // New logic: uses Intl.DateTimeFormat with an explicit VN timezone -> always '2026-03-01'.
    const newMonthStart = monthStart(d, TZ);

    // Proves the test detects the bug: the new logic differs from the old logic (because the old
    // logic doesn't account for timezone).
    expect(newMonthStart).toBe('2026-03-01'); // New logic is CORRECT.
    expect(oldMonthStart).not.toBe(newMonthStart); // Old logic is WRONG (differs from the new logic).
  });
});
