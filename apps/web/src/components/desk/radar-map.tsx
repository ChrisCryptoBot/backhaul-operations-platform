"use client";

import "maplibre-gl/dist/maplibre-gl.css";
import Link from "next/link";
import React from "react";
import type { Map as MapLibreMap, GeoJSONSource, StyleSpecification } from "maplibre-gl";
import { INTERSTATES } from "@/lib/basemap/interstates";
import { US_STATES } from "@/lib/basemap/us-states";
import type { RadarData, RadarTractor, RadarTrailer } from "@/server/tl/radar";

/**
 * The radar: every tractor and trailer that has a position, on a map the desk draws itself. The basemap is bundled (lower-48 outlines and the twelve freight corridors, src/lib/basemap), so it
 * needs no tile server and no key and works offline. Colours are read from the desk's own tokens, so night and day both work and no hex lives here. Tractors are square glyphs with a heading
 * arrow: gold moving under a load, amber standing with the engine on, ink moving with no load, dim parked. Trailers are squares, hooked or dropped, a green dot when loaded.
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

const ring = (color: string): Draw => (g) => {
  g.strokeStyle = color;
  g.lineWidth = 2;
  g.strokeRect(3, 3, 26, 26);
};

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
  put("sel", ring(t.labelHi));
}

const tractorIcon = (u: RadarTractor) => (u.state === "moving_load" ? "t-load" : u.state === "moving" ? "t-moving" : u.state === "idling" ? "t-idle" : u.state === "parked" ? "t-parked" : "t-none");
const trailerIcon = (u: RadarTrailer) => `tr-${u.dwell?.alert ? "a" : u.hooked ? "h" : "d"}-${u.loaded ? "l" : "e"}`;

type Point = { type: "Feature"; geometry: { type: "Point"; coordinates: [number, number] }; properties: Record<string, string | number> };
const KIND = { tractor: "tractor", trailer: "trailer" } as const;
const point = (lng: number, lat: number, properties: Point["properties"]): Point => ({ type: "Feature", geometry: { type: "Point", coordinates: [lng, lat] }, properties });
const collection = (features: Point[]) => ({ type: "FeatureCollection" as const, features });

function features(data: RadarData, showHooked: boolean, sel: Sel) {
  return {
    tractors: collection(data.tractors.map((u) => point(u.lng, u.lat, { id: u.id, kind: KIND.tractor, icon: tractorIcon(u), heading: u.state === "moving_load" || u.state === "moving" ? (u.headingDeg ?? 0) : 0 }))),
    // Dropped trailers are units of their own; a hooked one (when asked for) is drawn at its tractor, and clicking it opens the tractor.
    trailers: collection([
      ...data.trailers.map((u) => point(u.lng, u.lat, { id: u.id, kind: KIND.trailer, icon: trailerIcon(u), heading: 0 })),
      ...(showHooked ? data.tractors.filter((u) => u.trailer).map((u) => point(u.lng, u.lat, { id: u.id, kind: KIND.tractor, icon: `tr-h-${u.trailer!.loaded ? "l" : "e"}`, heading: 0 })) : [])
    ]),
    selected: collection(
      sel
        ? [sel.kind === "tractor" ? data.tractors.find((u) => u.id === sel.id) : data.trailers.find((u) => u.id === sel.id)].flatMap((u) => (u ? [point(u.lng, u.lat, { icon: "sel", heading: 0 })] : []))
        : []
    )
  };
}

function styleOf(t: Tokens): StyleSpecification {
  return {
    version: 8,
    sources: {
      states: { type: "geojson", data: { type: "FeatureCollection", features: US_STATES.map((s) => ({ type: "Feature", properties: { name: s.name }, geometry: { type: "MultiPolygon", coordinates: s.rings.map((r) => [r.map((p) => [p[0], p[1]])]) } })) } as never },
      roads: { type: "geojson", data: { type: "FeatureCollection", features: INTERSTATES.map((c) => ({ type: "Feature", properties: { name: c.name }, geometry: { type: "LineString", coordinates: c.coords.map((p) => [p[0], p[1]]) } })) } as never },
      tractors: { type: "geojson", data: collection([]) as never },
      trailers: { type: "geojson", data: collection([]) as never },
      selected: { type: "geojson", data: collection([]) as never }
    },
    layers: [
      { id: "bg", type: "background", paint: { "background-color": t.bg } },
      { id: "land", type: "fill", source: "states", paint: { "fill-color": t.land } },
      { id: "borders", type: "line", source: "states", paint: { "line-color": t.line, "line-width": 1 } },
      { id: "roads", type: "line", source: "roads", paint: { "line-color": t.road, "line-width": 1, "line-opacity": 0.6 } },
      { id: "trailers", type: "symbol", source: "trailers", layout: { "icon-image": ["get", "icon"], "icon-allow-overlap": true, "icon-ignore-placement": true } },
      { id: "tractors", type: "symbol", source: "tractors", layout: { "icon-image": ["get", "icon"], "icon-rotate": ["get", "heading"], "icon-rotation-alignment": "map", "icon-allow-overlap": true, "icon-ignore-placement": true } },
      { id: "selected", type: "symbol", source: "selected", layout: { "icon-image": "sel", "icon-allow-overlap": true, "icon-ignore-placement": true } }
    ]
  };
}

const US_BOUNDS: [[number, number], [number, number]] = [
  [-125, 24],
  [-66.5, 49.8]
];

/** The map itself. Draws what it is given and tells the parent which unit was clicked. */
function Canvas({ data, showHooked, sel, onSelect, compact }: { data: RadarData; showHooked: boolean; sel: Sel; onSelect: (s: Sel) => void; compact: boolean }) {
  const box = React.useRef<HTMLDivElement>(null);
  const mapRef = React.useRef<MapLibreMap | null>(null);
  const ready = React.useRef(false);
  const fitted = React.useRef(false);
  const latest = React.useRef({ data, showHooked, sel });
  latest.current = { data, showHooked, sel };
  const pick = React.useRef(onSelect);
  pick.current = onSelect;

  const push = React.useCallback(() => {
    const map = mapRef.current;
    if (!map || !ready.current) return;
    const f = features(latest.current.data, latest.current.showHooked, latest.current.sel);
    (map.getSource("tractors") as GeoJSONSource).setData(f.tractors as never);
    (map.getSource("trailers") as GeoJSONSource).setData(f.trailers as never);
    (map.getSource("selected") as GeoJSONSource).setData(f.selected as never);
    if (!fitted.current && (latest.current.data.tractors.length > 0 || latest.current.data.trailers.length > 0)) {
      fitted.current = true;
      const all = [...latest.current.data.tractors, ...latest.current.data.trailers];
      const lngs = all.map((u) => u.lng);
      const lats = all.map((u) => u.lat);
      const pad = 1.5;
      map.fitBounds(
        [
          [Math.min(...lngs) - pad, Math.min(...lats) - pad],
          [Math.max(...lngs) + pad, Math.max(...lats) + pad]
        ],
        { padding: compact ? 16 : 48, maxZoom: 6.5, duration: 0 }
      );
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
      map = new ml.Map({ container: box.current, style: styleOf(tokens), bounds: US_BOUNDS, fitBoundsOptions: { padding: compact ? 8 : 24 }, interactive: !compact, attributionControl: false, dragRotate: false, pitchWithRotate: false, renderWorldCopies: false, maxZoom: 9, minZoom: 2 });
      mapRef.current = map;
      // The container is laid out after the map is made (the rail, the page head): follow its size, or the map paints only part of it.
      watch = new ResizeObserver(() => map?.resize());
      watch.observe(box.current);
      if (!compact) map.addControl(new ml.NavigationControl({ showCompass: false }), "top-left");
      map.on("load", () => {
        addImages(map!, tokens);
        ready.current = true;
        push();
      });
      if (!compact) {
        for (const layer of ["tractors", "trailers"] as const) {
          map.on("click", layer, (e) => {
            const p = e.features?.[0]?.properties as { id?: string; kind?: string } | undefined;
            if (p?.id) pick.current({ kind: p.kind === "trailer" ? "trailer" : "tractor", id: p.id });
          });
          map.on("mouseenter", layer, () => (map!.getCanvas().style.cursor = "pointer"));
          map.on("mouseleave", layer, () => (map!.getCanvas().style.cursor = ""));
        }
        map.on("click", (e) => {
          if (map!.queryRenderedFeatures(e.point, { layers: ["tractors", "trailers"] }).length === 0) pick.current(null);
        });
      }
    });
    return () => {
      dead = true;
      watch?.disconnect();
      ready.current = false;
      fitted.current = false;
      map?.remove();
      mapRef.current = null;
    };
  }, [compact, push]);

  React.useEffect(push, [push, data, showHooked, sel]);
  return <div ref={box} className="rd-canvas" role="img" aria-label={`Map of ${data.tractors.length} tractors and ${data.trailers.length} trailers`} />;
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

function usePolled(initial: RadarData, every = 30_000) {
  const [data, setData] = React.useState(initial);
  const [now, setNow] = React.useState(() => Date.parse(initial.asOf ?? "") || 0);
  React.useEffect(() => setData(initial), [initial]);
  React.useEffect(() => {
    setNow(Date.now());
    const tick = setInterval(async () => {
      setNow(Date.now());
      if (document.hidden) return;
      try {
        const r = await fetch("/fleet/map/data", { cache: "no-store" });
        if (r.ok) setData((await r.json()) as RadarData);
      } catch {
        /* the next tick tries again */
      }
    }, every);
    return () => clearInterval(tick);
  }, [every]);
  return { data, now };
}

/** The full radar: the map, the telemetry rail on the right, and the inspector for whatever is clicked. `actions` is the server-rendered Read ELD button. */
export function RadarView({ initial, actions }: { initial: RadarData; actions?: React.ReactNode }) {
  const theme = useTheme();
  const { data, now } = usePolled(initial);
  const [sel, setSel] = React.useState<Sel>(null);
  const [showHooked, setShowHooked] = React.useState(false);
  const c = data.counts;
  const unit = sel ? (sel.kind === "tractor" ? data.tractors.find((u) => u.id === sel.id) : data.trailers.find((u) => u.id === sel.id)) : null;
  return (
    <div className="rd">
      <div className="rd-map">
        <Canvas key={theme} data={data} showHooked={showHooked} sel={sel} onSelect={setSel} compact={false} />
        {!data.connected && data.tractors.length === 0 ? (
          <p className="rd-empty">
            No ELD is connected, so there is nothing to place. <Link href="/settings?tab=integrations">Connect one in Settings</Link>.
          </p>
        ) : null}
      </div>
      <aside className="rd-rail" aria-label="Fleet telemetry">
        <h2 className="rd-h">Telemetry</h2>
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
          <input type="checkbox" checked={showHooked} onChange={(e) => setShowHooked(e.target.checked)} /> Show hooked trailers
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
        </ul>
        {unit ? ("loaded" in unit ? <TrailerCard u={unit} now={now} /> : <TractorCard u={unit} now={now} />) : <p className="rd-sub">Click a unit on the map.</p>}
      </aside>
    </div>
  );
}

/** A small, still map for the top of the Trucks and Trailers lists, linking to the full radar. */
export function RadarStrip({ initial }: { initial: RadarData }) {
  const theme = useTheme();
  const c = initial.counts;
  return (
    <section className="rd-strip" aria-label="Fleet radar">
      <div className="rd-strip-map">
        <Canvas key={theme} data={initial} showHooked={false} sel={null} onSelect={() => undefined} compact />
        <Link href="/fleet/map" className="rd-strip-link" aria-label="Open the radar map" />
      </div>
      <p className="rd-strip-line">
        <b>{c.tractors}</b> units · <b>{c.movingLoad}</b> moving under load · <b className={c.idling > 0 ? "rd-warn" : undefined}>{c.idling}</b> idling · <b>{c.parked}</b> parked · <b>{c.droppedTrailers}</b> dropped trailers ·{" "}
        <Link href="/fleet/map">Open the radar</Link>
      </p>
    </section>
  );
}
