// VENDORED from TrueLane lib/fuelPriceForRates.ts @ a3a9c0f4. Do not edit; run scripts/vendor-truelane.mjs.
/**
 * Prefer fuel $/gal pinned at Accept when reopening a load (FINALIZATION §10m).
 * Live EIA / profile only win after the user confirms Repin this session.
 */

export type ResolveEffectiveFuelPriceArgs = {
  /** load.fuelBenchmarkPricePerGal when editing; null/≤0 = no pin */
  pinnedGal: number | null | undefined;
  /** liveFuelPrice?.pricePerGallon ?? lastFuelPricePerGallon */
  liveOrProfile: number | null | undefined;
  /** User confirmed Repin? on Refresh while pinned */
  repinConfirmed: boolean;
};

export function isActiveFuelPin(
  pinnedGal: number | null | undefined,
  repinConfirmed: boolean
): boolean {
  return (
    !repinConfirmed &&
    pinnedGal != null &&
    Number.isFinite(pinnedGal) &&
    pinnedGal > 0
  );
}

export function resolveEffectiveFuelPriceForRates(
  args: ResolveEffectiveFuelPriceArgs
): number | null {
  const live =
    args.liveOrProfile != null &&
    Number.isFinite(args.liveOrProfile) &&
    args.liveOrProfile > 0
      ? args.liveOrProfile
      : null;

  if (isActiveFuelPin(args.pinnedGal, args.repinConfirmed)) {
    return args.pinnedGal as number;
  }
  return live;
}

/** Exact badge / card source labels (production finalization Phase B). */
export const FUEL_BADGE_PINNED = 'Pinned at accept';
export const FUEL_BADGE_REGIONAL = 'Regional EIA';

/**
 * The cost profile's live fuel estimate: the line under the Fuel price field and its one action. It states the number's
 * source and week (the field is the driver's own fallback; this never fills it by itself). Null for a price that is not
 * a real price, so $0 is never offered.
 */
export function fuelEstimateCopy(
  fuelType: 'diesel' | 'gasoline',
  period: string,
  pricePerGallon: number
): { text: string; actionLabel: string; value: string } | null {
  if (!Number.isFinite(pricePerGallon) || pricePerGallon <= 0) return null;
  const value = pricePerGallon.toFixed(2);
  const d = /^\d{4}-\d{2}-\d{2}$/.test(period) ? new Date(`${period}T12:00:00Z`) : null;
  const week = d && !Number.isNaN(d.getTime()) ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) : null;
  return {
    text: `US average ${fuelType}${week ? `, week of ${week}` : ''} (EIA)`,
    actionLabel: `Use $${value}`,
    value,
  };
}

/**
 * What fuel adds to the truck cost per mile, for the cost profile's summary: price per gallon over miles per gallon.
 * The price is the driver's own when they typed one, else this week's EIA estimate; the label says which. It is an
 * estimate for the summary only: Calculate works out fuel per load from the load's own miles. Null without a real
 * price and a real MPG. `allInPerMile` is null while there is no truck cost yet.
 */
export function profileFuelPerMile(args: {
  typedPrice: number | null;
  estimatePrice: number | null;
  mpg: number | null;
  /** The MPG is the truck type's typical value, not one set on the vehicle. */
  mpgIsTypical: boolean;
  truckCostPerMile: number;
}): { price: number; source: 'yours' | 'estimate'; mpg: number; fuelPerMile: number; allInPerMile: number | null; label: string } | null {
  const real = (n: number | null | undefined): n is number => n != null && Number.isFinite(n) && n > 0;
  const source = real(args.typedPrice) ? 'yours' : real(args.estimatePrice) ? 'estimate' : null;
  if (!source || !real(args.mpg)) return null;
  const price = (source === 'yours' ? args.typedPrice : args.estimatePrice) as number;
  const fuelPerMile = price / args.mpg;
  const allInPerMile = args.truckCostPerMile > 0 ? Math.round((args.truckCostPerMile + fuelPerMile) * 100) / 100 : null;
  const priceText = `$${price.toFixed(2)}${source === 'estimate' ? ' (EIA)' : ''}`;
  const mpgText = args.mpgIsTypical ? `a typical ${args.mpg} mpg` : `${args.mpg} mpg`;
  return { price, source, mpg: args.mpg, fuelPerMile, allInPerMile, label: `Fuel at ${priceText} and ${mpgText}` };
}

