export interface MonthlyPeriod { period: string; year: number; month: number; start: string; end: string }

/** UTC, half-open month boundaries. No locale or subscription-day inference. */
export function monthlyPeriod(period: string): MonthlyPeriod {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new RangeError('Period must be YYYY-MM');
  const year = Number(period.slice(0, 4)); const month = Number(period.slice(5));
  if (year < 1 || year > 9998) throw new RangeError('Period year is outside the supported range');
  const start = `${period}-01T00:00:00.000Z`;
  const next = month === 12 ? `${String(year + 1).padStart(4, '0')}-01` : `${String(year).padStart(4, '0')}-${String(month + 1).padStart(2, '0')}`;
  return { period, year, month, start, end: `${next}-01T00:00:00.000Z` };
}

export function utcMonth(value: Date | string | number = new Date()): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new RangeError('Invalid timestamp');
  const period = date.toISOString().slice(0, 7);
  monthlyPeriod(period);
  return period;
}

export function timestamp(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  // Date.parse silently normalizes impossible dates such as February 30.
  if (new Date(parsed).toISOString().slice(0, 19) !== value.slice(0, 19)) return null;
  return parsed;
}

export function isMonthlyInterval(start: string, end: string, period: string): boolean {
  try {
    const expected = monthlyPeriod(period);
    return timestamp(start) === Date.parse(expected.start) && timestamp(end) === Date.parse(expected.end);
  } catch { return false; }
}
