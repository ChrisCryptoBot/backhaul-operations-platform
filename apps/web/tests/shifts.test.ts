import { describe, expect, it } from "vitest";
import { quoteShift, blocksOnDay, checkLoad, checkShift, checkStop, conflictsIfChanged, dayBalance, flagShort, flagWords, h12, hhmm, parseMinutes, parseWeek, shiftStarting, shiftText, type DriverSchedule, type Week } from "@/lib/shifts";
import { centralInstant } from "@/lib/zoned";

const TZ = "America/Chicago";
const at = (y: number, m: number, d: number, h: number, min = 0) => new Date(centralInstant(y, m - 1, d, h, min, TZ));
const wk = (f: (day: number) => { start: number; end: number } | null): Week => Array.from({ length: 7 }, (_, i) => f(i));
const DAYSHIFT: Week = wk((d) => (d >= 1 && d <= 5 ? { start: 6 * 60, end: 18 * 60 } : null)); // Mon-Fri 06:00-18:00
const sched = (week: Week, exceptions: DriverSchedule["exceptions"] = []): DriverSchedule => ({ week, exceptions });

// Mon 2026-11-02 ... Fri 2026-11-06, Sat 7th
describe("a shift is the template plus exceptions; no schedule is neither on nor off", () => {
  it("reads the template by weekday and an exception over it", () => {
    const s = sched(DAYSHIFT, [{ dateKey: "2026-11-04", kind: "off", start: null, end: null, note: "Home time" }, { dateKey: "2026-11-05", kind: "shift", start: 12 * 60, end: 20 * 60, note: null }]);
    expect(shiftStarting(s, "2026-11-02")).toMatchObject({ kind: "on", shift: { start: 360, end: 1080 } });
    expect(shiftStarting(s, "2026-11-04")).toEqual({ kind: "off", note: "Home time" });
    expect(shiftStarting(s, "2026-11-05")).toMatchObject({ kind: "on", exception: true, shift: { start: 720, end: 1200 } });
    expect(shiftStarting(s, "2026-11-07")).toEqual({ kind: "off", note: null }); // Saturday is a day off in the template
    expect(shiftStarting(null, "2026-11-02")).toEqual({ kind: "unset" });
  });

  it("a driver with no schedule is never flagged", () => {
    expect(checkStop(null, { earliest: at(2026, 11, 3, 2), latest: at(2026, 11, 3, 2) }, TZ)).toBeNull();
    expect(blocksOnDay(null, "2026-11-03", TZ)).toEqual([]);
  });
});

describe("a stop outside the shift is flagged, one the driver can make is not", () => {
  const s = sched(wk((d) => (d >= 1 && d <= 5 ? { start: 6 * 60, end: 90 } : null))); // Mon-Fri 06:00 to 01:30 next morning (overnight)
  it("delivery at 2:00 AM for a shift that ends at 1:30 AM is past the shift end", () => {
    const c = checkStop(s, { earliest: at(2026, 11, 3, 2), latest: at(2026, 11, 3, 2) }, TZ);
    // Tue 02:00 is half an hour after Mon's shift ended at 01:30, and four hours before Tue's 06:00 start
    expect(c?.flag).toBe("exceeds_end");
    expect(hhmm(c!.edge!, TZ)).toBe("01:30");
    expect(flagShort(c!.flag, c!.edge, TZ)).toBe("Past shift end (1:30 AM)");
    const onShiftNight = checkStop(s, { earliest: at(2026, 11, 3, 1), latest: at(2026, 11, 3, 1) }, TZ);
    expect(onShiftNight).toBeNull(); // 01:00 is still Monday night's shift
  });

  it("day shift: after the end is EXCEEDS SHIFT END with the end time, before the start is BEFORE SHIFT START", () => {
    const day = sched(DAYSHIFT);
    const late = checkStop(day, { earliest: at(2026, 11, 3, 21), latest: at(2026, 11, 3, 21) }, TZ)!;
    expect(late.flag).toBe("exceeds_end");
    expect(hhmm(late.edge!, TZ)).toBe("18:00");
    expect(flagShort(late.flag, late.edge, TZ)).toBe("Past shift end (6:00 PM)");
    const early = checkStop(day, { earliest: at(2026, 11, 3, 3), latest: at(2026, 11, 3, 3) }, TZ)!;
    expect(early.flag).toBe("before_start");
    expect(hhmm(early.edge!, TZ)).toBe("06:00");
  });

  it("a day off is OFF DUTY, and a window that overlaps the shift is fine", () => {
    const day = sched(DAYSHIFT);
    expect(checkStop(day, { earliest: at(2026, 11, 7, 10), latest: at(2026, 11, 7, 10) }, TZ)?.flag).toBe("off_duty");
    expect(checkStop(day, { earliest: at(2026, 11, 3, 16), latest: at(2026, 11, 3, 20) }, TZ)).toBeNull(); // opens inside the shift
    expect(checkStop(day, { earliest: at(2026, 11, 3, 18), latest: at(2026, 11, 3, 18) }, TZ)).toBeNull(); // exactly at the end still fits
  });

  it("time off marks that one date, and a stop on it is OFF DUTY", () => {
    const off = sched(DAYSHIFT, [{ dateKey: "2026-11-04", kind: "off", start: null, end: null, note: "PTO" }]);
    expect(checkStop(off, { earliest: at(2026, 11, 4, 10), latest: at(2026, 11, 4, 10) }, TZ)?.flag).toBe("off_duty");
    expect(checkStop(off, { earliest: at(2026, 11, 5, 10), latest: at(2026, 11, 5, 10) }, TZ)).toBeNull();
  });
});

describe("a night shift belongs to the day it starts: Friday 3 AM is inside Thursday night", () => {
  const night = sched(wk((d) => (d === 4 ? { start: 22 * 60, end: 6 * 60 } : null))); // only Thursday 22:00 to Friday 06:00
  it("projects the tail into Friday morning", () => {
    const fri = blocksOnDay(night, "2026-11-06", TZ);
    expect(fri).toHaveLength(1);
    expect(fri[0]).toMatchObject({ tail: true, anchor: "2026-11-05" });
    expect(hhmm(fri[0]!.startMs, TZ)).toBe("22:00");
    expect(hhmm(fri[0]!.endMs, TZ)).toBe("06:00");
    expect(blocksOnDay(night, "2026-11-05", TZ).map((b) => b.tail)).toEqual([false]); // Thursday shows its own start
  });

  it("a delivery in Atlanta at 3:00 AM Friday is on shift, not OFF DUTY or BEFORE SHIFT START", () => {
    expect(checkStop(night, { earliest: at(2026, 11, 6, 3), latest: at(2026, 11, 6, 3) }, TZ)).toBeNull();
    expect(checkStop(night, { earliest: at(2026, 11, 6, 7), latest: at(2026, 11, 6, 7) }, TZ)).toMatchObject({ flag: "exceeds_end" });
    expect(checkStop(night, { earliest: at(2026, 11, 7, 3), latest: at(2026, 11, 7, 3) }, TZ)?.flag).toBe("off_duty"); // Saturday morning: no tail, no shift
  });

  it("an exception on Thursday takes Thursday's shift and its Friday tail away; one on Friday leaves the tail", () => {
    const thuOff = sched(night.week, [{ dateKey: "2026-11-05", kind: "off", start: null, end: null, note: null }]);
    expect(blocksOnDay(thuOff, "2026-11-06", TZ)).toEqual([]);
    const friOff = sched(night.week, [{ dateKey: "2026-11-06", kind: "off", start: null, end: null, note: null }]);
    expect(blocksOnDay(friOff, "2026-11-06", TZ)).toHaveLength(1);
  });

  it("wraps from Sunday night into Monday morning", () => {
    const sun = sched(wk((d) => (d === 0 ? { start: 22 * 60, end: 6 * 60 } : null)));
    expect(checkStop(sun, { earliest: at(2026, 11, 2, 3), latest: at(2026, 11, 2, 3) }, TZ)).toBeNull();
  });

  it("holds across the 1 November clock change (the night is 9 hours of work on the wall clock, 10 on the clock)", () => {
    const sat = sched(wk((d) => (d === 6 ? { start: 22 * 60, end: 6 * 60 } : null))); // Sat 31 Oct 22:00 to Sun 1 Nov 06:00
    const tail = blocksOnDay(sat, "2026-11-01", TZ);
    expect(tail).toHaveLength(1);
    expect(hhmm(tail[0]!.endMs, TZ)).toBe("06:00");
    expect(checkStop(sat, { earliest: at(2026, 11, 1, 5), latest: at(2026, 11, 1, 5) }, TZ)).toBeNull();
    expect(checkStop(sat, { earliest: at(2026, 11, 1, 7), latest: at(2026, 11, 1, 7) }, TZ)?.flag).toBe("exceeds_end");
  });
});

describe("a load is flagged by its first stop that does not fit", () => {
  const day = sched(DAYSHIFT);
  const stops = (p: Date, d: Date) => [
    { role: "pickup", earliest: p, latest: p },
    { role: "delivery", earliest: d, latest: d }
  ];
  it("names the stop and the edge it misses", () => {
    const f = checkLoad(day, stops(at(2026, 11, 3, 8), at(2026, 11, 3, 23)), TZ)!;
    expect(f).toMatchObject({ flag: "exceeds_end", role: "delivery" });
    expect(flagWords(f, TZ)).toBe("Delivery is after the shift ends at 6:00 PM.");
    expect(checkLoad(day, stops(at(2026, 11, 3, 8), at(2026, 11, 3, 15)), TZ)).toBeNull();
    expect(checkLoad(day, [{ role: "pickup", earliest: null, latest: null }], TZ)).toBeNull(); // no time, no judgement
  });
});

describe("cutting a schedule under booked freight", () => {
  const load = { loadId: "l1", loadNumber: "DM-40009", stops: [{ role: "delivery", earliest: at(2026, 11, 6, 10), latest: at(2026, 11, 6, 10) }] };
  it("reports a load the new schedule breaks that the old one did not", () => {
    const off = sched(DAYSHIFT, [{ dateKey: "2026-11-06", kind: "off", start: null, end: null, note: null }]);
    const out = conflictsIfChanged(sched(DAYSHIFT), off, [load], TZ);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ loadNumber: "DM-40009", flag: { flag: "off_duty" } });
  });
  it("says nothing when the load was already outside the old schedule, or still fits the new one", () => {
    const already = sched(DAYSHIFT, [{ dateKey: "2026-11-06", kind: "off", start: null, end: null, note: null }]);
    expect(conflictsIfChanged(already, sched(DAYSHIFT, [{ dateKey: "2026-11-06", kind: "off", start: null, end: null, note: "x" }]), [load], TZ)).toEqual([]);
    expect(conflictsIfChanged(sched(DAYSHIFT), sched(wk(() => ({ start: 0, end: 1440 }))), [load], TZ)).toEqual([]);
  });
  it("a driver with no schedule yet counts every booked load the first schedule breaks", () => {
    expect(conflictsIfChanged(null, sched(wk(() => null)), [load], TZ)).toHaveLength(1);
  });
});

describe("supply and demand per day", () => {
  const days = [2, 3, 4].map((d) => ({ key: `2026-11-0${d}`, start: centralInstant(2026, 10, d, 0, 0, TZ), end: centralInstant(2026, 10, d + 1, 0, 0, TZ) - 1 }));
  it("counts scheduled drivers on shift with nothing overlapping, and the drivers with no schedule apart", () => {
    const free = { schedule: sched(DAYSHIFT), busy: [] };
    const busyMon = { schedule: sched(DAYSHIFT), busy: [{ start: at(2026, 11, 2, 9).getTime(), end: at(2026, 11, 2, 11).getTime() }] };
    const off = { schedule: sched(wk(() => null)), busy: [] };
    const unset = { schedule: null, busy: [] };
    const out = dayBalance(days, [free, busyMon, off, unset], [2, 0, 1], TZ);
    expect(out.map((d) => d.available)).toEqual([1, 2, 2]);
    expect(out.map((d) => d.need)).toEqual([2, 0, 1]);
    expect(out.every((d) => d.unscheduled === 1)).toBe(true);
  });
  it("a night shift's tail counts for the next morning", () => {
    const night = { schedule: sched(wk((d) => (d === 1 ? { start: 22 * 60, end: 6 * 60 } : null))), busy: [] }; // Monday night only
    const out = dayBalance(days, [night], [0, 0, 0], TZ);
    expect(out.map((d) => d.available)).toEqual([1, 1, 0]); // Mon (own start) and Tue (tail)
  });
});

describe("typed shifts and stored weeks", () => {
  it("reads HH:MM, allows 24:00 as an end, and refuses nonsense", () => {
    expect(parseMinutes("06:00")).toBe(360);
    expect(parseMinutes("6:30")).toBe(390);
    expect(parseMinutes("24:00")).toBe(1440);
    expect(parseMinutes("24:30")).toBeNull();
    expect(parseMinutes("7")).toBeNull();
  });
  it("a shift needs different ends, wraps past midnight, and cautions over 14 hours", () => {
    expect(checkShift(360, 360)).toMatchObject({ ok: false });
    expect(checkShift(360, 1080)).toEqual({ ok: true, minutes: 720, caution: null });
    expect(checkShift(1320, 360)).toEqual({ ok: true, minutes: 480, caution: null });
    expect(checkShift(300, 1260)).toMatchObject({ ok: true, caution: expect.stringContaining("14-hour") });
    expect(shiftText({ start: 360, end: 1080 })).toBe("06:00–18:00 (12h)");
    expect(shiftText({ start: 1320, end: 360 })).toBe("22:00–06:00 (8h)");
  });
  it("a stored week must be seven good entries", () => {
    expect(parseWeek(DAYSHIFT)).toEqual(DAYSHIFT);
    expect(parseWeek([null, null])).toBeNull();
    expect(parseWeek(wk(() => ({ start: 5, end: 5 })))).toBeNull();
    expect(parseWeek("nope")).toBeNull();
    expect(h12(at(2026, 11, 3, 1, 30).getTime(), TZ)).toBe("1:30 AM");
  });
});

describe("what /quote says beside a driver", () => {
  const day = sched(DAYSHIFT);
  const NOW = at(2026, 11, 2, 9).getTime();
  const stops = (p: Date | null, d: Date | null) => [
    { role: "pickup", appointment: p?.getTime() ?? null },
    { role: "delivery", appointment: d?.getTime() ?? null }
  ];
  it("says nothing for a driver with no schedule", () => {
    expect(quoteShift(null, stops(at(2026, 11, 3, 8), at(2026, 11, 3, 23)), NOW, TZ)).toEqual({ tag: null, warn: null, title: null });
  });
  it("with no appointments typed it gives the hours and passes no judgement", () => {
    expect(quoteShift(day, stops(null, null), NOW, TZ)).toEqual({ tag: "Shift 06:00–18:00", warn: null, title: null });
    expect(quoteShift(sched(wk(() => null)), stops(null, null), NOW, TZ).tag).toBe("Off duty");
  });
  it("a typed delivery after the shift is a past-shift caution with the edge; one inside it is quiet", () => {
    const late = quoteShift(day, stops(at(2026, 11, 3, 8), at(2026, 11, 3, 23)), NOW, TZ);
    expect(late.tag).toBe("Shift 06:00–18:00");
    expect(late.warn).toBe("Past shift end (6:00 PM)");
    expect(late.title).toBe("Delivery is after the shift ends at 6:00 PM.");
    expect(quoteShift(day, stops(at(2026, 11, 3, 8), at(2026, 11, 3, 15)), NOW, TZ).warn).toBeNull();
  });
  it("a pickup on a day off reads Off duty that day", () => {
    const sat = quoteShift(day, stops(at(2026, 11, 7, 9), at(2026, 11, 7, 15)), NOW, TZ);
    expect(sat.tag).toBe("Off duty");
    expect(sat.warn).toBe("Off duty that day");
  });
});
