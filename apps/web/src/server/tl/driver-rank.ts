import { prisma } from "@/lib/db";
import { driverBlocker, driverClashNotes } from "./dispatch";
import { evaluateTlLoad } from "./evaluate";
import { numOrNull } from "./convert";
import type { loadInclude } from "./queries";
import type { Prisma } from "@prisma/client";

/**
 * Who could take a load, ranked: every driver in service is checked (a lapsed card, another load at the same time, what the load would leave over the cost floor
 * at their usual pay) with a fixed number of queries however many drivers there are, then the best are put first. Used by the Assign window and the load page,
 * which show the top few and let the dispatcher search for anyone else.
 */
export type AssignDriverOption = { id: string; name: string; blocker: string | null; busy: string | null; payKind: string | null; payRate: number | null };

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

/** `terminal`: rank only that terminal's drivers (the dispatcher's slice); anyone else is found by searching (/drivers/pick). Null ranks every driver. */
export async function rankDrivers(load: RankLoad, workspaceId: string, terminal: string | null = null): Promise<{ options: AssignDriverOption[]; fits: Suggestion[] }> {
  const drivers = await prisma.driver.findMany({ where: { workspaceId, active: true, ...(terminal ? { terminal } : {}) }, include: { assignedVehicle: { include: { costProfile: true } } }, orderBy: { name: "asc" } });
  const busyBy = await driverClashNotes(drivers.map((d) => d.id), load.id, load.stops);

  const options: AssignDriverOption[] = [];
  const fits: Suggestion[] = [];
  for (const d of drivers) {
    const blocker = driverBlocker(d);
    const busy = busyBy.get(d.id) ?? null;
    const payKind = d.defaultPayKind;
    const payRate = numOrNull(d.defaultPayRate);
    options.push({ id: d.id, name: d.name, blocker, busy, payKind, payRate });
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
  options.sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity));
  return { options, fits };
}

/** How many drivers a picker shows before the dispatcher searches: the best fits, and whoever is on the load already. */
export const PICKER_SIZE = 12;

export function pickerOptions(options: AssignDriverOption[], keepId?: string | null): AssignDriverOption[] {
  const top = options.slice(0, PICKER_SIZE);
  const keep = keepId && !top.some((o) => o.id === keepId) ? options.find((o) => o.id === keepId) : null;
  return keep ? [keep, ...top] : top;
}
