import { getTimeZoneOffsetMs, PHASE1_BOARD_TIMEZONE } from "@/lib/board-date";

/**
 * US state/territory → IANA timezone. Multi-zone states resolve to their
 * predominant zone (refine if operations expand). The NE region is all Eastern,
 * so this is conservative for today and ready for wider lanes.
 */
const STATE_TIME_ZONE: Record<string, string> = {
  // Eastern
  CT: "America/New_York", DE: "America/New_York", DC: "America/New_York", FL: "America/New_York",
  GA: "America/New_York", IN: "America/New_York", KY: "America/New_York", ME: "America/New_York",
  MD: "America/New_York", MA: "America/New_York", MI: "America/New_York", NH: "America/New_York",
  NJ: "America/New_York", NY: "America/New_York", NC: "America/New_York", OH: "America/New_York",
  PA: "America/New_York", RI: "America/New_York", SC: "America/New_York", VT: "America/New_York",
  VA: "America/New_York", WV: "America/New_York",
  // Central
  AL: "America/Chicago", AR: "America/Chicago", IL: "America/Chicago", IA: "America/Chicago",
  KS: "America/Chicago", LA: "America/Chicago", MN: "America/Chicago", MS: "America/Chicago",
  MO: "America/Chicago", NE: "America/Chicago", ND: "America/Chicago", OK: "America/Chicago",
  SD: "America/Chicago", TN: "America/Chicago", TX: "America/Chicago", WI: "America/Chicago",
  // Mountain (AZ has no DST)
  AZ: "America/Phoenix", CO: "America/Denver", ID: "America/Denver", MT: "America/Denver",
  NM: "America/Denver", UT: "America/Denver", WY: "America/Denver",
  // Pacific
  CA: "America/Los_Angeles", NV: "America/Los_Angeles", OR: "America/Los_Angeles", WA: "America/Los_Angeles",
  // Non-contiguous
  AK: "America/Anchorage", HI: "Pacific/Honolulu"
};

/** Resolve a 2-letter US state to its IANA timezone, defaulting to the board tz. */
export function stateToTimeZone(state: string | null | undefined): string {
  if (!state) return PHASE1_BOARD_TIMEZONE;
  return STATE_TIME_ZONE[state.trim().toUpperCase()] ?? PHASE1_BOARD_TIMEZONE;
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Is this a valid 24-hour HH:MM string? */
export function isHhMm(value: string | null | undefined): value is string {
  return Boolean(value && HHMM.test(value.trim()));
}

/**
 * Combine a local calendar date (YYYY-MM-DD) + wall-clock time (HH:MM) in the
 * given IANA timezone into the corresponding UTC instant. Returns null on bad
 * input. DST-correct via the board-date offset helper.
 */
export function zonedDateTimeToUtc(isoDay: string, hhmm: string, timeZone: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDay)) return null;
  const match = HHMM.exec(hhmm.trim());
  if (!match) return null;
  const [year, month, day] = isoDay.split("-").map(Number);
  const utcGuess = Date.UTC(year, month - 1, day, Number(match[1]), Number(match[2]), 0);
  const offset = getTimeZoneOffsetMs(new Date(utcGuess), timeZone);
  return new Date(utcGuess - offset);
}
