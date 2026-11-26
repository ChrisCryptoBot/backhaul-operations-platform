/**
 * Where a load sits on the Dispatch queue, from its desk status (queries.ts deskStatusOf: a phone's "scheduled" is accepted, its "dispatched" a draft that was sent) and its assignment.
 * One rule, read by the page and the tests, so a declined load or one assigned and never sent is never mistaken for one that has a driver on the way. Pure.
 *
 * - no_driver: nobody on it.
 * - ready_to_send: a driver is picked and the load was never sent to them.
 * - declined: the driver said no; the load needs someone else.
 * - sent: sent, waiting for the driver's answer.
 * - moving: accepted or on the road.
 * - yard: dropped at a relay point, waiting for its next driver (the "Awaiting handoff" card).
 */
export type QueueColumn = "no_driver" | "ready_to_send" | "declined" | "sent" | "moving" | "yard";
export const NEEDS_DRIVER: readonly QueueColumn[] = ["no_driver", "ready_to_send", "declined"];

export function queueColumnOf(r: { status: string; assignmentStatus: string | null }, inYard = false): QueueColumn | null {
  if (inYard) return "yard";
  if (r.assignmentStatus === "dispatched") return "sent";
  if (r.status === "draft") {
    if (!r.assignmentStatus) return "no_driver";
    if (r.assignmentStatus === "draft") return "ready_to_send";
    if (r.assignmentStatus === "declined") return "declined";
    return null;
  }
  if (r.status === "accepted" || r.status === "in_progress") return "moving";
  return null;
}

/** The order inside Needs a driver, after the recalled loads pinned first: a driver said no, then nobody picked, then picked and ready to go. */
export const NEEDS_ORDER: Record<string, number> = { declined: 0, no_driver: 1, ready_to_send: 2 };

/** The words on the chip. */
export const QUEUE_CHIP: Record<QueueColumn, string> = {
  no_driver: "Needs a driver",
  ready_to_send: "Ready to send",
  declined: "Declined",
  sent: "Sent",
  moving: "Moving",
  yard: "In the yard"
};

/** The driver's reason for a decline, from the stored answer ({ response, note }), or null. */
export function declineNoteOf(driverResponse: unknown): string | null {
  if (!driverResponse || typeof driverResponse !== "object") return null;
  const r = driverResponse as { response?: unknown; note?: unknown };
  return r.response === "declined" && typeof r.note === "string" && r.note.trim() !== "" ? r.note.trim() : null;
}
