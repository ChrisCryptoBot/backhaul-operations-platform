import { prisma } from "@/lib/db";
import { isIftaQuarter } from "@/lib/ifta-rates-csv";
import { iftaDueDate, iftaReturnMath, isReturnFuel, rateState, type IftaReturnMath, type RateState } from "@/lib/ifta-return";
import { currentWorkspaceId } from "@/server/tl/workspace";
import { workspaceTimezone } from "@/server/tl/zone";
import { countFlags, flagContextStart, readFlags } from "./fuel-flags";
import { countedMileage, quarterBounds } from "./ifta-mileage";
import { listIftaRates } from "./ifta-rates";

/**
 * A quarter's IFTA return, read from the records and worked out by lib/ifta-return.ts (money plan Wave 5 steps 6 and 7): the one answer the return screen, the per-truck audit, both CSVs and a
 * filed return (step 8) read. Nothing is written.
 *
 *   - Miles: each truck's counted rows only (ELD first, through countedMileage, the same read the mileage summary uses).
 *   - Fuel: every purchase in the quarter by the moment it was bought (`purchasedAt`, else the day it posted), in the workspace's own calendar. The math counts settled road diesel only.
 *   - Rates: the quarter's rate table (step 4).
 *   - Open fuel exception flags on any of the quarter's purchases, read the way Fuel reads them (the whole fleet's context, then narrowed to these purchases).
 * With `detail`, the same read also hands back the counted mileage pieces and the quarter's fuel receipts behind every number, so an audit reconciles line by line against the same rows.
 */
export type IftaPiece = {
  id: string;
  vehicleId: string;
  method: string;
  source: string;
  jurisdiction: string;
  loaded: boolean;
  loadId: string | null;
  loadNumber: string | null;
  startOdometer: string | null;
  endOdometer: string | null;
  startedAt: Date;
  endedAt: Date;
  miles: string;
  externalId: string;
};

export type IftaReceipt = {
  id: string;
  vehicleId: string | null;
  provider: string;
  externalId: string;
  /** `purchasedAt`, else the day it posted: the moment that put it in the quarter. */
  at: Date;
  location: string | null;
  state: string | null;
  product: string;
  status: string;
  taxPaid: boolean;
  gallons: string | null;
  amount: string;
  /** Settled road diesel: counted in the fleet MPG (and credited when tax was paid and the state is a US one). */
  counted: boolean;
};

export type IftaReturnOk = {
  ok: true;
  quarter: string;
  from: Date;
  to: Date;
  dueDate: string;
  rateCount: number;
  rateFinal: number;
  rateSample: number;
  rateState: RateState;
  flagsPartial: boolean;
} & IftaReturnMath;

export type IftaReturn = IftaReturnOk | { ok: false; error: string; code: string };
export type IftaReturnDetail = (IftaReturnOk & { pieces: IftaPiece[]; receipts: IftaReceipt[]; piecesCapped: boolean }) | { ok: false; error: string; code: string };

/** The most purchases one return reads. A quarter with more says so rather than leaving some out. */
export const IFTA_MAX_PURCHASES = 50_000;
/** The most mileage pieces one audit read hands back (the return itself is worked from grouped sums, so it is never capped). */
export const IFTA_MAX_PIECES = 100_000;

async function read(quarter: string, now: Date, workspaceId: string, detail: { vehicleId?: string | null } | null): Promise<IftaReturnDetail> {
  if (!isIftaQuarter(quarter)) return { ok: false, error: "A quarter, like 2026-Q3.", code: "bad_request" };
  const tz = await workspaceTimezone(workspaceId);
  const { from, to } = quarterBounds(quarter, tz)!;
  const [{ counted, chosen }, fuel, rates] = await Promise.all([
    countedMileage(quarter, workspaceId),
    prisma.fuelTransaction.findMany({
      where: { workspaceId, OR: [{ purchasedAt: { gte: from, lt: to } }, { purchasedAt: null, postedAt: { gte: from, lt: to } }] },
      select: { id: true, vehicleId: true, provider: true, externalId: true, purchasedAt: true, postedAt: true, location: true, purchaseState: true, product: true, status: true, taxPaid: true, gallons: true, amount: true },
      orderBy: { id: "asc" },
      take: IFTA_MAX_PURCHASES + 1
    }),
    listIftaRates(quarter, workspaceId)
  ]);
  if (fuel.length > IFTA_MAX_PURCHASES) return { ok: false, error: `${quarter} has more than ${IFTA_MAX_PURCHASES.toLocaleString("en-US")} fuel purchases, more than one return is worked from.`, code: "bad_request" };

  const flags = await readFlags(flagContextStart(from, now), workspaceId);
  const ids = fuel.map((f) => f.id);
  const open = countFlags(flags, ids);
  const flagged = ids.filter((id) => (flags.byId.get(id)?.open.length ?? 0) > 0);

  const truckIds = [...new Set([...chosen.keys(), ...fuel.flatMap((f) => (f.vehicleId ? [f.vehicleId] : []))])];
  const names = new Map((await prisma.vehicle.findMany({ where: { workspaceId, id: { in: truckIds } }, select: { id: true, name: true } })).map((v) => [v.id, v.name]));

  const returnFuel = fuel.map((f) => ({ id: f.id, vehicleId: f.vehicleId, state: f.purchaseState, product: f.product, status: f.status, taxPaid: f.taxPaid, gallons: f.gallons?.toString() ?? null }));
  const math = iftaReturnMath({
    miles: counted.map((g) => ({ vehicleId: g.vehicleId, jurisdiction: g.jurisdiction, miles: (g._sum.miles ?? 0).toString() })),
    fuel: returnFuel,
    rates: rates.map((r) => ({ jurisdiction: r.jurisdiction, rate: r.rate, surcharge: r.surcharge, isSample: r.isSample })),
    trucks: truckIds.map((vehicleId) => ({ vehicleId, name: names.get(vehicleId) ?? null, method: chosen.get(vehicleId)?.method ?? null, source: chosen.get(vehicleId)?.source ?? null })),
    openFlags: { count: flagged.length, ids: flagged }
  });
  const rateFinal = rates.filter((r) => r.status === "final").length;
  const rateSample = rates.filter((r) => r.isSample).length;
  const base: IftaReturnOk = { ok: true, quarter, from, to, dueDate: iftaDueDate(quarter)!, rateCount: rates.length, rateFinal, rateSample, rateState: rateState(rates.length, rateFinal, rateSample), flagsPartial: open.partial, ...math };
  if (!detail) return { ...base, pieces: [], receipts: [], piecesCapped: false };

  // The counted pieces: for each truck, exactly the method and company its sums came from.
  const only = detail.vehicleId ?? null;
  const pairs = [...chosen].filter(([v]) => only == null || v === only);
  const rows =
    pairs.length === 0
      ? []
      : await prisma.iftaMileage.findMany({
          where: { workspaceId, quarter, OR: pairs.map(([vehicleId, c]) => ({ vehicleId, method: c.method, source: c.source })) },
          select: { id: true, vehicleId: true, method: true, source: true, jurisdiction: true, loaded: true, loadId: true, startOdometer: true, endOdometer: true, startedAt: true, endedAt: true, miles: true, externalId: true, load: { select: { loadNumber: true } } },
          orderBy: [{ vehicleId: "asc" }, { startedAt: "asc" }, { externalId: "asc" }],
          take: IFTA_MAX_PIECES + 1
        });
  const pieces: IftaPiece[] = rows.slice(0, IFTA_MAX_PIECES).map((r) => ({
    id: r.id,
    vehicleId: r.vehicleId,
    method: r.method,
    source: r.source,
    jurisdiction: r.jurisdiction,
    loaded: r.loaded,
    loadId: r.loadId,
    loadNumber: r.load?.loadNumber ?? null,
    startOdometer: r.startOdometer?.toFixed(1) ?? null,
    endOdometer: r.endOdometer?.toFixed(1) ?? null,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    miles: r.miles.toFixed(1),
    externalId: r.externalId
  }));
  const asReturn = new Map(returnFuel.map((f) => [f.id, f]));
  const receipts: IftaReceipt[] = fuel
    .filter((f) => only == null || f.vehicleId === only)
    .map((f) => ({
      id: f.id,
      vehicleId: f.vehicleId,
      provider: f.provider,
      externalId: f.externalId,
      at: f.purchasedAt ?? f.postedAt,
      location: f.location,
      state: f.purchaseState,
      product: f.product,
      status: f.status,
      taxPaid: f.taxPaid,
      gallons: f.gallons?.toFixed(3) ?? null,
      amount: f.amount.toFixed(2),
      counted: isReturnFuel(asReturn.get(f.id)!)
    }))
    .sort((a, b) => a.at.getTime() - b.at.getTime() || a.id.localeCompare(b.id));
  return { ...base, pieces, receipts, piecesCapped: rows.length > IFTA_MAX_PIECES };
}

export async function iftaReturn(quarter: string, now = new Date(), workspaceId = currentWorkspaceId()): Promise<IftaReturn> {
  const r = await read(quarter, now, workspaceId, null);
  if (!r.ok) return r;
  const { pieces: _p, receipts: _r, piecesCapped: _c, ...ret } = r;
  return ret;
}

/** The return with the rows behind it: the counted mileage pieces and the quarter's fuel receipts, for the fleet or for one truck. */
export async function iftaReturnDetail(quarter: string, opts: { vehicleId?: string | null } = {}, now = new Date(), workspaceId = currentWorkspaceId()): Promise<IftaReturnDetail> {
  return read(quarter, now, workspaceId, opts);
}
