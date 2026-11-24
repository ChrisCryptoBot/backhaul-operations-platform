import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (p: string) => fs.readFileSync(path.join(__dirname, "..", p), "utf8").replace(/\r\n/g, "\n");

/**
 * The radar's standing rules, read from the source: the map layers OpenFreeMap streets and highways (`dark` / `positron`) over the desk's offline fallback (`US_STATES` + `INTERSTATES`) with
 * overlay colours read from tokens and no hex in a component; clusters show a hover breakdown and click to split or list; a typed dwell figure shows in the typed colour; the load drawer keeps
 * its first four tabs and the storage name while gaining a fifth; the radar rail has no coloured edge strip and no radius (docs/TERMINAL_MIGRATION.md).
 */
describe("the radar map uses OpenFreeMap with offline fallback and tokens", () => {
  const map = read("src/components/desk/radar-map.tsx");
  const family = [map, read("src/components/desk/radar-list.tsx"), read("src/components/desk/radius-search.tsx")];
  it("uses only keyless OpenFreeMap URLs, keeps offline basemap fallback, and holds no hex colour", () => {
    for (const src of family) {
      const urls = [...src.matchAll(/https?:\/\/[^\s"'`<>)]+/g)].map((m) => m[0]);
      for (const u of urls) expect(u).toMatch(/^https:\/\/(?:tiles\.)?openfreemap\.org\b/);
      expect(src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    }
    expect(map).toContain("https://tiles.openfreemap.org/styles/dark");
    expect(map).toContain("https://tiles.openfreemap.org/styles/positron");
    expect(map).toContain("offlineStyleOf");
    expect(map).toContain('map.on("mouseenter", "clusters"');
  });
  it("fetches fleet unit data only from the desk's own data route", () => {
    const urls = family.flatMap((src) => [...src.matchAll(/fetch\(\s*[`"]([^`"$?]+)/g)].map((m) => m[1]));
    expect(urls.length).toBeGreaterThan(0);
    expect([...new Set(urls)]).toEqual(["/fleet/map/data"]);
  });
  it("reads its colours from the live CSS tokens, so night and day both work", () => {
    for (const token of ["--bg", "--panel", "--line", "--line-hi", "--label", "--warn-fill", "--ink", "--dim", "--pos-fill"]) expect(map, token).toContain(token);
  });
  it("draws squares (fillRect/strokeRect) and no circles for its glyphs or its clusters", () => {
    expect(map).toMatch(/fillRect/);
    expect(map).not.toMatch(/\.arc\(|circle/);
  });
});

describe("the radar's dispatch tools: tolls, fuel stops, the unit's route, open freight, weather, exception chips", () => {
  const map = read("src/components/desk/radar-map.tsx");
  const route = read("src/app/(desk)/fleet/map/data/route.ts");
  const paint = read("src/lib/basemap/paint.ts");
  it("the data route answers the three new modes, and the weather lives in its own module (never in the whereabouts)", () => {
    for (const m of ['mode === "route"', 'mode === "open_loads"', 'mode === "weather"']) expect(route, m).toContain(m);
    expect(route).toContain("radarWeather()");
    for (const f of ["src/lib/whereabouts.ts", "src/server/tl/whereabouts.ts"]) expect(read(f), f).not.toMatch(/weather\.gov|radar-weather/);
    expect(read("src/server/tl/radar-weather.ts")).toContain("https://api.weather.gov/alerts/active?status=actual&message_type=alert");
  });
  it("toll roads are OpenStreetMap's toll = 1, said honestly (where, not what it costs)", () => {
    expect(paint).toContain('filter: ["==", ["get", "toll"], 1]');
    expect(map).toContain("Show toll roads");
    expect(map).toContain("Toll prices need a tolling or routing partner.");
    // Placed after the last road line, never "before the first label": dark's first label (water_name) comes before every road, which then painted over the tolls.
    expect(map).toMatch(/\["source-layer"\] === "transportation"\)\.lastIndexOf\(true\)/);
    expect(map).not.toMatch(/\$\s*\d+[^"]*toll|toll[^"]*\$\s*\d/i);
  });
  it("fuel and rest areas have their own switch and name OpenFreeMap's font", () => {
    expect(map).toContain("Show fuel &amp; rest areas");
    expect(paint).toContain('export const OFM_FONT = ["Noto Sans Regular"]');
    expect(paint).toContain('"text-font": OFM_FONT');
  });
  it("every show or hide is guarded by map.getLayer, so the offline outline map never throws", () => {
    const calls = [...map.matchAll(/setLayoutProperty\(/g)].length;
    expect(calls).toBe(1);
    expect(map).toMatch(/if \(map\.getLayer\(id\)\) map\.setLayoutProperty\(id, "visibility"/);
  });
  it("the route and the open freight are placed through mapLng, as the units are", () => {
    expect(map).toMatch(/const at = \(p: \{ lat: number; lng: number \}\): \[number, number\] => \[mapLng\(p\.lat, p\.lng\), p\.lat\]/);
    expect(map).toMatch(/coordinates: \[mapLng\(l\.lat, l\.lng\), l\.lat\]/);
  });
  it("Escape lets go of the selected unit, and its lane is said to be stop to stop, not the road", () => {
    expect(map).toMatch(/e\.key === "Escape"\) setSel\(null\)/);
    expect(map).toContain("the dashed line is the lane stop to stop (not the road route)");
  });
  it("the quick exception chips are the one place for idling and dwell (Search's Status has neither)", () => {
    expect(map).toContain("EXCEPTION_FILTERS.map");
    const pts = read("src/lib/radar-points.ts");
    const status = pts.slice(pts.indexOf("export const STATE_FILTERS"), pts.indexOf("];", pts.indexOf("export const STATE_FILTERS")));
    expect(status).not.toMatch(/"idling"|"dwell"/);
    expect(read("src/components/desk/radius-search.tsx")).toMatch(/tl-field">\s*Status\s*</);
  });
  it("open loads use the header's needs-a-driver rule and scope", () => {
    const ol = read("src/server/tl/radar-open-loads.ts");
    expect(ol).toContain("AND: [inTerminal(terminal)]");
    expect(ol).toContain('status: "draft", OR: [{ assignment: null }, { assignment: { status: { in: ["draft", "declined"] } } }]');
  });
});

describe("the radar clusters thousands of units and hands stacks over as a list", () => {
  const map = read("src/components/desk/radar-map.tsx");
  it("clusters in one source, splits a cluster on click, and opens units stacked on one spot as a list", () => {
    expect(map).toContain("cluster: true");
    expect(map).toContain("clusterProperties");
    expect(map).toContain("getClusterExpansionZoom");
    expect(map).toContain("getClusterLeaves");
    expect(map).toContain("setMissingStyleImageResolver"); // a cluster's square is drawn when the map first asks for its size
    expect(map).toContain("setClusterOptions"); // clusters can be switched off
    expect(map).toMatch(/maxZoom: MAP_MAX_ZOOM/);
  });
  it("holds the camera inside a region (a hard stop) and has Lower 48, Alaska and Hawaii buttons", () => {
    expect(map).toContain("maxBounds");
    expect(map).toContain("setMaxBounds");
    expect(map).toContain("REGION_KEYS");
    expect(map).toContain('className="rd-regions"');
    expect(map).toContain("mapLng("); // the western Aleutians are drawn west of -180
  });
  it("the Trucks and Trailers pages carry the map above the table on a split, narrowed by the same search", () => {
    for (const page of ["src/app/(desk)/fleet/page.tsx", "src/app/(desk)/trailers/page.tsx"]) {
      const src = read(page);
      expect(src, page).toContain("<FleetMapPanel");
      expect(src, page).toContain("unitsNear(");
      expect(src, page).toContain("onlyIds");
    }
    expect(map).toContain('orientation="vertical"');
    expect(map).toContain('orientation="horizontal"');
  });
});

describe("the radar and dwell styles keep to the design rules", () => {
  const css = read("src/app/terminal.css");
  // The Cockpit's radar rules: from the radar section to where the TrueLane app style's layer begins (that style curves on purpose; its own rules are pinned in
  // tests/no-legacy-css.test.ts).
  const from = css.indexOf("/* Radar map");
  const appLayer = css.indexOf("@layer app {", from);
  const rules = css.slice(from, appLayer > from ? appLayer : undefined);
  it("has no radius, no shadow, no gradient, and no coloured edge strip", () => {
    expect(rules).not.toMatch(/border-radius\s*:\s*[1-9]/);
    expect(rules).not.toMatch(/box-shadow\s*:\s*(?!none)/);
    expect(rules).not.toMatch(/gradient\(/);
    // A hairline rule in a neutral token is the panel's edge; a coloured strip down one side is not allowed.
    for (const m of rules.matchAll(/border-(?:left|right)\s*:\s*[^;}]*/g)) expect(m[0], m[0]).toMatch(/1px solid var\(--line(?:-hi)?\)/);
  });
  it("shows a person's typed figure in the typed colour", () => {
    expect(css).toMatch(/\.rd-typed\{color:var\(--typed\)/);
    const dwell = read("src/components/desk/dwell.tsx");
    expect(dwell).toContain("rd-typed");
    expect(dwell).toMatch(/d\.source\.rate === "typed" \|\| d\.source\.days === "typed" \|\| d\.waived/);
  });
});

describe("a dwell figure is a person's call", () => {
  it("the dialog offers the rate, the billable days, a waiver and a way back to the company's figure", () => {
    const dwell = read("src/components/desk/dwell.tsx");
    for (const word of ["Rate a day", "Billable days", "Waive the fee", "Back to the company figure", "adjustTrailerDwellAction", "waiveTrailerDwellAction", "clearTrailerDwellAction"]) expect(dwell, word).toContain(word);
  });
  it("the server asks for dispatching or billing, and never for the admin's work alone", () => {
    const actions = read("src/app/(desk)/actions.ts");
    for (const name of ["adjustTrailerDwellAction", "waiveTrailerDwellAction", "clearTrailerDwellAction"]) {
      const at = actions.indexOf(`export async function ${name}(`);
      expect(actions.slice(at, at + 200), name).toContain('requireCan("dispatch", "bill")');
    }
  });
  it("the company's terms are in Rules, with the industry norms as the defaults", () => {
    const t = read("src/lib/thresholds.ts");
    expect(t).toMatch(/dwellFreeHours: 48/);
    expect(t).toMatch(/dwellPerDayRate: 75/);
  });
});

describe("the load drawer gains Where it is and keeps what it had", () => {
  const cockpit = read("src/components/desk/load-cockpit.tsx");
  it("has four tabs on keys 1 to 4, remembers the last, and shows where the truck is under Trip", () => {
    expect(cockpit).toContain("tl_drawer_tab");
    for (const [key, label, kbd] of [["trip", "Trip", "1"], ["money", "Money", "2"], ["paper", "Paperwork", "3"], ["more", "More", "4"]]) expect(cockpit).toContain(`{ key: "${key}", label: "${label}", kbd: "${kbd}" }`);
    const view = read("src/components/desk/load-view.tsx");
    expect(view.slice(view.indexOf("const drawerTrip"), view.indexOf("const drawerMoney"))).toContain("<LoadTracker t={tracking}");
  });
  it("the tracking panel only shows: it writes no arrival", () => {
    const tracker = read("src/components/desk/load-tracker.tsx") + read("src/server/tl/load-tracking.ts");
    expect(tracker).not.toMatch(/arrivedAt\s*:/);
    expect(tracker).not.toMatch(/\.(update|updateMany|create|upsert)\(/);
  });
});

describe("the rail", () => {
  const shell = read("src/lib/nav.ts");
  it("lists the Radar map in the Fleet group for anyone who can read, and /fleet/map is not also Trucks", () => {
    expect(shell).toMatch(/href: "\/fleet\/map", label: "Radar map", code: "MP"/);
    expect(shell).toContain("function activeItem");
  });
});

describe("the map's worker is served by the desk and is the installed version's", () => {
  it("public/maplibre-gl-worker.mjs is byte for byte the installed maplibre-gl worker, and the map points at it", () => {
    const served = fs.readFileSync(path.join(__dirname, "../public/maplibre-gl-worker.mjs"));
    const installed = fs.readFileSync(path.join(__dirname, "../../../node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs"));
    expect(served.equals(installed), "after upgrading maplibre-gl, copy dist/maplibre-gl-worker.mjs to apps/web/public/").toBe(true);
    expect(read("src/components/desk/radar-map.tsx")).toContain('setWorkerUrl("/maplibre-gl-worker.mjs")');
  });
});
