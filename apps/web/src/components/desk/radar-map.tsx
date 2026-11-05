"use client";

import "maplibre-gl/dist/maplibre-gl.css";
import Link from "next/link";
import { useRouter } from "next/navigation";
import React from "react";
import type { Map as MapLibreMap, GeoJSONSource, StyleSpecification } from "maplibre-gl";
import { INTERSTATES } from "@/lib/basemap/interstates";
import { US_STATES } from "@/lib/basemap/us-states";
import { radarParamsText, type RadarPoint, type RadarQueryParams, type SearchInfo } from "@/lib/radar-points";
import { boundsAround, radiusRing } from "@/lib/radius";
import type { RadarTractor, RadarTrailer } from "@/server/tl/radar";
import type { RadarPoints } from "@/server/tl/radar-query";
import { RadarList } from "./radar-list";
import { RadiusSearch } from "./radius-search";
import { SplitPane } from "./kit/split-pane";

/**
 * The radar: every tractor and trailer that has a position, on a map the desk draws itself. The basemap is bundled (lower-48 outlines and the twelve freight corridors, src/lib/basemap), so it
 * needs no tile server and no key and works offline. Colours are read from the desk's own tokens, so night and day both work and no hex lives here. Tractors are square glyphs with a heading
 * arrow: gold moving under a load, amber standing with the engine on, ink moving with no load, dim parked. Trailers are squares, hooked or dropped, a green dot when loaded.
 *
 * Thousands of units are clustered: zoomed out you see a few large squares with counts, each zoom step splits them, and past the cluster zoom every unit is its own glyph. Units stacked on one spot
 * (several trailers at a shipper's dock) cannot be split by zooming, so a click on the stack opens them as a list. A radius search draws its ring and keeps only what is inside it.
 */

type Sel = { kind: "tractor" | "trailer"; id: string } | null;
type Tokens = Record<"bg" | "land" | "line" | "road" | "label" | "labelHi" | "warn" | "neg" | "ink" | "mid" | "dim" | "pos", string>;

/** Colours from the live CSS tokens (named fallbacks only, for a page with no stylesheet). */
function readTokens(): Tokens {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  return {
    bg: v("--bg", "black"),
    land: v("--panel", "black"),
    line: v("--line", "gray"),
    road: v("--line-hi", "gray"),
    label: v("--label", "orange"),
    labelHi: v("--label-hi", "gold"),
    warn: v("--warn-fill", "orange"),
    neg: v("--neg-fill", "red"),
    ink: v("--ink", "white"),
    mid: v("--mid", "silver"),
    dim: v("--dim", "gray"),
    pos: v("--pos-fill", "green")
  };
}

const SIZE = 32;
type Draw = (g: CanvasRenderingContext2D) => void;
function image(draw: Draw): { width: number; height: number; data: Uint8ClampedArray } {
  const c = document.createElement("canvas");
  c.width = c.height = SIZE;
  const g = c.getContext("2d")!;
  draw(g);
  return { width: SIZE, height: SIZE, data: g.getImageData(0, 0, SIZE, SIZE).data };
}

/** A tractor: a solid square, with a heading arrow above it when it is under way (the symbol is rotated to the heading). */
const tractor = (color: string, edge: string, arrow: boolean): Draw => (g) => {
  g.fillStyle = color;
  g.strokeStyle = edge;
  g.lineWidth = 2;
  g.fillRect(9, 9, 14, 14);
  g.strokeRect(9, 9, 14, 14);
  if (arrow) {
    g.beginPath();
    g.moveTo(16, 0);
    g.lineTo(22, 8);
    g.lineTo(10, 8);
    g.closePath();
    g.fillStyle = color;
    g.fill();
  }
};

/** A trailer: a square outline (heavy when it is dropped), a green dot inside when it is loaded. */
const trailer = (stroke: string, dropped: boolean, loaded: boolean, dot: string): Draw => (g) => {
  g.strokeStyle = stroke;
  g.lineWidth = dropped ? 3 : 2;
  g.strokeRect(10, 10, 12, 12);
  if (loaded) {
    g.fillStyle = dot;
    g.fillRect(13, 13, 6, 6);
  }
};

const selectRing = (color: string): Draw => (g) => {
  g.strokeStyle = color;
  g.lineWidth = 2;
  g.strokeRect(3, 3, 26, 26);
};

/** A cluster: a square with a heavy edge in the worst tone inside it (ink, amber for idling, red for a dwell alert) and the count in the middle. Square, never round; drawn when the map first asks for it. */
function clusterImage(count: number, sev: number, t: Tokens, family: string): { width: number; height: number; data: Uint8ClampedArray } {
  const side = count < 10 ? 26 : count < 100 ? 34 : count < 1000 ? 42 : 50;
  const px = side * 2;
  const c = document.createElement("canvas");
  c.width = c.height = px;
  const g = c.getContext("2d")!;
  const tone = sev >= 2 ? t.neg : sev === 1 ? t.warn : t.ink;
  g.fillStyle = t.bg;
  g.fillRect(0, 0, px, px);
  g.strokeStyle = tone;
  g.lineWidth = 4;
  g.strokeRect(2, 2, px - 4, px - 4);
  g.strokeStyle = t.line;
  g.lineWidth = 2;
  g.strokeRect(8, 8, px - 16, px - 16);
  g.fillStyle = t.ink;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.font = `600 ${count < 100 ? 22 : count < 1000 ? 20 : 17}px ${family}`;
  g.fillText(count >= 10_000 ? `${Math.round(count / 1000)}k` : count.toLocaleString("en-US"), px / 2, px / 2 + 1);
  return { width: px, height: px, data: g.getImageData(0, 0, px, px).data };
}

function addImages(map: MapLibreMap, t: Tokens) {
  const put = (name: string, draw: Draw) => {
    if (map.hasImage(name)) map.removeImage(name);
    map.addImage(name, image(draw), { pixelRatio: 2 });
  };
  put("t-load", tractor(t.label, t.bg, true));
  put("t-moving", tractor(t.ink, t.bg, true));
  put("t-idle", tractor(t.warn, t.bg, false));
  put("t-parked", tractor(t.dim, t.bg, false));
  put("t-none", tractor(t.line, t.bg, false));
  put("tr-h-e", trailer(t.dim, false, false, t.pos));
  put("tr-h-l", trailer(t.dim, false, true, t.pos));
  put("tr-d-e", trailer(t.ink, true, false, t.pos));
  put("tr-d-l", trailer(t.ink, true, true, t.pos));
  put("tr-a-e", trailer(t.warn, true, false, t.pos));
  put("tr-a-l", trailer(t.warn, true, true, t.pos));
  put("sel", selectRing(t.labelHi));
}

type Feat = { type: "Feature"; geometry: { type: "Point"; coordinates: [number, number] }; properties: Record<string, string | number> };
const collection = (features: Feat[]) => ({ type: "FeatureCollection" as const, features });
const pointFeature = (u: RadarPoint): Feat => ({ type: "Feature", geometry: { type: "Point", coordinates: [u.lng, u.lat] }, properties: { id: u.id, k: u.k, icon: u.icon, heading: u.h, sev: u.sev, t: u.t, r: u.r, name: u.name } });

export const CLUSTER_MAX_ZOOM = 10;
const CLUSTER_RADIUS = 64;
const MAP_MAX_ZOOM = 13;

function styleOf(t: Tokens): StyleSpecification {
  return {
    version: 8,
    sources: {
      states: { type: "geojson", data: { type: "FeatureCollection", features: US_STATES.map((s) => ({ type: "Feature", properties: { name: s.name }, geometry: { type: "MultiPolygon", coordinates: s.rings.map((r) => [r.map((p) => [p[0], p[1]])]) } })) } as never },
      roads: { type: "geojson", data: { type: "FeatureCollection", features: INTERSTATES.map((c) => ({ type: "Feature", properties: { name: c.name }, geometry: { type: "LineString", coordinates: c.coords.map((p) => [p[0], p[1]]) } })) } as never },
      units: {
        type: "geojson",
        data: collection([]) as never,
        cluster: true,
        clusterRadius: CLUSTER_RADIUS,
        clusterMaxZoom: CLUSTER_MAX_ZOOM,
        clusterProperties: { nt: ["+", ["get", "t"]], nr: ["+", ["get", "r"]], sev: ["max", ["get", "sev"]] }
      },
      selected: { type: "geojson", data: collection([]) as never },
      radius: { type: "geojson", data: { type: "FeatureCollection", features: [] } as never }
    },
    layers: [
      { id: "bg", type: "background", paint: { "background-color": t.bg } },
      { id: "land", type: "fill", source: "states", paint: { "fill-color": t.land } },
      { id: "borders", type: "line", source: "states", paint: { "line-color": t.line, "line-width": 1 } },
      { id: "roads", type: "line", source: "roads", paint: { "line-color": t.road, "line-width": 1, "line-opacity": 0.6 } },
      { id: "radius", type: "line", source: "radius", paint: { "line-color": t.label, "line-width": 1, "line-dasharray": [4, 3] } },
      { id: "units", type: "symbol", source: "units", filter: ["!", ["has", "point_count"]], layout: { "icon-image": ["get", "icon"], "icon-rotate": ["get", "heading"], "icon-rotation-alignment": "map", "icon-allow-overlap": true, "icon-ignore-placement": true } },
      { id: "clusters", type: "symbol", source: "units", filter: ["has", "point_count"], layout: { "icon-image": ["concat", "cl-", ["to-string", ["get", "point_count"]], "-", ["to-string", ["get", "sev"]]], "icon-allow-overlap": true, "icon-ignore-placement": true } },
      { id: "selected", type: "symbol", source: "selected", layout: { "icon-image": "sel", "icon-allow-overlap": true, "icon-ignore-placement": true } }
    ]
  };
}

const US_BOUNDS: [[number, number], [number, number]] = [
  [-125, 24],
  [-66.5, 49.8]
];

export type Ring = { lat: number; lng: number; radius: number } | null;
export type Focus = { lat: number; lng: number; zoom: number; n: number } | null;

/** The map itself. Draws the points it is given (clustered), the search ring, and the selection; tells the parent what was clicked, or which units are stacked on one spot. */
export function Canvas({
  points,
  sel,
  onSelect,
  onStack,
  ring,
  fitKey,
  focus,
  clustered = true,
  compact
}: {
  points: RadarPoint[];
  sel: Sel;
  onSelect: (s: Sel) => void;
  onStack?: (ids: string[]) => void;
  ring?: Ring;
  /** Changes when the map should fit what it shows again (a new search, a cleared one). */
  fitKey?: string;
  focus?: Focus;
  clustered?: boolean;
  compact: boolean;
}) {
  const box = React.useRef<HTMLDivElement>(null);
  const mapRef = React.useRef<MapLibreMap | null>(null);
  const ready = React.useRef(false);
  const fitted = React.useRef("");
  const latest = React.useRef({ points, sel, ring: ring ?? null, fitKey: fitKey ?? "", clustered });
  latest.current = { points, sel, ring: ring ?? null, fitKey: fitKey ?? "", clustered };
  const pick = React.useRef(onSelect);
  pick.current = onSelect;
  const stack = React.useRef(onStack);
  stack.current = onStack;

  const push = React.useCallback(() => {
    const map = mapRef.current;
    if (!map || !ready.current) return;
    const { points: pts, sel: chosen, ring: rg, fitKey: key } = latest.current;
    (map.getSource("units") as GeoJSONSource).setData(collection(pts.map(pointFeature)) as never);
    const found = chosen ? pts.find((u) => u.id === chosen.id && (chosen.kind === "tractor" ? u.k === "t" : u.k === "r")) : null;
    (map.getSource("selected") as GeoJSONSource).setData(collection(found ? [{ type: "Feature", geometry: { type: "Point", coordinates: [found.lng, found.lat] }, properties: {} }] : []) as never);
    (map.getSource("radius") as GeoJSONSource).setData({ type: "FeatureCollection", features: rg ? [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: radiusRing(rg, rg.radius) } }] : [] } as never);
    // Fit once for each fit key (the first load, and every new or cleared search), not on every refresh.
    if (fitted.current !== key && (pts.length > 0 || rg)) {
      fitted.current = key;
      if (rg) {
        const b = boundsAround(rg, rg.radius * 1.08);
        map.fitBounds([[b.minLng, b.minLat], [b.maxLng, b.maxLat]], { padding: compact ? 16 : 40, maxZoom: 11, duration: 0 });
      } else {
        const lngs = pts.map((u) => u.lng);
        const lats = pts.map((u) => u.lat);
        const pad = 1.5;
        map.fitBounds([[Math.min(...lngs) - pad, Math.min(...lats) - pad], [Math.max(...lngs) + pad, Math.max(...lats) + pad]], { padding: compact ? 16 : 48, maxZoom: 6.5, duration: 0 });
      }
    }
  }, [compact]);

  React.useEffect(() => {
    let dead = false;
    let map: MapLibreMap | null = null;
    let watch: ResizeObserver | null = null;
    void import("maplibre-gl").then((ml) => {
      if (dead || !box.current) return;
      // The bundler does not emit MapLibre's worker, so the desk serves its own copy (public/maplibre-gl-worker.mjs, kept equal to the installed version by tests/radar-rules.test.ts).
      ml.setWorkerUrl("/maplibre-gl-worker.mjs");
      const tokens = readTokens();
      const family = getComputedStyle(document.body).fontFamily || "monospace";
      map = new ml.Map({ container: box.current, style: styleOf(tokens), bounds: US_BOUNDS, fitBoundsOptions: { padding: compact ? 8 : 24 }, interactive: !compact, attributionControl: false, dragRotate: false, pitchWithRotate: false, renderWorldCopies: false, maxZoom: MAP_MAX_ZOOM, minZoom: 2 });
      mapRef.current = map;
      // The container is laid out after the map is made (the rail, a split that is dragged): follow its size, or the map paints only part of it.
      watch = new ResizeObserver(() => map?.resize());
      watch.observe(box.current);
      if (!compact) map.addControl(new ml.NavigationControl({ showCompass: false }), "top-left");
      // A cluster's square is drawn the first time the map asks for one of that size and tone.
      map.setMissingStyleImageResolver((id) => {
        const m = /^cl-(\d+)-(\d)$/.exec(id);
        if (m && map && !map.hasImage(id)) map.addImage(id, clusterImage(Number(m[1]), Number(m[2]), tokens, family), { pixelRatio: 2 });
      });
      map.on("load", () => {
        addImages(map!, tokens);
        ready.current = true;
        push();
      });
      if (!compact) {
        map.on("click", "clusters", async (e) => {
          const f = e.features?.[0];
          const id = f?.properties?.cluster_id as number | undefined;
          if (!f || id == null || !map) return;
          const src = map.getSource("units") as GeoJSONSource;
          const zoom = await src.getClusterExpansionZoom(id);
          if (zoom > CLUSTER_MAX_ZOOM) {
            // These never come apart by zooming (they are on one spot): hand them over as a list.
            const leaves = await src.getClusterLeaves(id, 200, 0);
            stack.current?.([...new Set(leaves.map((l) => String(l.properties?.id)))]);
          } else {
            map.easeTo({ center: (f.geometry as unknown as { coordinates: [number, number] }).coordinates, zoom: zoom + 0.25, duration: 400 });
          }
        });
        map.on("click", "units", (e) => {
          if (!map) return;
          // Everything under the pointer: more than one means they are stacked on one spot.
          const near = map.queryRenderedFeatures([[e.point.x - 7, e.point.y - 7], [e.point.x + 7, e.point.y + 7]], { layers: ["units"] });
          const ids = [...new Set(near.map((f) => String(f.properties?.id)))];
          if (ids.length > 1 && stack.current) return stack.current(ids);
          const p = e.features?.[0]?.properties as { id?: string; k?: string } | undefined;
          if (p?.id) pick.current({ kind: p.k === "r" ? "trailer" : "tractor", id: p.id });
        });
        for (const layer of ["units", "clusters"]) {
          map.on("mouseenter", layer, () => (map!.getCanvas().style.cursor = "pointer"));
          map.on("mouseleave", layer, () => (map!.getCanvas().style.cursor = ""));
        }
        map.on("click", (e) => {
          if (map!.queryRenderedFeatures(e.point, { layers: ["units", "clusters"] }).length === 0) pick.current(null);
        });
      }
    });
    return () => {
      dead = true;
      watch?.disconnect();
      ready.current = false;
      fitted.current = "";
      map?.remove();
      mapRef.current = null;
    };
  }, [compact, push]);

  React.useEffect(push, [push, points, sel, ring, fitKey]);
  React.useEffect(() => {
    const map = mapRef.current;
    if (map && ready.current) (map.getSource("units") as GeoJSONSource).setClusterOptions({ cluster: clustered });
  }, [clustered]);
  React.useEffect(() => {
    if (focus && mapRef.current) mapRef.current.easeTo({ center: [focus.lng, focus.lat], zoom: focus.zoom, duration: 500 });
  }, [focus]);
  return <div ref={box} className="rd-canvas" role="img" aria-label={`Map of ${points.length} units`} />;
}

const ago = (iso: string | null, now: number) => {
  if (!iso) return "no fix yet";
  const m = Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000));
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m ago`;
};

const STATE_WORD: Record<string, { tone: string; word: string }> = {
  moving_load: { tone: "label", word: "Moving under load" },
  moving: { tone: "ink", word: "Moving, no load" },
  idling: { tone: "warn", word: "Idling" },
  parked: { tone: "dim", word: "Parked" }
};

function TractorCard({ u, now }: { u: RadarTractor; now: number }) {
  const st = u.state ? STATE_WORD[u.state] : null;
  return (
    <div className="rd-card">
      <div className="rd-card-head">
        <b>{u.name}</b>
        <span className="rd-st">
          <i className="rd-dot" data-tone={st?.tone ?? "dim"} aria-hidden="true" /> {st?.word ?? "No signal"}
        </span>
      </div>
      <dl className="rd-kv">
        <dt>Road</dt>
        <dd>{u.road || "—"}</dd>
        <dt>Driver</dt>
        <dd>{u.driver ?? "—"}</dd>
        <dt>Load</dt>
        <dd>{u.loadId ? <Link href={`/loads/${u.loadId}`}>{u.loadNumber ?? "Open load"}</Link> : "—"}</dd>
        <dt>Trailer</dt>
        <dd>{u.trailer ? `${u.trailer.number}${u.trailer.code ? ` [${u.trailer.code}]` : ""}` : "—"}</dd>
        <dt>Last fix</dt>
        <dd>{ago(u.locatedAt, now)}</dd>
      </dl>
      {u.idle ? <p className="rd-leak">{`■ ${u.idle.sentence}`}</p> : null}
      {u.idle?.todayHours != null ? <p className="rd-sub">{u.idle.todayHours.toFixed(1)} h idling today</p> : null}
      <p>
        <Link href={`/fleet/${u.id}`}>Open the truck</Link>
      </p>
    </div>
  );
}

function TrailerCard({ u, now }: { u: RadarTrailer; now: number }) {
  return (
    <div className="rd-card">
      <div className="rd-card-head">
        <b>{`${u.number}${u.code ? ` [${u.code}]` : ""}`}</b>
        <span className="rd-st">
          <i className="rd-dot" data-tone={u.dwell?.alert ? "warn" : u.hooked ? "dim" : "ink"} aria-hidden="true" /> {u.hooked ? `Hooked to ${u.hookedTo ?? "a tractor"}` : "Dropped"}
        </span>
      </div>
      <dl className="rd-kv">
        <dt>Cargo</dt>
        <dd>{u.loaded ? "Loaded" : "Empty"}</dd>
        <dt>Last fix</dt>
        <dd>{ago(u.locatedAt, now)}</dd>
      </dl>
      {u.dwell ? <p className={`rd-leak${u.dwell.typed ? " rd-typed" : ""}`}>{`■ ${u.dwell.sentence}`}</p> : null}
      <p>
        <Link href={`/trailers/${u.id}`}>{u.dwell ? "Open the trailer to adjust the dwell" : "Open the trailer"}</Link>
      </p>
    </div>
  );
}

function useTheme() {
  const [theme, setTheme] = React.useState("night");
  React.useEffect(() => {
    const read = () => setTheme(document.documentElement.dataset.theme ?? "night");
    read();
    const o = new MutationObserver(read);
    o.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => o.disconnect();
  }, []);
  return theme;
}

/** The points the map shows, from the desk's own data route, narrowed by the search and filters, refreshed every 30 seconds while the tab is visible. */
export function usePoints(initial: RadarPoints, params: Partial<RadarQueryParams>, every = 30_000) {
  const [data, setData] = React.useState(initial);
  const [now, setNow] = React.useState(() => Date.parse(initial.asOf ?? "") || 0);
  const query = radarParamsText({ near: params.near, r: params.r, kind: params.kind, state: params.state, q: params.q, hooked: params.hooked });
  const first = React.useRef(true);
  const key = React.useRef(query);
  React.useEffect(() => setData(initial), [initial]);
  React.useEffect(() => {
    let dead = false;
    const go = async (fresh: boolean) => {
      if (document.hidden && !fresh) return;
      try {
        const r = await fetch(`/fleet/map/data?mode=points${query ? `&${query}` : ""}`, { cache: "no-store" });
        if (r.ok && !dead) setData((await r.json()) as RadarPoints);
      } catch {
        /* the next tick tries again */
      }
    };
    // A changed search or filter is fetched at once; the first render already has the server's answer.
    if (first.current) first.current = false;
    else if (key.current !== query) void go(true);
    key.current = query;
    setNow(Date.now());
    const tick = setInterval(() => {
      setNow(Date.now());
      void go(false);
    }, every);
    return () => {
      dead = true;
      clearInterval(tick);
    };
  }, [query, every]);
  return { data, now };
}

/** One unit's full card, fetched when it is clicked. */
function useUnit(sel: Sel) {
  const [card, setCard] = React.useState<{ tractor: RadarTractor | null; trailer: RadarTrailer | null } | null>(null);
  React.useEffect(() => {
    setCard(null);
    if (!sel) return;
    let dead = false;
    void fetch(`/fleet/map/data?mode=unit&kind=${sel.kind}&id=${encodeURIComponent(sel.id)}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!dead && j) setCard(j as { tractor: RadarTractor | null; trailer: RadarTrailer | null });
      })
      .catch(() => undefined);
    return () => {
      dead = true;
    };
  }, [sel]);
  return card;
}

type Tab = "telemetry" | "search" | "list";
const TAB_LABEL: Record<Tab, string> = { telemetry: "Telemetry", search: "Search", list: "List" };

/** Where the search and filters live, kept in the address so a search can be shared and survives going back. */
function writeUrl(p: Partial<RadarQueryParams>) {
  try {
    const text = radarParamsText({ near: p.near, r: p.r, kind: p.kind, state: p.state, q: p.q });
    window.history.replaceState(null, "", text ? `/fleet/map?${text}` : "/fleet/map");
  } catch {
    /* the address stays as it was */
  }
}

/**
 * The full radar: the map on the left and, beside it on a draggable bar, a panel with Telemetry (the counts and the key), Search (a ZIP, city or state and a radius) and List (every unit in view,
 * nearest first, optionally grouped by place). `actions` is the server-rendered Read ELD button.
 */
export function RadarView({ initial, params, actions }: { initial: RadarPoints; params: RadarQueryParams; actions?: React.ReactNode }) {
  const theme = useTheme();
  const [p, setP] = React.useState<RadarQueryParams>(params);
  const { data, now } = usePoints(initial, p);
  const [sel, setSel] = React.useState<Sel>(null);
  const [tab, setTab] = React.useState<Tab>(params.ids.length > 0 ? "list" : params.near ? "search" : "telemetry");
  const [clustered, setClustered] = React.useState(true);
  const [stackIds, setStackIds] = React.useState<string[] | null>(params.ids.length > 0 ? params.ids : null);
  const [focus, setFocus] = React.useState<Focus>(null);
  const card = useUnit(sel);
  const c = data.counts;
  const search = data.search;
  const ring: Ring = search?.ok ? { lat: search.lat, lng: search.lng, radius: search.radius } : null;
  const fitKey = search?.ok ? `${search.label}|${search.radius}` : "all";
  const update = (next: Partial<RadarQueryParams>) => {
    const merged = { ...p, ...next };
    setP(merged);
    writeUrl(merged);
  };
  const pickRow = (id: string, kind: "tractor" | "trailer", lat: number, lng: number) => {
    setSel({ kind, id });
    setFocus({ lat, lng, zoom: 11, n: Date.now() });
  };
  const showStack = (ids: string[]) => {
    setStackIds(ids);
    setTab("list");
  };

  return (
    <div className="rd">
      <SplitPane
        id="radar"
        orientation="horizontal"
        defaultSize={760}
        min={320}
        minSecond={360}
        firstLabel="map"
        first={
          <div className="rd-map">
            <Canvas key={theme} points={data.points} sel={sel} onSelect={setSel} onStack={showStack} ring={ring} fitKey={fitKey} focus={focus} clustered={clustered} compact={false} />
            {!data.connected && data.points.length === 0 && !p.near ? (
              <p className="rd-empty">
                No ELD is connected, so there is nothing to place. <Link href="/settings?tab=integrations">Connect one in Settings</Link>.
              </p>
            ) : null}
          </div>
        }
        second={
          <aside className="rd-rail" aria-label="Fleet radar">
            <div className="rd-tabs" role="tablist" aria-label="Radar panel">
              {(Object.keys(TAB_LABEL) as Tab[]).map((k) => (
                <button key={k} type="button" role="tab" aria-selected={tab === k} className="rd-tab" onClick={() => setTab(k)}>
                  {TAB_LABEL[k]}
                </button>
              ))}
            </div>
            {sel ? (
              <div className="rd-pinned">
                <button type="button" className="tl-btn ghost sm rd-x" onClick={() => setSel(null)} aria-label="Close the unit">
                  Close
                </button>
                {card?.tractor ? <TractorCard u={card.tractor} now={now} /> : card?.trailer ? <TrailerCard u={card.trailer} now={now} /> : <p className="rd-sub">Loading the unit.</p>}
              </div>
            ) : null}
            {tab === "telemetry" ? (
              <>
                <dl className="rd-hud">
                  <dt>Total units</dt>
                  <dd>{c.tractors}</dd>
                  <dt>Moving under load</dt>
                  <dd>{c.movingLoad}</dd>
                  {c.moving > 0 ? (
                    <>
                      <dt>Moving, no load</dt>
                      <dd>{c.moving}</dd>
                    </>
                  ) : null}
                  <dt>Idling</dt>
                  <dd className={c.idling > 0 ? "rd-warn" : undefined}>{c.idling}</dd>
                  <dt>Parked</dt>
                  <dd>{c.parked}</dd>
                  {c.noSignal > 0 ? (
                    <>
                      <dt>No signal</dt>
                      <dd>{c.noSignal}</dd>
                    </>
                  ) : null}
                  <dt>Dropped trailers</dt>
                  <dd>{c.droppedTrailers}</dd>
                </dl>
                <p className="rd-sub">As of {ago(data.asOf, now)}</p>
                <div className="rd-actions">{actions}</div>
                <label className="rd-check">
                  <input type="checkbox" checked={clustered} onChange={(e) => setClustered(e.target.checked)} /> Group nearby units into clusters
                </label>
                <label className="rd-check">
                  <input type="checkbox" checked={p.hooked} onChange={(e) => update({ hooked: e.target.checked })} /> Show hooked trailers
                </label>
                <ul className="rd-key" aria-label="Key">
                  <li>
                    <i className="rd-dot" data-tone="label" aria-hidden="true" /> Moving under a load
                  </li>
                  <li>
                    <i className="rd-dot" data-tone="warn" aria-hidden="true" /> Engine on, standing
                  </li>
                  <li>
                    <i className="rd-dot" data-tone="ink" aria-hidden="true" /> Moving, no load
                  </li>
                  <li>
                    <i className="rd-dot" data-tone="dim" aria-hidden="true" /> Parked
                  </li>
                  <li>Square: a trailer. Heavy: dropped. Green: loaded.</li>
                  <li>A numbered square is a cluster: zoom in to split it, or click it. Units on one spot open as a list.</li>
                </ul>
                {!sel ? <p className="rd-sub">Click a unit on the map.</p> : null}
              </>
            ) : null}
            {tab === "search" ? (
              <RadiusSearch
                value={{ near: p.near, r: p.rGiven ? String(p.r) : "" }}
                info={search}
                onSearch={(near, r) => update({ near, r: r ?? 50, rGiven: r != null })}
                onClear={() => update({ near: "", r: 50, rGiven: false })}
                filters={{ kind: p.kind, state: p.state, q: p.q }}
                onFilters={(f) => update(f)}
              />
            ) : null}
            {tab === "list" ? (
              <RadarList
                params={p}
                ids={stackIds}
                onClearIds={() => setStackIds(null)}
                selected={sel?.id ?? null}
                onPick={pickRow}
                onParams={(next) => update(next)}
                info={search}
              />
            ) : null}
          </aside>
        }
      />
    </div>
  );
}

/** The map above the Trucks and Trailers tables: the clustered map and a radius search over a drag bar, the table beneath it (`children`, server-rendered) narrowed by the same search. */
export function FleetMapPanel({
  initial,
  params,
  fullHref,
  children
}: {
  initial: RadarPoints;
  params: { near: string; r: number; rGiven: boolean };
  /** The page's address with the same search, for "Open the radar map". */
  fullHref: string;
  children: React.ReactNode;
}) {
  const theme = useTheme();
  const { data } = usePoints(initial, { near: params.near, r: params.r });
  const [sel, setSel] = React.useState<Sel>(null);
  const [stackIds, setStackIds] = React.useState<string[] | null>(null);
  const search = data.search;
  const ring: Ring = search?.ok ? { lat: search.lat, lng: search.lng, radius: search.radius } : null;
  const picked = sel ? data.points.find((u) => u.id === sel.id) : null;
  const href = (kind: "tractor" | "trailer", id: string) => (kind === "tractor" ? `/fleet/${id}` : `/trailers/${id}`);
  const full = stackIds ? `/fleet/map?${radarParamsText({ ids: stackIds })}` : fullHref;
  return (
    <section className="fm" aria-label="Fleet radar">
      <SearchBar info={search} params={params} />
      <SplitPane
        id="fleet-map"
        orientation="vertical"
        defaultSize={300}
        min={140}
        minSecond={200}
        firstLabel="map"
        tools={
          <Link href={full} className="tl-btn ghost sm">
            {stackIds ? `List these ${stackIds.length} on the radar` : "Open the radar map"}
          </Link>
        }
        first={
          <div className="fm-map">
            <Canvas key={theme} points={data.points} sel={sel} onSelect={(s) => { setSel(s); setStackIds(null); }} onStack={(ids) => { setStackIds(ids); setSel(null); }} ring={ring} fitKey={search?.ok ? `${search.label}|${search.radius}` : "all"} compact={false} />
            {picked && sel ? (
              <p className="fm-pick">
                <b>{picked.name}</b> · <Link href={href(sel.kind, sel.id)}>{sel.kind === "tractor" ? "Open the truck" : "Open the trailer"}</Link>
              </p>
            ) : stackIds ? (
              <p className="fm-pick">
                <b>{stackIds.length} units on this spot</b> · <Link href={full}>List them on the radar</Link>
              </p>
            ) : null}
          </div>
        }
        second={<div className="fm-table">{children}</div>}
      />
    </section>
  );
}

/** The radius search over the Trucks and Trailers tables: it reloads the page with `?near=&r=`, so the table and the map are narrowed together. */
function SearchBar({ info, params }: { info: SearchInfo | null; params: { near: string; r: number; rGiven: boolean } }) {
  const router = useRouter();
  const go = (near: string, r: number | null) => {
    const u = new URL(window.location.href);
    u.searchParams.delete("page");
    if (near) u.searchParams.set("near", near);
    else u.searchParams.delete("near");
    if (near && r != null) u.searchParams.set("r", String(r));
    else u.searchParams.delete("r");
    router.push(`${u.pathname}${u.search}`);
  };
  return <RadiusSearch compact value={{ near: params.near, r: params.rGiven ? String(params.r) : "" }} info={info} onSearch={go} onClear={() => go("", null)} />;
}
