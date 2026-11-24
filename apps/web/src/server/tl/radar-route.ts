import { prisma } from "@/lib/db";
import { terminalFilter, type Terminals } from "@/lib/scope";
import { getLoadTracking, type TrackingStop } from "./load-tracking";
import { truckInTerminal } from "./radar";
import { getTruckWhere } from "./whereabouts";

/**
 * What the radar draws for the unit a dispatcher clicked: its active load's lane (the stops in order), the breadcrumb of fixes since the load began, and the card's live lines (driver, hours left,
 * ETA and whether it is on schedule, the next stop with its window, the trailer it pulls). A tractor's load is the one it is running; a trailer's is the load it is on, else its tractor's.
 * Read only: built from getLoadTracking (the load drawer's own tracking) and getTruckWhere (the hover's own words), so the map says exactly what those screens say. Scoped to the workspace and the
 * terminals in view; a unit outside them, or with no load, answers `status: "none"`.
 */
export type RadarRoute =
  | { mode: "route"; status: "none" }
  | {
      mode: "route";
      status: "tracking" | "no_lane" | "no_position" | "no_truck";
      loadId: string;
      loadNumber: string | null;
      truckId: string | null;
      stops: TrackingStop[];
      trail: Array<{ lat: number; lng: number }>;
      /** The stretches of road it drove (LoadTracking `driven`). */
      driven: Array<Array<[number, number]>>;
      /** The road route (standard car directions, server memory only), when one could be had; else no line is drawn. */
      road: Array<[number, number]> | null;
      roadState: "on" | "none" | "off";
      headline: string | null;
      late: boolean;
      driver: string | null;
      hos: string | null;
      eta: string | null;
      nextStop: string | null;
      trailer: string | null;
    };

const RUNNING = ["accepted", "in_progress"];
const ON_LOAD = ["draft", "accepted", "in_progress"];
const NONE: RadarRoute = { mode: "route", status: "none" };
/** In progress first, then accepted: the load the unit is actually running. */
const running = { status: "desc" as const };

export async function unitRoute(kind: string, id: string, workspaceId: string, terminal: Terminals, now = new Date()): Promise<RadarRoute> {
  if (!id) return NONE;
  let load: { id: string; loadNumber: string | null; vehicleId: string | null } | null = null;
  if (kind === "trailer") {
    const f = terminal != null ? terminalFilter(terminal) : undefined;
    const tr = await prisma.trailer.findFirst({ where: { id, workspaceId, archivedAt: null, ...(f !== undefined ? { terminal: f } : {}) }, select: { id: true, currentVehicleId: true } });
    if (!tr) return NONE;
    load = await prisma.load.findFirst({ where: { workspaceId, deletedAt: null, trailerId: tr.id, status: { in: ON_LOAD } }, orderBy: running, select: { id: true, loadNumber: true, vehicleId: true } });
    if (!load && tr.currentVehicleId) load = await prisma.load.findFirst({ where: { workspaceId, deletedAt: null, vehicleId: tr.currentVehicleId, status: { in: RUNNING } }, orderBy: running, select: { id: true, loadNumber: true, vehicleId: true } });
  } else {
    const truck = await prisma.vehicle.findFirst({ where: { id, workspaceId, archivedAt: null, ...truckInTerminal(terminal) }, select: { id: true } });
    if (!truck) return NONE;
    load = await prisma.load.findFirst({ where: { workspaceId, deletedAt: null, vehicleId: truck.id, status: { in: RUNNING } }, orderBy: running, select: { id: true, loadNumber: true, vehicleId: true } });
  }
  if (!load) return NONE;

  // In order: the tracking may fetch the load's road route (once, kept in memory), and the card's ETA line then reads the same route.
  const tracking = await getLoadTracking(load.id, workspaceId, now);
  const where = load.vehicleId ? await getTruckWhere([load.vehicleId], workspaceId, terminal, now) : new Map();
  const w = load.vehicleId ? where.get(load.vehicleId) : undefined;
  const base = { mode: "route" as const, loadId: load.id, loadNumber: load.loadNumber, truckId: load.vehicleId, driver: w?.driver ?? null, hos: w?.hos ?? null, eta: w?.eta ?? null, nextStop: w?.nextStop ?? null, trailer: w?.hitched?.kind === "trailer" ? w.hitched.name : null };
  if (tracking.status === "tracking") return { ...base, status: "tracking", stops: tracking.stops, trail: tracking.trail, driven: tracking.driven, road: tracking.road?.coords ?? null, roadState: tracking.roadState, headline: tracking.headline, late: tracking.late };
  return { ...base, status: tracking.status, stops: [], trail: [], driven: [], road: null, roadState: "none", headline: null, late: false };
}
