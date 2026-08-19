interface MoneyOptions {
  decimals?: number;
}

interface PctOptions {
  fromRatio?: boolean;
  decimals?: number;
}

function toFinite(value: number | null | undefined): number | null {
  if (value === null || value === undefined || Number.isNaN(value) || !Number.isFinite(value)) {
    return null;
  }
  return value;
}

// Force a fixed locale (en-US) + UTC so server and client render identically — a
// bare toLocale*/undefined uses the runtime locale, which mismatches at hydration
// (server US vs a UK/EU browser). Use these everywhere a date/number is rendered.
const NUM_LOCALE = "en-US";

/** Deterministic short date ("Aug 18, 2026") from an ISO string or Date. */
export function formatDay(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString(NUM_LOCALE, { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" });
}

export function money(value: number | null | undefined, options: MoneyOptions = {}): string {
  const safe = toFinite(value);
  if (safe === null) {
    return "—";
  }
  const decimals = options.decimals ?? 2;
  return `$${safe.toLocaleString(NUM_LOCALE, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  })}`;
}

export function rpm(value: number | null | undefined, options: MoneyOptions = {}): string {
  const safe = toFinite(value);
  if (safe === null) {
    return "—";
  }
  const decimals = options.decimals ?? 2;
  return safe.toFixed(decimals);
}

export function miles(value: number | null | undefined, options: MoneyOptions = {}): string {
  const safe = toFinite(value);
  if (safe === null) {
    return "—";
  }
  const decimals = options.decimals ?? 0;
  return safe.toLocaleString(NUM_LOCALE, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  });
}

export function int(value: number | null | undefined): string {
  const safe = toFinite(value);
  if (safe === null) {
    return "—";
  }
  return Math.round(safe).toLocaleString(NUM_LOCALE);
}

export function pct(value: number | null | undefined, options: PctOptions = {}): string {
  const safe = toFinite(value);
  if (safe === null) {
    return "—";
  }
  const decimals = options.decimals ?? 1;
  const normalized = options.fromRatio ? safe * 100 : safe;
  return `${normalized.toFixed(decimals)}%`;
}
