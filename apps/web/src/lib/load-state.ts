/**
 * The two statuses that say where a load is, and how they go together. A load has a status of its own and, once a driver is on it, an assignment with another. The board, the
 * dispatch queue and the trip screens each read one of them, so they must never disagree; this is the table every change goes by, and the test that walks the changes checks it.
 *
 *   assignment                      load
 *   none, draft, dispatched,        draft       (still needs a driver, or the driver has not said yes)
 *   declined
 *   accepted                        accepted
 *   in_progress                     in_progress
 *   completed                       completed   (or none: a load closed by hand; a TONU or a cancelled load has left the table)
 *
 * Anything that sets the assignment back (a new driver, a changed pickup that asks the driver again, a decline) puts the load back to draft in the same transaction.
 * Pure.
 */
const LOAD_FOR_ASSIGNMENT: Record<string, string> = { draft: "draft", dispatched: "draft", declined: "draft", accepted: "accepted", in_progress: "in_progress", completed: "completed" };

/** The status a load has while its assignment has this status (none = no driver yet). */
export const loadStatusFor = (assignment: string | null | undefined): string => (assignment ? (LOAD_FOR_ASSIGNMENT[assignment] ?? "draft") : "draft");

/** Statuses that are in the table. A cancelled load, a TONU and a saved quote have left it, whatever their assignment says. */
const IN_TABLE = new Set(["draft", "accepted", "in_progress", "completed"]);

/** Whether a load's status and its assignment's go together. */
export function statesAgree(loadStatus: string, assignment: string | null | undefined): boolean {
  if (!IN_TABLE.has(loadStatus)) return true;
  // A delivered load may have been closed by hand with no driver on it; any other status needs the assignment that goes with it.
  if (loadStatus === "completed") return !assignment || assignment === "completed";
  return loadStatus === loadStatusFor(assignment);
}
