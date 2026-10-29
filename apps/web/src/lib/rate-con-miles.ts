/**
 * The miles on a rate confirmation's review. A document that prints miles keeps them. One that prints none gets the road miles measured from
 * its stops, the same way Quote does it, as a suggestion: a figure typed by hand is the dispatcher's and is never replaced, and blanking the
 * box hands it back to the map. Pure, so the rule is tested without a screen.
 */
export type MilesSource = "document" | "measured" | "typed" | "none";

/** Where the miles in the box came from after the box is edited: blank is none (the map may fill it), anything else is typed. */
export const sourceAfterTyping = (value: string): MilesSource => (value.trim() === "" ? "none" : "typed");

/** Whether to ask the map for miles now: only when the box is empty or holds an earlier measurement, every stop can be looked up, and the route is not the one already measured. */
export function shouldMeasureMiles(p: { source: MilesSource; ready: boolean; routeChanged: boolean }): boolean {
  if (!p.ready || !p.routeChanged) return false;
  return p.source === "none" || p.source === "measured";
}
