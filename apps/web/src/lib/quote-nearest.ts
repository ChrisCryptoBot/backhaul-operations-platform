/**
 * Which trucks a quote is priced for. A big fleet has far more trucks than anyone can read, and a truck far from the pickup is never the one to send, so the desk prices the nearest first: the trucks whose
 * empty miles to the pickup are known (measured on the road from each base, or typed), nearest first, then, only to fill the page, trucks with no base on file (priced with the typed empty miles, and said
 * so). A truck with a base that is not among the nearest measured is left out, never priced as if it were as near as the typed figure. With nothing measured at all (no pickup yet, no map) the first trucks
 * by name are priced and the answer says it is not a distance ranking. Pure.
 */
export type NearestTruck = { id: string; name: string | null; /** Whether the truck has a base the distance could be measured from. */ located: boolean };
export type NearestPick = {
  /** The trucks to price, in the order chosen. */
  ids: string[];
  /** "distance" when the order is by empty miles to the pickup; "name" when nothing was measured. */
  ranked: "distance" | "name";
  /** How many trucks could be priced in all (so "show more" knows when to stop). */
  available: number;
  /** How many of those have empty miles to the pickup. */
  measured: number;
};

export const NEAREST_DEFAULT = 25;
export const NEAREST_STEP = 25;
export const NEAREST_MAX = 100;

/** The number of trucks asked for, as a whole number from one step to the most, the default when it is not a number. */
export function asLimit(v: unknown): number {
  const n = typeof v === "number" ? v : Number.parseInt(String(v ?? ""), 10);
  if (!Number.isFinite(n)) return NEAREST_DEFAULT;
  const whole = n - (n % 1);
  return whole < NEAREST_STEP ? NEAREST_STEP : whole > NEAREST_MAX ? NEAREST_MAX : whole;
}

const byName = (a: NearestTruck, b: NearestTruck) => (a.name ?? "").localeCompare(b.name ?? "", "en", { numeric: true }) || a.id.localeCompare(b.id);

export function nearestTrucks(trucks: readonly NearestTruck[], deadhead: Readonly<Record<string, number>>, limit: number): NearestPick {
  const known = (t: NearestTruck) => Number.isFinite(deadhead[t.id]);
  const measured = trucks.filter(known).sort((a, b) => deadhead[a.id]! - deadhead[b.id]! || byName(a, b));
  if (measured.length === 0) {
    const all = [...trucks].sort(byName);
    return { ids: all.slice(0, limit).map((t) => t.id), ranked: "name", available: all.length, measured: 0 };
  }
  const unlocated = trucks.filter((t) => !known(t) && !t.located).sort(byName);
  const order = [...measured, ...unlocated];
  return { ids: order.slice(0, limit).map((t) => t.id), ranked: "distance", available: order.length, measured: measured.length };
}
