import { describe, expect, it } from "vitest";
import { US_STATES } from "@/lib/basemap/us-states";
import { bearingDeg } from "@/lib/geo-line";
import { GEOFENCE_MILES, ageWords, agoText, classifyTractor, durationText, dwell, engineStateOf, etaAt, fleetCounts, geofence, idleWaste, roadHeading, scheduleState, sittingText, speedLine } from "@/lib/telematics";

const H = 3_600_000;
const NOW = Date.parse("2026-11-05T18:00:00Z");
const TERMS = { freeHours: 48, perDay: 75 };

describe("a tractor is moving under a load, idling, or parked", () => {
  it("moving under an assigned load is gold, moving without one is not, engine on and standing is idling, engine off is parked", () => {
    expect(classifyTractor({ engine: "moving", speedMph: 66, onLoad: true })).toBe("moving_load");
    expect(classifyTractor({ engine: "moving", speedMph: 61, onLoad: false })).toBe("moving");
    expect(classifyTractor({ engine: "idle", speedMph: 0, onLoad: true })).toBe("idling");
    expect(classifyTractor({ engine: "off", speedMph: 0, onLoad: false })).toBe("parked");
    expect(classifyTractor({ engine: null, speedMph: 1, onLoad: false })).toBe("idling"); // standing, no engine word
    expect(classifyTractor({ engine: null, speedMph: null, onLoad: true })).toBeNull(); // no signal says nothing
  });
  it("reads only the engine words it knows", () => {
    expect(["moving", "idle", "off", "on", "", null].map((w) => engineStateOf(w))).toEqual(["moving", "idle", "off", null, null, null]);
  });
});

describe("idling burns about a gallon an hour, and the cash is that at the fleet's fuel price", () => {
  it("3h 14m of idling is 3.2 gallons and about $12.80", () => {
    const w = idleWaste((3 * 60 + 14) / 60, 3.96);
    expect(w.gallons.toFixed(1)).toBe("3.2");
    expect(w.cashLost!.toFixed(2)).toBe("12.80");
    expect(durationText(3 * 60 + 14)).toBe("3h 14m");
  });
  it("never guesses a price: no price, no cash figure", () => {
    expect(idleWaste(2, null)).toEqual({ gallons: 2, cashLost: null });
    expect(idleWaste(-1, 4)).toEqual({ gallons: 0, cashLost: 0 });
  });
  it("words a duration exactly at any length, and an age past two days in days", () => {
    expect(durationText(42)).toBe("42m");
    expect(durationText(60)).toBe("1h 00m");
    expect(durationText(47 * 60 + 59)).toBe("47h 59m");
    // It words a stay in the history and the idle sentence, so no hour is ever rounded away.
    expect(durationText(241 * 60 + 54)).toBe("241h 54m");
    expect(ageWords(47 * 60 + 59)).toBe("47h 59m");
    expect(ageWords(48 * 60)).toBe("2 days");
    expect(ageWords(241 * 60 + 54)).toBe("10 days");
  });
  it("says how long ago a fix was, and that there is none", () => {
    const now = Date.parse("2026-11-23T12:00:00Z");
    const ago = (m: number) => agoText(new Date(now - m * 60_000).toISOString(), now);
    expect(agoText(null, now)).toBe("no fix yet");
    expect([ago(0), ago(42), ago(194), ago(241 * 60)]).toEqual(["just now", "42 min ago", "3h 14m ago", "10 days ago"]);
  });
});

describe("a dropped trailer's dwell", () => {
  const dropped = (days: number) => NOW - days * 24 * H;
  it("inside the free time there is nothing owed and no alert", () => {
    const d = dwell(dropped(1.5), NOW, TERMS, false)!;
    expect(d).toMatchObject({ alert: false, amount: 0, overFreeHours: 0 });
  });
  it("4.2 days with 48 hours free is 2.2 days over, $165.00 at $75 a day, and an alert when nothing is booked for it", () => {
    const d = dwell(dropped(4.2), NOW, TERMS, false)!;
    expect(d.days).toBeCloseTo(4.2, 5);
    expect(d.computedDays).toBe(2.2);
    expect(d.amount).toBe(165);
    expect(d.alert).toBe(true);
    expect(d.source).toEqual({ days: "company", rate: "company" });
    expect(sittingText(d.hours)).toBe("4.2 days");
  });
  it("a trailer with a reload booked is not an alert, though the days still count", () => {
    const d = dwell(dropped(4.2), NOW, TERMS, true)!;
    expect(d.alert).toBe(false);
    expect(d.amount).toBe(165);
  });
  it("a typed rate beats the company's, and is marked typed", () => {
    const d = dwell(dropped(4.2), NOW, TERMS, false, { ratePerDay: 100 })!;
    expect(d.amount).toBe(220);
    expect(d.rate).toBe(100);
    expect(d.computedAmount).toBe(165); // the company figure stays visible beside it
    expect(d.source).toEqual({ days: "company", rate: "typed" });
  });
  it("typed billable days beat the computed days", () => {
    const d = dwell(dropped(4.2), NOW, TERMS, false, { billableDays: 1 })!;
    expect(d.amount).toBe(75);
    expect(d.billableDays).toBe(1);
    expect(d.source).toEqual({ days: "typed", rate: "company" });
  });
  it("typed days and a typed rate together, even on a trailer still inside its free time", () => {
    const d = dwell(dropped(1), NOW, TERMS, false, { billableDays: 2, ratePerDay: 50 })!;
    expect(d.amount).toBe(100);
    expect(d.alert).toBe(false);
  });
  it("waiving the fee owes nothing, and keeps the figure it would have been", () => {
    const d = dwell(dropped(4.2), NOW, TERMS, false, { waived: true })!;
    expect(d.waived).toBe(true);
    expect(d.amount).toBe(0);
    expect(d.computedAmount).toBe(165);
  });
  it("a typed zero is a figure, not a blank", () => {
    expect(dwell(dropped(4.2), NOW, TERMS, false, { ratePerDay: 0 })!.amount).toBe(0);
    expect(dwell(dropped(4.2), NOW, TERMS, false, { billableDays: 0 })!.source.days).toBe("typed");
  });
  it("company terms are the fallback and change the figure: 24 hours free at $100 a day", () => {
    expect(dwell(dropped(4.2), NOW, { freeHours: 24, perDay: 100 }, false)!.amount).toBe(320);
  });
  it("a trailer that is hooked, or has no drop time, has no dwell", () => {
    expect(dwell(null, NOW, TERMS, false)).toBeNull();
    expect(dwell(undefined, NOW, TERMS, false)).toBeNull();
  });
});

describe("geofence, ETA", () => {
  const dallas = { lat: 32.7767, lng: -96.797 };
  it("a truck within a mile of the stop is inside; just past it is not", () => {
    expect(GEOFENCE_MILES).toBe(1);
    expect(geofence({ lat: 32.7767, lng: -96.797 + 0.005 }, dallas).inside).toBe(true); // about 0.3 mile
    expect(geofence({ lat: 32.7767, lng: -96.797 + 0.03 }, dallas).inside).toBe(false); // about 1.7 miles
  });
  it("the ETA is the miles left at the speed it is doing, a standing truck at a typical 55", () => {
    expect(etaAt(NOW, 140, 70) - NOW).toBe(2 * H);
    expect(etaAt(NOW, 55, 0) - NOW).toBe(H);
  });
  it("late only once the ETA is past the window's close by more than the grace; no window says nothing", () => {
    const close = NOW + 3 * H;
    expect(scheduleState(close - H, close)).toBe("on_schedule");
    expect(scheduleState(close + 10 * 60_000, close)).toBe("on_schedule");
    expect(scheduleState(close + 20 * 60_000, close)).toBe("late");
    expect(scheduleState(close, null)).toBeNull();
  });
  it("bearing runs east to about 90 and north to 0", () => {
    expect(bearingDeg({ lat: 40, lng: -100 }, { lat: 40, lng: -90 })).toBeGreaterThan(80);
    expect(bearingDeg({ lat: 40, lng: -100 }, { lat: 41, lng: -100 })).toBe(0);
  });
});

describe("the nearest interstate corridor and which way along it", () => {
  it("a numbered road reads with the way the truck is heading along it; any other road, or none, never invents one", () => {
    expect([roadHeading("I-40", 85), roadHeading("I-40", 265), roadHeading("I-35", 5), roadHeading("US-67", 185), roadHeading("I-80", null)]).toEqual(["I-40 E", "I-40 W", "I-35 N", "US-67 S", "I-80"]);
    expect([roadHeading("Chicago Skyway", 90), roadHeading("TX-114", 90), roadHeading(null, 90)]).toEqual(["Chicago Skyway", "TX-114", null]);
  });
  it("the speed line uses the route's road, and falls back to a compass heading, never to a nearby highway", () => {
    expect(speedLine(70, "I-80", 270)).toBe("70 MPH · I-80 W");
    expect(speedLine(64.4, null, 45)).toBe("64 MPH · heading NE");
    expect(speedLine(null, "I-80", null)).toBe("I-80");
  });
});

describe("the HUD counts", () => {
  it("counts each state, the units with no signal, and the dropped trailers", () => {
    const c = fleetCounts(
      [{ state: "moving_load" }, { state: "moving_load" }, { state: "idling" }, { state: "parked" }, { state: "moving" }, { state: null }],
      [{ hooked: true }, { hooked: false }, { hooked: false }]
    );
    expect(c).toEqual({ tractors: 6, movingLoad: 2, moving: 1, idling: 1, parked: 1, noSignal: 1, droppedTrailers: 2, hookedTrailers: 1 });
  });
});

describe("the bundled basemap needs no network and is sane", () => {
  it("has the fifty states and DC, each a ring of at least four points, none past the world's edge", () => {
    expect(US_STATES.length).toBe(51);
    for (const s of US_STATES) {
      expect(s.rings.length, s.name).toBeGreaterThan(0);
      for (const ring of s.rings) {
        expect(ring.length).toBeGreaterThanOrEqual(4);
        for (const [lng, lat] of ring) {
          expect(lng).toBeGreaterThanOrEqual(-180);
          expect(lng).toBeLessThan(-66);
          expect(lat).toBeGreaterThan(18);
          expect(lat).toBeLessThan(72.5);
          // Only Alaska and Hawaii are outside the continental box.
          if (lat < 24 || lat > 49.5 || lng < -125.5) expect(["Alaska", "Hawaii"], s.name).toContain(s.name);
        }
      }
    }
    expect(US_STATES.map((s) => s.name)).toEqual(expect.arrayContaining(["Alaska", "Hawaii"]));
  });
});

describe("what the screens say about a unit", () => {
  const day = 24 * H;
  it("an equipment code is the length and a letter", async () => {
    const { equipmentCode } = await import("@/lib/radar");
    expect(equipmentCode("dry_van", 53)).toBe("53V");
    expect(equipmentCode("reefer", 48)).toBe("48R");
    expect(equipmentCode("flatbed", null)).toBe("F");
    expect(equipmentCode(null, 53)).toBe("53");
    expect(equipmentCode(null, null)).toBe("");
  });
  it("the idle sentence is the stationary time, the gallons and the cash, with the real minus", async () => {
    const { idleLine, idleSentence } = await import("@/lib/radar");
    expect(idleSentence(idleLine(3 * 60 + 14, 3.96))).toBe("IDLING (Stationary 3h 14m) · Burned: 3.2 gal · Cash Lost: −$12.80");
    expect(idleSentence(idleLine(241 * 60 + 5, 4))).toContain("Stationary 241h 05m"); // beside gallons and cash, to the minute
    const { idleShort } = await import("@/lib/radar");
    expect(idleShort(idleLine(241 * 60 + 5, 4))).toMatch(/^10 days · −\$\d/);
    expect(idleShort(idleLine(45, null))).toBe("45m");
    expect(idleSentence(idleLine(45, null))).toBe("IDLING (Stationary 45m) · Burned: 0.8 gal"); // no price, no cash figure
  });
  it("the dwell sentence says sitting, the alert and the detention, and a waiver in its own words", async () => {
    const { dwellSentence } = await import("@/lib/radar");
    const d = dwell(NOW - 4.2 * day, NOW, TERMS, false)!;
    expect(dwellSentence(d, 48)).toBe("SITTING 4.2 DAYS · Dwell Alert: Exceeds 48h free time · Detention Owed: +$165.00");
    expect(dwellSentence(dwell(NOW - 1 * day, NOW, TERMS, false)!, 48)).toBe("SITTING 1 DAY");
    expect(dwellSentence(dwell(NOW - 4.2 * day, NOW, TERMS, false, { waived: true })!, 48)).toBe("SITTING 4.2 DAYS · Dwell Alert: Exceeds 48h free time · Detention WAIVED (was +$165.00)");
    expect(dwellSentence(dwell(NOW - 4.2 * day, NOW, TERMS, true, { ratePerDay: 100 })!, 48)).toBe("SITTING 4.2 DAYS · Detention Owed: +$220.00"); // a reload is booked: no alert, the typed figure still shows
  });
});
