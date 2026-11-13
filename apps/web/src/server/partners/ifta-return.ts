import { prisma } from "@/lib/db";
import { isIftaQuarter } from "@/lib/ifta-rates-csv";
import { iftaReturnMath, type IftaReturnMath } from "@/lib/ifta-return";
import { currentWorkspaceId } from "@/server/tl/workspace";
import { workspaceTimezone } from "@/server/tl/zone";
import { countFlags, flagContextStart, readFlags } from "./fuel-flags";
import { countedMileage, quarterBounds } from "./ifta-mileage";
import { listIftaRates } from "./ifta-rates";

/**
 * A quarter's IFTA return, read from the records and worked out by lib/ifta-return.ts (money plan Wave 5 step 6): the one answer the return screen, its CSVs, the per-truck audit (step 7) and a
 * filed return (step 8) all read. Nothing is written.
 *
 *   - Miles: each truck's counted rows only (ELD first, through countedMileage, the same read /ifta uses).
 *   - Fuel: every purchase in the quarter by the moment it was bought (`purchasedAt`, else the day it posted), in the workspace's own calendar. The math counts settled road diesel only.
 *   - Rates: the quarter's rate table (step 4).
 *   - Open fuel exception flags on any of the quarter's purchases, read the way Fuel reads them (the whole fleet's context, then narrowed to these purchases).
 */
export type IftaReturn = ({ ok: true; quarter: string; from: Date; to: Date; rateFinal: number; rateCount: number; flagsPartial: boolean } & IftaReturnMath) | { ok: false; error: string; code: string };

/** The most purchases one return reads. A quarter with more says so rather than leaving some out. */
export const IFTA_MAX_PURCHASES = 50_000;

export async function iftaReturn(quarter: string, now = new Date(), workspaceId = currentWorkspaceId()): Promise<IftaReturn> {
  if (!isIftaQuarter(quarter)) return { ok: false, error: "A quarter, like 2026-Q3.", code: "bad_request" };
  const tz = await workspaceTimezone(workspaceId);
  const { from, to } = quarterBounds(quarter, tz)!;
  const [{ counted, chosen }, fuel, rates] = await Promise.all([
    countedMileage(quarter, workspaceId),
    prisma.fuelTransaction.findMany({
      where: { workspaceId, OR: [{ purchasedAt: { gte: from, lt: to } }, { purchasedAt: null, postedAt: { gte: from, lt: to } }] },
      select: { id: true, vehicleId: true, purchaseState: true, product: true, status: true, taxPaid: true, gallons: true },
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

  const math = iftaReturnMath({
    miles: counted.map((g) => ({ vehicleId: g.vehicleId, jurisdiction: g.jurisdiction, miles: (g._sum.miles ?? 0).toString() })),
    fuel: fuel.map((f) => ({ id: f.id, vehicleId: f.vehicleId, state: f.purchaseState, product: f.product, status: f.status, taxPaid: f.taxPaid, gallons: f.gallons?.toString() ?? null })),
    rates: rates.map((r) => ({ jurisdiction: r.jurisdiction, rate: r.rate, surcharge: r.surcharge, isSample: r.isSample })),
    trucks: truckIds.map((vehicleId) => ({ vehicleId, name: names.get(vehicleId) ?? null, method: chosen.get(vehicleId)?.method ?? null, source: chosen.get(vehicleId)?.source ?? null })),
    openFlags: { count: flagged.length, ids: flagged }
  });
  return { ok: true, quarter, from, to, rateCount: rates.length, rateFinal: rates.filter((r) => r.status === "final").length, flagsPartial: open.partial, ...math };
}
