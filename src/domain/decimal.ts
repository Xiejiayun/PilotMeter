/** Bounded, exact decimal arithmetic. Quantities never pass through Number. */
export interface Decimal { coefficient: bigint; scale: number }

const MAX_DIGITS = 256;

export function parseDecimal(value: string): Decimal {
  if (typeof value !== 'string' || value.length > MAX_DIGITS * 2) throw new RangeError('Invalid decimal');
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d{1,3}))?$/.exec(value);
  if (!match) throw new RangeError('Invalid decimal');
  const fraction = match[3] ?? '';
  const digits = `${match[2]}${fraction}`;
  if (digits.length > MAX_DIGITS) throw new RangeError('Decimal precision exceeds supported range');
  let scale = fraction.length - Number(match[4] ?? 0);
  if (Math.abs(scale) > MAX_DIGITS) throw new RangeError('Decimal scale exceeds supported range');
  let coefficient = BigInt(`${match[1]}${digits}`);
  if (scale < 0) { coefficient *= 10n ** BigInt(-scale); scale = 0; }
  while (scale > 0 && coefficient % 10n === 0n) { coefficient /= 10n; scale--; }
  return { coefficient, scale };
}

export function formatDecimal({ coefficient, scale }: Decimal): string {
  if (!Number.isInteger(scale) || scale < 0 || scale > MAX_DIGITS) throw new RangeError('Invalid decimal scale');
  const negative = coefficient < 0n;
  let digits = (negative ? -coefficient : coefficient).toString();
  if (scale > 0) {
    digits = digits.padStart(scale + 1, '0');
    digits = `${digits.slice(0, -scale)}.${digits.slice(-scale)}`.replace(/0+$/, '').replace(/\.$/, '');
  }
  return `${negative ? '-' : ''}${digits}`;
}

export function normalizeDecimal(value: string): string { return formatDecimal(parseDecimal(value)); }

export function nonNegativeDecimal(value: unknown): string {
  if (typeof value !== 'string') throw new RangeError('Quantity must be an exact decimal string');
  const result = parseDecimal(value);
  if (result.coefficient < 0n) throw new RangeError('Quantity must be non-negative');
  return formatDecimal(result);
}

function align(left: string, right: string): { left: bigint; right: bigint; scale: number } {
  const a = parseDecimal(left); const b = parseDecimal(right); const scale = Math.max(a.scale, b.scale);
  return { left: a.coefficient * 10n ** BigInt(scale - a.scale), right: b.coefficient * 10n ** BigInt(scale - b.scale), scale };
}

export function addDecimals(left: string, right: string): string {
  const values = align(left, right);
  return formatDecimal({ coefficient: values.left + values.right, scale: values.scale });
}

export function subtractDecimals(left: string, right: string): string {
  const values = align(left, right);
  return formatDecimal({ coefficient: values.left - values.right, scale: values.scale });
}

export function compareDecimals(left: string, right: string): -1 | 0 | 1 {
  const values = align(left, right);
  return values.left < values.right ? -1 : values.left > values.right ? 1 : 0;
}

/** Exact finite percentage, or null when division repeats or exceeds the supported precision. */
export function exactPercentageOf(used: string, limit: string): string | null {
  nonNegativeDecimal(used); nonNegativeDecimal(limit);
  const values = align(used, limit);
  if (values.right === 0n) return null;
  let numerator = values.left * 100n;
  let denominator = values.right;
  let a = numerator; let b = denominator;
  while (b !== 0n) { const remainder = a % b; a = b; b = remainder; }
  numerator /= a; denominator /= a;
  let twos = 0; let fives = 0;
  while (denominator % 2n === 0n) { denominator /= 2n; twos++; }
  while (denominator % 5n === 0n) { denominator /= 5n; fives++; }
  const scale = Math.max(twos, fives);
  if (denominator !== 1n || scale > MAX_DIGITS) return null;
  const coefficient = numerator * 2n ** BigInt(scale - twos) * 5n ** BigInt(scale - fives);
  if (coefficient.toString().length > MAX_DIGITS) return null;
  // Recheck the expanded decimal too, including zeroes before a tiny fractional value.
  try { return nonNegativeDecimal(formatDecimal({ coefficient, scale })); } catch { return null; }
}

/** Rounded half up, for display only. A zero denominator has no percentage. */
export function percentageOf(used: string, limit: string, precision = 1): string | null {
  if (!Number.isInteger(precision) || precision < 0 || precision > 6) throw new RangeError('Invalid percentage precision');
  nonNegativeDecimal(used); nonNegativeDecimal(limit);
  const values = align(used, limit);
  if (values.right === 0n) return null;
  const numerator = values.left * 100n * 10n ** BigInt(precision);
  const rounded = (numerator + values.right / 2n) / values.right;
  if (precision === 0) return rounded.toString();
  const digits = rounded.toString().padStart(precision + 1, '0');
  return `${digits.slice(0, -precision)}.${digits.slice(-precision)}`;
}

/** Callers must separately establish that nano AIU maps to AI Credits. */
export function nanoToCredits(nano: string): string {
  if (!/^\d{1,256}$/.test(nano)) throw new RangeError('Invalid nano quantity');
  return formatDecimal({ coefficient: BigInt(nano), scale: 9 });
}
