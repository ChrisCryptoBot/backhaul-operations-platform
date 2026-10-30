/**
 * The plans, as data. A plan is a range of fleet sizes with a monthly price; there is no billing yet (nothing charges anyone), so this only says what a fleet of a given
 * size comes to, and what a workspace that has chosen a plan may hold. Prices are whole cents. Pure.
 *
 * Readings that are mine and one line to change: Pro covers 11 to 49 and Enterprise starts at 50 (Chris, 2026-10-30; the same number the sign-up page sends to a person), and
 * "$X + $Y a truck" is Y on every truck in the tier, not only on those past the first of it.
 *
 * What a plan holds: its trucks, and twice as many drivers and trailers (a truck has a driver and a trailer, with room for relief drivers and spares). Enterprise has no
 * automatic limit; its contract says. A workspace with no plan chosen is held to Starter, never to "no limit".
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
  { key: "pro", label: "Pro", min: 11, max: 49, baseCents: 19900, perTruckCents: 1200 },
  { key: "enterprise", label: "Enterprise", min: 50, max: null, baseCents: 49900, perTruckCents: 0 }
];

export const isPlanKey = (v: unknown): v is PlanKey => typeof v === "string" && (PLAN_KEYS as readonly string[]).includes(v);
export const planOf = (key: PlanKey): Plan => PLANS.find((p) => p.key === key)!;

/** The plan a workspace is held to: the one chosen, or Starter when none is (or the stored word is not one of ours). */
export const effectivePlan = (plan: string | null | undefined): PlanKey => (isPlanKey(plan) ? plan : "starter");

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

/** What a plan counts and limits. */
export type UnitKind = "truck" | "driver" | "trailer" | "member";
/** What is in use of one limit, for a screen: "2 of 3", and whether the next one would be refused. */
export type UnitUse = { kind: UnitKind; word: string; used: number; limit: number | null; full: boolean };
export const UNIT_WORD: Record<UnitKind, [string, string]> = { truck: ["truck", "trucks"], driver: ["driver", "drivers"], trailer: ["trailer", "trailers"], member: ["seat", "seats"] };
/**
 * People who can sign in to a desk, by plan. A PROPOSAL, for Chris to confirm. Null is no automatic limit (Enterprise: its agreement says).
 */
export const SEATS: Record<PlanKey, number | null> = { starter: 1, growth: 3, pro: 10, enterprise: null };
/** Drivers and trailers a plan holds for each truck it holds. */
export const UNITS_PER_TRUCK = 2;

/** The most of a kind a workspace on this plan may hold; null is no limit. */
export function limitOf(key: PlanKey, kind: UnitKind = "truck"): number | null {
  if (kind === "member") return SEATS[key];
  const trucks = planOf(key).max;
  return trucks == null ? null : kind === "truck" ? trucks : trucks * UNITS_PER_TRUCK;
}
export const truckLimit = (key: PlanKey): number | null => limitOf(key, "truck");
/** All three limits of a plan. */
export const limitsOf = (key: PlanKey) => ({ trucks: limitOf(key, "truck"), drivers: limitOf(key, "driver"), trailers: limitOf(key, "trailer") });

/** The smallest plan that holds this many of a kind. */
export function planHolding(kind: UnitKind, count: number): Plan {
  return PLANS.find((p) => { const l = limitOf(p.key, kind); return l == null || count <= l; }) ?? PLANS[PLANS.length - 1]!;
}

/**
 * Allowances beyond the counts. PROPOSALS, for Chris to confirm: the rate confirmation reads mirror the driver app's own meter (supabase/functions/rate-con-extract/core.ts:
 * 25 a day, 10 failed a day), and the storage is for pictures and files on messages. Null is no limit.
 */
export const RATE_CON_READS_PER_DAY = 25;
/** Reads a day per desk, by plan (spend-guardrails plan; proposals for Chris to confirm). Enterprise is by contract: 100 until one is written. */
export const RATE_CON_READS_BY_PLAN: Record<PlanKey, number> = { starter: 10, growth: 25, pro: 50, enterprise: 100 };
export const rateConReadsPerDay = (plan: string | null | undefined): number => RATE_CON_READS_BY_PLAN[effectivePlan(plan)];
export const RATE_CON_FAILED_READS_PER_DAY = 10;
const MB = 1024 * 1024;
export const STORAGE_BYTES: Record<PlanKey, number | null> = { starter: 250 * MB, growth: 1024 * MB, pro: 5 * 1024 * MB, enterprise: null };
export const storageLimit = (key: PlanKey): number | null => STORAGE_BYTES[key];

export const centsText = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: cents % 100 === 0 ? 0 : 2, maximumFractionDigits: 2 })}`;

/** The price in words: "$199 + $12 a truck", "$49", "$499". */
export function priceText(key: PlanKey): string {
  const p = planOf(key);
  return p.perTruckCents > 0 ? `${centsText(p.baseCents)} + ${centsText(p.perTruckCents)} a truck` : centsText(p.baseCents);
}

/**
 * Whether `adding` more of a kind fit the plan; the message says so when they do not. A workspace with no plan chosen is held to Starter. `current` is what is in service now
 * (trucks not archived, drivers not deactivated, trailers not archived).
 */
export function planAllows(plan: PlanKey | null, current: number, adding = 1, kind: UnitKind = "truck"): { ok: true } | { ok: false; message: string } {
  const key = effectivePlan(plan);
  const limit = limitOf(key, kind);
  if (limit == null || current + adding <= limit) return { ok: true };
  const p = planOf(key);
  const [one, many] = UNIT_WORD[kind];
  const next = planHolding(kind, current + adding);
  const held = kind === "truck" || kind === "member" ? `${limit} ${limit === 1 ? one : many}` : `${limit} ${many} (twice its ${p.max} trucks)`;
  return { ok: false, message: `The ${p.label} plan covers ${held}, and there ${current === 1 ? "is" : "are"} ${current} now. ${next.key === key ? "" : `${current + adding} ${many} is the ${next.label} plan. `}Talk to a person to change the plan.`.replace("  ", " ") };
}
