/**
 * The plans, as data. A plan is a range of fleet sizes with a monthly price; there is no billing yet (nothing charges anyone), so this only says what a fleet of a given
 * size comes to, and what a workspace that has chosen a plan may hold. Prices are whole cents. Pure.
 *
 * Readings that are mine and one line to change: the tiers leave 26 to 74 trucks between "growth, up to 10" and "enterprise, 75 and up", so Pro covers 11 to 74; and
 * "$X + $Y a truck" is Y on every truck in the tier, not only on those past the first of it.
 */
export const PLAN_KEYS = ["starter", "growth", "pro", "enterprise"] as const;
export type PlanKey = (typeof PLAN_KEYS)[number];

export type Plan = {
  key: PlanKey;
  label: string;
  /** The fewest and the most trucks on the plan; null is no upper limit. */
  min: number;
  max: number | null;
  /** Monthly, in cents: the base, then so much for each truck. */
  baseCents: number;
  perTruckCents: number;
};

export const PLANS: readonly Plan[] = [
  { key: "starter", label: "Starter", min: 1, max: 3, baseCents: 4900, perTruckCents: 0 },
  { key: "growth", label: "Growth", min: 4, max: 10, baseCents: 9900, perTruckCents: 1500 },
  { key: "pro", label: "Pro", min: 11, max: 74, baseCents: 19900, perTruckCents: 1200 },
  { key: "enterprise", label: "Enterprise", min: 75, max: null, baseCents: 49900, perTruckCents: 0 }
];

export const isPlanKey = (v: unknown): v is PlanKey => typeof v === "string" && (PLAN_KEYS as readonly string[]).includes(v);
export const planOf = (key: PlanKey): Plan => PLANS.find((p) => p.key === key)!;

/** The plan a fleet of this many trucks falls in (none, or fewer than one, is Starter). */
export function planForTruckCount(trucks: number): Plan {
  const n = Math.max(0, Math.floor(trucks));
  return PLANS.find((p) => n >= p.min && (p.max == null || n <= p.max)) ?? PLANS[0]!;
}

/** What a month costs on a plan for this many trucks, in cents. */
export function monthlyPriceCents(key: PlanKey, trucks: number): number {
  const p = planOf(key);
  return p.baseCents + p.perTruckCents * Math.max(0, Math.floor(trucks));
}

/** The most trucks a workspace on this plan may hold; null is no limit. */
export const truckLimit = (key: PlanKey): number | null => planOf(key).max;

export const centsText = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: cents % 100 === 0 ? 0 : 2, maximumFractionDigits: 2 })}`;

/** The price in words: "$199 + $12 a truck", "$49", "$499". */
export function priceText(key: PlanKey): string {
  const p = planOf(key);
  return p.perTruckCents > 0 ? `${centsText(p.baseCents)} + ${centsText(p.perTruckCents)} a truck` : centsText(p.baseCents);
}

/** Whether one more truck (or `adding`) fits the plan; the message says so when it does not. A workspace with no plan chosen has no limit. */
export function planAllows(plan: PlanKey | null, current: number, adding = 1): { ok: true } | { ok: false; message: string } {
  if (!plan) return { ok: true };
  const limit = truckLimit(plan);
  if (limit == null || current + adding <= limit) return { ok: true };
  const p = planOf(plan);
  const next = planForTruckCount(current + adding);
  return { ok: false, message: `The ${p.label} plan covers ${limit} ${limit === 1 ? "truck" : "trucks"}, and there ${current === 1 ? "is" : "are"} ${current} now. ${next.key === plan ? "" : `${current + adding} trucks is the ${next.label} plan. `}A larger plan is needed to add more.`.replace("  ", " ") };
}
