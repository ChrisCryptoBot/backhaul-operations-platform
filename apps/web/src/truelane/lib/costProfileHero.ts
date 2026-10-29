// VENDORED from TrueLane lib/costProfileHero.ts @ a3a9c0f4. Do not edit; run scripts/vendor-truelane.mjs.
/**
 * The cost profile's hero card: the numbers it can show and how each reads. The card is the first thing the driver sees
 * on the cost profile, and fuel sets the market, so when a fuel price is known it opens on truck cost + fuel; without
 * one it opens on the truck cost alone and says "before fuel". The driver can move between the others.
 *
 * Pure: no React, no storage. It invents no number: every page is a figure the screen already works out (the truck cost
 * per mile, the bills-only per mile, the fuel estimate from `profileFuelPerMile`) or that figure times the miles.
 * Fuel here is an estimate for this summary; Calculate works out fuel per load from the load's own miles.
 */
import type { profileFuelPerMile } from './fuelPriceForRates';

export type HeroMetricKey = 'all_in' | 'truck' | 'fuel' | 'bills' | 'monthly';

export type HeroMetric = {
  key: HeroMetricKey;
  /** The small heading above the number. */
  kicker: string;
  /** The number, formatted ("$0.68", "$4,760"). */
  value: string;
  /** Beside the number ("/mi", "/mo"). */
  unit: string;
  /** Under the rule, left: where the number comes from. */
  sub: string;
  /** Under the rule, right: the unit line ("$/mi, before fuel"). */
  note: string;
};

const perMile = (n: number) => `$${n.toFixed(2)}`;
const whole = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;

export function costProfileHeroMetrics(args: {
  /** Fixed bills + maintenance + tires, per mile (before fuel). */
  truckCostPerMile: number;
  /** The fixed bills alone, per mile. */
  billsPerMile: number;
  estimatedMiles: number;
  /** The miles field as typed, for the "Based on 7000 mi/mo" line. */
  milesText: string;
  fuel: ReturnType<typeof profileFuelPerMile>;
}): HeroMetric[] {
  const { truckCostPerMile, billsPerMile, estimatedMiles, fuel } = args;
  if (!(estimatedMiles > 0)) return [];
  const miles = args.milesText.trim() || String(estimatedMiles);
  const out: HeroMetric[] = [];
  const allIn = fuel?.allInPerMile ?? null;

  if (fuel && allIn != null) {
    out.push({
      key: 'all_in',
      kicker: 'Truck cost + fuel per mile',
      value: perMile(allIn),
      unit: '/mi',
      sub: `Truck ${perMile(truckCostPerMile)} + fuel ${perMile(fuel.fuelPerMile)}`,
      note: '$/mi, with fuel',
    });
  }
  out.push({
    key: 'truck',
    kicker: 'Truck cost per mile',
    value: perMile(truckCostPerMile),
    unit: '/mi',
    sub: `Based on ${miles} mi/mo estimate`,
    note: '$/mi, before fuel',
  });
  if (fuel) {
    out.push({ key: 'fuel', kicker: 'Fuel per mile', value: perMile(fuel.fuelPerMile), unit: '/mi', sub: fuel.label, note: '$/mi, estimate' });
  }
  out.push({
    key: 'bills',
    kicker: 'Bills only, per mile',
    value: perMile(billsPerMile),
    unit: '/mi',
    sub: `Fixed bills ÷ ${miles} mi, before maintenance, tires and fuel`,
    note: '$/mi, bills only',
  });
  if (allIn != null) {
    out.push({
      key: 'monthly',
      kicker: 'Cost to run per month, with fuel',
      value: whole(allIn * estimatedMiles),
      unit: '/mo',
      sub: `${miles} mi × ${perMile(allIn)}`,
      note: '$/month, estimate',
    });
  } else {
    out.push({
      key: 'monthly',
      kicker: 'Truck cost per month',
      value: whole(truckCostPerMile * estimatedMiles),
      unit: '/mo',
      sub: `${miles} mi × ${perMile(truckCostPerMile)}, before fuel`,
      note: '$/month, before fuel',
    });
  }
  return out;
}

export type BuildUpLine = {
  key: 'insurance' | 'other_fixed' | 'maintenance_tires' | 'truck' | 'fuel' | 'all_in';
  label: string;
  value: string;
  /** A total: the line the parts above it add up to. */
  strong?: boolean;
};

/**
 * The breakdown under the hero card. Collapsed it is ONE line, headed by the number that matters most: truck cost + fuel
 * when a fuel price is known (fuel sets the market), else the truck cost before fuel. Opened it shows what builds that
 * number, in the order it is spent: insurance, the other fixed bills, maintenance and tires, the truck cost they add up
 * to, then fuel. The header is not repeated as a row. It repeats nothing else the card holds: not the month, not the
 * bills-only figure, not an echo of the hourly pay target. A part that is zero is left out.
 * `sub` is the second line shown while collapsed. Null with no miles (the card shows its placeholder).
 */
export function costBuildUp(args: {
  insuranceMonthly: number;
  /** Every fixed bill per month, insurance included. */
  fixedMonthly: number;
  estimatedMiles: number;
  maintenancePerMile: number;
  tiresPerMile: number;
  truckCostPerMile: number;
  fuel: ReturnType<typeof profileFuelPerMile>;
}): { total: BuildUpLine; sub: string; lines: BuildUpLine[] } | null {
  if (!(args.estimatedMiles > 0)) return null;
  const miles = args.estimatedMiles;
  const insurance = Math.max(0, args.insuranceMonthly);
  const other = Math.max(0, args.fixedMonthly - insurance);
  const upkeep = Math.max(0, args.maintenancePerMile) + Math.max(0, args.tiresPerMile);
  const mi = (n: number) => `$${n.toFixed(2)}/mi`;
  const truck: BuildUpLine = { key: 'truck', label: 'Truck cost per mile (before fuel)', value: mi(args.truckCostPerMile), strong: true };
  const allIn: BuildUpLine | null =
    args.fuel && args.fuel.allInPerMile != null
      ? { key: 'all_in', label: 'Truck cost + fuel per mile', value: `≈ ${mi(args.fuel.allInPerMile)}`, strong: true }
      : null;
  const total = allIn ?? truck;

  const lines: BuildUpLine[] = [];
  if (insurance > 0) lines.push({ key: 'insurance', label: `Insurance (${whole(insurance)}/mo)`, value: mi(insurance / miles) });
  if (other > 0) lines.push({ key: 'other_fixed', label: `Other fixed bills (${whole(other)}/mo)`, value: mi(other / miles) });
  if (upkeep > 0) lines.push({ key: 'maintenance_tires', label: 'Maintenance + tires', value: mi(upkeep) });
  if (total.key !== 'truck') lines.push(truck);
  if (args.fuel) lines.push({ key: 'fuel', label: args.fuel.label, value: `≈ ${mi(args.fuel.fuelPerMile)}` });

  const parts = [`Fixed bills ${whole(args.fixedMonthly)}/mo`];
  if (upkeep > 0) parts.push(`maintenance + tires ${mi(upkeep)}`);
  return { total, sub: parts.join(', '), lines };
}
