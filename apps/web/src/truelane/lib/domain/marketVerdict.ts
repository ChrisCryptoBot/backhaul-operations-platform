// VENDORED from TrueLane lib/domain/marketVerdict.ts @ e7c88066. Do not edit; run scripts/vendor-truelane.mjs.
/**
 * Market Variance verdict — layers market position on top of the break-even / route-minimum floor.
 *
 * Affordability is hard. Market is soft and three-tier:
 *   ≤10% under (default band)  → at_market, no gate
 *   >10% and ≤20% under        → negotiate, no gate
 *   >20% under                 → strong_caution, override (acceptGate: 'under_market')
 *
 * Display callers may pass a custom `band` half-width (tight 5% / wide 15%). The 20% strong-caution
 * threshold is fixed. The accept path always calls this with the default 10% band.
 *
 * SEMANTIC only (no colors, no copy). Break-even math in calculators.ts is unchanged.
 */

export type MarketBand =
  | 'below_floor'
  | 'needs_fuel'
  | 'strong_caution'
  | 'negotiate'
  | 'at_market'
  | 'above_market'
  | 'no_benchmark';

/** Pay vs the market alone, before the floor and fuel checks. */
export type MarketRead = 'above_market' | 'at_market' | 'negotiate' | 'strong_caution' | 'no_benchmark';

/** When non-null, accepting requires an explicit override/authorization step (records a reason). */
export type AcceptGate = 'below_floor' | 'needs_fuel' | 'under_market' | 'no_market' | null;

export type MarketVerdict = {
  band: MarketBand;
  /**
   * Pay vs the market on its own, before the floor and fuel checks — the same as `band` whenever the load
   * is above its floor with fuel priced. Under needs_fuel the cards still show it (Negotiate / Strong
   * caution), so a missing MPG doesn't hide "25% under market" (verifier re-pass after round 6).
   */
  marketRead: MarketRead;
  belowFloor: boolean;
  /** 0 ≤ verdict margin < $0.05/mi (RateResult.verdictMarginPerMi) — profitable but thin; an amber sub-warning. */
  thinMargin: boolean;
  /**
   * Profit per trip hour (after fuel, truck cost and driver pay) below the hourly target (V-01). A load
   * can be profitable per mile but a time trap per hour.
   */
  timeTrap: boolean;
  acceptGate: AcceptGate;
};

/**
 * `computeRates` returns decision:'reject' when totalMiles is 0 because its verdict margin is null —
 * that means "floor unknown", not "below floor". Feeding that reject into computeMarketVerdict
 * freezes the banner/card on BELOW FLOOR (red) so offer/market colors never update.
 */
export function isBelowFloorForVerdict(
  finalDecision: 'accept' | 'caution' | 'reject' | 'needs_fuel',
  totalMiles: number
): boolean {
  return totalMiles > 0 && finalDecision === 'reject';
}

export type MarketVerdictInput = {
  /** The load is below its cost floor (the app's `finalDecision === 'reject'`, which also
   *  covers the route-minimum gate). A hard red — market position is moot when you lose money.
   *  Callers must use `isBelowFloorForVerdict` so zero-miles "unknown" is not treated as below floor. */
  belowFloor: boolean;
  /** Profitable but thin: 0–5¢/mi above the verdict floor (the app's `finalDecision === 'caution'`). A
   *  secondary amber sub-warning, shown alongside the market band. */
  thinMargin: boolean;
  /** (offer + fuel surcharge − market total) / market total (lib/domain/marketVariance), or null when no market rate is entered. */
  variancePct: number | null;
  /**
   * Fuel can't be priced and the load clears truck cost + driver pay: no verdict until MPG and a fuel
   * price are set (V-02). Accepting needs an override.
   */
  needsFuel?: boolean;
  /**
   * Profit per trip hour (after fuel, truck cost and driver pay) is below the Cost profile's hourly
   * target (V-01 — it used to compare revenue per hour, before costs).
   */
  belowHourlyTarget?: boolean;
  /** Half-width of the "at market" band (default 0.10 = ±10%). */
  band?: number;
  /**
   * Ignored. A backhaul uses the same market gate as any other load once it is
   * above the cost floor. Kept so existing callers still type-check.
   */
  isBackhaul?: boolean;
};

/** 10q — a rate mathematically at the ±band boundary must not flip on IEEE-754 noise. */
const BAND_EPSILON = 1e-9;
/** Fixed strong-caution threshold — not scaled by the display preset. */
const STRONG_CAUTION = 0.2;

function underMarketBand(
  variancePct: number,
  atMarketHalfWidth: number
): 'negotiate' | 'strong_caution' | 'at_market' {
  if (variancePct >= -atMarketHalfWidth - BAND_EPSILON) return 'at_market';
  if (variancePct >= -STRONG_CAUTION - BAND_EPSILON) return 'negotiate';
  return 'strong_caution';
}

function readMarket(variancePct: number | null, atMarketHalfWidth: number): MarketRead {
  if (variancePct == null) return 'no_benchmark';
  if (variancePct > atMarketHalfWidth + BAND_EPSILON) return 'above_market';
  return underMarketBand(variancePct, atMarketHalfWidth);
}

export function computeMarketVerdict(input: MarketVerdictInput): MarketVerdict {
  const atMarketHalfWidth = input.band ?? 0.1;
  const marketRead = readMarket(input.variancePct, atMarketHalfWidth);
  // A time trap (10ac) is only meaningful above the break-even floor (below floor is already a hard red).
  const timeTrap = !input.belowFloor && !input.needsFuel && (input.belowHourlyTarget ?? false);
  const thinMargin = !input.belowFloor && input.thinMargin;

  // Below the break-even / route-minimum floor is the hard gate — market is moot when you lose money.
  if (input.belowFloor) {
    return { band: 'below_floor', marketRead, belowFloor: true, thinMargin: false, timeTrap: false, acceptGate: 'below_floor' };
  }

  // No fuel price or MPG and the load clears truck cost + driver pay: no verdict, override to accept.
  // marketRead still carries the market position for the cards.
  if (input.needsFuel) {
    return { band: 'needs_fuel', marketRead, belowFloor: false, thinMargin: false, timeTrap: false, acceptGate: 'needs_fuel' };
  }

  // No benchmark: fall back to the break-even verdict and require a market rate before accept.
  if (input.variancePct == null) {
    return {
      band: 'no_benchmark',
      marketRead,
      belowFloor: false,
      thinMargin,
      timeTrap,
      acceptGate: 'no_market',
    };
  }

  if (input.variancePct > atMarketHalfWidth + BAND_EPSILON) {
    return { band: 'above_market', marketRead, belowFloor: false, thinMargin, timeTrap, acceptGate: null };
  }

  const underBand = underMarketBand(input.variancePct, atMarketHalfWidth);
  if (underBand === 'at_market') {
    return { band: 'at_market', marketRead, belowFloor: false, thinMargin, timeTrap, acceptGate: null };
  }
  if (underBand === 'negotiate') {
    return { band: 'negotiate', marketRead, belowFloor: false, thinMargin, timeTrap, acceptGate: null };
  }
  // >20% under: override. A backhaul does not skip this.
  return {
    band: 'strong_caution',
    marketRead,
    belowFloor: false,
    thinMargin,
    timeTrap,
    acceptGate: 'under_market',
  };
}
