import { describe, expect, test } from "vitest";
import { MAX_FIXES, QUALITY_WORDS, canonicalEvidence, checkConfirmation, keepFixes, proposeStopEvidence, worthOf, type Fix, type KeptFix } from "@/lib/detention-evidence";

const STOP = { lat: 33.0, lng: -96.0 };
const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 3, 14, 0); // 14:00 UTC
const at = (minutes: number) => T0 + minutes * MIN;
/** One degree of latitude is about 69.09 miles. */
const north = (miles: number) => STOP.lat + miles / 69.09;
const fix = (minutes: number, miles: number): Fix => ({ at: at(minutes), lat: north(miles), lng: STOP.lng });
const kept = (fs: Fix[]): KeptFix[] => keepFixes(fs, STOP);
const window = (openMin: number | null, closeMin: number | null) => ({ windowStart: openMin == null ? null : at(openMin), windowEnd: closeMin == null ? null : at(closeMin) });

describe("what a stop's track supports", () => {
  test("a truck that came, sat and left: first fix inside is the arrival, last fix inside the departure, the wait is the difference", () => {
    const p = proposeStopEvidence(kept([fix(0, 3), fix(10, 1), fix(20, 0.1), fix(40, 0.05), fix(60, 0.1), fix(80, 0.1), fix(95, 0.8), fix(105, 3)]), window(null, null));
    expect(p).toMatchObject({ quality: "good", arrivalAt: at(20), departureAt: at(80), beforeGapMin: 10, afterGapMin: 15, stillInside: false, waitFrom: at(20), waitMinutes: 60, inCount: 4 });
    expect(p.notes.join(" ")).toContain("first fix inside");
  });

  test("the radius edge: 0.24 mile is at the facility, 0.26 mile is not", () => {
    const p = proposeStopEvidence(kept([fix(0, 1.9), fix(10, 0.24), fix(20, 0.24), fix(30, 0.24), fix(40, 0.26), fix(50, 1.9)]), window(null, null));
    expect(p.inCount).toBe(3);
    expect(p).toMatchObject({ arrivalAt: at(10), departureAt: at(30) });
    expect(proposeStopEvidence(kept([fix(0, 1.9), fix(10, 0.26), fix(20, 0.3)]), window(null, null))).toMatchObject({ quality: "none", arrivalAt: null, waitMinutes: null });
  });

  test("arriving before the window opens counts the wait from the window's start; arriving inside it counts from the arrival", () => {
    const early = proposeStopEvidence(kept([fix(0, 1.9), fix(10, 0.1), fix(30, 0.1), fix(50, 0.1), fix(70, 0.1), fix(80, 1.9)]), window(40, 120));
    expect(early).toMatchObject({ arrivalAt: at(10), waitFrom: at(40), departureAt: at(70), waitMinutes: 30 });
    expect(early.notes.join(" ")).toContain("before the appointment window opened");
    const late = proposeStopEvidence(kept([fix(0, 1.9), fix(50, 0.1), fix(70, 0.1), fix(90, 0.1), fix(110, 1.9)]), window(40, 120));
    expect(late).toMatchObject({ waitFrom: at(50), waitMinutes: 40 });
    // The window opens after the truck has gone: nothing to count, never negative.
    expect(proposeStopEvidence(kept([fix(0, 1.9), fix(10, 0.1), fix(20, 0.1), fix(30, 0.1), fix(40, 1.9)]), window(200, 300))).toMatchObject({ waitMinutes: 0 });
  });

  test("a truck pulled forward (seen outside for under 30 minutes) is one visit; a longer absence is a second visit and only the first is proposed", () => {
    const pulled = proposeStopEvidence(kept([fix(0, 1.9), fix(10, 0.1), fix(20, 0.1), fix(30, 0.1), fix(40, 0.6), fix(55, 0.1), fix(65, 0.1), fix(75, 0.1), fix(90, 1.9)]), window(null, null));
    expect(pulled.visits).toHaveLength(1);
    expect(pulled).toMatchObject({ arrivalAt: at(10), departureAt: at(75), waitMinutes: 65 });
    const twice = proposeStopEvidence(kept([fix(0, 1.9), fix(10, 0.1), fix(20, 0.1), fix(30, 0.1), fix(40, 1.5), fix(80, 1.5), fix(100, 0.1), fix(110, 0.1), fix(120, 0.1), fix(135, 1.9)]), window(null, null));
    expect(twice.visits.map((v) => [v.firstIn, v.lastIn])).toEqual([[at(10), at(30)], [at(100), at(120)]]);
    expect(twice).toMatchObject({ arrivalAt: at(10), departureAt: at(30), waitMinutes: 20 });
    expect(twice.notes.join(" ")).toContain("2 separate visits");
  });

  test("a truck seen inside for hours with sparse fixes and never outside is one visit, not many", () => {
    const p = proposeStopEvidence(kept([fix(0, 1.9), fix(10, 0.1), fix(70, 0.1), fix(130, 0.1), fix(190, 0.1), fix(205, 1.9)]), window(null, null));
    expect(p.visits).toHaveLength(1);
    expect(p).toMatchObject({ arrivalAt: at(10), departureAt: at(190), waitMinutes: 180 });
  });

  test("still inside at the last fix: an arrival, no departure and no wait to read", () => {
    const p = proposeStopEvidence(kept([fix(0, 1.9), fix(10, 0.1), fix(30, 0.1), fix(50, 0.1)]), window(null, null));
    expect(p).toMatchObject({ arrivalAt: at(10), departureAt: null, stillInside: true, waitMinutes: null, afterGapMin: null });
    expect(p.notes.join(" ")).toContain("still at the facility");
  });

  test("quality: good needs fixes close to both ends and enough inside; a long gap, few fixes or a track that starts inside are thin", () => {
    const base = [fix(0, 1.9), fix(10, 0.1), fix(20, 0.1), fix(30, 0.1), fix(40, 1.9)];
    expect(proposeStopEvidence(kept(base), window(null, null)).quality).toBe("good");
    expect(proposeStopEvidence(kept([fix(0, 1.9), fix(60, 0.1), fix(70, 0.1), fix(80, 0.1), fix(90, 1.9)]), window(null, null)).quality).toBe("thin"); // 60 min before the arrival
    expect(proposeStopEvidence(kept([fix(0, 1.9), fix(10, 0.1), fix(20, 0.1), fix(80, 1.9)]), window(null, null)).quality).toBe("thin"); // 2 inside, 60 min after
    const few = proposeStopEvidence(kept([fix(0, 1.9), fix(10, 0.1), fix(20, 0.1), fix(30, 1.9)]), window(null, null));
    expect(few.quality).toBe("thin");
    expect(few.notes.join(" ")).toContain("Only 2 fixes were inside");
    const starts = proposeStopEvidence(kept([fix(10, 0.1), fix(20, 0.1), fix(30, 0.1), fix(40, 1.9)]), window(null, null));
    expect(starts).toMatchObject({ quality: "thin", beforeGapMin: null });
    expect(QUALITY_WORDS.good).toMatch(/^Good/);
  });

  test("nothing near the stop proposes nothing, and says why", () => {
    expect(proposeStopEvidence([], window(null, null))).toMatchObject({ quality: "none", arrivalAt: null, departureAt: null, waitMinutes: null, fixCount: 0 });
    expect(proposeStopEvidence([], window(null, null)).notes[0]).toContain("No position fix");
  });
});

describe("the fixes that are kept", () => {
  test("only those within two miles, oldest first, with their distance", () => {
    const k = keepFixes([fix(30, 0.5), fix(0, 5), fix(10, 1.9), fix(20, 2.1)], STOP);
    expect(k.map((f) => f.at)).toEqual([at(10), at(30)]);
    expect(k[1]!.miles).toBeCloseTo(0.5, 2);
  });

  test("more than the cap are thinned evenly, and the fixes that decide the visit always survive", () => {
    const fs: Fix[] = [];
    for (let i = 0; i < 700; i++) fs.push(fix(i, 1.5)); // a long approach, all outside
    for (let i = 700; i < 760; i++) fs.push(fix(i, 0.1)); // a visit
    for (let i = 760; i < 1400; i++) fs.push(fix(i, 1.5));
    const k = keepFixes(fs, STOP);
    expect(k.length).toBeLessThanOrEqual(MAX_FIXES);
    const p = proposeStopEvidence(k, window(null, null));
    expect(p).toMatchObject({ arrivalAt: at(700), departureAt: at(759) });
    expect(p.beforeGapMin).toBeLessThanOrEqual(5);
    // Deterministic: the same fixes keep the same ones.
    expect(keepFixes(fs, STOP).map((f) => f.at)).toEqual(k.map((f) => f.at));
  });
});

describe("what it is worth, and the hash", () => {
  test("past the free time at the truck's rate, the invoice's own rule; nothing without a rate", () => {
    expect(worthOf(210, 120, 75)).toEqual({ billableMinutes: 90, amount: 112.5 });
    expect(worthOf(100, 120, 75)).toEqual({ billableMinutes: 0, amount: 0 });
    expect(worthOf(210, 120, null)).toBeNull();
    expect(worthOf(null, 120, 75)).toBeNull();
    expect(worthOf(210, 120, 0)).toBeNull();
  });

  test("the canonical evidence is stable, and any fix, time or window changes it", () => {
    const fs = kept([fix(0, 1.9), fix(10, 0.1), fix(20, 0.1), fix(30, 0.1), fix(40, 1.9)]);
    const p = proposeStopEvidence(fs, window(5, 90));
    const make = (over: Partial<Parameters<typeof canonicalEvidence>[0]> = {}) => canonicalEvidence({ stopId: "s1", radiusMiles: 0.25, windowStart: at(5), windowEnd: at(90), fixes: fs, proposal: p, ...over });
    expect(make()).toBe(make());
    expect(make({ fixes: fs.map((f, i) => (i === 2 ? { ...f, at: f.at + MIN } : f)) })).not.toBe(make());
    expect(make({ windowStart: at(6) })).not.toBe(make());
    expect(make({ stopId: "s2" })).not.toBe(make());
    expect(make({ proposal: { ...p, waitMinutes: 99 } })).not.toBe(make());
  });
});

describe("what a person may confirm", () => {
  const p = { arrivalAt: at(10), waitMinutes: 60 };
  test("the proposal as it is needs nothing more", () => {
    expect(checkConfirmation(p, {})).toEqual({ ok: true, arrivalAt: at(10), waitMinutes: 60, edited: false, note: null });
    expect(checkConfirmation(p, { waitMinutes: 60, arrivalAt: at(10) })).toMatchObject({ ok: true, edited: false });
  });
  test("a changed wait or arrival needs a few words on why, which are kept", () => {
    expect(checkConfirmation(p, { waitMinutes: 90 })).toMatchObject({ ok: false, errors: { note: expect.any(String) } });
    expect(checkConfirmation(p, { waitMinutes: 90, note: "ok" })).toMatchObject({ ok: false });
    expect(checkConfirmation(p, { waitMinutes: 90, note: "Dock log shows 90" })).toEqual({ ok: true, arrivalAt: at(10), waitMinutes: 90, edited: true, note: "Dock log shows 90" });
    expect(checkConfirmation(p, { arrivalAt: at(5), note: "Gate pass 14:05" })).toMatchObject({ ok: true, edited: true, arrivalAt: at(5) });
  });
  test("a track with no departure has no wait: one must be typed, with why", () => {
    const none = { arrivalAt: at(10), waitMinutes: null };
    expect(checkConfirmation(none, {})).toMatchObject({ ok: false, errors: { waitMinutes: expect.any(String) } });
    expect(checkConfirmation(none, { waitMinutes: 45, note: "Left at 14:55 per the driver" })).toMatchObject({ ok: true, waitMinutes: 45, edited: true });
  });
  test("whole minutes up to a week", () => {
    for (const bad of [-1, 1.5, 10_081, Number.NaN]) expect(checkConfirmation(p, { waitMinutes: bad, note: "typed" }).ok).toBe(false);
    expect(checkConfirmation(p, { waitMinutes: 0, note: "No wait at all" })).toMatchObject({ ok: true, waitMinutes: 0 });
  });
});
