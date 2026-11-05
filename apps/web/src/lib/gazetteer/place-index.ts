import { PLACE_LINES } from "./places";
import { STATES, type StateEntry } from "./states";
import { ZIP_LINES } from "./zips";
import { haversineMiles } from "../geo";

/**
 * Typed places, offline: a ZIP code, a city and state, or a state, turned into a point on the map from the bundled Census data (src/lib/gazetteer), and the nearest city to a point. No network and no
 * key, so it is instant and works in the demo and in tests. SERVER ONLY: the data is two megabytes and must never reach a browser bundle (tests/gazetteer.test.ts). Text this cannot read returns
 * null, and the caller may then ask the metered geocoder (server/geo/place-lookup.ts).
 */
export type Place = { st: string; name: string; lat: number; lng: number; area: number; incorporated: boolean };
export type Found = { kind: "zip" | "city" | "state"; label: string; lat: number; lng: number; /** A radius that suits the kind of place, when the person has not chosen one. */ defaultRadius: number | null };

let zips: Map<string, [number, number]> | null = null;
let places: Place[] | null = null;
let byKey: Map<string, Place> | null = null;
let byName: Map<string, Place[]> | null = null;
let byState: Map<string, Place[]> | null = null;
let grid: Map<string, Place[]> | null = null;
const CELL = 0.5; // degrees

const norm = (s: string) => s.toLowerCase().replace(/\./g, "").replace(/\s+/g, " ").trim();
const cellOf = (lat: number, lng: number) => `${Math.floor(lat / CELL)}:${Math.floor(lng / CELL)}`;

function load() {
  if (places) return;
  zips = new Map();
  for (const line of ZIP_LINES.split("\n")) {
    const [z, la, ln] = line.split(",");
    if (z) zips.set(z, [Number(la), Number(ln)]);
  }
  places = [];
  byKey = new Map();
  byName = new Map();
  byState = new Map();
  grid = new Map();
  for (const line of PLACE_LINES.split("\n")) {
    const [st, name, la, ln, area, f] = line.split("|");
    if (!st || !name) continue;
    const p: Place = { st, name, lat: Number(la), lng: Number(ln), area: Number(area), incorporated: f === "A" };
    places.push(p);
    const key = `${norm(name)}|${st}`;
    const cur = byKey.get(key);
    // Two places with one name in one state: the incorporated one, then the larger.
    if (!cur || (p.incorporated && !cur.incorporated) || (p.incorporated === cur.incorporated && p.area > cur.area)) byKey.set(key, p);
    const list = byName.get(norm(name)) ?? [];
    list.push(p);
    byName.set(norm(name), list);
    byState.set(st, [...(byState.get(st) ?? []), p]);
    const cell = cellOf(p.lat, p.lng);
    const g = grid.get(cell) ?? [];
    g.push(p);
    grid.set(cell, g);
  }
}

const stateOf = (text: string): StateEntry | null => {
  const t = norm(text);
  return STATES.find((s) => s.abbr.toLowerCase() === t || norm(s.name) === t) ?? null;
};

/** Coordinates of a ZIP, or null. Accepts ZIP+4. */
export function zipPoint(zip: string): { lat: number; lng: number } | null {
  load();
  const hit = zips!.get(zip.slice(0, 5));
  return hit ? { lat: hit[0], lng: hit[1] } : null;
}

/** The nearest place to a point within about `maxMiles` (default 60): the incorporated ones first when one is almost as close, since "Dallas" reads better than a census area inside it. */
export function nearestPlace(lat: number, lng: number, maxMiles = 60): { label: string; miles: number } | null {
  load();
  const ci = Math.floor(lat / CELL);
  const cj = Math.floor(lng / CELL);
  const reach = Math.max(1, Math.ceil(maxMiles / 34));
  let best: { p: Place; d: number } | null = null;
  for (let i = ci - reach; i <= ci + reach; i++) {
    for (let j = cj - reach; j <= cj + reach; j++) {
      for (const p of grid!.get(`${i}:${j}`) ?? []) {
        const d = haversineMiles({ lat, lng }, p);
        // A census-designated place only beats an incorporated one when it is clearly nearer.
        const score = p.incorporated ? d : d + 4;
        if (d <= maxMiles && (!best || score < (best.p.incorporated ? best.d : best.d + 4))) best = { p, d };
      }
    }
  }
  return best ? { label: `${best.p.name}, ${best.p.st}`, miles: best.d } : null;
}

/**
 * The Census names some cities in a longer way ("Urban Honolulu", "Nashville-Davidson", "Louisville/Jefferson County"). When a typed city is not a name as it stands, take the place in that state whose name
 * begins with it (before a space, a hyphen or a slash) or ends with it ("Urban Honolulu"), the incorporated and the larger one first.
 */
function looseMatch(city: string, st: string): Place | null {
  if (city.length < 3) return null;
  const hits = (byState!.get(st) ?? []).filter((p) => {
    const n = norm(p.name);
    return n.startsWith(`${city} `) || n.startsWith(`${city}-`) || n.startsWith(`${city}/`) || n.endsWith(` ${city}`);
  });
  if (hits.length === 0) return null;
  return [...hits].sort((a, b) => Number(b.incorporated) - Number(a.incorporated) || b.area - a.area)[0]!;
}

/** The place a typed phrase names, offline, or null. `75201`, `75201-1234`, `Dallas, TX`, `dallas tx`, `Dallas, Texas`, `Atlanta`, `TX`, `Texas`. */
export function findPlace(raw: string): Found | null {
  const text = raw.replace(/\s+/g, " ").trim();
  if (!text) return null;
  load();

  if (/^\d{5}(-\d{4})?$/.test(text)) {
    const z = zipPoint(text);
    if (!z) return null;
    const near = nearestPlace(z.lat, z.lng, 25);
    return { kind: "zip", label: `${text.slice(0, 5)}${near ? ` · ${near.label}` : ""}`, lat: z.lat, lng: z.lng, defaultRadius: null };
  }

  const st = stateOf(text);
  if (st) return { kind: "state", label: `${st.name} (${st.abbr})`, lat: st.lat, lng: st.lng, defaultRadius: st.radius };

  // "City, ST", "City ST", "City, State name": the state is whatever ends the phrase (one or two words).
  const comma = text.lastIndexOf(",");
  let cityText = text;
  let state: StateEntry | null = null;
  if (comma > 0) {
    state = stateOf(text.slice(comma + 1));
    cityText = text.slice(0, comma);
  } else {
    const words = text.split(" ");
    for (const take of [2, 1]) {
      if (words.length > take) {
        const s = stateOf(words.slice(-take).join(" "));
        if (s) {
          state = s;
          cityText = words.slice(0, -take).join(" ");
          break;
        }
      }
    }
  }
  const city = norm(cityText);
  if (state) {
    const p = byKey!.get(`${city}|${state.abbr}`) ?? looseMatch(city, state.abbr);
    return p ? { kind: "city", label: `${p.name}, ${p.st}`, lat: p.lat, lng: p.lng, defaultRadius: null } : null;
  }
  // A city with no state: only when the name is one place, or one place is far the biggest (so "Atlanta" is Georgia and "Springfield" is left to the person to qualify).
  const all = (byName!.get(city) ?? []).filter((p) => p.incorporated || (byName!.get(city) ?? []).length === 1);
  if (all.length === 0) return null;
  const sorted = [...all].sort((a, b) => b.area - a.area);
  const top = sorted[0]!;
  if (sorted.length > 1 && !(top.area >= (sorted[1]!.area || 1) * 3)) return null;
  return { kind: "city", label: `${top.name}, ${top.st}`, lat: top.lat, lng: top.lng, defaultRadius: null };
}

export const gazetteerSize = (): { zips: number; places: number } => {
  load();
  return { zips: zips!.size, places: places!.length };
};
