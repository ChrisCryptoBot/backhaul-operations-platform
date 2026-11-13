import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { isIftaQuarter } from "@/lib/ifta-rates-csv";
import { recordAudit } from "@/server/tl/audit";
import { lockWorkspace } from "@/server/tl/plan";
import { currentWorkspaceId } from "@/server/tl/workspace";
import { workspaceTimezone } from "@/server/tl/zone";
import { callPartner, providerName, type IftaTripHint } from "./call";
import { IFTA_MAX_LOADS, quarterBounds } from "./ifta";

/**
 * A quarter's miles by state as the ELD reported them (money plan Wave 5 step 5a): every piece each truck drove, loaded or empty, with its odometers and times, kept in `ifta_mileage` for the
 * return (step 6) and the per-truck audit (step 7). The quarter is the workspace's own calendar; a piece belongs to the quarter it starts in.
 *
 * The desk hands the ELD each truck's loads around the quarter (places, pickup and delivery times, loaded and empty miles) so a piece can be tied to the load it was driven on; the simulator
 * also drives the trucks from them. A read REPLACES what the answered trucks had for the quarter from that ELD, with the workspace locked, in one transaction, with one audit event: reading the
 * same quarter twice, or two reads at once, never doubles a piece (the unique key on the company's piece id is the backstop). A truck the ELD reported nothing for keeps what it had, and is
 * counted as "no ELD miles" for step 5b's routed fallback. Canadian miles are counted and said, not kept (gap 15). Only the billing office reaches it (the action checks `bill`).
 */
export type IftaMileageSync =
  | {
      ok: true;
      provider: string;
      batchId: string;
      quarter: string;
      /** Trucks the ELD answered for, and trucks asked about that it reported nothing for. */
      trucks: number;
      notAnswered: number;
      pieces: number;
      /** Pieces the answered trucks had for the quarter before, all replaced. */
      replaced: number;
      states: number;
      miles: string;
      loadedMiles: string;
      emptyMiles: string;
      canadaMiles: string;
      skipped: { outsideQuarter: number; afterAsOf: number; unreadable: number; duplicate: number };
    }
  | { ok: false; error: string; code?: string };

const BAD_QUARTER = "A quarter, like 2026-Q3.";
const DAY = 86_400_000;
const HOUR = 3_600_000;
/** How far either side of the quarter a load is looked at: a load picked up in one quarter and delivered in the next has pieces in both. */
const MARGIN = 31 * DAY;
const CHUNK = 500;
const whole = (n: number) => n - (n % 1);
const n1 = (d: Prisma.Decimal) => d.toNumber().toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const plural = (v: number, one: string, many: string) => `${v.toLocaleString("en-US")} ${v === 1 ? one : many}`;

type HintLoad = {
  id: string;
  vehicleId: string | null;
  status: string;
  originAddress: string | null;
  destinationAddress: string | null;
  loadedMiles: Prisma.Decimal;
  pickupDeadheadMiles: Prisma.Decimal;
  returnDeadheadMiles: Prisma.Decimal;
  completedAt: Date | null;
  stops: Array<{ addressString: string; arrivedAt: Date | null; timeWindowEarliest: Date | null; timeWindowLatest: Date | null }>;
};

/**
 * A load as a trip hint: picked up when the first stop was arrived at (else its window), delivered when the load was completed (else the last stop's arrival or window). With no pickup time the
 * load is taken to have started its loaded miles' drive time (50 mph) before delivery. A load with no delivery time, or with no place at either end, gives none.
 */
export function hintOf(l: HintLoad): IftaTripHint | null {
  const first = l.stops[0];
  const last = l.stops[l.stops.length - 1];
  const delivered = (l.completedAt ?? last?.arrivedAt ?? last?.timeWindowLatest ?? last?.timeWindowEarliest)?.getTime();
  if (delivered == null) return null;
  const origin = l.originAddress ?? first?.addressString ?? null;
  const destination = l.destinationAddress ?? last?.addressString ?? null;
  if (!origin || !destination) return null;
  const drive = whole(l.loadedMiles.div(50).times(HOUR).toNumber());
  let picked = (first?.arrivedAt ?? first?.timeWindowEarliest ?? first?.timeWindowLatest)?.getTime() ?? delivered - drive;
  if (picked >= delivered) picked = delivered - (drive > HOUR ? drive : HOUR);
  return { loadId: l.id, origin, destination, pickupAt: picked, deliveredAt: delivered, loadedMiles: l.loadedMiles.toFixed(4), pickupDeadheadMiles: l.pickupDeadheadMiles.toFixed(4), returnDeadheadMiles: l.returnDeadheadMiles.toFixed(4) };
}

/** Each truck's loads that touch the quarter (delivered or on the road), as trip hints in pickup order. */
async function hintsFor(workspaceId: string, bounds: { from: Date; to: Date }): Promise<Map<string, IftaTripHint[]> | null> {
  const loads = await prisma.load.findMany({
    where: {
      workspaceId,
      deletedAt: null,
      vehicleId: { not: null },
      OR: [{ status: "completed", completedAt: { gte: new Date(bounds.from.getTime() - MARGIN), lt: new Date(bounds.to.getTime() + MARGIN) } }, { status: "in_progress" }]
    },
    select: {
      id: true,
      vehicleId: true,
      status: true,
      originAddress: true,
      destinationAddress: true,
      loadedMiles: true,
      pickupDeadheadMiles: true,
      returnDeadheadMiles: true,
      completedAt: true,
      stops: { orderBy: { stopSequence: "asc" }, select: { addressString: true, arrivedAt: true, timeWindowEarliest: true, timeWindowLatest: true } }
    },
    orderBy: { id: "asc" },
    take: IFTA_MAX_LOADS + 1
  });
  if (loads.length > IFTA_MAX_LOADS) return null;
  const out = new Map<string, IftaTripHint[]>();
  for (const l of loads) {
    const h = hintOf(l);
    if (!h || !l.vehicleId) continue;
    // Only what could have a piece in the quarter: picked up (less a day for the empty run) before it ends, delivered (plus a day for the run home) after it begins.
    if (h.pickupAt - DAY >= bounds.to.getTime() || h.deliveredAt + DAY < bounds.from.getTime()) continue;
    out.set(l.vehicleId, [...(out.get(l.vehicleId) ?? []), h]);
  }
  for (const list of out.values()) list.sort((a, b) => a.pickupAt - b.pickupAt || a.loadId.localeCompare(b.loadId));
  return out;
}

export async function syncIftaMileage(quarter: string, now = new Date(), workspaceId = currentWorkspaceId()): Promise<IftaMileageSync> {
  if (!isIftaQuarter(quarter)) return { ok: false, error: BAD_QUARTER, code: "bad_request" };
  const tz = await workspaceTimezone(workspaceId);
  const bounds = quarterBounds(quarter, tz)!;
  const hints = await hintsFor(workspaceId, bounds);
  if (!hints) return { ok: false, error: `${quarter} has more than ${IFTA_MAX_LOADS.toLocaleString("en-US")} loads around it, which is more than one read is worked from.`, code: "bad_request" };
  const trucks = await prisma.vehicle.findMany({
    where: { workspaceId, OR: [{ archivedAt: null }, { id: { in: [...hints.keys()] } }] },
    select: { id: true, name: true, eldVehicleId: true, homeBaseAddress: true },
    orderBy: { id: "asc" }
  });
  const { provider, result } = await callPartner(
    "eld",
    null,
    { op: "ifta_trips", quarter, from: bounds.from.toISOString(), to: bounds.to.toISOString(), asOf: now.getTime(), vehicles: trucks.map((t) => ({ id: t.id, name: t.name, eldVehicleId: t.eldVehicleId, home: t.homeBaseAddress, trips: hints.get(t.id) ?? [] })) },
    workspaceId
  );
  if (!result.ok) return { ok: false, error: result.message ?? "The ELD could not be reached.", code: result.code };
  const answer = result.data.iftaTrips;
  if (!answer) return { ok: false, error: `${providerName(provider)} did not send a quarter's miles.`, code: "upstream_error" };

  const known = new Set(trucks.map((t) => t.id));
  const answered = answer.answered.filter((id) => known.has(id));
  const mine = new Set(answered);
  const pieces = answer.pieces.filter((p) => mine.has(p.vehicleId));
  const canada = answer.canada.filter((c) => mine.has(c.vehicleId));
  const batchId = randomUUID().replace(/-/g, "").slice(0, 16);
  const name = providerName(provider);
  const sum = (xs: Array<{ miles: string }>) => xs.reduce((s, x) => s.plus(x.miles), new Prisma.Decimal(0));
  const miles = sum(pieces);
  const loadedMiles = sum(pieces.filter((p) => p.loaded));
  const emptyMiles = miles.minus(loadedMiles);
  const canadaMiles = sum(canada);
  const states = new Set(pieces.map((p) => p.jurisdiction)).size;
  const notAnswered = trucks.length - answered.length;
  const skipped = answer.skipped;
  const left = skipped.outsideQuarter + skipped.afterAsOf + skipped.unreadable + skipped.duplicate;

  const replaced = await prisma.$transaction(
    async (tx) => {
      await lockWorkspace(tx, workspaceId);
      // Wave 5 step 8: once a filed return (IftaReturn) holds this quarter, refuse here, or warn and require a confirm, before the miles it was worked out from are replaced.
      // A load removed since the read keeps its pieces as loaded with no load.
      const loadIds = [...new Set(pieces.flatMap((p) => (p.loadId ? [p.loadId] : [])))];
      const live = new Set<string>();
      for (let i = 0; i < loadIds.length; i += CHUNK) for (const l of await tx.load.findMany({ where: { workspaceId, id: { in: loadIds.slice(i, i + CHUNK) } }, select: { id: true } })) live.add(l.id);
      // The answered trucks' quarter from this ELD goes, and any row holding one of the new pieces' ids (a piece that moved truck or quarter), so the insert can never meet itself.
      const before = answered.length === 0 ? 0 : await tx.iftaMileage.count({ where: { workspaceId, source: provider, quarter, vehicleId: { in: answered } } });
      if (answered.length > 0) await tx.iftaMileage.deleteMany({ where: { workspaceId, source: provider, quarter, vehicleId: { in: answered } } });
      const ids = pieces.map((p) => p.externalId);
      for (let i = 0; i < ids.length; i += CHUNK) await tx.iftaMileage.deleteMany({ where: { workspaceId, source: provider, externalId: { in: ids.slice(i, i + CHUNK) } } });
      for (let i = 0; i < pieces.length; i += CHUNK) {
        await tx.iftaMileage.createMany({
          data: pieces.slice(i, i + CHUNK).map((p) => ({
            workspaceId,
            vehicleId: p.vehicleId,
            quarter,
            jurisdiction: p.jurisdiction,
            source: provider,
            externalId: p.externalId,
            loadId: p.loadId != null && live.has(p.loadId) ? p.loadId : null,
            loaded: p.loaded,
            startOdometer: new Prisma.Decimal(p.startOdometer),
            endOdometer: new Prisma.Decimal(p.endOdometer),
            miles: new Prisma.Decimal(p.miles),
            startedAt: new Date(p.startedAt),
            endedAt: new Date(p.endedAt),
            syncBatchId: batchId,
            syncedAt: now
          }))
        });
      }
      const parts = [
        pieces.length > 0
          ? `${quarter} ELD miles read from ${name}: ${n1(miles)} miles in ${plural(states, "state", "states")} for ${plural(answered.length, "truck", "trucks")} (${n1(loadedMiles)} loaded, ${n1(emptyMiles)} empty)`
          : `${quarter} ELD miles read from ${name}: no miles reported${answered.length > 0 ? ` for ${plural(answered.length, "truck", "trucks")}` : ""}`,
        before > 0 ? `replacing ${plural(before, "piece", "pieces")}` : null,
        canada.length > 0 ? `${n1(canadaMiles)} miles in Canada not counted (gap 15)` : null,
        notAnswered > 0 ? `${plural(notAnswered, "truck", "trucks")} with no ELD miles` : null,
        left > 0 ? `${plural(left, "piece", "pieces")} left out` : null
      ].filter(Boolean);
      await recordAudit(
        {
          entity: "fleet",
          entityId: batchId,
          action: "ifta_miles_synced",
          summary: parts.join("; "),
          before: before > 0 ? { Pieces: String(before) } : null,
          after: {
            Quarter: quarter,
            Source: name,
            Trucks: String(answered.length),
            "No ELD miles": String(notAnswered),
            Pieces: String(pieces.length),
            Miles: miles.toFixed(1),
            Loaded: loadedMiles.toFixed(1),
            Empty: emptyMiles.toFixed(1),
            "Canada, not counted (gap 15)": canadaMiles.toFixed(1),
            "Outside the quarter": String(skipped.outsideQuarter),
            "After the desk's clock": String(skipped.afterAsOf),
            Unreadable: String(skipped.unreadable),
            Duplicates: String(skipped.duplicate)
          },
          at: now,
          workspaceId
        },
        tx
      );
      return before;
    },
    { timeout: 60_000 }
  );
  return { ok: true, provider, batchId, quarter, trucks: answered.length, notAnswered, pieces: pieces.length, replaced, states, miles: miles.toFixed(1), loadedMiles: loadedMiles.toFixed(1), emptyMiles: emptyMiles.toFixed(1), canadaMiles: canadaMiles.toFixed(1), skipped };
}

export type IftaMileageSummary = { source: string; trucks: number; pieces: number; states: number; miles: string; loadedMiles: string; emptyMiles: string; syncedAt: Date | null };

/** What the quarter holds from each ELD: trucks, pieces, states, miles loaded and empty, and when it was last read. Empty when nothing was read. */
export async function iftaMileageSummary(quarter: string, workspaceId = currentWorkspaceId()): Promise<IftaMileageSummary[]> {
  if (!isIftaQuarter(quarter)) return [];
  const [byLoaded, byTruck, byState] = await Promise.all([
    prisma.iftaMileage.groupBy({ by: ["source", "loaded"], where: { workspaceId, quarter }, _sum: { miles: true }, _count: { _all: true }, _max: { syncedAt: true } }),
    prisma.iftaMileage.groupBy({ by: ["source", "vehicleId"], where: { workspaceId, quarter } }),
    prisma.iftaMileage.groupBy({ by: ["source", "jurisdiction"], where: { workspaceId, quarter } })
  ]);
  const sources = [...new Set(byLoaded.map((r) => r.source))].sort();
  return sources.map((source) => {
    const rows = byLoaded.filter((r) => r.source === source);
    const loaded = rows.filter((r) => r.loaded).reduce((s, r) => s.plus(r._sum.miles ?? 0), new Prisma.Decimal(0));
    const empty = rows.filter((r) => !r.loaded).reduce((s, r) => s.plus(r._sum.miles ?? 0), new Prisma.Decimal(0));
    const at = rows.reduce<Date | null>((m, r) => (r._max.syncedAt && (m == null || r._max.syncedAt > m) ? r._max.syncedAt : m), null);
    return {
      source,
      trucks: byTruck.filter((r) => r.source === source).length,
      pieces: rows.reduce((s, r) => s + r._count._all, 0),
      states: byState.filter((r) => r.source === source).length,
      miles: loaded.plus(empty).toFixed(1),
      loadedMiles: loaded.toFixed(1),
      emptyMiles: empty.toFixed(1),
      syncedAt: at
    };
  });
}
