/**
 * The hours-deficit tag on a Fleet Matrix row. Pure.
 *
 * A truck's hours left on the clock (as the ELD last reported them) against the hours the load needs. The need is the trip's
 * ON-DUTY hours (drive time for the pickup deadhead, the loaded run and the way home, plus dock wait): the figure the verdict card's
 * own warning already compares with the clock, so the two never disagree. It is not the elapsed time, which also counts the
 * ten-hour rests a driver spends off duty.
 *
 * A note beside the verdict, never an input to it. It only reads what the server already decided: `level` is the server's
 * `hosCaution` (which also keeps the 24-hour rule, so a pickup next week shows nothing). Nothing here changes `blocked`, the
 * verdict or the floor.
 */

export type HosLevel = "none" | "caution" | "short";

export type HosDeficit = {
  /** Hours the load needs, rounded UP to a whole hour: a dispatcher should never be told it needs less than it does. */
  needsHours: number;
  /** Hours the truck has left on the clock, to a tenth. */
  leftHours: number;
  /** How far short the truck is, rounded up to a whole hour. */
  shortByHours: number;
};

/** Floating-point noise from spreading the drive time over the miles must not tip 22.0000000001 into 23. */
const EPSILON = 1e-9;

const finite = (n: number | null | undefined): n is number => typeof n === "number" && Number.isFinite(n);

/** The deficit, or null when there is nothing to flag (the server said none or only "nearly", or a figure is missing or does not make sense). */
export function hosDeficit(input: { level: HosLevel; availableHours: number | null | undefined; tripHours: number | null | undefined }): HosDeficit | null {
  if (input.level !== "short") return null;
  const left = input.availableHours;
  const trip = input.tripHours;
  if (!finite(left) || !finite(trip) || left < 0 || trip <= 0 || trip <= left) return null;
  return {
    needsHours: Math.ceil(trip - EPSILON),
    leftHours: Math.round(left * 10) / 10,
    shortByHours: Math.ceil(trip - left - EPSILON)
  };
}

/** The tag's words: "Deficit: needs 22h". */
export const hosDeficitLabel = (d: HosDeficit): string => `Deficit: needs ${d.needsHours}h`;

/** The tag's hover text. */
export const hosDeficitTitle = (d: HosDeficit): string => `Has ${d.leftHours}h left on the clock; about ${d.shortByHours}h short.`;
