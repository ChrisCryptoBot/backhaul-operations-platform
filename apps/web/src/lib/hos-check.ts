/**
 * Whether a driver has the hours for a trip, from the clocks their ELD last reported (minutes left to drive, in the shift, in the 60/70-hour cycle). A caution for the dispatcher, never the
 * record: the ELD is the record (49 CFR 395.3). Pure.
 *
 * - clear: the clocks cover the first day's driving (up to the 11-hour limit) and the whole trip within the cycle.
 * - short: they do not. Assigning anyway needs a reason (src/lib/assign-reasons.ts hos_short): it is the evidence a dispatcher made that call knowingly (49 CFR 390.6).
 * - stale: the ELD is linked but has not reported for STALE_HOURS. Ranked below clear drivers; assigning needs a reason, as the clocks may have run out since.
 * - none: no ELD clocks for this driver at all (most fleets without a telematics link). Nothing is said and nothing is asked.
 */
export type HosState = "clear" | "short" | "stale" | "none";
export type HosClocks = { hosDriveMinutes: number | null; hosShiftMinutes: number | null; hosCycleMinutes: number | null; hosSyncedAt: Date | null };

/** The most a driver may drive in one stretch before a 10-hour break (49 CFR 395.3(a)(3)): a longer trip is planned over more than one day. */
export const DRIVE_LIMIT_HOURS = 11;
/** Clocks older than this are not a reading of now. */
export const STALE_HOURS = 12;

const h1 = (minutes: number) => `${(Math.round((minutes / 60) * 10) / 10).toFixed(1)} h`;

export function hosCheck(d: HosClocks, tripHours: number, now = new Date()): { state: HosState; note: string | null } {
  if (d.hosSyncedAt == null || (d.hosDriveMinutes == null && d.hosCycleMinutes == null)) return { state: "none", note: null };
  const ageHours = (now.getTime() - d.hosSyncedAt.getTime()) / 3_600_000;
  if (ageHours > STALE_HOURS) return { state: "stale", note: `Hours last reported ${Math.floor(ageHours)} h ago` };
  const firstDay = Math.min(tripHours, DRIVE_LIMIT_HOURS) * 60;
  const need = `trip needs ~${h1(tripHours * 60)}`;
  if (d.hosDriveMinutes != null && d.hosDriveMinutes < firstDay) return { state: "short", note: `${h1(d.hosDriveMinutes)} drive left · ${need}` };
  if (d.hosShiftMinutes != null && d.hosShiftMinutes < firstDay) return { state: "short", note: `${h1(d.hosShiftMinutes)} left in the shift · ${need}` };
  if (d.hosCycleMinutes != null && d.hosCycleMinutes < tripHours * 60) return { state: "short", note: `${h1(d.hosCycleMinutes)} left in the cycle · ${need}` };
  return { state: "clear", note: d.hosDriveMinutes != null ? `${h1(d.hosDriveMinutes)} drive left` : null };
}

/** The order a driver's hours put them in among the fits: clear and unknown first, then a stale reading, then short. */
export const HOS_RANK: Record<HosState, number> = { clear: 0, none: 0, stale: 1, short: 2 };
