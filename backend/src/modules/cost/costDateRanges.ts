// Every function here computes dates in ONE specific timezone (by default, calls from
// cost-collector.ts always pass PATCH_TIMEZONE = 'Asia/Ho_Chi_Minh'), using
// Intl.DateTimeFormat.formatToParts instead of Date.getFullYear()/getMonth()/getDate() (which
// read the runtime's local time — on Lambda that defaults to UTC, causing a day mismatch in the
// early-morning/start-of-month VN hours, which would make "this month"/"today" get computed
// against UTC instead of VN time, causing monthToDateUsd to be missing 1 day of data at the start
// of the month).

function partsOf(d: Date, timeZone: string): { year: number; month: number; day: number } {
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const parts = formatter.formatToParts(d);
  const year = Number(parts.find((p) => p.type === 'year')!.value);
  const month = Number(parts.find((p) => p.type === 'month')!.value);
  const day = Number(parts.find((p) => p.type === 'day')!.value);
  return { year, month, day };
}

function toYmd(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function ymd(d: Date, timeZone: string): string {
  const { year, month, day } = partsOf(d, timeZone);
  return toYmd(year, month, day);
}

export function today(d: Date, timeZone: string): string {
  return ymd(d, timeZone);
}

export function monthStart(d: Date, timeZone: string): string {
  const { year, month } = partsOf(d, timeZone);
  return toYmd(year, month, 1);
}

export function prevMonthRange(d: Date, timeZone: string): [string, string] {
  const { year, month } = partsOf(d, timeZone);
  const currentMonthStart = toYmd(year, month, 1);
  const prevMonth = month === 1 ? 12 : month - 1;
  const prevYear = month === 1 ? year - 1 : year;
  return [toYmd(prevYear, prevMonth, 1), currentMonthStart];
}

const LAST_N_DAYS = 30;
const MONTHLY_HISTORY_MONTHS = 13;

export function last30DaysRange(d: Date, timeZone: string): [string, string] {
  const end = ymd(d, timeZone);
  // Anchor "today" (YYYY-MM-DD in timeZone) as UTC-midnight, then step back N days by subtracting
  // pure UTC milliseconds — safe because a calendar-day unit no longer depends on timezone once
  // it's been converted.
  const endAsUtcMidnight = new Date(`${end}T00:00:00.000Z`);
  const start = new Date(endAsUtcMidnight.getTime() - LAST_N_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return [start, end];
}

export function monthlyHistoryRange(d: Date, timeZone: string): [string, string] {
  const { year, month } = partsOf(d, timeZone);
  // Step back MONTHLY_HISTORY_MONTHS - 1 months, to have a FULL 13 months counting the currently
  // running month-to-date (matches the original behavior in cost-collector.ts before it was split
  // into this module).
  const totalMonthsBack = MONTHLY_HISTORY_MONTHS - 1;
  const zeroBasedMonth = month - 1 - totalMonthsBack;
  const startYear = year + Math.floor(zeroBasedMonth / 12);
  const startMonth = ((zeroBasedMonth % 12) + 12) % 12 + 1;
  return [toYmd(startYear, startMonth, 1), ymd(d, timeZone)];
}
