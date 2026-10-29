import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { rateConTotal } from "@/lib/pay";
import { notQuote } from "@/lib/quote-status";
import { num, numOrNull } from "./convert";
import { assignDriver, DispatchError, driverBlocker, driverClashNote } from "./dispatch";
import { evaluateTlLoad } from "./evaluate";
import type { PayKind } from "./projector";
import { loadInclude } from "./queries";
import { DEMO_WORKSPACE_ID } from "./workspace";

/**
 * Who could take a load, for the Assign window on the dispatch queue and the planner. Every active driver is listed with what stops them
 * (a lapsed card, or another load at the same time); the best fits are suggested first. A fit is how much the load leaves over the cost
 * floor at that driver's usual pay: the load's own truck if it has one, else the truck the driver usually drives. Nothing here changes
 * anything; assigning is `assignDriver`, with the same checks as from the load page.
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

export type AssignOptions = {
  loadNumber: string | null;
  lane: string;
  /** What a percent pay is taken of: the rate plus the fuel surcharge. */
  rateConTotal: number;
  hasTruck: boolean;
  drivers: AssignDriverOption[];
  suggestions: Suggestion[];
};

const MAX_SUGGESTIONS = 3;

export async function assignOptions(loadId: string, workspaceId = DEMO_WORKSPACE_ID, opts: { limit?: number } = {}): Promise<AssignOptions | null> {
  const load = await prisma.load.findFirst({ where: { id: loadId, workspaceId, deletedAt: null, ...notQuote }, include: loadInclude });
  if (!load) return null;
  const drivers = await prisma.driver.findMany({ where: { workspaceId, active: true }, include: { assignedVehicle: { include: { costProfile: true } } }, orderBy: { name: "asc" } });

  const options: AssignDriverOption[] = [];
  const fits: Suggestion[] = [];
  for (const d of drivers) {
    const blocker = driverBlocker(d);
    const busy = await driverClashNote(d.id, load.id, load.stops);
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

  return {
    loadNumber: load.loadNumber,
    lane: `${load.originAddress ?? "?"} → ${load.destinationAddress ?? "?"}`,
    rateConTotal: rateConTotal(num(load.quotedRevenue), num(load.fuelSurcharge)),
    hasTruck: load.vehicleId != null,
    drivers: options,
    suggestions: fits.slice(0, opts.limit ?? MAX_SUGGESTIONS)
  };
}

export type AssignOutcome = { ok: true } | { ok: false; error: string };

/**
 * Assign from the dispatch queue or the planner. The same `assignDriver` as from the load page, with the same checks (a lapsed card, a load
 * already taken at that time unless a reason is given), but it answers with a result instead of sending the page somewhere: the window says what
 * went wrong in place, and the queue refreshes behind it.
 */
export async function assignFromQueue(i: { loadId: string; driverId: string; payKind: string; rate: string; overrideReason?: string }): Promise<AssignOutcome> {
  let rate: number | null = null;
  try {
    const d = new Prisma.Decimal(i.rate.trim().replace(/,/g, ""));
    rate = d.isFinite() ? d.toNumber() : null;
  } catch {
    rate = null;
  }
  if (rate == null) return { ok: false, error: "Type the pay rate, above zero." };
  try {
    await assignDriver({ loadId: i.loadId, driverId: i.driverId, pay: { kind: i.payKind as PayKind, rate }, overrideReason: i.overrideReason ?? "" });
    return { ok: true };
  } catch (e) {
    if (e instanceof DispatchError) return { ok: false, error: e.message };
    throw e;
  }
}
