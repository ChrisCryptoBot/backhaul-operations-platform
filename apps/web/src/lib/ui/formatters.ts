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

export function money(value: number | null | undefined, options: MoneyOptions = {}): string {
  const safe = toFinite(value);
  if (safe === null) {
    return "—";
  }
  const decimals = options.decimals ?? 2;
  return `$${safe.toLocaleString(undefined, {
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
  return safe.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  });
}

export function int(value: number | null | undefined): string {
  const safe = toFinite(value);
  if (safe === null) {
    return "—";
  }
  return Math.round(safe).toLocaleString();
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
