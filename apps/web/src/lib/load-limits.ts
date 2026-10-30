/**
 * The most a load may weigh and measure, the same on the Quote and on Edit details. A load booked from a quote on these numbers must be editable on them: two sets (the Quote's
 * larger, Edit's smaller) meant a heavy or oversize load booked fine and could not then be saved after a correction. Oversize and overweight loads exist, with permits, so the
 * larger set is the one. Pure.
 */
export const LOAD_LIMITS = { weightLbs: 200_000, lengthFt: 120, widthFt: 30, heightIn: 300 } as const;
