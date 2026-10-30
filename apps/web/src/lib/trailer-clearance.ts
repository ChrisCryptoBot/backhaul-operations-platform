/** Trailer states a dispatcher sets by hand. "On a load" is read from the open loads, not stored. */
export const TRAILER_STATUSES = [
  { key: "available", label: "Available" },
  { key: "in_shop", label: "In the shop" },
  { key: "out_of_service", label: "Out of service" }
] as const;
export type TrailerStatus = (typeof TRAILER_STATUSES)[number]["key"];
export const statusLabel = (s: string | null | undefined) => TRAILER_STATUSES.find((x) => x.key === s)?.label ?? s ?? "";

export type TrailerCompliance = { status: string; registrationExpiry: Date | null; inspectionExpiry: Date | null };

/**
 * Pure: why a trailer cannot be put on a load today, or null. In the shop, out of service, a lapsed registration or a lapsed inspection each block it, as a lapsed
 * CDL or medical card blocks a driver (lib/clearance.ts).
 */
export function trailerBlocker(t: TrailerCompliance, now = new Date()): string | null {
  if (t.status === "in_shop") return "In the shop";
  if (t.status === "out_of_service") return "Out of service";
  if (t.registrationExpiry && t.registrationExpiry.getTime() < now.getTime()) return "Registration expired";
  if (t.inspectionExpiry && t.inspectionExpiry.getTime() < now.getTime()) return "Inspection expired";
  return null;
}

const DAY = 86_400_000;

/** Pure: the first of a trailer's two dates to lapse within `days` (and not lapsed yet), or null. */
export function trailerClearanceSoon(t: Pick<TrailerCompliance, "registrationExpiry" | "inspectionExpiry">, now: Date, days: number): { what: string; on: Date; inDays: number } | null {
  const dates: Array<{ what: string; on: Date | null }> = [
    { what: "registration", on: t.registrationExpiry },
    { what: "inspection", on: t.inspectionExpiry }
  ];
  const soon = dates.filter((c): c is { what: string; on: Date } => c.on != null && c.on.getTime() >= now.getTime() && c.on.getTime() - now.getTime() <= days * DAY).sort((a, b) => a.on.getTime() - b.on.getTime())[0];
  return soon ? { what: soon.what, on: soon.on, inDays: Math.ceil((soon.on.getTime() - now.getTime()) / DAY) } : null;
}

/** "ok" (nothing lapsed or due), "soon" (a date within `days`) or "lapsed", for the list's filter and chip. A status block is not a compliance state. */
export function complianceState(t: Pick<TrailerCompliance, "registrationExpiry" | "inspectionExpiry">, now: Date, days: number): "ok" | "soon" | "lapsed" {
  const lapsed = [t.registrationExpiry, t.inspectionExpiry].some((d) => d != null && d.getTime() < now.getTime());
  if (lapsed) return "lapsed";
  return trailerClearanceSoon(t, now, days) ? "soon" : "ok";
}
