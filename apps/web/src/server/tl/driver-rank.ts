import { inScope, terminalFilter, type Terminals } from "@/lib/scope";
import { prisma } from "@/lib/db";
import { driverBlocker, driverClashNotes, tripHoursOf, truckClashesIn } from "./dispatch";
import { hosCheck, HOS_RANK, type HosState } from "@/lib/hos-check";
import { truckBodyNote, truckFit } from "@/lib/load-fit";
import { loadSpecsOf, truckLimits } from "./truck-fit";
import { evaluateTlLoad } from "./evaluate";
import { numOrNull } from "./convert";
import type { loadInclude } from "./queries";
import type { Prisma } from "@prisma/client";
import { checkLoad, dateKeyOf, flagWords } from "@/lib/shifts";
import { loadSchedules } from "./shifts";
import { workspaceTimezone } from "./zone";
import { loadWindow } from "@/lib/schedule";

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
  /** For someone who may not see pay: this driver has no usual pay, so they cannot be assigned until billing sets it. */
  noUsualPay?: boolean;
  /** Their hours against this trip (src/lib/hos-check.ts): a caution and a rank, never a blocker; a short or stale reading needs a reason to assign. */
  hosNote?: string | null;
  hosState?: HosState;
  /** On a load with no truck, what stops the truck this driver brings (it cannot carry the load, or it is on another load then), or a caution about it. */
  truckNote?: string | null;
  /** This driver already said no to this load, or was just taken off it (no-show, not responding, breakdown): kept out of the best fits for it. */
  thisLoad?: string | null;
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
  /** Their hours against this trip, when the ELD reported any. */
  hosNote?: string | null;
  /** A caution about the truck they bring (a box truck on a trailer load, oversize, hazmat). */
  truckNote?: string | null;
};

type RankLoad = Prisma.LoadGetPayload<{ include: typeof loadInclude }>;

/** Every active driver is listed. `terminal` is the dispatcher's slice: drivers based there come first (a home base, not a restriction), everyone else follows, each tagged with their own home. */
export async function rankDrivers(load: RankLoad, workspaceId: string, terminal: Terminals = null, allowed: Terminals = null): Promise<{ options: AssignDriverOption[]; fits: Suggestion[] }> {
  // `allowed` is the person's limit (null: not limited). A base is not a fence for a dispatcher who can see everything, but a limited person is only offered drivers inside their limit.
  const drivers = await prisma.driver.findMany({ where: { workspaceId, active: true, ...(allowed != null ? { terminal: terminalFilter(allowed) } : {}) }, include: { assignedVehicle: { include: { costProfile: true } } }, orderBy: { name: "asc" } });
  const busyBy = await driverClashNotes(drivers.map((d) => d.id), load.id, load.stops);
  // Shifts are a caution beside the clash note: one batched read of the schedules, then each driver's own checked against this load's stops on the carrier's clock.
  const tz = await workspaceTimezone(workspaceId);
  const stopTimes = load.stops.map((s) => ({ role: s.stopRole ?? s.stopType, earliest: s.timeWindowEarliest, latest: s.timeWindowLatest }));
  const first = stopTimes.map((s) => (s.earliest ?? s.latest)?.getTime()).filter((t): t is number => t != null);
  const schedules = first.length > 0 ? await loadSchedules(workspaceId, null, dateKeyOf(Math.min(...first), tz), dateKeyOf(Math.max(...first), tz)) : new Map();
  // Every card is checked against when this load's last window closes, so a driver whose card lapses mid-trip is not offered.
  const tripEnd = loadWindow(load.stops)?.end ?? load.scheduledDate ?? null;
  const at = (home: string | null) => (terminal != null && inScope(terminal, home) ? 0 : 1);
  // Hours: the trip's drive time against each driver's clocks (a caution and a rank, never a blocker).
  const tripHours = tripHoursOf(load);
  const now = new Date();
  // On a load with no truck, each driver brings the truck they usually drive (dispatch.ts assignDriver): is it free then, and can it carry this load?
  const win = loadWindow(load.stops);
  const truckless = load.vehicleId == null;
  const truckBusy = truckless ? await truckClashesIn([...new Set(drivers.map((d) => d.assignedVehicleId).filter((v): v is string => v != null))], load.id, win, workspaceId) : new Map<string, string | null>();
  const specs = loadSpecsOf(load);
  // This load's own history: who said no to it, and who was just taken off it for not showing up, not answering or a breakdown.
  const SKIP_AFTER = new Set(["DRIVER_NO_SHOW", "DRIVER_UNRESPONSIVE", "MECHANICAL_BREAKDOWN"]);
  const past = await prisma.assignmentEvent.findMany({ where: { workspaceId, loadId: load.id, kind: { in: ["declined", "recalled"] } }, select: { driverId: true, kind: true, reasonCode: true } });
  const thisLoadOf = new Map<string, string>();
  for (const e of past) {
    if (!e.driverId) continue;
    if (e.kind === "declined") thisLoadOf.set(e.driverId, "Declined this load");
    else if (e.reasonCode && SKIP_AFTER.has(e.reasonCode)) thisLoadOf.set(e.driverId, "Just recalled from this load");
  }

  const options: AssignDriverOption[] = [];
  const fits: Suggestion[] = [];
  const hosRankOf = new Map<string, number>();
  for (const d of drivers) {
    const blocker = driverBlocker(d, new Date(), tripEnd);
    const busy = busyBy.get(d.id) ?? null;
    const payKind = d.defaultPayKind;
    const payRate = numOrNull(d.defaultPayRate);
    const flag = checkLoad(schedules.get(d.id) ?? null, stopTimes, tz);
    const hos = hosCheck(d, tripHours, now);
    // The truck this driver would bring to a load that has none: one already on another load then, or one that cannot carry it, keeps them out of the best fits.
    const brings = truckless ? d.assignedVehicle : null;
    const bringsBusy = brings ? truckBusy.get(brings.id) : undefined;
    const bringsFit = brings ? truckFit(specs, truckLimits(brings)) : null;
    const bodyNote = brings ? truckBodyNote(load.trailerType, brings.type, brings.name ?? "Their truck") : null;
    const truckName = brings?.name ?? "Their truck";
    const truckStop = brings ? (bringsFit?.blocker ? `${truckName} cannot take it: ${bringsFit.blocker}` : bringsBusy !== undefined ? `${truckName} is on ${bringsBusy ?? "another load"}` : null) : null;
    const truckNote = truckStop ?? bodyNote ?? bringsFit?.warnings[0] ?? null;
    const thisLoad = thisLoadOf.get(d.id) ?? null;
    options.push({ id: d.id, name: d.name, code: d.code, home: d.terminal, blocker, busy, shiftNote: flag ? flagWords(flag, tz) : null, payKind, payRate, hosNote: hos.note, hosState: hos.state, truckNote, thisLoad });
    if (blocker || busy || truckStop || thisLoad || hos.state === "short") continue;

    const truck = load.vehicle ?? d.assignedVehicle;
    const profile = truck?.costProfile ?? null;
    let leftOver: number | null = null;
    if (profile && truck) {
      const e = evaluateTlLoad({ ...load, assignment: payKind && payRate != null ? { payKind, payRate } : null }, profile, truck);
      const margin = e.result.verdictMarginPerMi;
      leftOver = margin == null ? null : margin * e.totalMiles;
    }
    fits.push({ driverId: d.id, name: d.name, leftOver, payKind, payRate, truckName: truck?.name ?? null, onLoadsTruck: load.vehicleId != null && d.assignedVehicleId === load.vehicleId, hosNote: hos.note, truckNote });
    hosRankOf.set(d.id, HOS_RANK[hos.state]);
  }

  // Best first: a driver whose hours are not in doubt (a stale reading goes after), then what the load leaves over the floor, then a driver who usually drives the load's truck, then name.
  // A fit that cannot be priced goes last.
  const key = (f: Suggestion) => f.leftOver ?? -Infinity;
  const hosRank = (f: Suggestion) => hosRankOf.get(f.driverId) ?? 0;
  fits.sort((a, b) => hosRank(a) - hosRank(b) || key(b) - key(a) || (b.onLoadsTruck ? 1 : 0) - (a.onLoadsTruck ? 1 : 0) || a.name.localeCompare(b.name));
  const rank = new Map(fits.map((f, i) => [f.driverId, i]));
  // The drivers who can take it, best fit first, then the rest by name.
  const homeOf = new Map(drivers.map((d) => [d.id, d.terminal] as const));
  // Someone who already said no to this load, or was just taken off it, goes to the very end of the list (still there, to pick on purpose).
  const last = (o: AssignDriverOption) => (o.thisLoad ? 1 : 0);
  options.sort((a, b) => last(a) - last(b) || at(homeOf.get(a.id) ?? null) - at(homeOf.get(b.id) ?? null) || (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity));
  return { options, fits };
}

/** How many drivers a picker shows before the dispatcher searches: the best fits, and whoever is on the load already. */
export const PICKER_SIZE = 12;

export function pickerOptions(options: AssignDriverOption[], keepId?: string | null): AssignDriverOption[] {
  const top = options.slice(0, PICKER_SIZE);
  const keep = keepId && !top.some((o) => o.id === keepId) ? options.find((o) => o.id === keepId) : null;
  return keep ? [keep, ...top] : top;
}
