import { prisma } from "@/lib/db";
import { arrivalEntry, callEntry, loadEntry, moveEntry, sortHistory, stayEntry, type HistoryEntry } from "@/lib/asset-history";
import { cityState } from "@/lib/city-state";
import { dateTime } from "@/lib/desk-format";
import { nearestPlace } from "@/lib/gazetteer/place-index";
import { notQuote } from "@/lib/quote-status";
import { longEnough } from "@/lib/stays";
import { whereIs, type KnownStop } from "@/lib/whereabouts";
import { numOrNull } from "./convert";
import { knownStopsNear } from "./whereabouts";
import { currentWorkspaceId } from "./workspace";

/**
 * The history of one truck or trailer, assembled for its History tab: where it stood and for how long (a tractor's stays), the check calls made about it, the stops it reached for its loads and who
 * drove them, and for a trailer which tractor pulled it and where it was left. Everything is read for this one unit and the window asked for, and the places are named from the stops of the fleet's own
 * loads and the offline gazetteer (no map provider). History starts when each source started being kept: stays and hooks from the day this shipped, calls from the first one logged.
 */
export type AssetHistory = {
  entries: HistoryEntry[];
  days: number;
  /** The unit's open loads, for the check-call form to tie a call to one. */
  openLoads: Array<{ id: string; number: string }>;
};

const DAY = 86_400_000;
const town = (lat: number, lng: number, max: number) => nearestPlace(lat, lng, max);
const fmt = (ms: number) => dateTime(new Date(ms));
/** A stay or drop reads "Stopped · Acme Foods dock, Memphis, TN", not "Stopped · At Acme...". */
const placeText = (label: string) => label.replace(/^At /, "");

type Point = { lat: number; lng: number };

/** A place in words for each point: the facility when it is a stop on file, else the nearest town. */
async function namePlaces(points: Point[], workspaceId: string, now: Date): Promise<(p: Point | null) => string | null> {
  const stops: KnownStop[] = await knownStopsNear(points, workspaceId, now);
  return (p) => (p ? placeText(whereIs({ lat: p.lat, lng: p.lng, speedMph: 0, engine: "off", headingDeg: null, locatedAt: null, standing: true }, stops, town, now.getTime()).label) : null);
}

type LoadForHistory = {
  id: string;
  loadNumber: string | null;
  status: string;
  scheduledDate: Date | null;
  originAddress: string | null;
  destinationAddress: string | null;
  stops: Array<{ id: string; stopSequence: number; stopRole: string | null; facilityName: string | null; addressString: string; arrivedAt: Date | null; timeWindowEarliest: Date | null }>;
  assignment: { driver: { name: string } | null } | null;
};

/** Arrivals at stops inside the window, and a plain load line for a load that reached none of them. */
function loadEntries(loads: LoadForHistory[], since: number, now: number): HistoryEntry[] {
  const out: HistoryEntry[] = [];
  for (const l of loads) {
    const driver = l.assignment?.driver?.name ?? null;
    const arrived = l.stops.filter((s) => s.arrivedAt && s.arrivedAt.getTime() >= since && s.arrivedAt.getTime() <= now);
    for (const s of arrived) out.push(arrivalEntry({ id: s.id, at: s.arrivedAt!.getTime(), role: s.stopRole, place: s.facilityName?.trim() || cityState(s.addressString) || s.addressString, loadId: l.id, loadNumber: l.loadNumber, driver }));
    if (arrived.length === 0) {
      const first = l.stops[0]?.timeWindowEarliest ?? l.scheduledDate;
      if (first && first.getTime() >= since && first.getTime() <= now) out.push(loadEntry({ id: l.id, at: first.getTime(), loadNumber: l.loadNumber, route: [l.originAddress, l.destinationAddress].map((a) => cityState(a) ?? "").filter(Boolean).join(" → "), status: l.status.replace("_", " "), driver }));
    }
  }
  return out;
}

const loadSelect = {
  id: true,
  loadNumber: true,
  status: true,
  scheduledDate: true,
  originAddress: true,
  destinationAddress: true,
  stops: { orderBy: { stopSequence: "asc" as const }, select: { id: true, stopSequence: true, stopRole: true, facilityName: true, addressString: true, arrivedAt: true, timeWindowEarliest: true } },
  assignment: { select: { driver: { select: { name: true } } } }
};

export async function getTruckHistory(vehicleId: string, days: number, workspaceId = currentWorkspaceId(), now = new Date()): Promise<AssetHistory> {
  const since = new Date(now.getTime() - days * DAY);
  const [stays, calls, moves, loads, open] = await Promise.all([
    prisma.unitStay.findMany({ where: { workspaceId, vehicleId, OR: [{ arrivedAt: { gte: since } }, { leftAt: null }, { leftAt: { gte: since } }] }, orderBy: { arrivedAt: "desc" }, take: 300 }),
    prisma.checkCall.findMany({ where: { workspaceId, vehicleId, at: { gte: since } }, orderBy: { at: "desc" }, take: 300, include: { load: { select: { loadNumber: true } } } }),
    prisma.trailerMove.findMany({ where: { workspaceId, vehicleId, at: { gte: since } }, orderBy: { at: "desc" }, take: 200, include: { trailer: { select: { number: true } } } }),
    prisma.load.findMany({ where: { workspaceId, vehicleId, deletedAt: null, ...notQuote, OR: [{ scheduledDate: { gte: since, lte: now } }, { stops: { some: { arrivedAt: { gte: since } } } }] }, orderBy: { scheduledDate: "desc" }, take: 100, select: loadSelect }),
    prisma.load.findMany({ where: { workspaceId, vehicleId, deletedAt: null, status: { in: ["accepted", "in_progress"] } }, select: { id: true, loadNumber: true }, take: 20 })
  ]);
  const keptStays = stays.filter((s) => s.leftAt != null || longEnough(s.arrivedAt.getTime(), s.lastSeenAt.getTime()));
  const points: Point[] = [...keptStays.map((s) => ({ lat: numOrNull(s.lat)!, lng: numOrNull(s.lng)! })), ...moves.flatMap((m) => (m.lat != null && m.lng != null ? [{ lat: numOrNull(m.lat)!, lng: numOrNull(m.lng)! }] : []))];
  const name = await namePlaces(points, workspaceId, now);
  const entries: HistoryEntry[] = [
    ...keptStays.map((s) => stayEntry({ id: s.id, arrivedAt: s.arrivedAt.getTime(), lastSeenAt: s.lastSeenAt.getTime(), leftAt: s.leftAt?.getTime() ?? null }, name({ lat: numOrNull(s.lat)!, lng: numOrNull(s.lng)! }) ?? "Position only")),
    ...calls.map((c) => callEntry({ id: c.id, at: c.at.getTime(), place: c.place, etaAt: c.etaAt?.getTime() ?? null, status: c.status, note: c.note, spokeWith: c.spokeWith, loggedBy: c.loggedBy, loadNumber: c.load?.loadNumber ?? null }, fmt)),
    ...moves.map((m) => moveEntry({ id: m.id, kind: m.kind === "dropped" ? "dropped" : "hooked", at: m.at.getTime(), tractor: null, trailer: m.trailer.number, place: name(m.lat != null && m.lng != null ? { lat: numOrNull(m.lat)!, lng: numOrNull(m.lng)! } : null), by: m.byName }, null)),
    ...loadEntries(loads, since.getTime(), now.getTime())
  ];
  return { entries: sortHistory(entries), days, openLoads: open.map((l) => ({ id: l.id, number: l.loadNumber ?? "A load" })) };
}

export async function getTrailerHistory(trailerId: string, days: number, workspaceId = currentWorkspaceId(), now = new Date()): Promise<AssetHistory> {
  const since = new Date(now.getTime() - days * DAY);
  const [trailer, calls, moves, loads, open] = await Promise.all([
    prisma.trailer.findFirst({ where: { id: trailerId, workspaceId }, select: { currentVehicleId: true } }),
    prisma.checkCall.findMany({ where: { workspaceId, trailerId, at: { gte: since } }, orderBy: { at: "desc" }, take: 300, include: { load: { select: { loadNumber: true } } } }),
    prisma.trailerMove.findMany({ where: { workspaceId, trailerId, at: { gte: since } }, orderBy: { at: "asc" }, take: 200, include: { vehicle: { select: { name: true } } } }),
    prisma.load.findMany({ where: { workspaceId, trailerId, deletedAt: null, ...notQuote, OR: [{ scheduledDate: { gte: since, lte: now } }, { stops: { some: { arrivedAt: { gte: since } } } }] }, orderBy: { scheduledDate: "desc" }, take: 100, select: loadSelect }),
    prisma.load.findMany({ where: { workspaceId, trailerId, deletedAt: null, status: { in: ["draft", "accepted", "in_progress"] } }, select: { id: true, loadNumber: true }, take: 20 })
  ]);
  // Each hook runs until the next drop (or to now while it is still hooked to that tractor): the tractor's stays in that time are where the trailer stood, too.
  const intervals: Array<{ vehicleId: string; name: string; from: Date; to: Date }> = [];
  moves.forEach((m, i) => {
    if (m.kind !== "hooked" || !m.vehicleId) return;
    const drop = moves.slice(i + 1).find((x) => x.kind === "dropped");
    const to = drop ? drop.at : trailer?.currentVehicleId === m.vehicleId ? now : m.at;
    intervals.push({ vehicleId: m.vehicleId, name: m.vehicle?.name ?? "a tractor", from: m.at, to });
  });
  const ridden = (await Promise.all(intervals.slice(-10).map(async (iv) => ({ iv, stays: await prisma.unitStay.findMany({ where: { workspaceId, vehicleId: iv.vehicleId, arrivedAt: { lte: iv.to }, OR: [{ leftAt: null }, { leftAt: { gte: iv.from } }] }, orderBy: { arrivedAt: "desc" }, take: 100 }) })))).flatMap(({ iv, stays }) => stays.filter((s) => s.leftAt != null || longEnough(s.arrivedAt.getTime(), s.lastSeenAt.getTime())).map((s) => ({ iv, s })));
  const points: Point[] = [...ridden.map(({ s }) => ({ lat: numOrNull(s.lat)!, lng: numOrNull(s.lng)! })), ...moves.flatMap((m) => (m.lat != null && m.lng != null ? [{ lat: numOrNull(m.lat)!, lng: numOrNull(m.lng)! }] : []))];
  const name = await namePlaces(points, workspaceId, now);
  const seen = new Set<string>();
  const stayEntries = ridden.flatMap(({ iv, s }) => {
    if (seen.has(s.id)) return [];
    seen.add(s.id);
    return [stayEntry({ id: s.id, arrivedAt: s.arrivedAt.getTime(), lastSeenAt: s.lastSeenAt.getTime(), leftAt: s.leftAt?.getTime() ?? null }, `${name({ lat: numOrNull(s.lat)!, lng: numOrNull(s.lng)! }) ?? "Position only"} (with ${iv.name})`)];
  });
  const moveEntries = moves.map((m, i) => {
    const point = m.lat != null && m.lng != null ? { lat: numOrNull(m.lat)!, lng: numOrNull(m.lng)! } : null;
    let sat: { until: number; ongoing: boolean } | null = null;
    if (m.kind === "dropped") {
      const next = moves.slice(i + 1).find((x) => x.kind === "hooked");
      sat = next ? { until: next.at.getTime(), ongoing: false } : trailer?.currentVehicleId == null ? { until: now.getTime(), ongoing: true } : null;
    }
    return moveEntry({ id: m.id, kind: m.kind === "dropped" ? "dropped" : "hooked", at: m.at.getTime(), tractor: m.vehicle?.name ?? null, place: name(point), by: m.byName }, sat);
  });
  const callEntries = calls.map((c) => callEntry({ id: c.id, at: c.at.getTime(), place: c.place, etaAt: c.etaAt?.getTime() ?? null, status: c.status, note: c.note, spokeWith: c.spokeWith, loggedBy: c.loggedBy, loadNumber: c.load?.loadNumber ?? null }, fmt));
  return { entries: sortHistory([...stayEntries, ...moveEntries, ...callEntries, ...loadEntries(loads, since.getTime(), now.getTime())]), days, openLoads: open.map((l) => ({ id: l.id, number: l.loadNumber ?? "A load" })) };
}
