/**
 * The plans, as data. A plan is a range of fleet sizes with a monthly price; there is no billing yet (nothing charges anyone), so this only says what a fleet of a given
 * size comes to, and what a workspace that has chosen a plan may hold. Prices are whole cents. Pure.
 *
 * The price (Chris, 2026-11-06; docs/PRICING_RESEARCH_2026-11.md): one formula for every size, $99 + $25 a truck on every truck, with a $349 minimum (so 10 trucks is $349, 25 is $724,
 * 49 is $1,324). The plans below differ only in what they hold (trucks, drivers, trailers, seats, storage), not in price per truck, so a fleet that grows never meets a cliff. The Desk
 * includes Signals at every size, so the Desk is never cheaper than Signals alone (Signals is $20 a truck with a $300 minimum, quoted after the Read, never listed here). Enterprise (50 and up)
 * is by agreement: the formula is only where the conversation starts. Pro covers 26 to 49 and Enterprise starts at 50 (the same number the sign-up page sends to a person).
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
  /** Monthly, in cents: the base, then so much for each truck, and the least a month can come to. */
  baseCents: number;
  perTruckCents: number;
  minCents: number;
};

export const PLANS: readonly Plan[] = [
  { key: "starter", label: "Starter", min: 1, max: 10, baseCents: 9900, perTruckCents: 2500, minCents: 34900 },
  { key: "growth", label: "Growth", min: 11, max: 25, baseCents: 9900, perTruckCents: 2500, minCents: 34900 },
  { key: "pro", label: "Pro", min: 26, max: 49, baseCents: 9900, perTruckCents: 2500, minCents: 34900 },
  { key: "enterprise", label: "Enterprise", min: 50, max: null, baseCents: 9900, perTruckCents: 2500, minCents: 34900 }
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

/** What a month costs on a plan for this many trucks, in cents: base plus so much a truck, and never under the plan's minimum. Enterprise is by agreement; this is only its starting point. */
export function monthlyPriceCents(key: PlanKey, trucks: number): number {
  const p = planOf(key);
  return Math.max(p.minCents, p.baseCents + p.perTruckCents * Math.max(0, Math.floor(trucks)));
}

/** What a plan counts and limits. */
export type UnitKind = "truck" | "driver" | "trailer" | "member";
/** What is in use of one limit, for a screen: "2 of 3", and whether the next one would be refused. */
export type UnitUse = { kind: UnitKind; word: string; used: number; limit: number | null; full: boolean };
export const UNIT_WORD: Record<UnitKind, [string, string]> = { truck: ["truck", "trucks"], driver: ["driver", "drivers"], trailer: ["trailer", "trailers"], member: ["seat", "seats"] };
/**
 * People who can sign in to a desk, by plan. A PROPOSAL, for Chris to confirm (2026-11-06: 3 up to 10 trucks so a dispatcher can have an assistant and a carrier a read-only seat). Null is no
 * automatic limit (Enterprise: its agreement says).
 */
export const SEATS: Record<PlanKey, number | null> = { starter: 3, growth: 5, pro: 10, enterprise: null };
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
 * Allowances beyond the counts. PROPOSALS, for Chris to confirm. The storage is for pictures and files on messages. Null is no limit.
 *
 * Rate confirmation reads (a rate confirmation or a dispatch screenshot read by the AI service; the cost per read is in docs/PRICING_RESEARCH_2026-11.md, about 7 to 13 cents at the model in use):
 * the desk includes READS_INCLUDED_PER_TRUCK reads a truck a month, pooled across the desk and counted on the reads that worked (a read that failed is never counted or billed). Past that, a read is
 * OVERAGE_CENTS_PER_READ cents, billed on its own line at the month's end, up to the desk's overage ceiling (OVERAGE_CEILING_DEFAULT_CENTS until a desk sets its own, which needs a stored setting not
 * built yet); at the ceiling reads stop until it is raised, and the form still works on typed values. The daily number is only a burst limit so a Monday batch of rate confirmations is not blocked.
 */
export const READS_INCLUDED_PER_TRUCK = 25;
export const OVERAGE_CENTS_PER_READ = 25;
export const OVERAGE_CEILING_DEFAULT_CENTS = 5_000;
/** The least a desk may read in a day, whatever its size. */
export const BURST_MIN_READS_PER_DAY = 25;
export const RATE_CON_FAILED_READS_PER_DAY = 10;

const wholeTrucks = (trucks: number) => Math.max(1, Math.floor(Number.isFinite(trucks) ? trucks : 0));
/** Reads a month the desk includes: so many a truck, and at least one truck's worth so a new desk with no trucks yet can still read its first rate confirmation. */
export const includedReads = (trucks: number): number => READS_INCLUDED_PER_TRUCK * wholeTrucks(trucks);
/** The most reads a desk may start in a month: those included, plus those its overage ceiling pays for. */
export const hardMonthlyReads = (trucks: number, ceilingCents: number = OVERAGE_CEILING_DEFAULT_CENTS): number => includedReads(trucks) + Math.floor(Math.max(0, ceilingCents) / OVERAGE_CENTS_PER_READ);
/** The daily burst limit: three times the average day of the allowance, and never under BURST_MIN_READS_PER_DAY. */
export const burstReadsPerDay = (trucks: number): number => Math.max(BURST_MIN_READS_PER_DAY, Math.ceil((3 * includedReads(trucks)) / 30));
/** What the month's reads that worked cost over the allowance, in cents (the separate usage line). */
export const overageCents = (workedReads: number, trucks: number): number => Math.max(0, Math.floor(workedReads) - includedReads(trucks)) * OVERAGE_CENTS_PER_READ;
const MB = 1024 * 1024;
export const STORAGE_BYTES: Record<PlanKey, number | null> = { starter: 250 * MB, growth: 1024 * MB, pro: 5 * 1024 * MB, enterprise: null };
export const storageLimit = (key: PlanKey): number | null => STORAGE_BYTES[key];

export const centsText = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: cents % 100 === 0 ? 0 : 2, maximumFractionDigits: 2 })}`;

/** The price in words: "$99 + $25 a truck, $349 minimum". Enterprise is by agreement. */
export function priceText(key: PlanKey): string {
  const p = planOf(key);
  if (key === "enterprise") return "By agreement";
  const formula = p.perTruckCents > 0 ? `${centsText(p.baseCents)} + ${centsText(p.perTruckCents)} a truck` : centsText(p.baseCents);
  return p.minCents > 0 ? `${formula}, ${centsText(p.minCents)} minimum` : formula;
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
