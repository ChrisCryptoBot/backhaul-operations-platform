"use client";

import "./maplibre-vendor.css";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import React from "react";
import type { Map as MapLibreMap, GeoJSONSource, StyleSpecification } from "maplibre-gl";
import { basemapPaint, radarBasemapLayers } from "@/lib/basemap/paint";
import { US_STATES } from "@/lib/basemap/us-states";
import { EXCEPTION_FILTERS, radarParamsText, readLiveSeconds, type ExceptionKey, type RadarPoint, type RadarQueryParams, type SearchInfo } from "@/lib/radar-points";
import { NO_ROAD_NOTE, OFF_ROAD_NOTE, ROAD_ROUTE_NOTE, agoText } from "@/lib/telematics";
import { fixAge } from "@/lib/whereabouts";
import { boundsAround, radiusRing } from "@/lib/radius";
import { REGIONS, REGION_KEYS, boxAround, firstRegion, mapLng, regionCounts, regionOf, within as withinRegion, type Box, type RegionKey } from "@/lib/radar-regions";
import type { RadarTractor, RadarTrailer } from "@/server/tl/radar";
import type { RadarPoints } from "@/server/tl/radar-query";
import type { OpenLoadPin, RadarOpenLoads } from "@/server/tl/radar-open-loads";
import type { RadarRoute } from "@/server/tl/radar-route";
import type { LoadTracking } from "@/server/tl/load-tracking";
import type { RadarWeather } from "@/server/tl/radar-weather";
import { RadarList } from "./radar-list";
import { RadiusSearch } from "./radius-search";
import { SplitPane } from "./kit/split-pane";
import { StaleFix } from "./kit/stale-fix";
import { TipPopup, type TipData } from "./kit/tooltip";

/**
 * The radar: every tractor and trailer that has a position, over OpenFreeMap vector streets and highways (`dark` / `positron` by theme) with the bundled states and corridors (`src/lib/basemap`)
 * kept as an automatic offline fallback. Overlay colours are read from the desk's own tokens, so night and day both work and no hex lives here. Tractors are square glyphs with a heading
 * arrow: gold moving under a load, amber standing with the engine on, ink moving with no load, dim parked. Trailers are squares, hooked or dropped, a green dot when loaded.
 *
 * Thousands of units are clustered: zoomed out you see a few large squares with counts (hover for breakdown, click to expand), each zoom step splits them, and past the cluster zoom every unit is
 * its own glyph with live driver, HOS left, hooked trailer, load, ETA, and schedule health on hover. Units stacked on one spot (several trailers at a shipper's dock) open as a list.
 */

type Sel = { kind: "tractor" | "trailer"; id: string } | null;
type Tokens = Record<"bg" | "land" | "line" | "road" | "label" | "labelHi" | "warn" | "neg" | "ink" | "mid" | "dim" | "pos" | "typed" | "head" | "faint" | "water" | "mapLand" | "roadLo" | "roadMid" | "roadHi" | "casing" | "border", string>;

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
    pos: v("--pos-fill", "green"),
    typed: v("--typed", "steelblue"),
    head: v("--head", "black"),
    faint: v("--faint", "gray"),
    // The basemap's own tones (terminal.css, one set per theme): roads stepped motorway > major > minor and kept under the unit marks, water apart from land.
    water: v("--map-water", "darkslategray"),
    mapLand: v("--map-land", "black"),
    roadLo: v("--map-road-lo", "dimgray"),
    roadMid: v("--map-road", "gray"),
    roadHi: v("--map-road-hi", "gray"),
    casing: v("--map-casing", "black"),
    border: v("--map-border", "gray")
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

/** A stop on the selected unit's lane: a filled square in the ground colour with a heavy edge (gold for a pickup, ink for a delivery). */
const stopMark = (edge: string, ground: string): Draw => (g) => {
  g.fillStyle = ground;
  g.fillRect(8, 8, 16, 16);
  g.strokeStyle = edge;
  g.lineWidth = 3;
  g.strokeRect(8, 8, 16, 16);
  g.fillStyle = edge;
  g.fillRect(14, 14, 4, 4);
};

/** Freight that needs a driver: a hollow square with a cross, in the bright gold, so it never reads as a unit. */
const openLoadMark = (color: string, ground: string): Draw => (g) => {
  g.fillStyle = ground;
  g.fillRect(7, 7, 18, 18);
  g.strokeStyle = color;
  g.lineWidth = 2;
  g.strokeRect(7, 7, 18, 18);
  g.fillStyle = color;
  g.fillRect(15, 10, 2, 12);
  g.fillRect(10, 15, 12, 2);
};

/** A fuel stop or rest area: a small square, quiet (dim), filled for fuel and hollow for a rest area. */
const poiMark = (color: string, filled: boolean): Draw => (g) => {
  g.strokeStyle = color;
  g.lineWidth = 2;
  g.strokeRect(12, 12, 8, 8);
  if (filled) {
    g.fillStyle = color;
    g.fillRect(14, 14, 4, 4);
  }
};

/** One GPS breadcrumb fix: a small square tick so sparse fixes stay visible even when a gap breaks the trail line. */
const trailMark = (color: string, ground: string): Draw => (g) => {
  g.fillStyle = color;
  g.strokeStyle = ground;
  g.lineWidth = 2;
  g.fillRect(13, 13, 6, 6);
  g.strokeRect(13, 13, 6, 6);
};

const selectRing = (color: string): Draw => (g) => {
  g.strokeStyle = color;
  g.lineWidth = 2;
  g.strokeRect(3, 3, 26, 26);
};

/** A cluster: a square with a heavy edge in the worst tone inside it (ink, amber for idling, red for a dwell alert) and the count in the middle. Square, never round; drawn when the map first asks for it. */
function clusterImage(count: number, sev: number, t: Tokens, family: string): { width: number; height: number; data: Uint8ClampedArray } {
  const side = count < 10 ? 32 : count < 100 ? 38 : count < 1000 ? 44 : 50;
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
  put("stop-p", stopMark(t.label, t.bg));
  put("stop-d", stopMark(t.ink, t.bg));
  put("l-open", openLoadMark(t.labelHi, t.bg));
  put("poi-fuel", poiMark(t.dim, true));
  put("poi-rest", poiMark(t.dim, false));
  put("trail-pt", trailMark(t.ink, t.bg));
}

type Feat = { type: "Feature"; geometry: { type: "Point"; coordinates: [number, number] }; properties: Record<string, string | number> };
const collection = (features: Feat[]) => ({ type: "FeatureCollection" as const, features });
const pointFeature = (u: RadarPoint): Feat => ({ type: "Feature", geometry: { type: "Point", coordinates: [mapLng(u.lat, u.lng), u.lat] }, properties: { id: u.id, k: u.k, icon: u.icon, heading: u.h, sev: u.sev, t: u.t, r: u.r, name: u.name } });

export const CLUSTER_MAX_ZOOM = 10;
const CLUSTER_RADIUS = 64;
const MAP_MAX_ZOOM = 16;

const OFM_STYLE = {
  night: "https://tiles.openfreemap.org/styles/dark",
  day: "https://tiles.openfreemap.org/styles/positron"
} as const;
const BASE_STYLE_CACHE = new Map<string, StyleSpecification>();

function overlaySources(): StyleSpecification["sources"] {
  return {
    units: {
      type: "geojson",
      data: collection([]) as never,
      cluster: true,
      clusterRadius: CLUSTER_RADIUS,
      clusterMaxZoom: CLUSTER_MAX_ZOOM,
      clusterProperties: { nt: ["+", ["get", "t"]], nr: ["+", ["get", "r"]], sev: ["max", ["get", "sev"]] }
    },
    selected: { type: "geojson", data: collection([]) as never },
    radius: { type: "geojson", data: { type: "FeatureCollection", features: [] } as never },
    // The clicked unit's load (its road, the breadcrumb, its stops), freight that needs a driver, and severe weather: empty until asked for.
    route: { type: "geojson", data: { type: "FeatureCollection", features: [] } as never },
    "open-loads": { type: "geojson", data: collection([]) as never },
    weather: { type: "geojson", data: { type: "FeatureCollection", features: [] } as never }
  };
}

function overlayLayers(t: Tokens): StyleSpecification["layers"] {
  const severity = ["match", ["get", "severity"], "Extreme", t.neg, t.warn] as never;
  return [
    // Weather sits lowest of the overlays: a faint tint and a plain outline, so units and freight stay on top of it.
    { id: "wx-fill", type: "fill", source: "weather", layout: { visibility: "none" }, paint: { "fill-color": severity, "fill-opacity": 0.12 } },
    { id: "wx-line", type: "line", source: "weather", layout: { visibility: "none" }, paint: { "line-color": severity, "line-width": 1.5, "line-opacity": 0.9 } },
    { id: "radius", type: "line", source: "radius", paint: { "line-color": t.label, "line-width": 1, "line-dasharray": [4, 3] } },
    { id: "route-road", type: "line", source: "route", filter: ["==", ["get", "part"], "road"], layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": t.label, "line-width": 3, "line-opacity": 0.9 } },
    { id: "route-trail", type: "line", source: "route", filter: ["==", ["get", "part"], "trail"], layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": t.ink, "line-width": 2 } },
    { id: "route-trail-pts", type: "symbol", source: "route", filter: ["==", ["get", "part"], "trail-pt"], layout: { "icon-image": "trail-pt", "icon-allow-overlap": true, "icon-ignore-placement": true } },
    { id: "route-stops", type: "symbol", source: "route", filter: ["==", ["get", "part"], "stop"], layout: { "icon-image": ["get", "icon"], "icon-allow-overlap": true, "icon-ignore-placement": true } },
    { id: "open-loads", type: "symbol", source: "open-loads", layout: { visibility: "none", "icon-image": "l-open", "icon-allow-overlap": true, "icon-ignore-placement": true } },
    { id: "units", type: "symbol", source: "units", filter: ["!", ["has", "point_count"]], layout: { "icon-image": ["get", "icon"], "icon-rotate": ["get", "heading"], "icon-rotation-alignment": "map", "icon-allow-overlap": true, "icon-ignore-placement": true } },
    { id: "clusters", type: "symbol", source: "units", filter: ["has", "point_count"], layout: { "icon-image": ["concat", "cl-", ["to-string", ["get", "point_count"]], "-", ["to-string", ["get", "sev"]]], "icon-allow-overlap": true, "icon-ignore-placement": true } },
    { id: "selected", type: "symbol", source: "selected", layout: { "icon-image": "sel", "icon-allow-overlap": true, "icon-ignore-placement": true } }
  ];
}

function offlineStyleOf(t: Tokens): StyleSpecification {
  return {
    version: 8,
    sources: {
      states: { type: "geojson", data: { type: "FeatureCollection", features: US_STATES.map((s) => ({ type: "Feature", properties: { name: s.name }, geometry: { type: "MultiPolygon", coordinates: s.rings.map((r) => [r.map((p) => [p[0], p[1]])]) } })) } as never },
      ...overlaySources()
    },
    layers: [
      { id: "bg", type: "background", paint: { "background-color": t.bg } },
      { id: "land", type: "fill", source: "states", paint: { "fill-color": t.land } },
      { id: "borders", type: "line", source: "states", paint: { "line-color": t.border, "line-width": 1 } },
      ...overlayLayers(t)
    ]
  };
}

function mergeOpenFreeMapStyle(base: StyleSpecification, t: Tokens): StyleSpecification {
  const painted = (base.layers ?? []).map((layer) => basemapPaint(layer, t));
  // Toll roads go just over the last road line (so no road paints over them) and under the road and place names; fuel and rest areas over the basemap, under every overlay.
  // Not "before the first label": dark's first label is water_name, which comes before every road.
  const extra = radarBasemapLayers(t);
  const lastRoad = painted.map((l) => l.type === "line" && (l as { "source-layer"?: string })["source-layer"] === "transportation").lastIndexOf(true);
  const at = lastRoad < 0 ? painted.length : lastRoad + 1;
  const layers = [...painted.slice(0, at), extra.tolls, ...painted.slice(at), extra.pois];
  return {
    ...base,
    sources: { ...(base.sources ?? {}), ...overlaySources() },
    layers: [...layers, ...overlayLayers(t)]
  };
}

async function resolveStyle(mode: "night" | "day", t: Tokens, signal: AbortSignal): Promise<{ style: StyleSpecification; live: boolean }> {
  const url = OFM_STYLE[mode];
  const cached = BASE_STYLE_CACHE.get(url);
  if (cached) return { style: mergeOpenFreeMapStyle(cached, t), live: true };
  try {
    const res = await fetch(url, { signal });
    if (!res.ok) return { style: offlineStyleOf(t), live: false };
    const json = (await res.json()) as StyleSpecification;
    if (!json || !json.sources || !Array.isArray(json.layers)) return { style: offlineStyleOf(t), live: false };
    BASE_STYLE_CACHE.set(url, json);
    return { style: mergeOpenFreeMapStyle(json, t), live: true };
  } catch {
    return { style: offlineStyleOf(t), live: false };
  }
}

/** A box as MapLibre wants it. */
const ll = (b: Box): [[number, number], [number, number]] => [[b[0], b[1]], [b[2], b[3]]];

/** Show or hide one of the map's own layers. A layer the style does not have (the offline fallback has no tolls or fuel stops) is left alone, never an error. */
function setVisible(map: MapLibreMap, id: string, on: boolean) {
  if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
}

/** The selected unit's load as map features: the road to drive, the road driven, a dot for each fix and a square at each stop. Every point goes through mapLng, as the units do. */
function routeFeatures(r: RadarRoute | null): unknown[] {
  if (!r || r.status === "none") return [];
  const at = (p: { lat: number; lng: number }): [number, number] => [mapLng(p.lat, p.lng), p.lat];
  const out: unknown[] = [];
  // Roads only: the road route when one is known (standard car directions, kept in server memory), the stretches of it that were driven, and a dot for every fix. Nothing is joined straight.
  if (r.road && r.road.length >= 2) out.push({ type: "Feature", properties: { part: "road" }, geometry: { type: "LineString", coordinates: r.road.map((c) => at({ lat: c[1], lng: c[0] })) } });
  for (const run of r.driven) out.push({ type: "Feature", properties: { part: "trail" }, geometry: { type: "LineString", coordinates: run.map((c) => at({ lat: c[1], lng: c[0] })) } });
  for (const pt of r.trail) out.push({ type: "Feature", properties: { part: "trail-pt" }, geometry: { type: "Point", coordinates: at(pt) } });
  for (const st of r.stops) out.push({ type: "Feature", properties: { part: "stop", icon: st.role === "pickup" ? "stop-p" : "stop-d", label: st.label, role: st.role }, geometry: { type: "Point", coordinates: at(st) } });
  return out;
}

const openLoadFeatures = (pins: OpenLoadPin[]): Feat[] =>
  pins.map((l) => ({ type: "Feature", geometry: { type: "Point", coordinates: [mapLng(l.lat, l.lng), l.lat] }, properties: { id: l.id, number: l.number, lane: l.lane, rate: l.rate ?? "", rpm: l.rpm ?? "", due: l.pickupDue ?? "", equipment: l.equipment ?? "" } }));

/** What the map draws besides the units, each switched by the panel. */
export type Overlays = { tolls: boolean; pois: boolean; openLoads: OpenLoadPin[] | null; weather: RadarWeather | null; route: RadarRoute | null };
const NO_OVERLAYS: Overlays = { tolls: false, pois: false, openLoads: null, weather: null, route: null };

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
  compact,
  bare = false,
  overlays = NO_OVERLAYS,
  extent,
  onLive
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
  /** No region buttons: a map of a single unit has nothing to switch between. */
  bare?: boolean;
  overlays?: Overlays;
  /** Places the first view must also hold besides the points (a load's stops and road): the map fits all of them, closer in than a fleet view. */
  extent?: ReadonlyArray<{ lat: number; lng: number }>;
  /** Told whether the live OpenFreeMap tiles loaded (tolls and fuel stops exist only on them). */
  onLive?: (live: boolean) => void;
}) {
  const box = React.useRef<HTMLDivElement>(null);
  const mapRef = React.useRef<MapLibreMap | null>(null);
  const ready = React.useRef(false);
  const fitted = React.useRef("");
  // The region the camera is held to (the lower 48, Alaska or Hawaii). The first view is the one with the most units.
  const regionRef = React.useRef<RegionKey>(firstRegion(points));
  const [region, setRegion] = React.useState<RegionKey>(regionRef.current);
  const counts = React.useMemo(() => regionCounts(points), [points]);
  const latest = React.useRef({ points, sel, ring: ring ?? null, fitKey: fitKey ?? "", clustered, overlays, extent: extent ?? null });
  latest.current = { points, sel, ring: ring ?? null, fitKey: fitKey ?? "", clustered, overlays, extent: extent ?? null };
  const live = React.useRef(onLive);
  live.current = onLive;
  const router = useRouter();
  const go = React.useRef((href: string) => router.push(href));
  go.current = (href: string) => router.push(href);
  const pick = React.useRef(onSelect);
  pick.current = onSelect;
  const stack = React.useRef(onStack);
  stack.current = onStack;
  // The hover: a unit's name at once, then where it is (read once for the unit, kept for a minute).
  const [hover, setHover] = React.useState<{ anchor: DOMRect; tip: TipData } | null>(null);
  const [liveTiles, setLiveTiles] = React.useState(false);

  /** Hold the camera inside a region's box (a hard stop at its edge, so the land cannot be dragged out of view). */
  const hold = React.useCallback((key: RegionKey) => {
    const map = mapRef.current;
    regionRef.current = key;
    setRegion(key);
    map?.setMaxBounds(ll(REGIONS[key].clamp));
  }, []);

  const goRegion = React.useCallback(
    (key: RegionKey) => {
      const map = mapRef.current;
      hold(key);
      map?.fitBounds(ll(REGIONS[key].fit), { padding: compact ? 8 : 24, duration: 500 });
    },
    [hold, compact]
  );

  const push = React.useCallback(() => {
    const map = mapRef.current;
    if (!map || !ready.current) return;
    const { points: pts, sel: chosen, ring: rg, fitKey: key, overlays: ov, extent: ext } = latest.current;
    (map.getSource("route") as GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features: routeFeatures(ov.route) } as never);
    (map.getSource("open-loads") as GeoJSONSource | undefined)?.setData(collection(openLoadFeatures(ov.openLoads ?? [])) as never);
    (map.getSource("weather") as GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features: ov.weather?.features ?? [] } as never);
    setVisible(map, "tolls", ov.tolls);
    setVisible(map, "truck-poi", ov.pois);
    setVisible(map, "open-loads", ov.openLoads != null);
    setVisible(map, "wx-fill", ov.weather != null);
    setVisible(map, "wx-line", ov.weather != null);
    (map.getSource("units") as GeoJSONSource).setData(collection(pts.map(pointFeature)) as never);
    const found = chosen ? pts.find((u) => u.id === chosen.id && (chosen.kind === "tractor" ? u.k === "t" : u.k === "r")) : null;
    (map.getSource("selected") as GeoJSONSource).setData(collection(found ? [{ type: "Feature", geometry: { type: "Point", coordinates: [mapLng(found.lat, found.lng), found.lat] }, properties: {} }] : []) as never);
    (map.getSource("radius") as GeoJSONSource).setData({ type: "FeatureCollection", features: rg ? [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: radiusRing({ lat: rg.lat, lng: mapLng(rg.lat, rg.lng) }, rg.radius) } }] : [] } as never);
    // Fit once for each fit key (the first load, and every new or cleared search), not on every refresh.
    if (fitted.current !== key && (pts.length > 0 || rg)) {
      fitted.current = key;
      if (rg) {
        // A search in Alaska or Hawaii moves the camera's box there first, so the fit is never clamped away.
        const k = regionOf(rg.lat, rg.lng);
        if (k !== regionRef.current) hold(k);
        const b = boundsAround({ lat: rg.lat, lng: mapLng(rg.lat, rg.lng) }, rg.radius * 1.08);
        map.fitBounds(ll(withinRegion([b.minLng, b.minLat, b.maxLng, b.maxLat], k)), { padding: compact ? 16 : 40, maxZoom: 11, duration: 0 });
      } else if (ext && ext.length > 0) {
        // A load: the truck, its stops and its road all in view, as close as they allow.
        const k = firstRegion(pts);
        if (k !== regionRef.current) hold(k);
        const box = boxAround([...pts, ...ext], 0.25, 0.8) ?? REGIONS[k].fit;
        map.fitBounds(ll(withinRegion(box, k)), { padding: compact ? 24 : 48, maxZoom: 10, duration: 0 });
      } else {
        // Open on the region with the most units, fitted to the units in it (one truck in Anchorage does not stretch the first view across the world).
        const k = firstRegion(pts);
        if (k !== regionRef.current) hold(k);
        const box = boxAround(pts.filter((u) => regionOf(u.lat, u.lng) === k)) ?? REGIONS[k].fit;
        map.fitBounds(ll(withinRegion(box, k)), { padding: compact ? 16 : 48, maxZoom: 6.5, duration: 0 });
      }
    }
  }, [compact, hold]);

  React.useEffect(() => {
    let dead = false;
    let map: MapLibreMap | null = null;
    let watch: ResizeObserver | null = null;
    const ac = new AbortController();
    const styleTimer = window.setTimeout(() => ac.abort(), 4000);
    const tokens = readTokens();
    const mode = document.documentElement.dataset.theme === "day" ? "day" : "night";
    void Promise.all([import("maplibre-gl"), resolveStyle(mode, tokens, ac.signal)]).then(([ml, resolved]) => {
      window.clearTimeout(styleTimer);
      if (dead || !box.current) return;
      // The bundler does not emit MapLibre's worker, so the desk serves its own copy (public/maplibre-gl-worker.mjs, kept equal to the installed version by tests/radar-rules.test.ts).
      ml.setWorkerUrl("/maplibre-gl-worker.mjs");
      setLiveTiles(resolved.live);
      live.current?.(resolved.live);
      const family = getComputedStyle(document.body).fontFamily || "monospace";
      map = new ml.Map({ container: box.current, style: resolved.style, bounds: ll(REGIONS[regionRef.current].fit), maxBounds: ll(REGIONS[regionRef.current].clamp), fitBoundsOptions: { padding: compact ? 8 : 24 }, interactive: !compact, attributionControl: false, dragRotate: false, pitchWithRotate: false, renderWorldCopies: false, maxZoom: MAP_MAX_ZOOM, minZoom: 2 });
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
        // Freight that needs a driver opens its load.
        map.on("click", "open-loads", (e) => {
          const id = e.features?.[0]?.properties?.id as string | undefined;
          if (id) go.current(`/loads/${id}`);
        });
        for (const layer of ["units", "clusters", "open-loads"]) {
          map.on("mouseenter", layer, () => (map!.getCanvas().style.cursor = "pointer"));
          map.on("mouseleave", layer, () => (map!.getCanvas().style.cursor = ""));
        }
        map.on("click", (e) => {
          const hit = ["units", "clusters", "open-loads"].filter((l) => map!.getLayer(l));
          if (map!.queryRenderedFeatures(e.point, { layers: hit }).length === 0) pick.current(null);
        });
      }
      const tips = new Map<string, { at: number; tip: TipData }>();
      let hoverTimer: number | undefined;
      let hoverKey = "";
      const clearHover = (prefix?: string) => {
        if (prefix && !hoverKey.startsWith(prefix)) return;
        window.clearTimeout(hoverTimer);
        hoverKey = "";
        setHover(null);
      };
      if (!compact) {
        map.on("mouseenter", "clusters", async (e) => {
          const p = e.features?.[0]?.properties as { cluster_id?: number; point_count?: number; nt?: number; nr?: number } | undefined;
          if (!p?.cluster_id || !p.point_count || !box.current || !map) return;
          const id = p.cluster_id;
          const key = `cluster:${id}`;
          hoverKey = key;
          const r = box.current.getBoundingClientRect();
          const anchor = new DOMRect(r.left + e.point.x - 10, r.top + e.point.y - 10, 20, 20);
          const rows: Array<[string, string]> = [];
          if (p.nt) rows.push(["Tractors", String(p.nt)]);
          if (p.nr) rows.push(["Trailers", String(p.nr)]);
          setHover({ anchor, tip: { title: `${p.point_count.toLocaleString("en-US")} units here`, rows, note: "Click to zoom in or open list." } });
          try {
            const src = map.getSource("units") as GeoJSONSource;
            const leaves = await src.getClusterLeaves(id, 6, 0);
            const names = leaves.map((l) => String(l.properties?.name ?? "")).filter(Boolean);
            const more = p.point_count - names.length;
            if (hoverKey === key && names.length > 0) {
              setHover({
                anchor,
                tip: {
                  title: `${p.point_count.toLocaleString("en-US")} units here`,
                  rows: [...rows, ["Includes", more > 0 ? `${names.join(", ")}, +${more} more` : names.join(", ")]],
                  note: "Click to zoom in or open list."
                }
              });
            }
          } catch {
            /* summary rows stay */
          }
        });
        map.on("mouseleave", "clusters", () => clearHover("cluster:"));
        // An open load: its lane, rate and pickup window, from the pin itself (no read).
        map.on("mouseenter", "open-loads", (e) => {
          const p = e.features?.[0]?.properties as Record<string, string> | undefined;
          if (!p?.id || !box.current) return;
          hoverKey = `load:${p.id}`;
          const r = box.current.getBoundingClientRect();
          const rows: Array<[string, string]> = [["Lane", p.lane ?? ""]];
          if (p.rate) rows.push(["Rate / RPM", p.rpm ? `${p.rate} · ${p.rpm}` : p.rate]);
          if (p.due) rows.push(["Pickup due", p.due]);
          if (p.equipment) rows.push(["Equipment", p.equipment]);
          setHover({ anchor: new DOMRect(r.left + e.point.x - 8, r.top + e.point.y - 8, 16, 16), tip: { title: `Load ${p.number ?? ""} · needs a driver`, rows, note: "Click to open the load." } });
        });
        map.on("mouseleave", "open-loads", () => clearHover("load:"));
        // A weather alert's area: what it is, how bad, and until when, in the National Weather Service's words.
        map.on("mousemove", "wx-fill", (e) => {
          if (hoverKey.startsWith("unit:") || hoverKey.startsWith("cluster:") || hoverKey.startsWith("load:")) return;
          const p = e.features?.[0]?.properties as Record<string, string> | undefined;
          if (!p || !box.current) return;
          const key = `wx:${p.id ?? ""}`;
          if (hoverKey === key) return;
          hoverKey = key;
          const r = box.current.getBoundingClientRect();
          const rows: Array<[string, string]> = [["Severity", p.severity ?? ""]];
          if (p.headline) rows.push(["Headline", p.headline]);
          if (p.expires) rows.push(["Expires", new Date(p.expires).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })]);
          setHover({ anchor: new DOMRect(r.left + e.point.x - 8, r.top + e.point.y - 8, 16, 16), tip: { title: p.event ?? "Weather alert", rows, note: "National Weather Service" } });
        });
        map.on("mouseleave", "wx-fill", () => clearHover("wx:"));
      }
      map.on("mouseenter", "units", (e) => {
        const p = e.features?.[0]?.properties as { id?: string; k?: string; name?: string } | undefined;
        if (!p?.id || !box.current) return;
        const id = p.id;
        const key = `unit:${p.k}:${id}`;
        hoverKey = key;
        const r = box.current.getBoundingClientRect();
        const anchor = new DOMRect(r.left + e.point.x - 6, r.top + e.point.y - 6, 12, 12);
        const cached = tips.get(key);
        const fresh = cached != null && Date.now() - cached.at < 60_000;
        setHover({ anchor, tip: fresh ? cached.tip : { title: p.name ?? "" } });
        if (fresh) return;
        window.clearTimeout(hoverTimer);
        hoverTimer = window.setTimeout(async () => {
          try {
            const res = await fetch(`/fleet/map/data?mode=where&kind=${p.k === "r" ? "trailer" : "tractor"}&id=${encodeURIComponent(id)}`, { cache: "no-store" });
            if (!res.ok) return;
            const tip = (await res.json()) as TipData;
            tips.set(key, { at: Date.now(), tip });
            if (hoverKey === key) setHover({ anchor, tip });
          } catch {
            /* the name stays on screen */
          }
        }, 150);
      });
      map.on("mouseleave", "units", () => clearHover("unit:"));
      map.on("movestart", () => clearHover());
    });
    return () => {
      dead = true;
      window.clearTimeout(styleTimer);
      ac.abort();
      watch?.disconnect();
      ready.current = false;
      fitted.current = "";
      map?.remove();
      mapRef.current = null;
    };
  }, [compact, push]);

  React.useEffect(push, [push, points, sel, ring, fitKey, overlays]);
  React.useEffect(() => {
    const map = mapRef.current;
    if (map && ready.current) (map.getSource("units") as GeoJSONSource).setClusterOptions({ cluster: clustered });
  }, [clustered]);
  React.useEffect(() => {
    if (!focus || !mapRef.current) return;
    const k = regionOf(focus.lat, focus.lng);
    if (k !== regionRef.current) hold(k);
    mapRef.current.easeTo({ center: [mapLng(focus.lat, focus.lng), focus.lat], zoom: focus.zoom, duration: 500 });
  }, [focus, hold]);
  return (
    <>
      <div ref={box} className="rd-canvas" role="img" aria-label={`Map of ${points.length} units`} />
      {hover ? <TipPopup anchor={hover.anchor} tip={hover.tip} /> : null}
      {liveTiles && !bare ? (
        <p className="rd-attrib">
          <a href="https://openfreemap.org" target="_blank" rel="noreferrer">
            OpenFreeMap
          </a>{" "}
          © OpenMapTiles · © OpenStreetMap
        </p>
      ) : null}
      {bare ? null : (
        <div className="rd-regions" role="group" aria-label="Region">
          {REGION_KEYS.map((k) => (
            <button key={k} type="button" className="rd-region" aria-pressed={region === k} onClick={() => goRegion(k)}>
              {REGIONS[k].label}
              <span>{counts[k].toLocaleString("en-US")}</span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}

/** A map of one truck or trailer, for its Where-it-is tab: the same mark the radar draws, centred on its last position. */
export function UnitMap({ unit }: { unit: { id: string; kind: "truck" | "trailer"; name: string; lat: number; lng: number; icon: string; headingDeg: number | null } }) {
  const theme = useTheme();
  const point: RadarPoint = { id: unit.id, k: unit.kind === "truck" ? "t" : "r", lat: unit.lat, lng: unit.lng, icon: unit.icon, h: unit.headingDeg ?? 0, sev: 0, t: unit.kind === "truck" ? 1 : 0, r: unit.kind === "truck" ? 0 : 1, name: unit.name };
  return (
    <div className="eq-map" aria-label={`Map of ${unit.name}`}>
      <Canvas key={theme} points={[point]} sel={null} onSelect={() => undefined} clustered={false} compact bare fitKey={unit.id} focus={{ lat: unit.lat, lng: unit.lng, zoom: 9, n: 1 }} />
    </div>
  );
}

/**
 * A load on the real map, for the drawer's Where it is tab: the truck's mark where the ELD last put it, the load's road when one could be
 * had, the breadcrumb and the stops, drawn by the radar's own layers on the same tiles (OpenFreeMap; its built-in state outlines when those cannot load). `fallback` is the plain drawing, shown only where the browser cannot draw a map at all (no WebGL). It shows; it records nothing.
 */
export function LoadMap({ t, fallback }: { t: LoadTracking; fallback: React.ReactNode }) {
  const theme = useTheme();
  const [canDraw, setCanDraw] = React.useState<boolean | null>(null);
  React.useEffect(() => {
    try {
      const c = document.createElement("canvas");
      setCanDraw(!!(c.getContext("webgl2") ?? c.getContext("webgl")));
    } catch {
      setCanDraw(false);
    }
  }, []);
  if (t.status !== "tracking") return null;
  if (canDraw === false) return <>{fallback}</>;
  const p = t.position;
  const icon = p.state === "moving_load" ? "t-load" : p.state === "moving" ? "t-moving" : p.state === "idling" ? "t-idle" : p.state === "parked" ? "t-parked" : "t-none";
  const truck: RadarPoint = { id: "load-truck", k: "t", lat: p.lat, lng: p.lng, icon, h: p.headingDeg ?? 0, sev: p.state === "idling" ? 1 : 0, t: 1, r: 0, name: t.truckName };
  const route: RadarRoute = {
    mode: "route", status: "tracking", loadId: "drawer", loadNumber: null, truckId: null, stops: t.stops, trail: t.trail, driven: t.driven, road: t.road?.coords ?? null,
    roadState: t.roadState, headline: t.headline, late: t.late, driver: null, hos: null, eta: null, nextStop: null, trailer: null
  };
  const extent = [...t.stops, ...(t.road?.coords ?? []).map((c) => ({ lat: c[1], lng: c[0] }))];
  const key = `${t.stops.map((s) => `${s.lat},${s.lng}`).join("|")}`;
  return (
    <div className="eq-map lt-map" aria-label={`${t.truckName}: ${t.headline}`}>
      {canDraw ? (
        <Canvas key={theme} points={[truck]} sel={null} onSelect={() => undefined} clustered={false} compact bare fitKey={key} extent={extent} overlays={{ ...NO_OVERLAYS, route }} />
      ) : null}
    </div>
  );
}

type KeyKind = "load" | "moving" | "idle" | "parked" | "none" | "hooked" | "dropped" | "dwell" | "loaded" | "cluster" | "open" | "tolls" | "weather";
const KEY_SQUARE: Partial<Record<KeyKind, number>> = { hooked: 1.5, dropped: 2.5, dwell: 2.5, loaded: 2.5 };
/** One mark of the key, the shape the map draws for it (addImages, clusterImage), in the same colour tokens. */
function KeyMark({ kind }: { kind: KeyKind }) {
  const stroke = KEY_SQUARE[kind];
  return (
    <svg className="rd-mark" data-mark={kind} width={14} height={14} viewBox="0 0 16 16" aria-hidden="true">
      {kind === "load" || kind === "moving" ? (
        <>
          <polygon points="8,1 11,5 5,5" />
          <rect x="4" y="6" width="8" height="8" />
        </>
      ) : stroke ? (
        <>
          <rect x="4" y="4" width="8" height="8" fill="none" strokeWidth={stroke} />
          {kind === "loaded" ? <rect className="rd-dot-in" x="6" y="6" width="4" height="4" /> : null}
        </>
      ) : kind === "cluster" ? (
        <>
          <rect x="2" y="2" width="12" height="12" fill="none" strokeWidth={1.5} />
          <rect className="rd-cl-in" x="5" y="5" width="6" height="6" fill="none" strokeWidth={1} />
        </>
      ) : kind === "open" ? (
        <path d="M3 3h10v10H3zM8 5.5v5M5.5 8h5" fill="none" strokeWidth={1.5} />
      ) : kind === "tolls" ? (
        <path d="M2 8h12" strokeWidth={3} />
      ) : kind === "weather" ? (
        <rect x="3" y="3" width="10" height="10" strokeWidth={1.5} />
      ) : (
        <rect x="4" y="5" width="8" height="8" />
      )}
    </svg>
  );
}

const KEY_ALWAYS: ReadonlyArray<{ kind: KeyKind; words: string }> = [
  { kind: "load", words: "Moving under a load (the point is its heading)" },
  { kind: "moving", words: "Moving, no load" },
  { kind: "idle", words: "Engine on, standing" },
  { kind: "parked", words: "Parked" },
  { kind: "none", words: "No signal" },
  { kind: "hooked", words: "Trailer, hooked (thin edge)" },
  { kind: "dropped", words: "Trailer, dropped (heavy edge)" },
  { kind: "dwell", words: "Trailer past its free time (heavy edge, amber)" },
  { kind: "loaded", words: "Trailer, loaded (filled centre)" },
  { kind: "cluster", words: "Units close together: click to split; a stack on one spot opens as a list" }
];

/** What every mark on the map is, in shape and in words; a layer's own mark joins when the layer is on. */
function RadarKey({ loads, tolls, weather }: { loads: boolean; tolls: boolean; weather: boolean }) {
  const items = [
    ...KEY_ALWAYS,
    ...(loads ? [{ kind: "open" as const, words: "A load that needs a driver, at its pickup" }] : []),
    ...(tolls ? [{ kind: "tolls" as const, words: "Toll road (from OpenStreetMap). Toll prices need a tolling or routing partner." }] : []),
    ...(weather ? [{ kind: "weather" as const, words: "Severe (amber) or extreme (red) weather alert, National Weather Service" }] : [])
  ];
  return (
    <ul className="rd-key" aria-label="Key">
      {items.map((k) => (
        <li key={k.kind}>
          <KeyMark kind={k.kind} />
          <span>{k.words}</span>
        </li>
      ))}
    </ul>
  );
}

/** How old the picture is, beside the button that reads it again, and why that button cannot be pressed when it cannot. */
function RadarAge({ asOf, now, reason, children }: { asOf: string | null; now: number; reason?: string | null; children?: React.ReactNode }) {
  const age = fixAge(asOf, now);
  return (
    <>
      <div className="rd-sync">
        {age?.old ? <StaleFix minutes={age.minutes}>Units may have moved.</StaleFix> : <p className="rd-sub">As of {agoText(asOf, now)}</p>}
        {children ? <div className="rd-actions">{children}</div> : null}
      </div>
      {reason ? <p className="rd-sub">{reason}</p> : null}
    </>
  );
}

const STATE_WORD: Record<string, { tone: string; word: string }> = {
  moving_load: { tone: "label", word: "Moving under load" },
  moving: { tone: "ink", word: "Moving, no load" },
  idling: { tone: "warn", word: "Idling" },
  parked: { tone: "dim", word: "Parked" }
};

/** The schedule chip from the ETA's own words ("... · ON SCHEDULE" / "RUNNING LATE"), and the ETA without them. */
function etaParts(r: RadarRoute | null): { text: string | null; chip: "late" | "on" | null } {
  if (!r || r.status === "none" || !r.eta) return { text: null, chip: r && r.status !== "none" && r.late ? "late" : null };
  const late = r.late || r.eta.includes("RUNNING LATE");
  const on = !late && r.eta.includes("ON SCHEDULE");
  return { text: r.eta.replace(/(^|\s*·\s*)(RUNNING LATE|ON SCHEDULE)\s*$/, "") || null, chip: late ? "late" : on ? "on" : null };
}

/** The live lines of a unit on a load: driver, hours left, ETA with its schedule chip, the next stop and its window, the trailer. */
function RouteLines({ r, old, fallbackDriver, fallbackTrailer }: { r: RadarRoute | null; /** The fix is too old to work an arrival out from. */ old: boolean; fallbackDriver: string | null; fallbackTrailer: string | null }) {
  const on = r && r.status !== "none" ? r : null;
  const eta = etaParts(r);
  return (
    <>
      <dt>Driver</dt>
      <dd>{on?.driver ?? fallbackDriver ?? "—"}</dd>
      {on ? (
        <>
          <dt>HOS left</dt>
          <dd>{on.hos ?? "—"}</dd>
          <dt>ETA</dt>
          <dd>
            {old ? <span className="dim">Needs a newer position</span> : (eta.text ?? (eta.chip ? null : <span className="dim">No road route yet</span>))}
            {eta.chip && !old ? (
              <>
                {" "}
                <b className="rd-sched" data-tone={eta.chip === "late" ? "warn" : "pos"}>
                  {eta.chip === "late" ? "RUNNING LATE" : "ON SCHEDULE"}
                </b>
              </>
            ) : null}
          </dd>
          <dt>Next stop</dt>
          <dd>{on.nextStop ?? "—"}</dd>
        </>
      ) : null}
      <dt>Trailer</dt>
      <dd>{on?.trailer ?? fallbackTrailer ?? "—"}</dd>
    </>
  );
}

function RouteNote({ r }: { r: RadarRoute | null }) {
  if (!r || r.status === "none") return null;
  if (r.status === "tracking") {
    return (
      <p className="rd-sub">
        {r.road ? "On the map: the gold line is the road route; the white line is the road the truck drove on this load, and each dot is a position it sent. " : r.trail.length > 0 ? "On the map: each dot is a position the truck sent. " : null}
        {r.roadState === "none" ? NO_ROAD_NOTE : r.roadState === "off" ? `${OFF_ROAD_NOTE} ` : null}
        {r.road ? ROAD_ROUTE_NOTE : null}
      </p>
    );
  }
  if (r.status === "no_lane") return <p className="rd-sub">The load&apos;s stops have no map points yet, so there is no road to draw.</p>;
  if (r.status === "no_position") return <p className="rd-sub">The truck has no fix yet, so there is no trail to draw.</p>;
  return null;
}

function TractorCard({ u, now, route }: { u: RadarTractor; now: number; route: RadarRoute | null }) {
  const st = u.state ? STATE_WORD[u.state] : null;
  const age = fixAge(u.locatedAt, now);
  const old = age?.old === true;
  const loadId = route && route.status !== "none" ? route.loadId : u.loadId;
  const loadNumber = route && route.status !== "none" ? route.loadNumber : u.loadNumber;
  return (
    <div className="rd-card">
      <div className="rd-card-head">
        <b>{u.name}</b>
        <span className="rd-st">
          <i className="rd-dot" data-tone={old ? "dim" : (st?.tone ?? "dim")} aria-hidden="true" /> {st ? (old ? `Then: ${st.word.toLowerCase()}` : st.word) : "No signal"}
        </span>
      </div>
      {old ? <StaleFix minutes={age.minutes}>May have moved.</StaleFix> : null}
      <dl className="rd-kv">
        <dt>{old ? "Road then" : "Road"}</dt>
        <dd>{u.road || "—"}</dd>
        <RouteLines r={route} old={old} fallbackDriver={u.driver} fallbackTrailer={u.trailer ? `${u.trailer.number}${u.trailer.code ? ` [${u.trailer.code}]` : ""}` : null} />
        <dt>Last fix</dt>
        <dd>{agoText(u.locatedAt, now)}</dd>
      </dl>
      {u.idle ? <p className="rd-leak">{`■ ${old ? "When last read: " : ""}${u.idle.sentence}`}</p> : null}
      {u.idle?.todayHours != null ? <p className="rd-sub">{u.idle.todayHours.toFixed(1)} h idling today</p> : null}
      <RouteNote r={route} />
      <p className="rd-links">
        {loadId ? (
          <Link className="tl-btn sm" href={`/loads/${loadId}`}>
            {`Open load ${loadNumber ?? ""}`.trim()}
          </Link>
        ) : null}
        <Link className="tl-btn ghost sm" href={`/fleet/${u.id}`}>
          Open truck
        </Link>
      </p>
    </div>
  );
}

function TrailerCard({ u, now, route }: { u: RadarTrailer; now: number; route: RadarRoute | null }) {
  const on = route && route.status !== "none" ? route : null;
  const age = fixAge(u.locatedAt, now);
  // A dropped trailer stands where it was left, so only one that is hooked to a tractor can have moved since its fix.
  const old = age?.old === true && u.hooked;
  return (
    <div className="rd-card">
      <div className="rd-card-head">
        <b>{`${u.number}${u.code ? ` [${u.code}]` : ""}`}</b>
        <span className="rd-st">
          <i className="rd-dot" data-tone={u.dwell?.alert ? "warn" : u.hooked ? "dim" : "ink"} aria-hidden="true" /> {u.hooked ? `Hooked to ${u.hookedTo ?? "a tractor"}` : "Dropped"}
        </span>
      </div>
      {old && age ? <StaleFix minutes={age.minutes}>May have moved.</StaleFix> : null}
      <dl className="rd-kv">
        <dt>Cargo</dt>
        <dd>{u.loaded ? "Loaded" : "Empty"}</dd>
        {on ? <RouteLines r={on} old={old} fallbackDriver={null} fallbackTrailer={null} /> : null}
        <dt>Last fix</dt>
        <dd>{agoText(u.locatedAt, now)}</dd>
      </dl>
      {u.dwell ? <p className={`rd-leak${u.dwell.typed ? " rd-typed" : ""}`}>{`■ ${u.dwell.sentence}`}</p> : null}
      <RouteNote r={route} />
      <p className="rd-links">
        {on ? (
          <Link className="tl-btn sm" href={`/loads/${on.loadId}`}>
            {`Open load ${on.loadNumber ?? ""}`.trim()}
          </Link>
        ) : null}
        {on?.truckId ? (
          <Link className="tl-btn ghost sm" href={`/fleet/${on.truckId}`}>
            Open truck
          </Link>
        ) : null}
        <Link className="tl-btn ghost sm" href={`/trailers/${u.id}`}>
          {u.dwell ? "Open trailer (dwell)" : "Open trailer"}
        </Link>
      </p>
    </div>
  );
}

function useTheme() {
  const [theme, setTheme] = React.useState("night");
  React.useEffect(() => {
    // The interface style (data-ui="app") changes the tokens too, so the map is redrawn when either changes.
    const read = () => setTheme(`${document.documentElement.dataset.theme ?? "night"}|${document.documentElement.dataset.ui ?? "desk"}`);
    read();
    const o = new MutationObserver(read);
    o.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-ui"] });
    return () => o.disconnect();
  }, []);
  return theme;
}

/** The points the map shows, from the desk's own data route, narrowed by the search and filters, refreshed every 30 seconds while the tab is visible. */
export function usePoints(initial: RadarPoints, params: Partial<RadarQueryParams>, every = 30_000) {
  const [data, setData] = React.useState(initial);
  const [now, setNow] = React.useState(() => Date.parse(initial.asOf ?? "") || 0);
  const query = radarParamsText({ near: params.near, r: params.r, kind: params.kind, state: params.state, x: params.x, q: params.q, hooked: params.hooked });
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

/** One unit's full card, fetched when it is clicked (and again every `every` ms while it stays selected, only when the page was opened with ?live=). */
function useUnit(sel: Sel, every: number | null = null) {
  const [card, setCard] = React.useState<{ tractor: RadarTractor | null; trailer: RadarTrailer | null } | null>(null);
  React.useEffect(() => {
    setCard(null);
    if (!sel) return;
    let dead = false;
    const read = () =>
      void fetch(`/fleet/map/data?mode=unit&kind=${sel.kind}&id=${encodeURIComponent(sel.id)}`, { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => {
          if (!dead && j) setCard(j as { tractor: RadarTractor | null; trailer: RadarTrailer | null });
        })
        .catch(() => undefined);
    read();
    const tick = every ? setInterval(() => (document.hidden ? undefined : read()), every) : null;
    return () => {
      dead = true;
      if (tick) clearInterval(tick);
    };
  }, [sel, every]);
  return card;
}

/** The clicked unit's load (lane, breadcrumb, live lines), read when it is clicked and every minute (or every `every` ms with ?live=) while it stays selected. */
function useRoute(sel: Sel, every = 60_000) {
  const [route, setRoute] = React.useState<RadarRoute | null>(null);
  React.useEffect(() => {
    setRoute(null);
    if (!sel) return;
    let dead = false;
    const read = () =>
      void fetch(`/fleet/map/data?mode=route&kind=${sel.kind}&id=${encodeURIComponent(sel.id)}`, { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => {
          if (!dead && j) setRoute(j as RadarRoute);
        })
        .catch(() => undefined);
    read();
    const tick = setInterval(() => {
      if (!document.hidden) read();
    }, every);
    return () => {
      dead = true;
      clearInterval(tick);
    };
  }, [sel, every]);
  return route;
}

/** An overlay's data from the desk's own route, read when it is switched on and every `every` ms while it stays on; null while it is off. */
function useOverlay<T>(mode: "open_loads" | "weather", on: boolean, every: number): T | null {
  const [data, setData] = React.useState<T | null>(null);
  React.useEffect(() => {
    if (!on) {
      setData(null);
      return;
    }
    let dead = false;
    const read = () =>
      void fetch(`/fleet/map/data?mode=${mode}`, { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => {
          if (!dead && j) setData(j as T);
        })
        .catch(() => undefined);
    read();
    const tick = setInterval(() => {
      if (!document.hidden) read();
    }, every);
    return () => {
      dead = true;
      clearInterval(tick);
    };
  }, [mode, on, every]);
  return data;
}

type Tab = "telemetry" | "search" | "list";
const TAB_LABEL: Record<Tab, string> = { telemetry: "Telemetry", search: "Search", list: "List" };

/** Where the search and filters live, kept in the address so a search can be shared and survives going back. */
function writeUrl(p: Partial<RadarQueryParams>) {
  try {
    const text = radarParamsText({ near: p.near, r: p.r, kind: p.kind, state: p.state, x: p.x, q: p.q });
    window.history.replaceState(null, "", text ? `/fleet/map?${text}` : "/fleet/map");
  } catch {
    /* the address stays as it was */
  }
}

/**
 * The full radar: the map on the left and, beside it on a draggable bar, a panel with Telemetry (the counts and the key), Search (a ZIP, city or state and a radius) and List (every unit in view,
 * nearest first, optionally grouped by place). `actions` is the server-rendered Read ELD button.
 */
export function RadarView({ initial, params, actions, eldReason }: { initial: RadarPoints; params: RadarQueryParams; actions?: React.ReactNode; eldReason?: string | null }) {
  const theme = useTheme();
  const [p, setP] = React.useState<RadarQueryParams>(params);
  // ?live=5 (a demo or a recording): the page asks every 5 seconds, so a moving unit is seen to move. Without it the rhythm is the usual 30 s and 60 s.
  const liveSecs = readLiveSeconds(useSearchParams()?.get("live"));
  const { data, now } = usePoints(initial, p, liveSecs ? liveSecs * 1000 : 30_000);
  const [sel, setSel] = React.useState<Sel>(null);
  const [tab, setTab] = React.useState<Tab>(params.ids.length > 0 ? "list" : params.near ? "search" : "telemetry");
  const [clustered, setClustered] = React.useState(true);
  const [stackIds, setStackIds] = React.useState<string[] | null>(params.ids.length > 0 ? params.ids : null);
  const [focus, setFocus] = React.useState<Focus>(null);
  const card = useUnit(sel, liveSecs ? liveSecs * 1000 : null);
  const route = useRoute(sel, liveSecs ? liveSecs * 1000 : 60_000);
  const [tolls, setTolls] = React.useState(false);
  const [pois, setPois] = React.useState(false);
  const [showLoads, setShowLoads] = React.useState(false);
  const [showWeather, setShowWeather] = React.useState(false);
  const [live, setLive] = React.useState<boolean | null>(null);
  const openLoads = useOverlay<RadarOpenLoads>("open_loads", showLoads, 60_000);
  const weather = useOverlay<RadarWeather>("weather", showWeather, 300_000);
  const overlays = React.useMemo<Overlays>(
    () => ({ tolls, pois, openLoads: showLoads ? (openLoads?.pins ?? []) : null, weather: showWeather && weather?.ok ? weather : null, route }),
    [tolls, pois, showLoads, openLoads, showWeather, weather, route]
  );
  // Escape lets go of the selected unit (its card, lane, trail and stops), as Close does.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSel(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const ex = data.exceptions;
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

  // Grouping is how the units are drawn, not a layer: only what adds marks to the map counts as on.
  const layersOn = [p.hooked, showLoads, tolls, pois, showWeather].filter(Boolean).length;
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
            <Canvas key={theme} points={data.points} sel={sel} onSelect={setSel} onStack={showStack} ring={ring} fitKey={fitKey} focus={focus} clustered={clustered} compact={false} overlays={overlays} onLive={setLive} />
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
                {card?.tractor ? <TractorCard u={card.tractor} now={now} route={route} /> : card?.trailer ? <TrailerCard u={card.trailer} now={now} route={route} /> : <p className="rd-sub">Loading the unit.</p>}
              </div>
            ) : null}
            {tab === "telemetry" ? (
              <>
                <div className="rd-xchips" role="group" aria-label="Show only">
                  {EXCEPTION_FILTERS.map((f) => (
                    <button key={f.key || "all"} type="button" className="rd-x-chip" aria-pressed={p.x === f.key} data-tone={(f.key === "late" || f.key === "idling") && (ex?.[f.key] ?? 0) > 0 ? "warn" : undefined} onClick={() => update({ x: f.key as ExceptionKey | "" })}>
                      {f.label}
                      <span>{(ex?.[(f.key || "all") as ExceptionKey | "all"] ?? 0).toLocaleString("en-US")}</span>
                    </button>
                  ))}
                </div>
                <dl className="rd-hud">
                  <dt>Tractors</dt>
                  <dd>{c.tractors}</dd>
                  <dt>Moving under load</dt>
                  <dd>{c.movingLoad}</dd>
                  {c.moving > 0 ? (
                    <>
                      <dt>Moving, no load</dt>
                      <dd>{c.moving}</dd>
                    </>
                  ) : null}
                  {c.idling > 0 ? (
                    <>
                      <dt>Idling</dt>
                      <dd>{c.idling}</dd>
                    </>
                  ) : null}
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
                <RadarAge asOf={data.asOf} now={now} reason={eldReason}>{actions}</RadarAge>
                <details className="rd-layers">
                  <summary>
                    Layers
                    {layersOn > 0 ? <em>{layersOn} on</em> : null}
                  </summary>
                  <div className="rd-layer-list">
                    <label className="rd-check">
                      <input type="checkbox" checked={clustered} onChange={(e) => setClustered(e.target.checked)} /> Group nearby units into clusters
                    </label>
                    <label className="rd-check">
                      <input type="checkbox" checked={p.hooked} onChange={(e) => update({ hooked: e.target.checked })} /> Show hooked trailers
                    </label>
                    <label className="rd-check">
                      <input type="checkbox" checked={showLoads} onChange={(e) => setShowLoads(e.target.checked)} /> Show open loads
                      {showLoads && openLoads ? <em>{`${openLoads.pins.length} need a driver${openLoads.unplaced > 0 ? `, ${openLoads.unplaced} with no map point` : ""}`}</em> : null}
                    </label>
                    <label className="rd-check">
                      <input type="checkbox" checked={tolls} disabled={live === false} onChange={(e) => setTolls(e.target.checked)} /> Show toll roads
                      {tolls ? <em>from zoom 9</em> : null}
                    </label>
                    <label className="rd-check">
                      <input type="checkbox" checked={pois} disabled={live === false} onChange={(e) => setPois(e.target.checked)} /> Show fuel &amp; rest areas
                      {pois ? <em>from zoom 14</em> : null}
                    </label>
                    {live === false ? <p className="rd-sub">Toll roads and fuel stops need the street map, which did not load; the outline map is showing.</p> : null}
                    <label className="rd-check">
                      <input type="checkbox" checked={showWeather} onChange={(e) => setShowWeather(e.target.checked)} /> Show weather alerts
                      {showWeather && weather ? <em>{weather.ok ? `${weather.features.length} severe${weather.skippedNoShape > 0 ? `, ${weather.skippedNoShape} by county only` : ""}` : "Weather alerts unavailable right now"}</em> : null}
                    </label>
                  </div>
                </details>
                <RadarKey loads={showLoads} tolls={tolls} weather={showWeather} />
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

/** The map above the Trucks and Trailers tables, folded away until it is asked for (the table is the page; the Radar map is the map): the clustered map and a radius search over a drag bar, the table beneath it (`children`, server-rendered) narrowed by the same search. */
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
        id="fleet-list-map"
        orientation="vertical"
        defaultHidden
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
