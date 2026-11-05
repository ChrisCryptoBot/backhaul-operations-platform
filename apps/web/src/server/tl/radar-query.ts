import { nearestPlace } from "@/lib/gazetteer/place-index";
import { pageCount } from "@/lib/paging";
import { STATE_WORD, type ListGroup, type ListRow, type RadarPoint, type RadarQueryParams, type SearchInfo, type StateKey } from "@/lib/radar-points";
import { siteKey, within } from "@/lib/radius";
import type { FleetCounts } from "@/lib/telematics";
import { lookupPlace } from "@/server/geo/place-lookup";
import type { RadarData, RadarTractor, RadarTrailer } from "./radar";

/**
 * The radar asked a question: which units, filtered by kind, state, words, a radius around a typed place, the part of the map in view, or a handful of ids. Answers three ways from the same data:
 * lean points for the map (a fleet of thousands is sent as small points, not cards), a page of rows for the list (optionally grouped by place), and one unit's full card for the inspector. The
 * data is `getRadarData`, already scoped to the workspace and the chosen terminal; this only narrows and shapes it. A search is resolved offline first (src/lib/gazetteer), then by the metered
 * geocoder (server/geo/place-lookup.ts).
 */
export const LIST_PAGE = 50;
export const GROUP_PAGE = 25;

type Unit = {
  kind: "tractor" | "trailer";
  /** What a cluster counts it as: a hooked trailer drawn at its tractor opens the tractor and counts as a trailer. */
  counts: "t" | "r";
  id: string;
  name: string;
  code: string | null;
  lengthFt: number | null;
  state: StateKey;
  lat: number;
  lng: number;
  heading: number;
  icon: string;
  sev: 0 | 1 | 2;
  who: string | null;
  loadId: string | null;
  loadNumber: string | null;
  leak: string | null;
  glyphOnly: boolean;
};

const tractorIcon = (u: RadarTractor) => (u.state === "moving_load" ? "t-load" : u.state === "moving" ? "t-moving" : u.state === "idling" ? "t-idle" : u.state === "parked" ? "t-parked" : "t-none");
const trailerIcon = (u: RadarTrailer) => `tr-${u.dwell?.alert ? "a" : u.hooked ? "h" : "d"}-${u.loaded ? "l" : "e"}`;

/** Every unit as one list: tractors, dropped trailers, and (for the map, when asked) the trailers riding behind tractors as glyphs at their tractor. */
function unitsOf(data: RadarData, withHooked: boolean): Unit[] {
  const out: Unit[] = [];
  for (const u of data.tractors) {
    const state: StateKey = u.state ?? "no_signal";
    out.push({
      kind: "tractor",
      counts: "t",
      id: u.id,
      name: u.name,
      code: null,
      lengthFt: null,
      state,
      lat: u.lat,
      lng: u.lng,
      heading: state === "moving_load" || state === "moving" ? (u.headingDeg ?? 0) : 0,
      icon: tractorIcon(u),
      sev: state === "idling" ? 1 : 0,
      who: u.driver,
      loadId: u.loadId,
      loadNumber: u.loadNumber,
      leak: u.idle?.sentence ?? null,
      glyphOnly: false
    });
    if (withHooked && u.trailer) {
      out.push({ kind: "tractor", counts: "r", id: u.id, name: u.trailer.number, code: u.trailer.code, lengthFt: null, state: "hooked", lat: u.lat, lng: u.lng, heading: 0, icon: `tr-h-${u.trailer.loaded ? "l" : "e"}`, sev: 0, who: u.driver, loadId: u.loadId, loadNumber: u.loadNumber, leak: null, glyphOnly: true });
    }
  }
  for (const u of data.trailers) {
    out.push({
      kind: "trailer",
      counts: "r",
      id: u.id,
      name: u.number,
      code: u.code || null,
      lengthFt: u.lengthFt,
      state: u.dwell?.alert ? "dwell" : u.hooked ? "hooked" : "dropped",
      lat: u.lat,
      lng: u.lng,
      heading: 0,
      icon: trailerIcon(u),
      sev: u.dwell?.alert ? 2 : 0,
      who: u.hookedTo,
      loadId: null,
      loadNumber: null,
      leak: u.dwell?.sentence ?? null,
      glyphOnly: false
    });
  }
  return out;
}

async function resolveSearch(p: RadarQueryParams): Promise<{ info: SearchInfo | null; centre: { lat: number; lng: number } | null; radius: number }> {
  if (!p.near) return { info: null, centre: null, radius: p.r };
  const found = await lookupPlace(p.near);
  if (!found) return { info: { ok: false, text: p.near, error: `Could not find "${p.near}". Try a ZIP code, or a city and state such as Dallas, TX.` }, centre: null, radius: p.r };
  const radius = !p.rGiven && found.defaultRadius ? found.defaultRadius : p.r;
  return { info: { ok: true, text: p.near, label: found.label, lat: found.lat, lng: found.lng, radius, trucks: 0, trailers: 0, source: found.source }, centre: { lat: found.lat, lng: found.lng }, radius };
}

const wordsOf = (u: Unit) => `${u.name} ${u.code ?? ""} ${u.who ?? ""} ${u.loadNumber ?? ""}`.toLowerCase();

function narrow(units: Unit[], p: RadarQueryParams) {
  const q = p.q.toLowerCase();
  return units.filter((u) => {
    if (p.kind !== "all" && p.kind !== u.kind) return false;
    if (p.state && p.state !== u.state) return false;
    if (q && !wordsOf(u).includes(q)) return false;
    return true;
  });
}

const stateOrder: StateKey[] = ["dwell", "idling", "moving_load", "moving", "dropped", "hooked", "parked", "no_signal"];

export type RadarPoints = { mode: "points"; points: RadarPoint[]; total: number; counts: FleetCounts; asOf: string | null; connected: boolean; search: SearchInfo | null };
export type RadarList = { mode: "list"; rows: ListRow[]; groups: ListGroup[] | null; total: number; page: number; pages: number; pageSize: number; search: SearchInfo | null };
export type RadarUnitCard = { mode: "unit"; tractor: RadarTractor | null; trailer: RadarTrailer | null };

/** Points for the map. A search keeps only what is inside the radius, and says how many of each. */
export async function radarPoints(data: RadarData, p: RadarQueryParams): Promise<RadarPoints> {
  const { info, centre, radius } = await resolveSearch(p);
  let units = narrow(unitsOf(data, p.hooked), p);
  if (centre) {
    units = within(units, centre, radius).map((w) => w.item);
    if (info?.ok) {
      info.trucks = units.filter((u) => u.kind === "tractor" && !u.glyphOnly).length;
      info.trailers = units.filter((u) => u.kind === "trailer").length;
    }
  }
  const points: RadarPoint[] = units.map((u) => ({ id: u.id, k: u.kind === "tractor" ? "t" : "r", lat: u.lat, lng: u.lng, icon: u.icon, h: u.heading, sev: u.sev, t: u.counts === "t" ? 1 : 0, r: u.counts === "r" ? 1 : 0, name: u.name }));
  return { mode: "points", points, total: points.length, counts: data.counts, asOf: data.asOf, connected: data.connected, search: info };
}

/** A page of the list, nearest first when there is a search. `group` gathers units that sit at the same place. */
export async function radarList(data: RadarData, p: RadarQueryParams): Promise<RadarList> {
  const { info, centre, radius } = await resolveSearch(p);
  const idSet = p.ids.length > 0 ? new Set(p.ids) : null;
  let units = narrow(unitsOf(data, false), p).filter((u) => (idSet ? idSet.has(u.id) : true));
  if (p.bbox) {
    const [w, s, e, n] = p.bbox;
    units = units.filter((u) => u.lng >= w && u.lng <= e && u.lat >= s && u.lat <= n);
  }
  const miles = new Map<string, number>();
  if (centre) {
    const hits = within(units, centre, radius);
    for (const h of hits) miles.set(`${h.item.kind}:${h.item.id}`, h.miles);
    units = hits.map((h) => h.item);
    if (info?.ok) {
      info.trucks = units.filter((u) => u.kind === "tractor").length;
      info.trailers = units.filter((u) => u.kind === "trailer").length;
    }
  }
  const byName = (a: Unit, b: Unit) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  if (p.sort === "name") units = [...units].sort(byName);
  else if (p.sort === "state") units = [...units].sort((a, b) => stateOrder.indexOf(a.state) - stateOrder.indexOf(b.state) || byName(a, b));
  else if (centre) units = [...units].sort((a, b) => (miles.get(`${a.kind}:${a.id}`) ?? 0) - (miles.get(`${b.kind}:${b.id}`) ?? 0) || byName(a, b));
  else units = [...units].sort(byName);

  const rowOf = (u: Unit): ListRow => ({
    id: u.id,
    kind: u.kind,
    name: u.name,
    code: u.code,
    lengthFt: u.lengthFt,
    state: u.state,
    near: nearestPlace(u.lat, u.lng)?.label ?? null,
    miles: miles.get(`${u.kind}:${u.id}`) ?? null,
    who: u.who,
    loadId: u.loadId,
    loadNumber: u.loadNumber,
    leak: u.leak,
    site: siteKey(u),
    lat: u.lat,
    lng: u.lng,
    href: u.kind === "tractor" ? `/fleet/${u.id}` : `/trailers/${u.id}`
  });

  if (p.group) {
    const groups = new Map<string, Unit[]>();
    for (const u of units) {
      const k = siteKey(u);
      groups.set(k, [...(groups.get(k) ?? []), u]);
    }
    const ordered = [...groups.values()].sort((a, b) => b.length - a.length || byName(a[0]!, b[0]!));
    const pages = pageCount(ordered.length, GROUP_PAGE);
    const page = Math.min(p.page, pages);
    const slice = ordered.slice((page - 1) * GROUP_PAGE, page * GROUP_PAGE);
    const out: ListGroup[] = slice.map((g) => {
      const rows = g.slice(0, 50).map(rowOf);
      return { site: siteKey(g[0]!), near: rows[0]?.near ?? null, lat: g[0]!.lat, lng: g[0]!.lng, trucks: g.filter((u) => u.kind === "tractor").length, trailers: g.filter((u) => u.kind === "trailer").length, rows };
    });
    return { mode: "list", rows: [], groups: out, total: ordered.length, page, pages, pageSize: GROUP_PAGE, search: info };
  }
  const pages = pageCount(units.length, LIST_PAGE);
  const page = Math.min(p.page, pages);
  return { mode: "list", rows: units.slice((page - 1) * LIST_PAGE, page * LIST_PAGE).map(rowOf), groups: null, total: units.length, page, pages, pageSize: LIST_PAGE, search: info };
}

/** The full card of one unit, for the inspector. */
export function radarUnit(data: RadarData, kind: string, id: string): RadarUnitCard {
  return { mode: "unit", tractor: kind === "trailer" ? null : (data.tractors.find((u) => u.id === id) ?? null), trailer: kind === "trailer" ? (data.trailers.find((u) => u.id === id) ?? null) : null };
}

export { STATE_WORD };
