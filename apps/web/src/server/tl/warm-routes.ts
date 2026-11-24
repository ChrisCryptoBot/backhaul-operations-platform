import { prisma } from "@/lib/db";
import { geofence, roadMilesLeft, stopsAhead } from "@/lib/telematics";
import { STALE_MINUTES } from "@/lib/whereabouts";
import { mapboxConfigured } from "@/server/geo/mapbox";
import { ensureRoadRoute, ensureWayThere } from "@/server/geo/road-route";
import { numOrNull } from "./convert";
import { FAIL_TTL_MS, readRoadRoute, readWayThere, roomToWarm } from "./road-route-cache";

/**
 * The road routes of the loads under way, fetched a few at a time while somebody has the radar open (Chris, 2026-11-24), so the Late chip, the list and the hover know every moving truck's road and
 * not only the ones that were opened. The radar asks for it (`?mode=roads`); the reads themselves still fetch nothing.
 *
 * What bounds it: only loads under way whose truck has a fresh position (an old one gives no arrival, so its road is not needed yet); a load with a road its truck is on is never asked for again (a
 * route lasts 12 hours); at most PASS_MAX a pass, two at once, a pass a minute for the whole company however many screens are open (never one terminal's, or its screen
 * would use up every pass); a failure waits ten minutes; none when the memory is nearly full; and every
 * fetch is claimed against the background share of the directions allowance (lib/spend.ts), which leaves the rest for people.
 */
export const PASS_MAX = 6;
export const PASS_EVERY_MS = 60_000;
const AT_ONCE = 2;
const g = globalThis as { __tlWarmPass?: Map<string, number>; __tlWarmFailed?: Map<string, number> };
const lastPass = (g.__tlWarmPass ??= new Map());
const failed = (g.__tlWarmFailed ??= new Map());

/** For tests: forget the last pass and the failures. */
export function forgetWarming(): void {
  lastPass.clear();
  failed.clear();
}

export async function warmRoadRoutes(workspaceId: string, now = Date.now()): Promise<{ asked: number; got: number }> {
  const none = { asked: 0, got: 0 };
  if (!mapboxConfigured() || now - (lastPass.get(workspaceId) ?? 0) < PASS_EVERY_MS) return none;
  lastPass.set(workspaceId, now);
  for (const [id, at] of failed) if (now - at >= FAIL_TTL_MS) failed.delete(id);

  const loads = await prisma.load.findMany({
    where: { workspaceId, deletedAt: null, status: "in_progress", vehicle: { is: { workspaceId, archivedAt: null, lastLocatedAt: { gte: new Date(now - STALE_MINUTES * 60_000) } } } },
    orderBy: { id: "asc" },
    take: 300,
    select: { id: true, status: true, vehicle: { select: { lastLat: true, lastLng: true } }, stops: { orderBy: { stopSequence: "asc" }, select: { lat: true, lng: true, arrivedAt: true, timeWindowLatest: true } } }
  });

  // What is missing, soonest due first: that is whose lateness matters first.
  const missing: Array<{ id: string; due: number; fetch: () => Promise<unknown> }> = [];
  for (const l of loads) {
    const lat = numOrNull(l.vehicle?.lastLat);
    const lng = numOrNull(l.vehicle?.lastLng);
    const stops = l.stops.map((s) => ({ ...s, lat: numOrNull(s.lat), lng: numOrNull(s.lng) })).filter((s): s is typeof s & { lat: number; lng: number } => s.lat != null && s.lng != null);
    if (lat == null || lng == null || stops.length < 2 || failed.has(l.id)) continue;
    const here = { lat, lng };
    const last = stops[stops.length - 1]!;
    if (geofence(here, last).inside) continue;
    const { ahead, approaching } = stopsAhead(l.status, stops, here);
    const planned = readRoadRoute(l.id, stops, now);
    const due = last.timeWindowLatest?.getTime() ?? Infinity;
    if (planned === undefined) missing.push({ id: l.id, due, fetch: () => ensureRoadRoute(l.id, stops, { background: true }) });
    else if (!roadMilesLeft({ here, approaching, planned, way: readWayThere(l.id, ahead, now)?.route })) missing.push({ id: l.id, due, fetch: () => ensureWayThere(l.id, here, ahead, { background: true }) });
  }
  missing.sort((a, b) => a.due - b.due || (a.id < b.id ? -1 : 1));

  const todo = missing.slice(0, PASS_MAX);
  let asked = 0;
  let got = 0;
  const worker = async () => {
    for (let m = todo.shift(); m; m = todo.shift()) {
      if (!roomToWarm()) return;
      asked++;
      if (await m.fetch().catch(() => null)) got++;
      else failed.set(m.id, now);
    }
  };
  await Promise.all(Array.from({ length: AT_ONCE }, worker));
  return { asked, got };
}
