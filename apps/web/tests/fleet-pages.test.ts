import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (p: string) => fs.readFileSync(path.join(__dirname, "..", p), "utf8").replace(/\r\n/g, "\n");

/** The Fleet screens' own rules, read from the source: one look for an old position, a key that is the map's marks, and the actions that live beside what they change. */
describe("an old position is said one way", () => {
  it("is the same component on the drawer, the radar and the unit pages", () => {
    for (const p of ["load-tracker", "radar-map", "unit-where"]) expect(read(`src/components/desk/${p}.tsx`)).toContain('from "./kit/stale-fix"');
    for (const p of ["radar-map", "unit-where", "load-tracker"]) expect(read(`src/components/desk/${p}.tsx`)).not.toContain('className="t-stale"');
  });
  it("never lets an old fix's state, speed or arrival read as now", () => {
    const unit = read("src/components/desk/unit-where.tsx");
    for (const w of ["Status then", "Speed then", "Road then", "Last seen"]) expect(unit).toContain(w);
    const map = read("src/components/desk/radar-map.tsx");
    expect(map).toContain("eta.chip && !old");
    expect(map).toContain("Needs a newer position");
    expect(read("src/server/tl/radar-query.ts")).toContain("oldFix: oldFixOf(u)");
  });
});

describe("the radar's key is the radar's marks", () => {
  const map = read("src/components/desk/radar-map.tsx");
  it("has a mark for every kind of unit the map draws", () => {
    const keyed = [...map.slice(map.indexOf("const KEY_ALWAYS"), map.indexOf("function RadarKey")).matchAll(/kind: "(\w+)"/g)].map((m) => m[1]);
    // addImages: t-load, t-moving, t-idle, t-parked, t-none; tr-h, tr-d, tr-a (past its free time); -l (loaded); and the cluster.
    expect(keyed).toEqual(["load", "moving", "idle", "parked", "none", "hooked", "dropped", "dwell", "loaded", "cluster"]);
    for (const name of ["t-load", "t-moving", "t-idle", "t-parked", "t-none", "tr-h-e", "tr-d-e", "tr-a-e", "tr-d-l"]) expect(map).toContain(`put("${name}"`);
  });
  it("draws each from the same colour token as the map", () => {
    const css = read("src/app/terminal.css");
    const tokens = map.slice(map.indexOf("function readTokens"), map.indexOf("function readTokens") + 1200);
    for (const [mark, token] of [["load", "label"], ["idle", "warn-fill"], ["moving", "ink"], ["tolls", "typed"]] as const) {
      expect(css).toMatch(new RegExp(`\\.rd-mark\\[data-mark=${mark}\\]\\{[a-z]+:var\\(--${token}\\)`));
      expect(tokens).toContain(`"--${token}"`);
    }
    expect(css.slice(css.indexOf(".rd-mark{"), css.indexOf(".rd-card .t-stale"))).not.toMatch(/rgba?\(|#[0-9a-f]{3}/i);
  });
  it("counts only what adds to the map as a layer that is on", () => {
    expect(map).toContain("const layersOn = [p.hooked, showLoads, tolls, pois, showWeather]");
  });
});

describe("the actions live beside what they change", () => {
  it("an archived unit says so on every tab and where to restore it", () => {
    for (const p of ["fleet", "trailers"]) {
      const s = read(`src/app/(desk)/${p}/[id]/page.tsx`);
      expect(s).toContain('t.archivedAt && tab !== "details"');
      expect(s).toMatch(/Card\s+title="Details"\s+action=/);
    }
  });
  it("a driver's code is either the edit or the code, never both", () => {
    const s = read("src/app/(desk)/drivers/[id]/page.tsx");
    expect(s.replace(/\s+/g, " ")).toContain('canRoster ? ( <CanGate caps={["roster"]}> <DriverCodeEdit');
    expect(s.match(/<DriverCodeEdit/g)).toHaveLength(1);
    expect(s.match(/title="Changes"/g)).toHaveLength(1);
  });
});
