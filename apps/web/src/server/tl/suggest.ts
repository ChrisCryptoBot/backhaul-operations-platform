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
import { currentAllowed } from "./scope";
import { currentWorkspaceId } from "./workspace";
import { inTerminal } from "./terminal-sql";
import type { Terminals } from "@/lib/scope";
import { isReasonCode, type ReasonNeed, type Reasons } from "@/lib/assign-reasons";

/** Only the known conditions, each a string: whatever else a client sends is dropped. */
const cleanReasons = (r: unknown): Reasons => {
  const out: Reasons = {};
  if (r && typeof r === "object") for (const [k, v] of Object.entries(r)) if (isReasonCode(k) && typeof v === "string") out[k] = v.slice(0, 300);
  return out;
};

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
  /** Who has the load now, as the window opened: sent back with the assignment, so a change someone else made in between is refused instead of written over. */
  current: { assignmentVersion: number | null; driverId: string | null };
};

const MAX_SUGGESTIONS = 3;

export async function assignOptions(loadId: string, workspaceId = currentWorkspaceId(), opts: { limit?: number; allowed?: Terminals } = {}): Promise<AssignOptions | null> {
  // A person limited to some terminals reaches only those terminals' loads (and the loads not placed anywhere yet), whatever id arrives: another terminal's load is "gone", never read.
  const allowed = opts.allowed !== undefined ? opts.allowed : await currentAllowed(workspaceId);
  const load = await prisma.load.findFirst({ where: { id: loadId, workspaceId, deletedAt: null, ...notQuote, ...inTerminal(allowed) }, include: loadInclude });
  if (!load) return null;
  const { options, fits } = await rankDrivers(load, workspaceId, await currentTerminal(workspaceId), allowed);

  return {
    loadNumber: load.loadNumber,
    lane: `${load.originAddress ?? "?"} → ${load.destinationAddress ?? "?"}`,
    rateConTotal: rateConTotal(num(load.quotedRevenue), num(load.fuelSurcharge)),
    hasTruck: load.vehicleId != null,
    drivers: pickerOptions(options),
    suggestions: fits.slice(0, opts.limit ?? MAX_SUGGESTIONS),
    current: { assignmentVersion: load.assignment?.assignmentVersion ?? null, driverId: load.assignment?.driverId ?? null }
  };
}

/** `code` is the DispatchError's; `needs` lists every condition still without its own reason (src/lib/assign-reasons.ts), so the window asks for each at once. */
export type AssignOutcome = { ok: true } | { ok: false; error: string; code?: string; needs?: ReasonNeed[] };

/**
 * Assign from the dispatch queue or the planner. The same `assignDriver` as from the load page, with the same checks (a lapsed card, a load
 * already taken at that time unless a reason is given), but it answers with a result instead of sending the page somewhere: the window says what
 * went wrong in place, and the queue refreshes behind it.
 */
export async function assignFromQueue(i: { loadId: string; driverId: string; payKind: string; rate: string; reasons?: Reasons; overrideReason?: string; expected?: AssignOptions["current"] | null }): Promise<AssignOutcome> {
  let rate: number | null = null;
  try {
    const d = new Prisma.Decimal(i.rate.trim().replace(/,/g, ""));
    rate = d.isFinite() ? d.toNumber() : null;
  } catch {
    rate = null;
  }
  if (rate == null) return { ok: false, error: "Type the pay rate, above zero." };
  try {
    await assignDriver({ loadId: i.loadId, driverId: i.driverId, pay: { kind: i.payKind as PayKind, rate }, reasons: cleanReasons(i.reasons), overrideReason: i.overrideReason ?? "", expected: i.expected ?? null });
    return { ok: true };
  } catch (e) {
    if (e instanceof DispatchError) return { ok: false, error: e.message, code: e.code, ...(e.needs.length > 0 ? { needs: e.needs } : {}) };
    throw e;
  }
}
