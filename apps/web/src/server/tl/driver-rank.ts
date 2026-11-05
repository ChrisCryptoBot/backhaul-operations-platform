import { prisma } from "@/lib/db";
import { driverBlocker, driverClashNotes } from "./dispatch";
import { evaluateTlLoad } from "./evaluate";
import { numOrNull } from "./convert";
import type { loadInclude } from "./queries";
import type { Prisma } from "@prisma/client";
import { checkLoad, dateKeyOf, flagWords } from "@/lib/shifts";
import { loadSchedules } from "./shifts";
import { workspaceTimezone } from "./zone";

/**
 * Who could take a load, ranked: every driver in service is checked (a lapsed card, another load at the same time, what the load would leave over the cost floor
 * at their usual pay) with a fixed number of queries however many drivers there are, then the best are put first. Used by the Assign window and the load page,
 * which show the top few and let the dispatcher search for anyone else.
 */
export type AssignDriverOption = {
  id: string;
  name: string;
  /** The driver's short code (JSMI) and their home terminal: a base, never a fence, so every active driver is offered whatever their terminal. */
  code: string | null;
  home: string | null;
  blocker: string | null;
  busy: string | null;
  /** A caution only (never a blocker): a stop of this load falls outside the driver's shift, "Delivery is after the shift ends at 1:30 AM." Null for a driver with no schedule. */
  shiftNote: string | null;
  payKind: string | null;
  payRate: number | null;
};

export type Suggestion = {
  driverId: string;
  name: string;
  /** Dollars the load leaves over the floor on every mile at this driver's usual pay (negative: short by that much); null when it cannot be priced. */
  leftOver: number | null;
  payKind: string | null;
  payRate: number | null;
  /** The truck the price is on, and whether it is the load's own. */
  truckName: string | null;
  onLoadsTruck: boolean;
};

type RankLoad = Prisma.LoadGetPayload<{ include: typeof loadInclude }>;

/** Every active driver is listed. `terminal` is the dispatcher's slice: drivers based there come first (a home base, not a restriction), everyone else follows, each tagged with their own home. */
export async function rankDrivers(load: RankLoad, workspaceId: string, terminal: string | null = null): Promise<{ options: AssignDriverOption[]; fits: Suggestion[] }> {
  const drivers = await prisma.driver.findMany({ where: { workspaceId, active: true }, include: { assignedVehicle: { include: { costProfile: true } } }, orderBy: { name: "asc" } });
  const busyBy = await driverClashNotes(drivers.map((d) => d.id), load.id, load.stops);
  // Shifts are a caution beside the clash note: one batched read of the schedules, then each driver's own checked against this load's stops on the carrier's clock.
  const tz = await workspaceTimezone(workspaceId);
  const stopTimes = load.stops.map((s) => ({ role: s.stopRole ?? s.stopType, earliest: s.timeWindowEarliest, latest: s.timeWindowLatest }));
  const first = stopTimes.map((s) => (s.earliest ?? s.latest)?.getTime()).filter((t): t is number => t != null);
  const schedules = first.length > 0 ? await loadSchedules(workspaceId, null, dateKeyOf(Math.min(...first), tz), dateKeyOf(Math.max(...first), tz)) : new Map();
  const at = (home: string | null) => (terminal && home?.toLowerCase() === terminal.toLowerCase() ? 0 : 1);

  const options: AssignDriverOption[] = [];
  const fits: Suggestion[] = [];
  for (const d of drivers) {
    const blocker = driverBlocker(d);
    const busy = busyBy.get(d.id) ?? null;
    const payKind = d.defaultPayKind;
    const payRate = numOrNull(d.defaultPayRate);
    const flag = checkLoad(schedules.get(d.id) ?? null, stopTimes, tz);
    options.push({ id: d.id, name: d.name, code: d.code, home: d.terminal, blocker, busy, shiftNote: flag ? flagWords(flag, tz) : null, payKind, payRate });
    if (blocker || busy) continue;

    const truck = load.vehicle ?? d.assignedVehicle;
    const profile = truck?.costProfile ?? null;
    let leftOver: number | null = null;
    if (profile && truck) {
      const e = evaluateTlLoad({ ...load, assignment: payKind && payRate != null ? { payKind, payRate } : null }, profile, truck);
      const margin = e.result.verdictMarginPerMi;
      leftOver = margin == null ? null : margin * e.totalMiles;
    }
    fits.push({ driverId: d.id, name: d.name, leftOver, payKind, payRate, truckName: truck?.name ?? null, onLoadsTruck: load.vehicleId != null && d.assignedVehicleId === load.vehicleId });
  }

  // Best first: what the load leaves over the floor, then a driver who usually drives the load's truck, then name. A fit that cannot be priced goes last.
  const key = (f: Suggestion) => f.leftOver ?? -Infinity;
  fits.sort((a, b) => key(b) - key(a) || (b.onLoadsTruck ? 1 : 0) - (a.onLoadsTruck ? 1 : 0) || a.name.localeCompare(b.name));
  const rank = new Map(fits.map((f, i) => [f.driverId, i]));
  // The drivers who can take it, best fit first, then the rest by name.
  const homeOf = new Map(drivers.map((d) => [d.id, d.terminal] as const));
  options.sort((a, b) => at(homeOf.get(a.id) ?? null) - at(homeOf.get(b.id) ?? null) || (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity));
  return { options, fits };
}

/** How many drivers a picker shows before the dispatcher searches: the best fits, and whoever is on the load already. */
export const PICKER_SIZE = 12;

export function pickerOptions(options: AssignDriverOption[], keepId?: string | null): AssignDriverOption[] {
  const top = options.slice(0, PICKER_SIZE);
  const keep = keepId && !top.some((o) => o.id === keepId) ? options.find((o) => o.id === keepId) : null;
  return keep ? [keep, ...top] : top;
}
