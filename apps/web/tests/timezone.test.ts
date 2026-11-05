import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CARRIER_ZONES, DEFAULT_TZ, asZone, clockName, isCarrierZone, zoneAbbr } from "@/lib/tz";
import { centralInstant, centralMidnight, centralParts, parseCentralLocal, toCentralLocal } from "@/lib/zoned";
import { dateTime, shortDate, stopTime } from "@/lib/desk-format";
import { stopZoneOf } from "@/server/geo/stop-zone";

const NY = "America/New_York";
const CHI = "America/Chicago";
const DEN = "America/Denver";
const LA = "America/Los_Angeles";
const src = (p: string) => fs.readFileSync(path.join(__dirname, "..", p), "utf8").replace(/\r\n/g, "\n");

describe("the carrier's zones", () => {
  it("offers Eastern, Central, Mountain, Arizona, Pacific, Alaska and Hawaii, each a real zone with its own suffix", () => {
    expect(CARRIER_ZONES.map((z) => z.abbr)).toEqual(["ET", "CT", "MT", "MST", "PT", "AKT", "HST"]);
    for (const z of CARRIER_ZONES) {
      expect(() => new Intl.DateTimeFormat("en-US", { timeZone: z.id })).not.toThrow();
      expect(isCarrierZone(z.id)).toBe(true);
    }
    expect(DEFAULT_TZ).toBe(CHI);
  });

  it("never trusts a stored or cookie value: anything that is not on the list is the default", () => {
    expect(asZone(NY)).toBe(NY);
    for (const bad of ["", "Mars/Olympus", "america/new_york", null, undefined, 7, "America/Chicago; drop table"]) expect(asZone(bad)).toBe(CHI);
  });

  it("names the suffix and the clock", () => {
    expect(zoneAbbr(NY)).toBe("ET");
    expect(zoneAbbr("America/Toronto")).toBe("ET");
    expect(zoneAbbr("America/Winnipeg")).toBe("CT");
    expect(zoneAbbr("Europe/Paris")).toBe("Paris");
    expect(clockName(NY)).toBe("Eastern time");
    expect(clockName("America/Phoenix")).toBe("Arizona time");
  });
});

describe("carrier base time: where a day, a week and a month begin", () => {
  it("midnight is the carrier's own midnight, in winter and in summer", () => {
    expect(new Date(centralMidnight(2026, 10, 5, NY)).toISOString()).toBe("2026-11-05T05:00:00.000Z");
    expect(new Date(centralMidnight(2026, 10, 5, CHI)).toISOString()).toBe("2026-11-05T06:00:00.000Z");
    expect(new Date(centralMidnight(2026, 10, 5, DEN)).toISOString()).toBe("2026-11-05T07:00:00.000Z");
    expect(new Date(centralMidnight(2026, 10, 5, LA)).toISOString()).toBe("2026-11-05T08:00:00.000Z");
    expect(new Date(centralMidnight(2026, 6, 4, NY)).toISOString()).toBe("2026-07-04T04:00:00.000Z");
    expect(new Date(centralMidnight(2026, 6, 4, "America/Phoenix")).toISOString()).toBe("2026-07-04T07:00:00.000Z"); // Arizona keeps MST all year
  });

  it("the same instant is a different billing day on a different clock", () => {
    const t = Date.parse("2026-11-05T05:30:00Z");
    expect(centralParts(t, NY)).toMatchObject({ m0: 10, d: 5, h: 0, min: 30 });
    expect(centralParts(t, CHI)).toMatchObject({ m0: 10, d: 4, h: 23, min: 30 });
    expect(centralParts(t, LA)).toMatchObject({ m0: 10, d: 4, h: 21, min: 30 });
  });

  it("a month ends at the carrier's midnight: the last evening of October is October on every clock", () => {
    const lateOct31Chicago = Date.parse("2026-11-01T04:30:00Z"); // 11:30 pm Oct 31 CDT
    expect(centralParts(lateOct31Chicago, CHI).m0).toBe(9);
    expect(centralParts(lateOct31Chicago, NY).m0).toBe(10); // already November 12:30 am on the east coast
  });

  it("round-trips a typed time through the carrier's clock across both daylight saving changes", () => {
    for (const zone of [NY, CHI, DEN, LA]) {
      for (const text of ["2026-03-08T01:30", "2026-03-08T03:30", "2026-11-01T00:30", "2026-11-01T03:30", "2026-07-04T12:00", "2026-12-31T23:59"]) {
        const t = parseCentralLocal(text, zone)!;
        expect(t, `${zone} ${text}`).not.toBeNull();
        expect(toCentralLocal(t, zone)).toBe(text);
      }
    }
    expect(parseCentralLocal("2026-02-31T10:00", NY)).toBeNull();
    // Spring forward: 02:30 on March 8 does not exist in New York; it is read as the next real moment, never a different day.
    const gap = centralInstant(2026, 2, 8, 2, 30, NY);
    expect(centralParts(gap, NY).d).toBe(8);
  });

  it("with no zone given it is Central, exactly as the desk always was", () => {
    expect(new Date(centralMidnight(2026, 10, 5)).toISOString()).toBe("2026-11-05T06:00:00.000Z");
    expect(dateTime(new Date("2026-11-05T15:30:00Z"))).toBe("Nov 5, 9:30 AM CT");
  });
});

describe("the suffix is the carrier's, not a constant", () => {
  const t = new Date("2026-11-05T15:30:00Z");
  it("says ET, CT, MT or PT with the time on that clock", () => {
    expect(dateTime(t, NY)).toBe("Nov 5, 10:30 AM ET");
    expect(dateTime(t, CHI)).toBe("Nov 5, 9:30 AM CT");
    expect(dateTime(t, DEN)).toBe("Nov 5, 8:30 AM MT");
    expect(dateTime(t, LA)).toBe("Nov 5, 7:30 AM PT");
    expect(shortDate(new Date("2026-11-05T05:30:00Z"), NY)).toBe("Nov 5");
    expect(shortDate(new Date("2026-11-05T05:30:00Z"), CHI)).toBe("Nov 4");
    expect(dateTime(null, NY)).toBe("—");
  });
});

describe("stop local time is its own clock", () => {
  const t = new Date("2026-11-05T15:30:00Z");
  it("an appointment is shown where the dock is, with the carrier's time beside it when they differ", () => {
    expect(stopTime(t, NY, CHI)).toBe("Nov 5, 10:30 AM ET (9:30 AM CT)");
    expect(stopTime(t, LA, NY)).toBe("Nov 5, 7:30 AM PT (10:30 AM ET)");
    expect(stopTime(t, CHI, CHI)).toBe("Nov 5, 9:30 AM CT");
    expect(stopTime(t, null, DEN)).toBe("Nov 5, 8:30 AM MT");
    expect(stopTime(null, NY, CHI)).toBe("—");
  });

  it("finds a stop's zone from its coordinates, else its state, else the carrier's own", () => {
    expect(stopZoneOf({ addressString: "Atlanta, GA" }, CHI)).toBe(NY);
    expect(stopZoneOf({ addressString: "Denver, CO" }, NY)).toBe(DEN);
    // Texas spans two zones: with no coordinates it is read on the carrier's clock, and with them it is exact.
    expect(stopZoneOf({ addressString: "Dallas, TX" }, NY)).toBe(NY);
    expect(stopZoneOf({ addressString: "Dallas, TX", lat: 32.78, lng: -96.8 }, NY)).toBe(CHI);
    expect(stopZoneOf({ addressString: "El Paso, TX", lat: 31.76, lng: -106.49 }, CHI)).toBe(DEN);
    expect(stopZoneOf({}, LA)).toBe(LA);
  });
});

describe("no screen or query hard-codes a clock any more", () => {
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
    }
    return out;
  };
  const files = walk(path.join(__dirname, "../src")).filter((f) => !f.includes(`${path.sep}truelane${path.sep}`));
  const rel = (f: string) => path.relative(path.join(__dirname, ".."), f).split(path.sep).join("/");

  it("the Chicago zone name appears only where it is the default (the zone list, the tz module, the zone fallbacks)", () => {
    const hits = files.filter((f) => /America\/Chicago/.test(fs.readFileSync(f, "utf8"))).map(rel).sort();
    expect(hits).toEqual(["src/lib/tz.ts", "src/server/geo/zones.ts", "src/server/tl/shell.ts"]);
  });

  it("the money and day counting on the server reads the workspace's zone, never a cookie", () => {
    expect(src("src/server/tl/aging.ts")).toContain("await workspaceTimezone(workspaceId)");
    expect(src("src/server/tl/queries.ts")).toContain("await workspaceTimezone(workspaceId)");
    expect(src("src/server/tl/history.ts")).toContain("monthSql(tz)");
    expect(src("src/server/tl/aging.ts")).not.toContain("DESK_TZ");
  });

  it("no form still says 'Dallas time'", () => {
    const hits = files.filter((f) => /Dallas time/.test(fs.readFileSync(f, "utf8"))).map(rel);
    expect(hits).toEqual([]);
  });

  it("the sync formatters ask the carrier's zone, and the browser is brought into line with the desk once", () => {
    expect(src("src/lib/desk-format.ts")).toContain("activeTz()");
    expect(src("src/components/desk/desk-shell.tsx")).toContain("<ZoneSync zone={data.timezone} />");
    expect(src("src/server/tl/workspace.ts")).toContain('import "./zone";');
  });
});
