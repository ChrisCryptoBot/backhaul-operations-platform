// VENDORED from TrueLane lib/formatNumbers.ts @ a3a9c0f4. Do not edit; run scripts/vendor-truelane.mjs.
/**
 * Shared numeric parsing and display rounding.
 * Use rounding for revenue/miles in UI to avoid floating-point display issues
 * (SQLite/WatermelonDB store as number; e.g. $100.00 may appear as 99.999999).
 *
 * M-20: helpers exist, but not every display site routes through them — some still use raw
 * `.toFixed(N)`. Known and deferred; the fix is a routing refactor, not a math fix.
 */

/**
 * Typed number text → plain decimal text ("$1,500.25" → "1500.25", "1,5" → "1.5"). How a comma reads:
 * - With a dot too, whichever comes LAST is the decimal point ("1,500.25" and "1.500,25" both = 1500.25).
 * - Alone, a comma is a thousands separator only where it groups three digits after a 1–3 digit whole
 *   part that doesn't start with 0 ("1,500", "12,345", "1,234,567").
 * - Any other single comma is the decimal point — a phone set to a comma locale ("1,5" = 1.5,
 *   "0,125" = 0.125, "12,50" = 12.5). It used to be dropped: "1,5" read as 15.
 */
export function normalizeNumberText(s: string): string {
  const t = s.replace(/[^0-9.,-]/g, '');
  if (!t.includes(',')) return t;
  if (t.includes('.')) {
    return t.lastIndexOf(',') > t.lastIndexOf('.')
      ? t.replace(/\./g, '').replace(',', '.')
      : t.replace(/,/g, '');
  }
  if (/^-?[1-9]\d{0,2}(,\d{3})+$/.test(t)) return t.replace(/,/g, '');
  return (t.match(/,/g) ?? []).length === 1 ? t.replace(',', '.') : t.replace(/,/g, '');
}

/** Typed number text → number, or null when blank / not a number. Commas read as in normalizeNumberText. */
export function parseNumberText(s: string | null | undefined): number | null {
  if (s == null) return null;
  const t = normalizeNumberText(s);
  if (t === '') return null;
  const n = parseFloat(t);
  return Number.isFinite(n) ? n : null;
}

export function toNum(s: string | number | null | undefined): number {
  if (s === null || s === undefined) return 0;
  if (typeof s === 'number') return Number.isFinite(s) ? s : 0;
  return parseNumberText(s) ?? 0;
}

/** For money, miles and per-mile inputs where a negative is invalid: a negative reads as 0. */
export function toNumNonNegative(s: string | number | null | undefined): number {
  const n = toNum(s);
  return n >= 0 ? n : 0;
}

/** Round for currency display (2 decimals). Use before formatting $ values. */
export function roundCurrency(n: number): number {
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

/** Round for miles display (1 decimal). Use before displaying mile values. */
export function roundMiles(n: number): number {
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : 0;
}

/** Round for percentage display (1 decimal). */
export function roundPct(n: number): number {
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : 0;
}

// ─── Percent fields (factoring fee, carrier cut, labor burden, tax reserve) ───
// Entry is ALWAYS a whole percent: "1" = 1%, "0.5" = 0.5%, "3" = 3%. Stored as a fraction (0.01).
// There is no "≤ 1 means a fraction" guess — that rule read "1" as 100%.

/** Values at or above this fraction (50%) are confirmed with the driver before saving. */
export const PERCENT_CONFIRM_THRESHOLD = 0.5;

/** Percent text → fraction (0–1). Blank → null. A lone comma is a decimal point ("2,5" = 2.5%). */
export function parsePercentInput(s: string | null | undefined): number | null {
  if (s == null) return null;
  let t = s.replace(/%/g, '').trim();
  if (t === '') return null;
  if (!t.includes('.') && (t.match(/,/g) ?? []).length === 1) t = t.replace(',', '.');
  const n = parseFloat(t.replace(/[^0-9.-]/g, ''));
  if (!Number.isFinite(n)) return null;
  return clampFraction(n / 100);
}

/** Stored fraction → percent text for an input ("" when unset or 0). 0.01 → "1", 0.035 → "3.5". */
export function formatPercentInput(fraction: number | null | undefined): string {
  if (fraction == null || !Number.isFinite(fraction) || fraction <= 0) return '';
  return String(parseFloat((fraction * 100).toFixed(4)));
}

/** A stored fraction clamped to 0–1 (non-finite → 0). No percent-point guessing. */
export function clampFraction(v: number | null | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(v, 1)) : 0;
}

/** Keystroke filter for a percent field: digits and one decimal point; a comma counts as the point. */
export function cleanPercentText(text: string): string {
  const t = text.replace(/,/g, '.').replace(/[^0-9.]/g, '');
  const i = t.indexOf('.');
  return i < 0 ? t : t.slice(0, i + 1) + t.slice(i + 1).replace(/\./g, '');
}

/** True when a percent is high enough (≥ 50%) that the driver should confirm it before it is saved. */
export function needsPercentConfirm(fraction: number | null | undefined): boolean {
  return fraction != null && Number.isFinite(fraction) && fraction >= PERCENT_CONFIRM_THRESHOLD;
}

// ─── Plausibility (math review round 6, V-03) ───
// A comma-locale phone types "3,899" for a $3.899 fuel price; the parser reads a 1–3 digit group then
// ",ddd" as thousands (3,899). Values outside these ranges are confirmed before they are saved.

export type UnusualValueKind = 'fuelPrice' | 'reservePerMile' | 'mpg' | 'fscPerMile' | 'towingPerMile';

/** Plausible range per field; outside it the driver is asked "Did you mean …?". */
export const UNUSUAL_VALUE_LIMITS: Record<UnusualValueKind, { min?: number; max: number }> = {
  fuelPrice: { max: 15 }, // $/gal
  reservePerMile: { max: 2 }, // maintenance or tire reserve, $/mi
  mpg: { min: 3, max: 30 },
  fscPerMile: { max: 3 }, // fuel surcharge, $ per loaded mile
  towingPerMile: { max: 5 }, // towing adjustment, $/mi
};

/** True when a positive value is outside its field's plausible range (blank / 0 are never unusual). */
export function isUnusualValue(kind: UnusualValueKind, value: number | null | undefined): boolean {
  if (value == null || !Number.isFinite(value) || value <= 0) return false;
  const limits = UNUSUAL_VALUE_LIMITS[kind];
  return value > limits.max || (limits.min != null && value < limits.min);
}

/**
 * The number the text would be if its one comma were a decimal point — only for text the parser read
 * as a thousands group ("3,899" → 3.899, "1,500" → 1.5). Null otherwise.
 */
export function commaDecimalReading(text: string | null | undefined): number | null {
  const t = (text ?? '').replace(/[^0-9.,-]/g, '');
  if (!/^-?[1-9]\d{0,2},\d{3}$/.test(t)) return null;
  const n = parseFloat(t.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}
