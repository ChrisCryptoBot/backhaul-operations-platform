import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { rateConTotal } from "@/lib/pay";
import { notQuote } from "@/lib/quote-status";
import { num } from "./convert";
import { assignDriver, DispatchError } from "./dispatch";
import { pickerOptions, rankDrivers, type AssignDriverOption, type Suggestion } from "./driver-rank";
export type { AssignDriverOption, Suggestion } from "./driver-rank";
import type { PayKind } from "./projector";
import { loadInclude } from "./queries";
import { currentTerminal } from "./terminal";
import { currentWorkspaceId } from "./workspace";

/**
 * Who could take a load, for the Assign window on the dispatch queue and the planner. Every active driver is listed with what stops them
 * (a lapsed card, or another load at the same time); the best fits are suggested first. A fit is how much the load leaves over the cost
 * floor at that driver's usual pay: the load's own truck if it has one, else the truck the driver usually drives. Nothing here changes
 * anything; assigning is `assignDriver`, with the same checks as from the load page.
 */
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

export async function assignOptions(loadId: string, workspaceId = currentWorkspaceId(), opts: { limit?: number } = {}): Promise<AssignOptions | null> {
  const load = await prisma.load.findFirst({ where: { id: loadId, workspaceId, deletedAt: null, ...notQuote }, include: loadInclude });
  if (!load) return null;
  const { options, fits } = await rankDrivers(load, workspaceId, await currentTerminal(workspaceId));

  return {
    loadNumber: load.loadNumber,
    lane: `${load.originAddress ?? "?"} → ${load.destinationAddress ?? "?"}`,
    rateConTotal: rateConTotal(num(load.quotedRevenue), num(load.fuelSurcharge)),
    hasTruck: load.vehicleId != null,
    drivers: pickerOptions(options),
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
