import { Prisma } from "@prisma/client";
import { CA_PROVINCES, US_STATES } from "@/lib/fuel-normalize";

/**
 * A quarter's IFTA return, worked out (money plan Wave 5 step 6). Pure and exact (Prisma.Decimal throughout, never a float), so the screen, the CSV, the audit and a filed return (steps 7 and 8)
 * all read one answer.
 *
 *   Fleet MPG        = all miles ÷ ALL settled road diesel put in the trucks (tax paid at the pump AND bulk fuel with no tax paid).
 *   Per jurisdiction: taxable gallons = its miles ÷ fleet MPG
 *                     tax-paid gallons = settled road diesel bought there with tax paid
 *                     net = taxable − tax-paid (whole gallons; negative is a credit)
 *                     tax = net × rate            (a credit when net is negative)
 *                     surcharge = taxable × surcharge rate (no credit for fuel bought)
 * Reefer diesel, DEF, gasoline, other, and anything pending, declined or void are not IFTA fuel and count nowhere. A jurisdiction is on the return when it has miles OR tax-paid fuel (a fill in a
 * state the trucks drove no miles in is still a credit, and needs its rate). Canadian fuel and miles are not on it (gap 15): counted and said.
 *
 * Rounding lives in IFTA_ROUNDING and the three helpers below, nowhere else: MPG to 2 places, gallons whole, money to the cent per jurisdiction, then summed. To be confirmed with an accountant
 * before a real filing. With no road diesel at all there is no MPG and no taxable gallons: a blocker, never a made-up MPG.
 */
export const IFTA_ROUNDING = { mpgPlaces: 2, gallonPlaces: 0, moneyPlaces: 2, mode: Prisma.Decimal.ROUND_HALF_UP } as const;
const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
export const roundMpg = (v: Prisma.Decimal.Value) => D(v).toDecimalPlaces(IFTA_ROUNDING.mpgPlaces, IFTA_ROUNDING.mode);
export const roundGallons = (v: Prisma.Decimal.Value) => D(v).toDecimalPlaces(IFTA_ROUNDING.gallonPlaces, IFTA_ROUNDING.mode);
export const roundMoney = (v: Prisma.Decimal.Value) => D(v).toDecimalPlaces(IFTA_ROUNDING.moneyPlaces, IFTA_ROUNDING.mode);

export type ReturnMiles = { vehicleId: string; jurisdiction: string; miles: string; loadedMiles?: string };
export type ReturnFuel = { id: string; vehicleId: string | null; state: string | null; product: string; status: string; taxPaid: boolean; gallons: string | null };
export type ReturnRate = { jurisdiction: string; rate: string; surcharge: string; isSample: boolean };
export type ReturnTruck = { vehicleId: string; name: string | null; method: string | null; source: string | null };

export type BlockerCode = "missing_rate" | "no_fuel" | "no_miles" | "open_flags" | "fuel_no_state" | "fuel_no_truck" | "fuel_unknown_product" | "sample_rates";
export type Blocker = { code: BlockerCode; count: number; /** Jurisdictions or purchase ids the blocker is about. */ items: string[]; text: string };

export type ReturnLine = {
  jurisdiction: string;
  name: string;
  miles: string;
  taxableGallons: string | null;
  taxPaidGallons: string;
  netGallons: string | null;
  rate: string | null;
  surchargeRate: string | null;
  tax: string | null;
  surcharge: string | null;
  total: string | null;
};

export type TruckDetail = {
  vehicleId: string;
  name: string | null;
  /** Where its miles came from: ELD or routed, and the company. Null when it has fuel but no miles. */
  method: string | null;
  source: string | null;
  miles: string;
  milesByState: Array<{ jurisdiction: string; miles: string }>;
  /** All settled road diesel (tax paid and bulk), and the tax-paid part by state. */
  gallons: string;
  bulkGallons: string;
  taxPaidByState: Array<{ jurisdiction: string; gallons: string }>;
  /** Its own miles to the gallon, for checking only (the return uses the fleet's). */
  mpg: string | null;
  purchases: number;
};

export type IftaReturnMath = {
  miles: string;
  gallons: string;
  taxPaidGallons: string;
  bulkGallons: string;
  mpg: string | null;
  lines: ReturnLine[];
  tax: string | null;
  surcharge: string | null;
  total: string | null;
  trucks: TruckDetail[];
  blockers: Blocker[];
  /** Counted and left off: Canadian fuel (gap 15), and purchases that are not IFTA fuel or not settled. */
  notes: { canadaGallons: string; notFuel: number; notSettled: number };
};

const ZERO = () => D(0);
const sum = <T>(xs: readonly T[], f: (x: T) => Prisma.Decimal.Value) => xs.reduce((s, x) => s.plus(f(x)), ZERO());
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Settled road diesel with gallons: the only fuel IFTA counts. */
export const isReturnFuel = (f: Pick<ReturnFuel, "product" | "status" | "gallons">) => f.status === "settled" && f.product === "road_diesel" && f.gallons != null && D(f.gallons).gt(0);

export function iftaReturnMath(input: { miles: readonly ReturnMiles[]; fuel: readonly ReturnFuel[]; rates: readonly ReturnRate[]; trucks: readonly ReturnTruck[]; openFlags: { count: number; ids: string[] } }): IftaReturnMath {
  const miles = input.miles.filter((m) => US_STATES[m.jurisdiction] != null);
  const counted = input.fuel.filter(isReturnFuel);
  const usFuel = counted.filter((f) => f.state == null || CA_PROVINCES[f.state] == null);
  const canada = counted.filter((f) => f.state != null && CA_PROVINCES[f.state] != null);
  const taxPaid = usFuel.filter((f) => f.taxPaid && f.state != null && US_STATES[f.state] != null);

  const totalMiles = sum(miles, (m) => m.miles);
  // All road diesel into the trucks, tax paid or not, Canadian fills aside (their miles are not here either).
  const totalGallons = sum(usFuel, (f) => f.gallons!);
  const mpg = totalGallons.gt(0) && totalMiles.gt(0) ? roundMpg(totalMiles.div(totalGallons)) : null;

  const rates = new Map(input.rates.map((r) => [r.jurisdiction, r]));
  const milesBy = new Map<string, Prisma.Decimal>();
  for (const m of miles) milesBy.set(m.jurisdiction, (milesBy.get(m.jurisdiction) ?? ZERO()).plus(m.miles));
  const paidBy = new Map<string, Prisma.Decimal>();
  for (const f of taxPaid) paidBy.set(f.state!, (paidBy.get(f.state!) ?? ZERO()).plus(f.gallons!));
  const states = [...new Set([...[...milesBy].filter(([, v]) => v.gt(0)).map(([k]) => k), ...[...paidBy].filter(([, v]) => v.gt(0)).map(([k]) => k)])].sort();

  const lines: ReturnLine[] = states.map((j) => {
    const m = milesBy.get(j) ?? ZERO();
    const paid = roundGallons(paidBy.get(j) ?? 0);
    const r = rates.get(j);
    const taxable = mpg ? roundGallons(m.div(mpg)) : totalMiles.isZero() ? ZERO() : null;
    const net = taxable ? taxable.minus(paid) : null;
    const tax = net && r ? roundMoney(net.times(r.rate)) : null;
    const surcharge = taxable && r ? roundMoney(taxable.times(r.surcharge)) : null;
    return {
      jurisdiction: j,
      name: US_STATES[j] ?? j,
      miles: m.toFixed(1),
      taxableGallons: taxable?.toFixed(0) ?? null,
      taxPaidGallons: paid.toFixed(0),
      netGallons: net?.toFixed(0) ?? null,
      rate: r ? D(r.rate).toFixed(4) : null,
      surchargeRate: r ? D(r.surcharge).toFixed(4) : null,
      tax: tax?.toFixed(2) ?? null,
      surcharge: surcharge?.toFixed(2) ?? null,
      total: tax && surcharge ? tax.plus(surcharge).toFixed(2) : null
    };
  });
  const complete = lines.every((l) => l.total != null);
  const tax = complete ? sum(lines, (l) => l.tax!) : null;
  const surcharge = complete ? sum(lines, (l) => l.surcharge!) : null;

  // Blockers: what stands between this answer and a return that can be filed.
  const blockers: Blocker[] = [];
  const missing = states.filter((j) => !rates.has(j));
  if (missing.length > 0) blockers.push({ code: "missing_rate", count: missing.length, items: missing, text: `No tax rate for ${missing.join(", ")}. Import the quarter's rate table.` });
  if (totalMiles.gt(0) && totalGallons.isZero()) blockers.push({ code: "no_fuel", count: 0, items: [], text: "Miles but no settled road diesel: there is no fleet MPG to work taxable gallons from." });
  if (totalMiles.isZero() && totalGallons.gt(0)) blockers.push({ code: "no_miles", count: 0, items: [], text: "Road diesel bought but no miles kept for the quarter. Read ELD miles or route the trucks." });
  if (input.openFlags.count > 0) blockers.push({ code: "open_flags", count: input.openFlags.count, items: input.openFlags.ids, text: `${plural(input.openFlags.count, "fuel purchase has", "fuel purchases have")} an open exception flag. Clear or fix ${input.openFlags.count === 1 ? "it" : "them"} on Fuel.` });
  const ifta = input.fuel.filter((f) => f.status === "settled" && (f.product === "road_diesel" || f.product === "unknown"));
  const noState = ifta.filter((f) => f.state == null).map((f) => f.id);
  if (noState.length > 0) blockers.push({ code: "fuel_no_state", count: noState.length, items: noState, text: `${plural(noState.length, "settled fuel purchase has", "settled fuel purchases have")} no state, so no credit can go to it.` });
  const noTruck = ifta.filter((f) => f.vehicleId == null).map((f) => f.id);
  if (noTruck.length > 0) blockers.push({ code: "fuel_no_truck", count: noTruck.length, items: noTruck, text: `${plural(noTruck.length, "settled fuel purchase is", "settled fuel purchases are")} on no truck.` });
  const unknown = input.fuel.filter((f) => f.status === "settled" && f.product === "unknown").map((f) => f.id);
  if (unknown.length > 0) blockers.push({ code: "fuel_unknown_product", count: unknown.length, items: unknown, text: `${plural(unknown.length, "settled purchase does", "settled purchases do")} not say what was pumped: road diesel or not.` });
  const sample = states.filter((j) => rates.get(j)?.isSample);
  if (sample.length > 0) blockers.push({ code: "sample_rates", count: sample.length, items: sample, text: `Sample rates (made up, not for filing) for ${sample.join(", ")}.` });

  // Per truck: the audit trail behind the fleet numbers.
  const names = new Map(input.trucks.map((t) => [t.vehicleId, t]));
  const truckIds = [...new Set([...miles.map((m) => m.vehicleId), ...usFuel.flatMap((f) => (f.vehicleId ? [f.vehicleId] : []))])];
  const trucks: TruckDetail[] = truckIds
    .map((vehicleId) => {
      const mine = miles.filter((m) => m.vehicleId === vehicleId);
      const fuel = usFuel.filter((f) => f.vehicleId === vehicleId);
      const byState = new Map<string, Prisma.Decimal>();
      for (const m of mine) byState.set(m.jurisdiction, (byState.get(m.jurisdiction) ?? ZERO()).plus(m.miles));
      const paid = new Map<string, Prisma.Decimal>();
      for (const f of fuel.filter((x) => x.taxPaid && x.state != null)) paid.set(f.state!, (paid.get(f.state!) ?? ZERO()).plus(f.gallons!));
      const m = sum(mine, (x) => x.miles);
      const g = sum(fuel, (x) => x.gallons!);
      const t = names.get(vehicleId);
      return {
        vehicleId,
        name: t?.name ?? null,
        method: t?.method ?? null,
        source: t?.source ?? null,
        miles: m.toFixed(1),
        milesByState: [...byState].sort(([a], [b]) => a.localeCompare(b)).map(([jurisdiction, v]) => ({ jurisdiction, miles: v.toFixed(1) })),
        gallons: g.toFixed(3),
        bulkGallons: sum(fuel.filter((x) => !x.taxPaid), (x) => x.gallons!).toFixed(3),
        taxPaidByState: [...paid].sort(([a], [b]) => a.localeCompare(b)).map(([jurisdiction, v]) => ({ jurisdiction, gallons: v.toFixed(3) })),
        mpg: g.gt(0) && m.gt(0) ? roundMpg(m.div(g)).toFixed(2) : null,
        purchases: fuel.length
      };
    })
    .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "") || a.vehicleId.localeCompare(b.vehicleId));

  return {
    miles: totalMiles.toFixed(1),
    gallons: totalGallons.toFixed(3),
    taxPaidGallons: sum(taxPaid, (f) => f.gallons!).toFixed(3),
    bulkGallons: sum(usFuel.filter((f) => !f.taxPaid), (f) => f.gallons!).toFixed(3),
    mpg: mpg?.toFixed(2) ?? null,
    lines,
    tax: tax?.toFixed(2) ?? null,
    surcharge: surcharge?.toFixed(2) ?? null,
    total: tax && surcharge ? tax.plus(surcharge).toFixed(2) : null,
    trucks,
    blockers,
    notes: {
      canadaGallons: sum(canada, (f) => f.gallons!).toFixed(3),
      notFuel: input.fuel.filter((f) => f.status === "settled" && f.product !== "road_diesel" && f.product !== "unknown").length,
      notSettled: input.fuel.filter((f) => f.status !== "settled").length
    }
  };
}

/** When a quarter's return is due: the last day of the month after the quarter ends (Q1 April 30, Q2 July 31, Q3 October 31, Q4 January 31 of the next year). YYYY-MM-DD, or null. */
export function iftaDueDate(quarter: string): string | null {
  const m = /^(\d{4})-Q([1-4])$/.exec(quarter);
  if (!m) return null;
  const q = parseInt(m[2]!, 10);
  const year = parseInt(m[1]!, 10) + (q === 4 ? 1 : 0);
  const month = q === 4 ? 1 : q * 3 + 1; // 1-based
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, "0")}-${String(last).padStart(2, "0")}`;
}

export type RateState = "none" | "sample" | "provisional" | "mixed" | "final";
/** Where the quarter's rate table stands, in one word: none, sample (any sample rate), all provisional, some final, or all final. */
export function rateState(count: number, final: number, sample: number): RateState {
  if (count === 0) return "none";
  if (sample > 0) return "sample";
  if (final === 0) return "provisional";
  return final === count ? "final" : "mixed";
}
export const RATE_STATE_LABEL: Record<RateState, string> = { none: "No rates", sample: "Sample rates", provisional: "Provisional", mixed: "Some final", final: "Final" };

const utcDay = (ymd: string) => Date.UTC(parseInt(ymd.slice(0, 4), 10), parseInt(ymd.slice(5, 7), 10) - 1, parseInt(ymd.slice(8, 10), 10));
/** How far a due date (YYYY-MM-DD) is from today (YYYY-MM-DD, the workspace's own day): whole days left, negative when past due. */
export const daysUntil = (due: string, today: string): number => (utcDay(due) - utcDay(today)) / 86_400_000;

/** Money for the return screen: "$13.80", "-$102.30" (a credit), or a dash. */
export const returnMoney = (s: string | null): string => {
  if (s == null) return "—";
  const neg = s.startsWith("-");
  const abs = D(neg ? s.slice(1) : s).toFixed(2);
  const [whole, cents] = abs.split(".");
  return `${neg ? "-" : ""}$${whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${cents}`;
};
