import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (p: string) => fs.readFileSync(path.join(__dirname, "..", p), "utf8").replace(/\r\n/g, "\n");

/**
 * The radar's standing rules, read from the source: the map is drawn from the desk's own tokens with no network and no hex in a component; a typed dwell figure shows in the typed colour; the
 * load drawer keeps its first four tabs and the storage name while gaining a fifth; the radar rail has no coloured edge strip and no radius (docs/TERMINAL_MIGRATION.md).
 */
describe("the radar map is offline and drawn from tokens", () => {
  const map = read("src/components/desk/radar-map.tsx");
  // The map, its list, its search and the panel over the tables are one family: none of them may reach outside the desk.
  const family = [map, read("src/components/desk/radar-list.tsx"), read("src/components/desk/radius-search.tsx")];
  it("has no tile server, glyph or sprite endpoint, no external address, and no hex colour", () => {
    for (const src of family) {
      expect(src).not.toMatch(/https?:\/\//);
      expect(src).not.toMatch(/(glyphs|sprite|tiles)\s*:/);
      expect(src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")).not.toMatch(/#[0-9a-fA-F]{3,8}/);
    }
  });
  it("fetches only the desk's own data route", () => {
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
  const rules = css.slice(css.indexOf("/* Radar map"));
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
  it("keeps tabs 1 to 4, their ids, and the storage name; the fifth is Where it is on key 5", () => {
    expect(cockpit).toContain("tl_cockpit_tab");
    for (const id of ["tab-route", "tab-margin", "tab-docs", "tab-partners", "tab-tracking"]) expect(cockpit, id).toContain(`id="${id}"`);
    for (const k of ["1", "2", "3", "4", "5"]) expect(cockpit, k).toContain(`e.key === "${k}"`);
    expect(cockpit).toContain("Where it is");
  });
  it("the tracking panel only shows: it writes no arrival", () => {
    const tracker = read("src/components/desk/load-tracker.tsx") + read("src/server/tl/load-tracking.ts");
    expect(tracker).not.toMatch(/arrivedAt\s*:/);
    expect(tracker).not.toMatch(/\.(update|updateMany|create|upsert)\(/);
  });
});

describe("the rail", () => {
  const shell = read("src/components/desk/desk-shell.tsx");
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
