// VENDORED from TrueLane lib/domain/marketVariance.ts @ a3a9c0f4. Do not edit; run scripts/vendor-truelane.mjs.
/**
 * Market variance — ONE basis for every screen (math audit H4). Calculate compared the offer without
 * the fuel surcharge; Analytics compared offer + FSC + layover per DRIVEN mile; the broker scorecard
 * compared linehaul only. The same load could read "under market" on one screen and "above" on another.
 *
 * The basis, everywhere:
 * - Pay = all-in: linehaul (paid, else agreed) + fuel surcharge. Layover, detention and other
 *   accessorials are not part of a lane rate, so they are left out.
 * - Benchmark = the market rate the driver entered for the lane (a total $), stored as $/mi over the
 *   PLANNED miles, and compared over those same planned miles. Detours after the fact don't move it.
 * - Planned miles = the quote-time snapshot (set when the trip ends), else the working miles.
 * - A TONU has no lane rate to compare; it is left out.
 */
import { linehaul } from './loadEconomics';

export type MarketVarianceLoad = {
  status?: string;
  quotedRevenue: number;
  actualRevenue: number | null;
  fuelSurcharge: number | null;
  marketBenchmark?: number | null;
  pickupDeadheadMiles: number;
  loadedMiles: number;
  returnDeadheadMiles: number;
  quotedPickupDhMiles?: number | null;
  quotedLoadedMiles?: number | null;
  quotedReturnDhMiles?: number | null;
};

const pos = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/** The miles the market rate was entered for: the quote-time snapshot, else the working miles. */
export function benchmarkMiles(l: Omit<MarketVarianceLoad, 'quotedRevenue' | 'actualRevenue' | 'fuelSurcharge' | 'marketBenchmark'>): number {
  const quoted = pos(l.quotedPickupDhMiles) + pos(l.quotedLoadedMiles) + pos(l.quotedReturnDhMiles);
  if (quoted > 0) return quoted;
  return pos(l.pickupDeadheadMiles) + pos(l.loadedMiles) + pos(l.returnDeadheadMiles);
}

/** The market rate as the total $ the driver entered, or null when none was entered. */
export function marketBenchmarkTotal(l: MarketVarianceLoad): number | null {
  const b = pos(l.marketBenchmark);
  const mi = benchmarkMiles(l);
  return b > 0 && mi > 0 ? b * mi : null;
}

/** Below this, a "total" is almost surely a per-mile rate typed into the total field ($2.45 for 850 mi). */
export const MARKET_TOTAL_MIN_RPM = 0.5;
/** Above this over a real trip, the total likely has an extra digit. */
export const MARKET_TOTAL_MAX_RPM = 15;
/** Short local runs can legitimately price above the max per mile, so the high check waits for this. */
export const MARKET_TOTAL_HIGH_CHECK_MILES = 100;

/**
 * A plain-language warning when the market total the driver typed implies an implausible $/mi over the
 * planned miles, else null. Advisory only — the number is still used as entered.
 */
export function marketTotalEntryWarning(total: number, miles: number): string | null {
  if (!(total > 0) || !(miles > 0)) return null;
  const rpm = total / miles;
  const at = `$${rpm.toFixed(2)}/mi over ${Math.round(miles).toLocaleString('en-US')} mi`;
  if (rpm < MARKET_TOTAL_MIN_RPM) return `That’s ${at}. Enter the total $ for the load, not the per-mile rate.`;
  if (rpm > MARKET_TOTAL_MAX_RPM && miles >= MARKET_TOTAL_HIGH_CHECK_MILES) {
    return `That’s ${at}. Check the total — it looks high for this trip.`;
  }
  return null;
}

/** All-in pay for the lane: linehaul (paid when entered, else agreed — loadEconomics) + fuel surcharge. */
export function allInLanePay(l: Pick<MarketVarianceLoad, 'quotedRevenue' | 'actualRevenue' | 'fuelSurcharge'>): number {
  return Math.max(0, linehaul(l)) + pos(l.fuelSurcharge);
}

/** (pay − market total) ÷ market total. Positive = above market. Null without a market total. */
export function marketVariancePct(allInPay: number, benchmarkTotal: number | null): number | null {
  if (benchmarkTotal == null || !(benchmarkTotal > 0) || !Number.isFinite(allInPay)) return null;
  return (allInPay - benchmarkTotal) / benchmarkTotal;
}

export type LoadMarketVariance = {
  /** All-in pay ($) and the market total ($) over the same planned miles. */
  pay: number;
  benchmarkTotal: number;
  miles: number;
  /** Market rate, $/planned mile. */
  benchmarkRpm: number;
  /** All-in pay, $/planned mile. */
  payRpm: number;
  /** payRpm − benchmarkRpm. */
  varianceRpm: number;
  /** (pay − market total) ÷ market total. */
  variancePct: number;
};

/** A saved load's variance, or null when it has no benchmark, no miles, or is a TONU. */
export function loadMarketVariance(l: MarketVarianceLoad): LoadMarketVariance | null {
  if (l.status === 'tonu') return null;
  const total = marketBenchmarkTotal(l);
  if (total == null) return null;
  const miles = benchmarkMiles(l);
  const pay = allInLanePay(l);
  const benchmarkRpm = total / miles;
  const payRpm = pay / miles;
  return {
    pay,
    benchmarkTotal: total,
    miles,
    benchmarkRpm,
    payRpm,
    varianceRpm: payRpm - benchmarkRpm,
    variancePct: (pay - total) / total,
  };
}
