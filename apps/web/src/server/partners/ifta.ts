import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { centralInstant } from "@/lib/zoned";
import { recordAudit } from "@/server/tl/audit";
import { num } from "@/server/tl/convert";
import { currentWorkspaceId } from "@/server/tl/workspace";
import { workspaceTimezone } from "@/server/tl/zone";
import { callPartner, providerName } from "./call";

/**
 * IFTA: a quarter's fuel-tax miles and gallons by state, worked out by the mileage company from the quarter's delivered loads and then kept (the `ifta_lines` store, one answer per quarter, replaced
 * as a whole each time). The quarter is the workspace's own calendar. What is sent is each delivered load's places and its loaded miles; empty miles have no places on a load, so they are not in
 * these numbers until an ELD's state-by-state odometer is (said on the screen when one is built). Gallons are fuel consumed from the miles; fuel bought comes from the fuel card.
 */
export type IftaResult = { ok: true; jurisdictions: Array<{ state: string; miles: number; gallons: number }>; loads?: number; stored?: boolean } | { ok: false; error: string; code?: string };

/** The most delivered loads one quarter's answer is worked from. A quarter with more says so rather than quietly leaving the rest out. */
export const IFTA_MAX_LOADS = 20_000;

export const quarterBounds = (quarter: string, tz: string): { from: Date; to: Date } | null => {
  const m = /^(\d{4})-Q([1-4])$/.exec(quarter);
  if (!m) return null;
  const year = parseInt(m[1]!, 10);
  const q = parseInt(m[2]!, 10);
  return { from: new Date(centralInstant(year, (q - 1) * 3, 1, 0, 0, tz)), to: new Date(centralInstant(year, q * 3, 1, 0, 0, tz)) };
};

export async function calculateIfta(quarter: string, workspaceId = currentWorkspaceId(), now = new Date()): Promise<IftaResult> {
  if (!/^\d{4}-Q[1-4]$/.test(quarter)) return { ok: false, error: "A quarter, like 2026-Q3.", code: "bad_request" };
  const tz = await workspaceTimezone(workspaceId);
  const bounds = quarterBounds(quarter, tz)!;
  const [vehicles, loads] = await Promise.all([
    prisma.vehicle.findMany({ where: { workspaceId, archivedAt: null }, select: { id: true, name: true }, take: 2000 }),
    prisma.load.findMany({
      where: { workspaceId, deletedAt: null, status: "completed", completedAt: { gte: bounds.from, lt: bounds.to }, vehicleId: { not: null }, originAddress: { not: null }, destinationAddress: { not: null } },
      select: { id: true, vehicleId: true, originAddress: true, destinationAddress: true, loadedMiles: true, vehicle: { select: { mpg: true } } },
      orderBy: { completedAt: "asc" },
      take: IFTA_MAX_LOADS + 1
    })
  ]);
  if (loads.length > IFTA_MAX_LOADS) return { ok: false, error: `${quarter} has more than ${IFTA_MAX_LOADS.toLocaleString("en-US")} delivered loads, which is more than one answer is worked from. Ask for it by month.`, code: "bad_request" };
  const trips = loads.map((l) => ({ id: l.id, vehicleId: l.vehicleId!, origin: l.originAddress!, destination: l.destinationAddress!, miles: num(l.loadedMiles), mpg: l.vehicle?.mpg != null ? num(l.vehicle.mpg) : null })).filter((t) => t.miles > 0);
  const { provider, result } = await callPartner("ifta", null, { quarter, vehicles, trips }, workspaceId);
  if (!result.ok) return { ok: false, error: result.message ?? "The mileage company could not be reached.", code: result.code };
  const rows = result.data.jurisdictions;
  await prisma.$transaction(async (tx) => {
    // One answer per quarter: the last one replaces the one before, so the store is never half of each.
    await tx.iftaLine.deleteMany({ where: { workspaceId, quarter } });
    if (rows.length > 0) await tx.iftaLine.createMany({ data: rows.map((r) => ({ workspaceId, quarter, state: r.state, miles: new Prisma.Decimal(r.miles), gallons: new Prisma.Decimal(r.gallons), source: provider, loads: trips.length, computedAt: now })) });
    const total = rows.reduce((s, r) => s.plus(r.miles), new Prisma.Decimal(0)).toDecimalPlaces(1).toNumber();
    await recordAudit({ entity: "fleet", action: "partner_event", summary: `${quarter} fuel-tax miles worked out by ${providerName(provider)}: ${total.toLocaleString("en-US")} miles in ${rows.length} ${rows.length === 1 ? "state" : "states"}, from ${trips.length} delivered ${trips.length === 1 ? "load" : "loads"}`, at: now, workspaceId }, tx);
  });
  return { ok: true, jurisdictions: rows, loads: trips.length, stored: true };
}

/** What is kept for a quarter, by state. Empty when it has not been worked out. */
export async function storedIfta(quarter: string, workspaceId = currentWorkspaceId()) {
  const rows = await prisma.iftaLine.findMany({ where: { workspaceId, quarter }, orderBy: { state: "asc" } });
  return rows.map((r) => ({ state: r.state, miles: num(r.miles), gallons: num(r.gallons), source: r.source, loads: r.loads, computedAt: r.computedAt }));
}
