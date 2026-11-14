import type { LayerSpecification } from "maplibre-gl";

/** The theme's colours the basemap is painted with, read from the live CSS tokens by the radar (src/components/desk/radar-map.tsx `readTokens`). */
export type BasemapTones = Record<"bg" | "line" | "ink" | "mid" | "water" | "mapLand" | "roadLo" | "roadMid" | "roadHi" | "casing" | "border", string> & Partial<Record<"typed" | "dim", string>>;

/** A value that steps with the zoom, as MapLibre wants it. */
const byZoom = (...stops: Array<[number, number]>): unknown => ["interpolate", ["linear"], ["zoom"], ...stops.flat()];

/**
 * OpenFreeMap's `dark` and `positron` are drawn for a quiet backdrop: on a laptop screen (or a screen share) their roads, water and labels all but vanish. Every layer is repainted here from
 * the theme's tokens, by what the layer is (its id, which differs between the two styles): land is the ground, water a distinct slate, roads in three steps (motorway, major, minor at street
 * zoom) that stay under the unit marks, state and country lines plain, and every name in the desk's ink with a halo of the ground so it reads over roads and water. Unknown layers keep
 * OpenFreeMap's paint.
 */
export function basemapPaint(layer: LayerSpecification, t: BasemapTones): LayerSpecification {
  const id = layer.id;
  const paint = (p: Record<string, unknown>) => ({ ...layer, paint: { ...((layer as { paint?: Record<string, unknown> }).paint ?? {}), ...p } }) as LayerSpecification;
  if (layer.type === "background") return paint({ "background-color": t.bg });
  if (layer.type === "fill") {
    if (id === "water") return paint({ "fill-color": t.water, "fill-opacity": 1 });
    if (id === "building") return paint({ "fill-color": t.mapLand, "fill-outline-color": t.line, "fill-opacity": byZoom([12.5, 0], [13, 0.55], [15, 0.85]) });
    if (id === "road_area_pier") return paint({ "fill-color": t.bg });
    if (/^(landcover|landuse|park|aeroway)/.test(id)) return paint({ "fill-color": t.mapLand });
    return layer;
  }
  if (layer.type === "line") {
    if (id === "waterway") return paint({ "line-color": t.water });
    if (/casing/.test(id)) return paint({ "line-color": t.casing, "line-opacity": 1 });
    if (/motorway/.test(id)) return paint({ "line-color": t.roadHi, "line-opacity": 1 });
    if (/major/.test(id)) return paint({ "line-color": t.roadMid, "line-opacity": 1 });
    if (id === "highway_minor") return paint({ "line-color": t.roadLo, "line-opacity": byZoom([8, 0.35], [11, 0.75], [12, 1]) });
    if (id === "highway_path") return paint({ "line-color": t.roadLo, "line-opacity": byZoom([13, 0], [14, 0.8]) });
    if (/^aeroway/.test(id)) return paint({ "line-color": t.roadLo });
    if (id === "road_pier" || /dashline/.test(id)) return paint({ "line-color": t.bg });
    if (/^railway/.test(id)) return paint({ "line-color": t.roadLo, "line-opacity": 0.8 });
    if (/^boundary_(state|3)$/.test(id)) {
      // State lines from the national view down. Positron's boundary_3 starts at zoom 8 (none at all at the zoom a dispatcher works at) and also draws counties; dark's is a faint 2/2 dash.
      // Both become state lines only (admin level 4, not at sea), from zoom 2, heavier, in a long dash that reads as a line and still differs from a road.
      const { minzoom: _from, ...rest } = layer as LayerSpecification & { minzoom?: number };
      return {
        ...rest,
        filter: ["all", ["==", ["get", "admin_level"], 4], ["!=", ["get", "maritime"], 1]],
        paint: { ...((layer as { paint?: Record<string, unknown> }).paint ?? {}), "line-color": t.border, "line-opacity": 1, "line-blur": 0, "line-dasharray": [5, 2], "line-width": byZoom([2, 0.9], [5, 1.3], [8, 1.7], [12, 2.2]) }
      } as LayerSpecification;
    }
    if (/^boundary/.test(id)) return paint({ "line-color": t.border, "line-opacity": 1, "line-blur": 0, "line-width": byZoom([2, 1.2], [5, 1.6], [10, 2.4]) });
    return layer;
  }
  if (layer.type === "symbol") {
    const layout = (layer as { layout?: Record<string, unknown> }).layout ?? {};
    if (!("text-field" in layout) || /shield/.test(id)) return layer;
    const halo = { "text-halo-color": t.bg, "text-halo-width": 1.6, "text-halo-blur": 0 };
    // A town's round dot goes: the desk draws squares, never circles, and OpenFreeMap's dark style asks for a `circle-11` its own sprite does not have (a console warning on every load).
    const named = (p: Record<string, unknown>): LayerSpecification => {
      const out = paint(p) as LayerSpecification & { layout?: Record<string, unknown> };
      if (/^(place_|label_)/.test(id) && "icon-image" in layout) {
        const rest = { ...layout };
        delete rest["icon-image"];
        out.layout = rest;
      }
      return out;
    };
    if (/^(place_city|place_country|label_city|label_country)/.test(id)) return named({ "text-color": t.ink, ...halo });
    return named({ "text-color": t.mid, ...halo });
  }
  return layer;
}

/** OpenFreeMap's vector source in both its styles. */
export const OFM_SOURCE = "openmaptiles";
/** The one font OpenFreeMap serves in every style: naming it keeps MapLibre from asking for its default (Open Sans Regular), which is not served (a 404). */
export const OFM_FONT = ["Noto Sans Regular"];
/** The first zoom at which OpenFreeMap's tiles say which roads are tolled (checked against the tiles, 2026-11-13). */
export const TOLL_MIN_ZOOM = 9;

/** A fuel station, matched on class or subclass; an EV charger (class fuel, subclass charging_station) is not truck fuel. */
const isFuel: unknown = ["all", ["any", ["==", ["get", "class"], "fuel"], ["==", ["get", "subclass"], "fuel"]], ["!=", ["get", "subclass"], "charging_station"]];
/** OpenFreeMap's poi layer is all but empty below zoom 14 (checked against the tiles, 2026-11-13): fuel stations appear at 14. */
export const POI_MIN_ZOOM = 14;

/**
 * The radar's own layers over OpenFreeMap's, both hidden until a dispatcher switches them on:
 *   tolls      roads OpenStreetMap marks as toll roads (`toll` = 1 in the tiles), in the typed blue, from zoom 9 (OpenFreeMap's tiles carry `toll` from zoom 9 only). Where a toll is, not
 *              what it costs: a price needs a tolling or routing partner.
 *   truck-poi  fuel stations and rest areas from zoom 14 (where the tiles have them), a small square each (no circles on the desk), named; EV chargers left out.
 * Live tiles only: the offline fallback has neither, and the map checks a layer exists before it shows or hides it.
 */
export function radarBasemapLayers(t: BasemapTones): { tolls: LayerSpecification; pois: LayerSpecification } {
  const tolls = {
    id: "tolls",
    type: "line",
    source: OFM_SOURCE,
    "source-layer": "transportation",
    minzoom: TOLL_MIN_ZOOM,
    filter: ["==", ["get", "toll"], 1],
    layout: { visibility: "none", "line-cap": "round", "line-join": "round" },
    paint: { "line-color": t.typed ?? t.ink, "line-opacity": 0.85, "line-width": byZoom([5, 1.4], [9, 2.4], [13, 4], [16, 7]) }
  } as unknown as LayerSpecification;
  const pois = {
    id: "truck-poi",
    type: "symbol",
    source: OFM_SOURCE,
    "source-layer": "poi",
    minzoom: POI_MIN_ZOOM,
    filter: ["any", isFuel, ["in", ["get", "subclass"], ["literal", ["rest_area", "services"]]]],
    layout: {
      visibility: "none",
      "icon-image": ["case", isFuel, "poi-fuel", "poi-rest"],
      "icon-allow-overlap": false,
      "text-field": ["coalesce", ["get", "name:en"], ["get", "name"], ""],
      "text-font": OFM_FONT,
      "text-size": 10,
      "text-anchor": "top",
      "text-offset": [0, 0.9],
      "text-optional": true
    },
    paint: { "text-color": t.mid, "text-halo-color": t.bg, "text-halo-width": 1.6, "text-halo-blur": 0 }
  } as unknown as LayerSpecification;
  return { tolls, pois };
}
