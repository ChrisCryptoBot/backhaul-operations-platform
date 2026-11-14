import { describe, expect, it } from "vitest";
import type { LayerSpecification } from "maplibre-gl";
import { basemapPaint, radarBasemapLayers, type BasemapTones } from "@/lib/basemap/paint";

/**
 * The radar repaints OpenFreeMap's `dark` and `positron` from the theme's tokens (src/lib/basemap/paint.ts). The layer ids below are the two styles' own (they differ: `place_city` in dark,
 * `label_city` in positron); each must come out in the desk's colour, so no OpenFreeMap grey survives on a road, water, a border or a name.
 */
const t: BasemapTones = { bg: "BG", line: "LINE", ink: "INK", mid: "MID", water: "WATER", mapLand: "LAND", roadLo: "LO", roadMid: "MAJOR", roadHi: "MOTORWAY", casing: "CASING", border: "BORDER" };
const text = { "text-field": "{name}" };
const layer = (id: string, type: string, extra: Record<string, unknown> = {}) => ({ id, type, source: "openmaptiles", paint: { "x-kept": 1 }, ...extra }) as unknown as LayerSpecification;
const paintOf = (l: LayerSpecification) => (basemapPaint(l, t) as unknown as { paint: Record<string, unknown> }).paint;

describe("the basemap is painted from the theme", () => {
  it("land, water and the ground", () => {
    expect(paintOf(layer("background", "background"))["background-color"]).toBe("BG");
    expect(paintOf(layer("water", "fill"))["fill-color"]).toBe("WATER");
    expect(paintOf(layer("waterway", "line"))["line-color"]).toBe("WATER");
    for (const id of ["landuse_residential", "landcover_wood", "park", "aeroway-area"]) expect(paintOf(layer(id, "fill"))["fill-color"], id).toBe("LAND");
    const building = paintOf(layer("building", "fill"));
    expect(building["fill-color"]).toBe("LAND");
    expect(building["fill-opacity"]).toEqual(["interpolate", ["linear"], ["zoom"], 12.5, 0, 13, 0.55, 15, 0.85]);
  });

  it("roads in three steps, with the casing in its own tone, in both styles", () => {
    for (const id of ["highway_motorway_inner", "highway_motorway_subtle", "highway_motorway_bridge_inner", "tunnel_motorway_inner"]) expect(paintOf(layer(id, "line"))["line-color"], id).toBe("MOTORWAY");
    for (const id of ["highway_major_inner", "highway_major_subtle"]) expect(paintOf(layer(id, "line"))["line-color"], id).toBe("MAJOR");
    for (const id of ["highway_motorway_casing", "highway_major_casing", "tunnel_motorway_casing", "aeroway-runway-casing"]) expect(paintOf(layer(id, "line"))["line-color"], id).toBe("CASING");
    const minor = paintOf(layer("highway_minor", "line"));
    expect(minor["line-color"]).toBe("LO");
    expect(minor["line-opacity"]).toEqual(["interpolate", ["linear"], ["zoom"], 8, 0.35, 11, 0.75, 12, 1]);
    expect(paintOf(layer("aeroway-runway", "line"))["line-color"]).toBe("LO");
  });

  it("state lines show from the national view in both styles: positron's boundary_3 loses its zoom-8 start and its counties", () => {
    for (const id of ["boundary_state", "boundary_3"]) {
      const out = basemapPaint(layer(id, "line", { minzoom: 8, filter: ["all", [">=", ["get", "admin_level"], 3]] }), t) as unknown as { minzoom?: number; filter: unknown; paint: Record<string, unknown> };
      expect(out.minzoom, id).toBeUndefined();
      expect(out.filter, id).toEqual(["all", ["==", ["get", "admin_level"], 4], ["!=", ["get", "maritime"], 1]]);
      expect(out.paint["line-color"], id).toBe("BORDER");
      expect(out.paint["line-dasharray"], id).toEqual([5, 2]);
      expect(out.paint["line-width"], id).toEqual(["interpolate", ["linear"], ["zoom"], 2, 0.9, 5, 1.3, 8, 1.7, 12, 2.2]);
    }
  });

  it("state and country lines, with no blur", () => {
    for (const id of ["boundary_state", "boundary_country_z5-", "boundary_2", "boundary_3"]) {
      const p = paintOf(layer(id, "line"));
      expect(p["line-color"], id).toBe("BORDER");
      expect(p["line-blur"], id).toBe(0);
    }
  });

  it("names: cities and countries in ink, the rest in mid, every one with a halo of the ground at least 1.5 wide", () => {
    for (const id of ["place_city", "place_city_large", "label_city", "label_city_capital", "place_country_major", "label_country_1"]) expect(paintOf(layer(id, "symbol", { layout: text }))["text-color"], id).toBe("INK");
    for (const id of ["place_state", "label_state", "place_town", "label_town", "place_suburb", "highway_name_motorway", "highway_name_other", "highway-name-major", "water_name", "airport"]) {
      const p = paintOf(layer(id, "symbol", { layout: text }));
      expect(p["text-color"], id).toBe("MID");
      expect(p["text-halo-color"], id).toBe("BG");
      expect(p["text-halo-width"] as number, id).toBeGreaterThanOrEqual(1.5);
    }
  });

  it("drops the round town dots (no circles on the desk; dark's circle-11 is missing from its sprite) and keeps the name", () => {
    for (const icon of [["step", ["zoom"], "circle-11", 9, ""], ["step", ["zoom"], "circle_11_black", 10, ""]]) {
      const out = basemapPaint(layer("place_city", "symbol", { layout: { ...text, "icon-image": icon, "text-anchor": "top" } }), t) as unknown as { layout: Record<string, unknown> };
      expect(out.layout["icon-image"]).toBeUndefined();
      expect(out.layout["text-field"]).toBe("{name}");
      expect(out.layout["text-anchor"]).toBe("top");
    }
    const airport = basemapPaint(layer("airport", "symbol", { layout: { ...text, "icon-image": "airport_11" } }), t) as unknown as { layout: Record<string, unknown> };
    expect(airport.layout["icon-image"]).toBe("airport_11");
  });

  it("the radar's own layers: toll roads (toll = 1) in the typed blue and fuel / rest areas as squares, both hidden until switched on", () => {
    const { tolls, pois } = radarBasemapLayers({ ...t, typed: "TYPED", dim: "DIM" });
    const tl = tolls as unknown as { source: string; "source-layer": string; filter: unknown; layout: Record<string, unknown>; paint: Record<string, unknown> };
    expect(tl.source).toBe("openmaptiles");
    expect(tl["source-layer"]).toBe("transportation");
    expect(tl.filter).toEqual(["==", ["get", "toll"], 1]);
    expect((tolls as unknown as { minzoom: number }).minzoom).toBe(9);
    expect(tl.paint["line-color"]).toBe("TYPED");
    expect(tl.layout.visibility).toBe("none");
    const po = pois as unknown as { "source-layer": string; minzoom: number; filter: unknown; layout: Record<string, unknown> };
    expect(po["source-layer"]).toBe("poi");
    expect(po.minzoom).toBe(14);
    expect(po.layout.visibility).toBe("none");
    expect(po.layout["text-font"]).toEqual(["Noto Sans Regular"]);
    const fuel = ["all", ["any", ["==", ["get", "class"], "fuel"], ["==", ["get", "subclass"], "fuel"]], ["!=", ["get", "subclass"], "charging_station"]];
    expect(po.filter).toEqual(["any", fuel, ["in", ["get", "subclass"], ["literal", ["rest_area", "services"]]]]);
    expect(po.layout["icon-image"]).toEqual(["case", fuel, "poi-fuel", "poi-rest"]);
  });

  it("keeps the rest of a layer's paint, and leaves alone what it does not know (shields, one-way arrows, new layers)", () => {
    expect(paintOf(layer("water", "fill"))["x-kept"]).toBe(1);
    for (const l of [layer("highway-shield-us-interstate", "symbol", { layout: text }), layer("road_oneway", "symbol", { layout: { "icon-image": "oneway" } }), layer("something_new", "line")]) expect(basemapPaint(l, t)).toBe(l);
  });
});
