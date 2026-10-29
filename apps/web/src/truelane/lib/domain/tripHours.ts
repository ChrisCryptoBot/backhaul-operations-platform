// VENDORED from TrueLane lib/domain/tripHours.ts @ a3a9c0f4. Do not edit; run scripts/vendor-truelane.mjs.
/**
 * Trip hours — one rule for every per-hour number (RPH, hourly driver pay, the time-trap check).
 *
 * A load's hours are its DRIVE time for every mile (pickup deadhead + loaded + return deadhead) plus
 * the dock wait: the driver is on the clock for both. The route lookup only knows the loaded leg's
 * driving time, so `driveHoursForAllMiles` spreads it over all the miles at the same average speed.
 */

const pos = (n: number | null | undefined) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0);

/** Drive time for all miles, from the loaded leg's driving time at the same average speed. */
export function driveHoursForAllMiles(loadedLegHours: number, loadedMiles: number, totalMiles: number): number {
  const h = pos(loadedLegHours);
  const loaded = pos(loadedMiles);
  const total = pos(totalMiles);
  if (h === 0 || loaded === 0) return h;
  return h * (Math.max(total, loaded) / loaded);
}

/**
 * On-duty hours for a load: drive time + dock wait. 0 without a drive time — dock wait alone is not a
 * trip estimate, and dividing pay by it would show a wildly high $/hr.
 */
export function onDutyHours(driveHours: number | null | undefined, dockWaitMinutes: number | null | undefined): number {
  const drive = pos(driveHours);
  return drive > 0 ? drive + pos(dockWaitMinutes) / 60 : 0;
}
