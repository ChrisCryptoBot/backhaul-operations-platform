import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findPlace, gazetteerSize, nearestPlace, zipPoint } from "@/lib/gazetteer/place-index";
import { STATES } from "@/lib/gazetteer/states";

describe("the bundled gazetteer", () => {
  it("holds the Census ZIPs and places, with every point on Earth's US side", () => {
    const n = gazetteerSize();
    expect(n.zips).toBeGreaterThan(33_000);
    expect(n.places).toBeGreaterThan(30_000);
    for (const s of STATES) {
      expect(s.lat).toBeGreaterThan(17);
      expect(s.lat).toBeLessThan(72);
      expect(s.lng).toBeLessThan(-65);
      expect(s.radius).toBeGreaterThan(0);
    }
    expect(STATES).toHaveLength(51);
  });

  it("knows well-known ZIPs where they are", () => {
    const dallas = zipPoint("75201")!;
    expect(dallas.lat).toBeCloseTo(32.79, 1);
    expect(dallas.lng).toBeCloseTo(-96.8, 1);
    expect(zipPoint("30303")!.lat).toBeCloseTo(33.75, 1); // Atlanta
    expect(zipPoint("10001")!.lng).toBeCloseTo(-74.0, 1); // New York
    expect(zipPoint("99999")).toBeNull();
  });

  it("is server only: no component or client file imports the data", () => {
    const root = path.join(__dirname, "..", "src");
    const bad: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(tsx?|mjs)$/.test(e.name)) {
          const t = fs.readFileSync(p, "utf8");
          const rel = path.relative(root, p).replaceAll("\\", "/");
          const importsData = /gazetteer\/(zips|places|place-index)"/.test(t);
          if (importsData && !rel.startsWith("server/") && !rel.startsWith("lib/gazetteer/")) bad.push(rel);
          if (importsData && t.includes('"use client"')) bad.push(rel);
        }
      }
    };
    walk(root);
    expect(bad).toEqual([]);
  });
});

describe("typed places, offline", () => {
  it("reads a ZIP, ZIP+4, a city and state in the usual spellings, and a state", () => {
    const zip = findPlace("75201")!;
    expect(zip.kind).toBe("zip");
    expect(zip.label.startsWith("75201")).toBe(true);
    expect(zip.label).toContain("Dallas");
    expect(findPlace("75201-1234")!.kind).toBe("zip");
    for (const t of ["Dallas, TX", "dallas tx", "DALLAS, Texas", "Dallas TX"]) {
      const c = findPlace(t)!;
      expect(c.kind, t).toBe("city");
      expect(c.label, t).toBe("Dallas, TX");
      expect(c.lat, t).toBeCloseTo(32.79, 1);
    }
    expect(findPlace("Atlanta, GA")!.label).toBe("Atlanta, GA");
    expect(findPlace("St. Louis, MO")!.label).toBe("St. Louis, MO");
    expect(findPlace("New York, NY")!.label).toContain("New York");
    const tx = findPlace("TX")!;
    expect(tx).toMatchObject({ kind: "state", label: "Texas (TX)", defaultRadius: 400 });
    expect(findPlace("texas")!.label).toBe("Texas (TX)");
    expect(findPlace("North Dakota")!.label).toBe("North Dakota (ND)");
  });

  it("takes a lone big city, and leaves an ambiguous name to be qualified", () => {
    expect(findPlace("Atlanta")!.label).toBe("Atlanta, GA");
    expect(findPlace("Springfield")).toBeNull();
  });

  it("returns nothing for text it cannot read, so the caller may ask the geocoder", () => {
    expect(findPlace("")).toBeNull();
    expect(findPlace("99999")).toBeNull();
    expect(findPlace("1600 Pennsylvania Ave NW")).toBeNull();
    expect(findPlace("Nowhereville, TX")).toBeNull();
  });

  it("names the nearest city to a point, and nothing in the middle of the ocean", () => {
    expect(nearestPlace(32.79, -96.8)!.label).toBe("Dallas, TX");
    expect(nearestPlace(33.75, -84.39)!.label).toContain("Atlanta");
    expect(nearestPlace(30, -50)).toBeNull();
  });
});
