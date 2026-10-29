// VENDORED from TrueLane utils/calculateHelpers.ts @ a3a9c0f4. Do not edit; run scripts/vendor-truelane.mjs.
/**
 * Pure helpers and constants for the Rate Calculator (§8.1).
 * Shared by CalculateScreen and MetricsDisplay.
 */

import { toNumNonNegative } from '@/truelane/lib/formatNumbers';

export const LOADED_MILES_MIN = 0.1;
export const RPH_MIN_HOURS = 0.25;

/**
 * Every load-form number (money, miles, hours, minutes, sizes, stops) is 0 or more: a typed negative
 * reads as 0, so it can never lower the floor or inflate a margin (M8). Commas read as in
 * lib/formatNumbers ("1,5" = 1.5, "1,500" = 1500).
 */
export const toNum = toNumNonNegative;

export function formatRpm(n: number | null): string {
  return n !== null ? `$${n.toFixed(2)}/mi` : '—';
}

export function formatRph(n: number | null): string {
  return n !== null ? `$${n.toFixed(0)}/hr` : '—';
}
