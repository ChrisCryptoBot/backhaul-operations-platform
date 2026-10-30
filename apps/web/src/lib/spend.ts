/**
 * What the desk may spend on paid services, and the rule that decides a claim. Pure: no database, no network (server/tl/usage.ts reads the counts and calls `decideClaim`).
 *
 * The numbers are the spend-guardrails plan's (docs/platform/SPEND_GUARDRAILS.md). The desk's own database is separate from the phone backend's, so it keeps its own ledger
 * (the ServiceUsage table) with the same rule as the phone's public.ops_claim_spend: ask BEFORE the paid call, one caller at a time, a refusal costs nothing.
 * Mapbox cannot be capped at the provider (its own FAQ says so), so for Mapbox these ceilings are the only cap there is.
 */
export type UsageService = "anthropic_desk" | "mapbox_geocode" | "mapbox_directions" | "mapbox_permanent";

export type UsageLimits = {
  /** Units this one desk may use in a UTC day / month. null (or left out) is no limit for that window. */
  workspaceDay?: number | null;
  workspaceMonth?: number | null;
  /** Units every desk together may use in a UTC day / month, and the month's estimated cents. */
  globalDay?: number | null;
  globalMonth?: number | null;
  globalMonthCents?: number | null;
};

export type UsageRefusal = "workspace_day" | "workspace_month" | "global_day" | "global_month" | "global_month_cents" | "error";

/**
 * The ceilings. `estCents` is what one unit is estimated to cost (whole cents, rounded up), used only for the monthly dollar ceiling.
 *  - anthropic_desk: a rate-confirmation read, about 8 cents (the phone's own estimate is 5-8). Per desk per day comes from the plan (lib/plans.ts); everyone together: 60 reads a day and $25 a month
 *    (the desk's own Anthropic workspace is capped at $25 in the Console, so this stops first).
 *  - mapbox_geocode / mapbox_directions: temporary geocoding and routing. Free tier is 100,000 of each a month; the ceiling is 60,000 of each for everyone (60%), so an overage is not possible by accident.
 *  - mapbox_permanent: geocoding whose result is stored. NO free tier (about 0.5 cent each); 150 a day per desk and 3,000 a month for everyone (about $15).
 */
export const SPEND: Record<UsageService, { estCents: number; limits: UsageLimits }> = {
  anthropic_desk: { estCents: 8, limits: { globalDay: 60, globalMonthCents: 2_500 } },
  mapbox_geocode: { estCents: 0, limits: { workspaceDay: 800, globalDay: 3_000, globalMonth: 60_000 } },
  mapbox_directions: { estCents: 0, limits: { workspaceDay: 700, globalDay: 3_000, globalMonth: 60_000 } },
  mapbox_permanent: { estCents: 1, limits: { workspaceDay: 150, globalMonth: 3_000 } }
};

/** The services a person can switch off from the environment (DESK_SERVICES_OFF=mapbox_geocode,anthropic_desk), the desk's kill switch. Names are exact; "all" turns every one off. */
export function switchedOff(service: UsageService, env: string | undefined): boolean {
  const list = (env ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return list.includes("all") || list.includes(service);
}

export type Counts = { workspaceDay: number; workspaceMonth: number; globalDay: number; globalMonth: number; globalMonthCents: number };

/** Whether `units` more (costing `estCents` more) fit under every limit that is set, given what has already been used. Windows are checked narrowest first. */
export function decideClaim(counts: Counts, limits: UsageLimits, units: number, estCents: number): { ok: true } | { ok: false; reason: UsageRefusal } {
  const u = Math.max(1, units);
  if (limits.workspaceDay != null && counts.workspaceDay + u > limits.workspaceDay) return { ok: false, reason: "workspace_day" };
  if (limits.workspaceMonth != null && counts.workspaceMonth + u > limits.workspaceMonth) return { ok: false, reason: "workspace_month" };
  if (limits.globalDay != null && counts.globalDay + u > limits.globalDay) return { ok: false, reason: "global_day" };
  if (limits.globalMonth != null && counts.globalMonth + u > limits.globalMonth) return { ok: false, reason: "global_month" };
  if (limits.globalMonthCents != null && counts.globalMonthCents + Math.max(0, estCents) > limits.globalMonthCents) return { ok: false, reason: "global_month_cents" };
  return { ok: true };
}

/** UTC day and month starts (the ledger's windows, the same as the phone backend's). */
export function windowStarts(now: Date): { day: Date; month: Date } {
  return { day: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())), month: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)) };
}

/** What to say when a claim is refused: the desk's own allowance ("tomorrow") or everyone's ("busy"). */
export const refusalText = (reason: UsageRefusal): string =>
  reason === "workspace_day" || reason === "workspace_month"
    ? "This desk has used its allowance for that lookup today. Try again tomorrow."
    : "That lookup is busy right now. Try again later, or type the value.";
