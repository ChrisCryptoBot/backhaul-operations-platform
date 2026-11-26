/**
 * Why a driver is taken off a load that was already sent to them (docs/RELAY_DESIGN.md). A fixed list, so "which loads were recalled, and why" is a query and not a text search.
 * Pure: the screens, the server and the tests all read this one list.
 */
export const RECALL_CODES = ["ASSIGNED_IN_ERROR", "HOS_TIMEOUT", "MECHANICAL_BREAKDOWN", "DRIVER_UNRESPONSIVE", "DRIVER_NO_SHOW", "SCHEDULED_RELAY"] as const;
export type RecallCode = (typeof RECALL_CODES)[number];

export const RECALL_LABELS: Record<RecallCode, string> = {
  ASSIGNED_IN_ERROR: "Assigned in error",
  HOS_TIMEOUT: "Out of hours",
  MECHANICAL_BREAKDOWN: "Breakdown",
  DRIVER_UNRESPONSIVE: "Driver not responding",
  DRIVER_NO_SHOW: "Driver no-show / quit",
  SCHEDULED_RELAY: "Scheduled relay"
};

/**
 * The codes a dispatcher can pick on a clean recall (the trip has not started). SCHEDULED_RELAY is defined but reserved: a relay is a handoff, which arrives with legs (phase 2),
 * so it is not offered as a reason to just take the driver off.
 */
// DRIVER_NO_SHOW is known (a recall made with it reads right) but not offered until migration 20270115000000_recall_driver_no_show widens the database's reason check: offered
// before that, a recall with it would be refused by the database. Add it to this list once the migration is applied.
export const RECALL_OFFERED: readonly RecallCode[] = ["ASSIGNED_IN_ERROR", "HOS_TIMEOUT", "MECHANICAL_BREAKDOWN", "DRIVER_UNRESPONSIVE"];

export const isRecallCode = (v: unknown): v is RecallCode => typeof v === "string" && (RECALL_CODES as readonly string[]).includes(v);

/** A code that can be used for a clean recall today: one of the offered ones. */
export const isOfferedRecallCode = (v: unknown): v is RecallCode => isRecallCode(v) && RECALL_OFFERED.includes(v);

/** The longest note kept with a recall. */
export const RECALL_NOTE_MAX = 300;

/** The words the audit trail keeps as the reason: "Assigned in error: sent the wrong rate con". With no note, just the label. */
export function recallReasonText(code: RecallCode, note?: string | null): string {
  const n = (note ?? "").trim().slice(0, RECALL_NOTE_MAX);
  return n ? `${RECALL_LABELS[code]}: ${n}` : RECALL_LABELS[code];
}

/** What a recall's delivery to the driver link looks like to a dispatcher. It never says the driver saw it: the phone cannot confirm yet. */
export type RecallDelivery = "delivered" | "waiting" | "failed" | "none";

export function recallDeliveryText(d: RecallDelivery): string {
  switch (d) {
    case "delivered":
      return "Reached the driver link. The driver has not confirmed seeing it.";
    case "waiting":
      return "Waiting to reach the driver link. Call the driver.";
    case "failed":
      return "Did not reach the driver link. Call the driver.";
    case "none":
      return "Driver was not on the driver link. Tell them directly.";
  }
}
