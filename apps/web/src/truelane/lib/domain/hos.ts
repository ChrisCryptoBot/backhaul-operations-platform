// VENDORED from TrueLane lib/domain/hos.ts @ a3a9c0f4. Do not edit; run scripts/vendor-truelane.mjs.
/**
 * FMCSA Hours-of-Service (HOS) layover costing (property-carrying, solo). On long runs the forced
 * rests inflate the true elapsed time of a load, which quietly crushes the real $/hr even when the
 * $/mi looks fine.
 *
 * The rules modeled (49 CFR 395.3):
 * - 11 hours of DRIVING at most per shift;
 * - a 14-hour on-duty WINDOW per shift — dock / loading time counts against it too;
 * - 10 consecutive hours off duty between shifts;
 * - a 30-minute break once a shift has driven 8 hours.
 *
 * M5 (math audit): the estimate ignored dock time and the 14-hour window, so a dock-heavy run showed
 * too few rests. The trip's hours are its DRIVE time (what the route lookup fills in); dock wait is on
 * duty but not driving. Now:
 *   driving  = drive hours;  on-duty = drive hours + dock wait
 *   shifts   = max(⌈driving / 11⌉, ⌈(on-duty + breaks) / 14⌉);  rests = shifts − 1
 *   breaks   = shifts whose driving passes 8 h (each shift drives as much as it may)
 *   elapsed  = on-duty + breaks × 0.5 h + rests × 10 h
 *
 * Not modeled (V-11 / RP-15; the card says so): a 30-minute on-duty-not-driving period, such as dock time,
 * satisfies the break under the 2020 rule, so elapsed can run 0.5 h high when the dock wait covers it; dock
 * time is pooled across shifts; the 60/70-hour limits are not checked.
 *
 * SEMANTIC only (no colors, no copy) — like marketVerdict/leadTime, the UI maps this into an amber
 * advisory and a derived "true $/hr". This does NOT change the base rph that history/analytics read;
 * it is a layer on top.
 */

const DRIVING_LIMIT_HOURS = 11; // FMCSA: max driving per shift.
const WINDOW_HOURS = 14; // FMCSA: on-duty window per shift.
const REST_HOURS = 10; // FMCSA: off duty between shifts.
const BREAK_AFTER_DRIVING_HOURS = 8; // FMCSA: 30-minute break once a shift has driven 8 h.
const BREAK_HOURS = 0.5;

export type HosLayover = {
  /** Driving hours (coerced to ≥ 0). */
  drivingHours: number;
  /** On-duty hours: driving + dock wait. */
  onDutyHours: number;
  /** Shifts the run needs. 0 when there is nothing to drive or do. */
  shifts: number;
  /** How many mandatory 10-hour rests the run forces (shifts − 1). */
  requiredRests: number;
  /** Total rest hours added = requiredRests × restHours. */
  restHours: number;
  /** 30-minute breaks (shifts that drive past 8 h). */
  breaks: number;
  /** True elapsed time = on-duty + breaks + rests. */
  elapsedHours: number;
};

export type HosLayoverInput = {
  /** The trip's drive time (hours). Negative / non-finite → 0. */
  drivingHours: number;
  /** Hours waiting at docks — on duty, not driving. Negative / non-finite → 0. */
  dockWaitHours?: number | null;
  /** Legal driving limit per shift (default 11). */
  drivingLimitHours?: number;
  /** Hours of mandatory rest between shifts (default 10). */
  restHours?: number;
};

const finitePos = (n: number | null | undefined) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0);

/** 30-minute breaks for a run split into `shifts`, each driving as much as it may (11, 11, …, rest). */
function breaksFor(drivingHours: number, shifts: number, limit: number): number {
  let left = drivingHours;
  let breaks = 0;
  for (let i = 0; i < shifts && left > 0; i++) {
    const drive = Math.min(limit, left);
    if (drive > BREAK_AFTER_DRIVING_HOURS) breaks += 1;
    left -= drive;
  }
  return breaks;
}

export function computeHosLayover(input: HosLayoverInput): HosLayover {
  const limit =
    input.drivingLimitHours != null && Number.isFinite(input.drivingLimitHours) && input.drivingLimitHours > 0
      ? input.drivingLimitHours
      : DRIVING_LIMIT_HOURS;
  const rest =
    input.restHours != null && Number.isFinite(input.restHours) && input.restHours >= 0
      ? input.restHours
      : REST_HOURS;

  // Coerce garbage/negative estimates to 0 so the advisory never fires on noise.
  const drivingHours = finitePos(input.drivingHours);
  const onDutyHours = drivingHours + finitePos(input.dockWaitHours);

  if (drivingHours === 0) {
    return { drivingHours: 0, onDutyHours: 0, shifts: 0, requiredRests: 0, restHours: 0, breaks: 0, elapsedHours: 0 };
  }

  // Breaks sit inside the 14-hour window, so more breaks can need another shift: settle both.
  let shifts = Math.max(1, Math.ceil(drivingHours / limit), Math.ceil(onDutyHours / WINDOW_HOURS));
  let breaks = breaksFor(drivingHours, shifts, limit);
  for (let i = 0; i < 4; i++) {
    const need = Math.max(shifts, Math.ceil((onDutyHours + breaks * BREAK_HOURS) / WINDOW_HOURS));
    if (need === shifts) break;
    shifts = need;
    breaks = breaksFor(drivingHours, shifts, limit);
  }

  const requiredRests = shifts - 1;
  const totalRest = requiredRests * rest;
  return {
    drivingHours,
    onDutyHours,
    shifts,
    requiredRests,
    restHours: totalRest,
    breaks,
    elapsedHours: onDutyHours + breaks * BREAK_HOURS + totalRest,
  };
}
