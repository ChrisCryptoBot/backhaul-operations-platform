/**
 * Relays: the rules for a handoff (the baton) between two drivers on one load (docs/RELAY_DESIGN.md, docs/BATON_CONTRACT_V3.md). Pure: the server, the screens and the tests all read this.
 * A load is the commercial contract; a leg is one driver's span of it; a baton closes one leg and opens the next. Between a drop and a hook nobody holds the load: it is "in the yard".
 */
export const HANDOFF_TYPES = ["drop_hook", "rescue", "slip_seat"] as const;
export type HandoffType = (typeof HANDOFF_TYPES)[number];
export const HANDOFF_TYPE_LABEL: Record<HandoffType, string> = { drop_hook: "Drop and hook at a yard", rescue: "Breakdown rescue", slip_seat: "Driver swap, same truck" };

export const HANDOFF_REASONS = ["planned", "hos", "breakdown", "recall_convert"] as const;
export type HandoffReason = (typeof HANDOFF_REASONS)[number];
export const HANDOFF_REASON_LABEL: Record<HandoffReason, string> = { planned: "Planned", hos: "Out of hours", breakdown: "Breakdown", recall_convert: "Recalled while rolling" };

export const OUTGOING_NEXT = ["bobtail", "hook_empty", "return_load", "available_at_yard"] as const;
export type OutgoingNext = (typeof OUTGOING_NEXT)[number];
export const OUTGOING_NEXT_LABEL: Record<OutgoingNext, string> = { bobtail: "Bobtails to a hotel or home", hook_empty: "Hooks an empty trailer", return_load: "Picks up a return load", available_at_yard: "Available at the yard" };

export const LOCATION_SET_BY = ["planned_yard", "emergency_pin", "dispatcher_typed"] as const;
export type LocationSetBy = (typeof LOCATION_SET_BY)[number];

export type HandoffState = "dropped" | "received" | "disputed" | "cancelled";
export const HANDOFF_STATE_LABEL: Record<HandoffState, string> = { dropped: "Awaiting handoff", received: "Received", disputed: "Disputed", cancelled: "Cancelled" };

export type MilesSource = "eld" | "driver" | "dispatcher";
export type LegMilesSource = MilesSource | "remainder";
export const MILES_SOURCES: readonly MilesSource[] = ["eld", "driver", "dispatcher"];

const has = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === "string" && (list as readonly string[]).includes(v);
export const isHandoffType = (v: unknown): v is HandoffType => has(HANDOFF_TYPES, v);
export const isHandoffReason = (v: unknown): v is HandoffReason => has(HANDOFF_REASONS, v);
export const isOutgoingNext = (v: unknown): v is OutgoingNext => has(OUTGOING_NEXT, v);
export const isLocationSetBy = (v: unknown): v is LocationSetBy => has(LOCATION_SET_BY, v);

/** What a dispatcher (or, later, a phone) gives when a driver drops the load. */
export type DropInput = {
  type: unknown;
  reason: unknown;
  locationName?: string | null;
  lat?: number | null;
  lng?: number | null;
  slot?: string | null;
  locationSetBy?: unknown;
  outgoingNext: unknown;
  sealNumber?: string | null;
  reeferSetTemp?: number | null;
  reeferActualTemp?: number | null;
  reeferFuelPct?: number | null;
  conditionOk?: boolean | null;
  conditionNotes?: string | null;
  /** Miles the outgoing driver covered on their leg, with where the figure came from. Neither is a guess: both or neither. */
  milesDriven?: number | null;
  milesSource?: unknown;
  /** Required when outgoing driver's pay kind is `flat` (Phase 3): this driver's set dollar amount for their leg. */
  flatPay?: number | null;
};

export type Problem = { field: string; message: string };

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/** What is wrong with a drop, in the order a person fills it in. Empty means it can be recorded. */
export function dropProblems(i: DropInput): Problem[] {
  const out: Problem[] = [];
  if (!isHandoffType(i.type)) out.push({ field: "type", message: "Pick what kind of handoff this is." });
  if (!isHandoffReason(i.reason)) out.push({ field: "reason", message: "Pick why the load is changing hands." });
  const named = (i.locationName ?? "").trim().length > 0;
  const pinned = finite(i.lat) && finite(i.lng);
  if (!named && !pinned) out.push({ field: "location", message: "Say where the load was handed off: a name, or a pin." });
  if ((i.lat != null) !== (i.lng != null)) out.push({ field: "location", message: "A pin needs both a latitude and a longitude." });
  if (finite(i.lat) && (i.lat < -90 || i.lat > 90)) out.push({ field: "location", message: "That latitude is not on the map." });
  if (finite(i.lng) && (i.lng < -180 || i.lng > 180)) out.push({ field: "location", message: "That longitude is not on the map." });
  if (i.locationSetBy != null && !isLocationSetBy(i.locationSetBy)) out.push({ field: "location", message: "That is not a way a location is set." });
  // Edge case A: the outgoing driver is never left in limbo. A drop says what they do now.
  if (!isOutgoingNext(i.outgoingNext)) out.push({ field: "outgoingNext", message: "Say what the outgoing driver does now." });
  if (i.milesDriven != null) {
    if (!finite(i.milesDriven) || i.milesDriven < 0 || i.milesDriven > 5000) out.push({ field: "miles", message: "Miles driven must be between 0 and 5,000." });
    if (!has(MILES_SOURCES, i.milesSource)) out.push({ field: "miles", message: "Say where the miles came from: the ELD, the driver, or you." });
  } else if (i.milesSource != null) out.push({ field: "miles", message: "A source with no miles. Enter the miles or clear the source." });
  if (i.reeferFuelPct != null && (!Number.isInteger(i.reeferFuelPct) || i.reeferFuelPct < 0 || i.reeferFuelPct > 100)) out.push({ field: "reefer", message: "Reefer fuel is a whole percent from 0 to 100." });
  for (const t of [i.reeferSetTemp, i.reeferActualTemp]) if (t != null && (!finite(t) || t < -60 || t > 120)) out.push({ field: "reefer", message: "A reefer temperature must be between -60 and 120." });
  if (i.flatPay != null && (!finite(i.flatPay) || i.flatPay <= 0 || i.flatPay > 20000)) out.push({ field: "flatPay", message: "Flat leg pay must be between $0.01 and $20,000." });
  return out;
}

/** What is wrong with taking custody of a dropped baton. The same truck for a swap; a different truck for a hook or a rescue; always a different driver. */
export function receiveProblems(h: { type: string; tractorOutId: string | null; outDriverId: string | null; state: string; discrepancyFlagged: boolean; ackAt: Date | null }, i: { driverId: string; vehicleId?: string | null }): Problem[] {
  const out: Problem[] = [];
  if (h.state === "received") out.push({ field: "state", message: "This handoff was already received." });
  if (h.state === "cancelled") out.push({ field: "state", message: "This handoff was cancelled." });
  if (h.discrepancyFlagged && !h.ackAt) out.push({ field: "state", message: "A discrepancy was reported. Dispatch has to acknowledge it before anyone takes the load." });
  else if (h.state === "disputed") out.push({ field: "state", message: "Acknowledge the dispute on this handoff before anyone takes the load." });
  if (!i.driverId) out.push({ field: "driver", message: "Pick the driver taking the load." });
  else if (h.outDriverId && i.driverId === h.outDriverId) out.push({ field: "driver", message: "That is the driver who dropped it. Pick the next driver." });
  if (h.type === "slip_seat") {
    if (i.vehicleId && h.tractorOutId && i.vehicleId !== h.tractorOutId) out.push({ field: "vehicle", message: "A driver swap keeps the same truck." });
  } else {
    if (!i.vehicleId) out.push({ field: "vehicle", message: "Pick the truck that is taking the trailer." });
    else if (h.tractorOutId && i.vehicleId === h.tractorOutId) out.push({ field: "vehicle", message: "A hook or a rescue is a different truck. Use a driver swap to keep the same one." });
  }
  return out;
}

/** The pay for a leg that was only positioning (a driver recalled while rolling empty to the pickup): the driver's own cents-a-mile times the miles driven, or null when either is not known. Never a guess. */
export function positioningPayEstimate(milesDriven: number | null | undefined, rateCpm: number | null | undefined): number | null {
  if (!finite(milesDriven) || !finite(rateCpm) || milesDriven < 0 || rateCpm <= 0) return null;
  return Math.round(milesDriven * rateCpm * 100) / 100;
}

/**
 * Estimate pay for one relay leg (Phase 3):
 * - cpm -> leg miles x rate
 * - percent -> rateConTotal x rate% x leg miles / loaded miles
 * - hourly -> null (entered on the settlement)
 * - flat -> flat leg rate
 */
export function legPayEstimate(
  payKind: string | null | undefined,
  payRate: number | null | undefined,
  legMiles: number | null | undefined,
  loadedMiles: number | null | undefined,
  rateConTotal: number | null | undefined
): number | null {
  if (!finite(payRate) || payRate <= 0) return null;
  if (payKind === "flat") return Math.round(payRate * 100) / 100;
  if (payKind === "hourly") return null;
  if (!finite(legMiles) || legMiles < 0) return null;
  if (payKind === "cpm") return Math.round(legMiles * payRate * 100) / 100;
  if (payKind === "percent") {
    if (!finite(loadedMiles) || loadedMiles <= 0 || !finite(rateConTotal) || rateConTotal <= 0) return null;
    return Math.round(rateConTotal * (payRate / 100) * (legMiles / loadedMiles) * 100) / 100;
  }
  return null;
}

/** How long a dropped baton has been waiting, in whole minutes (never negative). */
export const waitMinutes = (droppedAt: Date, now: Date): number => Math.max(0, Math.floor((now.getTime() - droppedAt.getTime()) / 60_000));

/** A trailer waiting in a yard for its next driver: a warning after an hour, a block after four. A reported discrepancy is a block at once. */
export const HANDOFF_WARN_MINUTES = 60;
export const HANDOFF_BLOCK_MINUTES = 240;
export function handoffLevel(h: { state: string; discrepancyFlagged: boolean; ackAt: Date | null; droppedAt: Date }, now: Date): "block" | "warn" | null {
  if (h.state === "received" || h.state === "cancelled") return null;
  if (h.discrepancyFlagged && !h.ackAt) return "block";
  const m = waitMinutes(h.droppedAt, now);
  return m >= HANDOFF_BLOCK_MINUTES ? "block" : m >= HANDOFF_WARN_MINUTES ? "warn" : null;
}

export function waitWords(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** The badge a relay load wears on the board: "Relay · leg 1 of 2 · awaiting handoff". Legs counts the ones written; a baton that is open means one more is coming. */
export function relayBadge(legs: number, open: { state: string; locationName: string | null } | null): string {
  const total = open ? legs + 1 : legs;
  const where = open?.locationName ? ` at ${open.locationName}` : "";
  if (open) return `Relay · leg ${legs} of ${total} · ${open.state === "disputed" ? "handoff disputed" : "awaiting handoff"}${where}`;
  return `Relay · leg ${legs} of ${total}`;
}

/** The exact fields a baton's proof is made of, in a fixed order, so the same baton always hashes the same. The server hashes this string (SHA-256) when custody transfers or a discrepancy is flagged. */
export function batonDigestText(h: {
  loadId: string; type: string; reason: string; outLegSeq: number; locationName: string | null; locationLat: unknown; locationLng: unknown; locationSlot: string | null; locationSetBy: string;
  tractorOutId: string | null; tractorInId: string | null; trailerId: string | null; outDriverId: string | null; inDriverId: string | null; sealNumber: string | null; sealMatches: boolean | null;
  reeferSetTemp: unknown; reeferActualTemp: unknown; reeferFuelPct: number | null; conditionOk: boolean | null; conditionNotes: string | null; discrepancyFlagged: boolean; discrepancyNotes: string | null;
  discrepancyBy: string | null; outgoingNext: string | null; droppedAt: Date; droppedSource: string; receivedAt: Date | null; receivedSource: string | null; enteredBy: string;
}): string {
  const v = (x: unknown) => (x == null ? null : x instanceof Date ? x.toISOString() : typeof x === "object" ? String(x) : x);
  const fields: Array<[string, unknown]> = [
    ["loadId", h.loadId], ["type", h.type], ["reason", h.reason], ["outLegSeq", h.outLegSeq], ["locationName", h.locationName], ["locationLat", h.locationLat], ["locationLng", h.locationLng],
    ["locationSlot", h.locationSlot], ["locationSetBy", h.locationSetBy], ["tractorOutId", h.tractorOutId], ["tractorInId", h.tractorInId], ["trailerId", h.trailerId], ["outDriverId", h.outDriverId],
    ["inDriverId", h.inDriverId], ["sealNumber", h.sealNumber], ["sealMatches", h.sealMatches], ["reeferSetTemp", h.reeferSetTemp], ["reeferActualTemp", h.reeferActualTemp],
    ["reeferFuelPct", h.reeferFuelPct], ["conditionOk", h.conditionOk], ["conditionNotes", h.conditionNotes], ["discrepancyFlagged", h.discrepancyFlagged], ["discrepancyNotes", h.discrepancyNotes],
    ["discrepancyBy", h.discrepancyBy], ["outgoingNext", h.outgoingNext], ["droppedAt", h.droppedAt], ["droppedSource", h.droppedSource], ["receivedAt", h.receivedAt], ["receivedSource", h.receivedSource],
    ["enteredBy", h.enteredBy]
  ];
  return JSON.stringify(fields.map(([k, x]) => [k, v(x)]));
}
