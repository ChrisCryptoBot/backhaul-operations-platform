import { DEFAULT_RADIUS, clampRadius } from "./radius";

/**
 * What the radar's map, list and search say to each other: the lean point for each unit (a fleet of thousands is sent as points, not as full cards), a row of the list, what a search found, and how
 * the screens' URL parameters (`?near=75201&r=50`) are read and written. Pure; shared by the server and the browser.
 */

/** One unit on the map. `k` says which card a click opens; `t` and `r` say what a cluster counts it as (a hooked trailer drawn at its tractor counts as a trailer and opens the tractor). */
export type RadarPoint = { id: string; k: "t" | "r"; lat: number; lng: number; icon: string; h: number; sev: 0 | 1 | 2; t: 0 | 1; r: 0 | 1; name: string };

export type SearchInfo =
  | { ok: true; text: string; label: string; lat: number; lng: number; radius: number; trucks: number; trailers: number; source: "census" | "mapbox" }
  | { ok: false; text: string; error: string };

export type StateKey = "moving_load" | "moving" | "idling" | "parked" | "no_signal" | "dropped" | "hooked" | "dwell";
export const STATE_WORD: Record<StateKey, string> = { moving_load: "Moving under load", moving: "Moving, no load", idling: "Idling", parked: "Parked", no_signal: "No signal", dropped: "Dropped", hooked: "Hooked", dwell: "Dwell alert" };
export const STATE_FILTERS: ReadonlyArray<{ key: StateKey; label: string }> = [
  { key: "moving_load", label: "Moving under load" },
  { key: "idling", label: "Idling" },
  { key: "parked", label: "Parked" },
  { key: "dropped", label: "Dropped trailers" },
  { key: "dwell", label: "Dwell alerts" }
];

export type ListRow = {
  id: string;
  kind: "tractor" | "trailer";
  name: string;
  /** A trailer's equipment code, "53V". */
  code: string | null;
  lengthFt: number | null;
  state: StateKey;
  /** The nearest city, "Dallas, TX". */
  near: string | null;
  /** Distance from the search centre, when there is one. */
  miles: number | null;
  who: string | null;
  loadId: string | null;
  loadNumber: string | null;
  /** The idle or dwell line, short. */
  leak: string | null;
  site: string;
  lat: number;
  lng: number;
  href: string;
};

export type ListGroup = { site: string; near: string | null; lat: number; lng: number; trucks: number; trailers: number; rows: ListRow[] };

export type RadarQueryParams = {
  near: string;
  r: number;
  /** Whether the request named a radius (else a state search takes the state's own). */
  rGiven: boolean;
  kind: "all" | "tractor" | "trailer";
  state: StateKey | "";
  q: string;
  hooked: boolean;
  ids: string[];
  bbox: [number, number, number, number] | null;
  sort: "distance" | "name" | "state";
  page: number;
  group: boolean;
};

const STATES = new Set<string>(["moving_load", "moving", "idling", "parked", "no_signal", "dropped", "hooked", "dwell"]);
const first = (v: string | string[] | undefined | null): string => (Array.isArray(v) ? (v[0] ?? "") : (v ?? ""));

/** The parameters of a radar request (a page's search params or a route's query string), each read safely and defaulted. */
export function readRadarParams(get: (k: string) => string | string[] | undefined | null): RadarQueryParams {
  const num = (s: string) => Number.parseFloat(s);
  const bb = first(get("bbox")).split(",").map(num);
  const kind = first(get("kind"));
  const state = first(get("state"));
  const sort = first(get("sort"));
  const page = Number.parseInt(first(get("page")), 10);
  return {
    near: first(get("near")).trim().slice(0, 80),
    r: clampRadius(first(get("r")) || DEFAULT_RADIUS),
    rGiven: first(get("r")) !== "",
    kind: kind === "tractor" || kind === "trailer" ? kind : "all",
    state: STATES.has(state) ? (state as StateKey) : "",
    q: first(get("q")).trim().slice(0, 60),
    hooked: first(get("hooked")) === "1",
    ids: first(get("ids")).split(",").map((s) => s.trim()).filter(Boolean).slice(0, 200),
    bbox: bb.length === 4 && bb.every(Number.isFinite) ? (bb as [number, number, number, number]) : null,
    sort: sort === "name" || sort === "state" ? sort : "distance",
    page: Number.isFinite(page) && page > 0 ? page : 1,
    group: first(get("group")) === "1"
  };
}

/** The same parameters as a query string, leaving out anything that is the default. */
export function radarParamsText(p: Partial<RadarQueryParams>): string {
  const u = new URLSearchParams();
  if (p.near) u.set("near", p.near);
  if (p.near && p.r && p.r !== DEFAULT_RADIUS) u.set("r", String(p.r));
  if (p.kind && p.kind !== "all") u.set("kind", p.kind);
  if (p.state) u.set("state", p.state);
  if (p.q) u.set("q", p.q);
  if (p.hooked) u.set("hooked", "1");
  if (p.ids && p.ids.length > 0) u.set("ids", p.ids.join(","));
  if (p.bbox) u.set("bbox", p.bbox.map((n) => n.toFixed(4)).join(","));
  if (p.sort && p.sort !== "distance") u.set("sort", p.sort);
  if (p.page && p.page > 1) u.set("page", String(p.page));
  if (p.group) u.set("group", "1");
  return u.toString();
}
