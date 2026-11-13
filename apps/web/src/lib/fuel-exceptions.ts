import type { FuelProduct } from "./fuel-normalize";

/**
 * Fuel exception flags (Wave 5 step 3): what about a fuel purchase deserves a person's look before it is paid, deducted or claimed for fuel tax. Worked out each time from the purchases in view,
 * never stored; a person's "cleared, because..." is kept per purchase AND per flag (FuelFlagReview), so clearing one reason never hides another on the same purchase. Pure.
 *
 * Which purchases each rule reads:
 *   - Declined and voided purchases are never flagged for capacity, duplicates, price or charge: a declined swipe and the settled retry a minute later at the same pump are one fill, not two.
 *   - A pending purchase is read like a settled one for those, so a doubled or overpriced fill is seen before it settles.
 *   - "No state" and "no truck" are flagged on settled purchases only, where they would block fuel tax or a driver statement: a settled road-diesel (or unsaid) purchase with no state cannot be
 *     credited to a jurisdiction, and a settled purchase with no truck is on nobody's statement or fuel-tax return.
 */
export const FLAG_CODES = ["over_capacity", "duplicate", "price_high", "price_low", "charge_mismatch", "discount_over_price", "zero_amount", "non_diesel", "no_state", "no_truck"] as const;
export type FlagCode = (typeof FLAG_CODES)[number];
export const isFlagCode = (v: unknown): v is FlagCode => typeof v === "string" && (FLAG_CODES as readonly string[]).includes(v);

export const FLAG_LABEL: Record<FlagCode, string> = {
  over_capacity: "Over tank size",
  duplicate: "Possible duplicate",
  price_high: "Price high",
  price_low: "Price low",
  charge_mismatch: "Charge does not add up",
  discount_over_price: "Discount over price",
  zero_amount: "Nothing charged",
  non_diesel: "Not diesel",
  no_state: "No state",
  no_truck: "No truck"
};

/** Every threshold in one place, so each can be argued about (and tested) on its own. */
export const FLAG_RULES = {
  /** A fill this much over the truck's typed tank size is flagged (tanks are rarely bone dry, and pumps over-read a little). */
  tankTolerance: 0.05,
  /** Two purchases on one truck are the same fill when this close in time (both have a time), or on the same day (either has none)... */
  duplicateMinutes: 30,
  /** ...and their gallons and charge match within these. */
  duplicateGallons: 0.5,
  duplicateCents: 100,
  /** A price a gallon this far from the middle price is flagged; the middle is the state's for that product when it has enough purchases, else the product's. */
  priceBand: 0.15,
  priceMinSamples: 5,
  /** A charge that misses (price - discount) x gallons by more than the larger of these is flagged. */
  chargeCents: 100,
  chargeShare: 0.02
} as const;

export type FlagRow = {
  id: string;
  vehicleId: string | null;
  /** The truck's typed tank size in gallons, or null when nobody has typed it (the capacity check is then skipped, never guessed). */
  tankGallons: number | null;
  product: FuelProduct | string;
  status: string;
  gallons: number | null;
  amount: number;
  pricePerGallon: number | null;
  discountPerGallon: number | null;
  discount: number | null;
  /** The moment of purchase when known, else null; `day` is always the calendar day. */
  at: number | null;
  day: string;
  state: string | null;
};

export type Flag = { code: FlagCode; detail: string; /** For a duplicate: the other purchase. */ otherId?: string };
export type FlagResult = { flags: Map<string, Flag[]>; /** Road-diesel fills on trucks with no tank size typed: the capacity check could not be made for them. */ tankUnknown: number };

const cents = (n: number) => Math.round(n * 100);
const money = (c: number) => `$${(c / 100).toFixed(2)}`;
const per = (n: number) => `$${n.toFixed(3)}`;
const gal = (n: number) => `${Math.round(n * 10) / 10} gal`;
const live = (r: FlagRow) => r.status !== "declined" && r.status !== "void";
const isDiesel = (p: string) => p === "road_diesel" || p === "reefer_diesel";

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export function fuelFlags(rows: readonly FlagRow[]): FlagResult {
  const flags = new Map<string, Flag[]>();
  const add = (id: string, f: Flag) => {
    const list = flags.get(id) ?? [];
    if (!list.some((x) => x.code === f.code)) list.push(f);
    flags.set(id, list);
  };
  let tankUnknown = 0;

  // Middle prices a gallon: by product, and by product and state.
  const byProduct = new Map<string, number[]>();
  const byState = new Map<string, number[]>();
  for (const r of rows) {
    if (!live(r) || !isDiesel(r.product) || r.pricePerGallon == null || r.pricePerGallon <= 0) continue;
    byProduct.set(r.product, [...(byProduct.get(r.product) ?? []), r.pricePerGallon]);
    if (r.state) byState.set(`${r.product}|${r.state}`, [...(byState.get(`${r.product}|${r.state}`) ?? []), r.pricePerGallon]);
  }
  const middle = new Map<string, { value: number; where: string }>();
  for (const [k, v] of byProduct) if (v.length >= FLAG_RULES.priceMinSamples) middle.set(k, { value: median(v), where: "" });
  for (const [k, v] of byState) if (v.length >= FLAG_RULES.priceMinSamples) middle.set(k, { value: median(v), where: ` in ${k.split("|")[1]}` });

  for (const r of rows) {
    if (r.status === "settled") {
      if (!r.state && (r.product === "road_diesel" || r.product === "unknown")) add(r.id, { code: "no_state", detail: "Fuel tax cannot credit these gallons to a jurisdiction without one." });
      if (!r.vehicleId) add(r.id, { code: "no_truck", detail: "On no driver statement and no truck's fuel-tax record." });
    }
    if (!live(r)) continue;

    if (r.product === "gasoline" || r.product === "other") add(r.id, { code: "non_diesel", detail: r.product === "gasoline" ? "Gasoline on a diesel fleet's card." : "Not fuel the trucks burn (neither diesel, reefer nor DEF)." });
    if (cents(r.amount) <= 0) add(r.id, { code: "zero_amount", detail: "Nothing was charged." });

    if (r.product === "road_diesel" && r.gallons != null && r.vehicleId) {
      if (r.tankGallons == null) tankUnknown += 1;
      else if (r.gallons > r.tankGallons * (1 + FLAG_RULES.tankTolerance)) add(r.id, { code: "over_capacity", detail: `${gal(r.gallons)} into tanks that hold ${gal(r.tankGallons)}.` });
    }

    const ppg = r.pricePerGallon;
    if (ppg != null && ppg > 0) {
      const dpg = r.discountPerGallon ?? 0;
      if (dpg >= ppg || (r.gallons != null && r.discount != null && cents(r.discount) >= cents(ppg * r.gallons))) add(r.id, { code: "discount_over_price", detail: `A discount of ${dpg >= ppg ? `${per(dpg)} a gallon` : money(cents(r.discount ?? 0))} is not less than the price.` });
      else if (r.gallons != null && r.gallons > 0) {
        const expected = r.discountPerGallon != null ? cents((ppg - dpg) * r.gallons) : cents(ppg * r.gallons) - cents(r.discount ?? 0);
        const off = Math.abs(cents(r.amount) - expected);
        if (off > Math.max(FLAG_RULES.chargeCents, Math.round(expected * FLAG_RULES.chargeShare))) add(r.id, { code: "charge_mismatch", detail: `Charged ${money(cents(r.amount))}; the price, discount and gallons come to ${money(expected)}.` });
      }
      if (isDiesel(r.product)) {
        const m = (r.state ? middle.get(`${r.product}|${r.state}`) : undefined) ?? middle.get(r.product);
        if (m) {
          const share = (ppg - m.value) / m.value;
          const what = `${per(ppg)} a gallon, ${Math.round(Math.abs(share) * 100)}% ${share > 0 ? "above" : "below"} the ${per(m.value)} middle for ${r.product === "road_diesel" ? "diesel" : "reefer diesel"}${m.where}.`;
          if (share > FLAG_RULES.priceBand) add(r.id, { code: "price_high", detail: what });
          else if (share < -FLAG_RULES.priceBand) add(r.id, { code: "price_low", detail: what });
        }
      }
    }
  }

  // Duplicates: on one truck, one product, gallons and charge the same, close in time.
  const groups = new Map<string, FlagRow[]>();
  for (const r of rows) {
    if (!live(r) || !r.vehicleId) continue;
    const k = `${r.vehicleId}|${r.product}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const DAY = 86_400_000;
  const when = (r: FlagRow) => r.at ?? Date.parse(`${r.day}T12:00:00Z`);
  for (const list of groups.values()) {
    list.sort((a, b) => when(a) - when(b) || a.id.localeCompare(b.id));
    for (let i = 0; i < list.length; i++) {
      const a = list[i]!;
      for (let j = i + 1; j < list.length && when(list[j]!) - when(a) <= DAY; j++) {
        const b = list[j]!;
        const close = a.at != null && b.at != null ? Math.abs(b.at - a.at) <= FLAG_RULES.duplicateMinutes * 60_000 : a.day === b.day;
        const sameGal = a.gallons == null || b.gallons == null ? a.gallons === b.gallons : Math.abs(a.gallons - b.gallons) <= FLAG_RULES.duplicateGallons;
        if (!close || !sameGal || Math.abs(cents(a.amount) - cents(b.amount)) > FLAG_RULES.duplicateCents) continue;
        const gap = a.at != null && b.at != null ? `${Math.round(Math.abs(b.at - a.at) / 60_000)} min apart` : "on the same day";
        add(a.id, { code: "duplicate", detail: `Same truck, gallons and charge as another purchase ${gap}.`, otherId: b.id });
        add(b.id, { code: "duplicate", detail: `Same truck, gallons and charge as another purchase ${gap}.`, otherId: a.id });
      }
    }
  }

  // Each purchase's flags in one stable order.
  for (const [id, list] of flags) flags.set(id, list.sort((x, y) => FLAG_CODES.indexOf(x.code) - FLAG_CODES.indexOf(y.code)));
  return { flags, tankUnknown };
}
