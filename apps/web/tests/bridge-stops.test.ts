import { describe, expect, it } from "vitest";
import { checkCallPlace, deskOwned, stopChange } from "@/server/bridge/stops";
import { deriveTimeline } from "@/lib/desk-timeline";

const T = "2026-11-22T15:00:00.000Z";
const blank = { arrivedAt: null, waitMinutes: null, sealNumber: null, arrivedSource: null };
const ev = (kind: string, over: Record<string, unknown> = {}) => ({ kind, at: T, wait_minutes: null, seal: null, ...over });

describe("who owns a stop's times (sync plan Step 2)", () => {
  it("a dispatcher's entry, or a time from before the source was kept, is the desk's; blank or the phone's is not", () => {
    expect(deskOwned({ ...blank, arrivedSource: "desk" })).toBe(true);
    expect(deskOwned({ ...blank, arrivedAt: new Date(T) })).toBe(true);
    expect(deskOwned({ ...blank, arrivedAt: new Date(T), arrivedSource: "phone" })).toBe(false);
    expect(deskOwned(blank)).toBe(false);
  });
});

describe("what a stop event changes", () => {
  it("an arrival fills a blank stop and makes it the phone's", () => {
    expect(stopChange(ev("arrived"), blank)).toEqual({ data: { arrivedAt: new Date(T), arrivedSource: "phone" }, clash: null });
  });
  it("replaces the phone's own earlier value (the start time standing in for the arrival)", () => {
    const held = { ...blank, arrivedAt: new Date("2026-11-22T13:00:00Z"), arrivedSource: "phone" };
    expect(stopChange(ev("arrived"), held).data).toEqual({ arrivedAt: new Date(T), arrivedSource: "phone" });
  });
  it("never overwrites a dispatcher's entry: a different time is a clash, the same minute is nothing", () => {
    const desk = { ...blank, arrivedAt: new Date("2026-11-22T14:00:00Z"), arrivedSource: "desk" };
    const c = stopChange(ev("arrived"), desk);
    expect(c.data).toBeNull();
    expect(c.clash).toMatch(/^arrived .* \(the desk has .*\)$/);
    expect(stopChange(ev("arrived"), { ...desk, arrivedAt: new Date(Date.parse(T) + 30_000) })).toEqual({ data: null, clash: null });
  });
  it("leaving loaded carries the measured wait and the seal; a blank the desk left is filled without taking the stop over", () => {
    expect(stopChange(ev("loaded", { wait_minutes: 45, seal: "S-1" }), { ...blank, arrivedAt: new Date(T), arrivedSource: "phone" }).data).toEqual({ waitMinutes: 45, sealNumber: "S-1", arrivedSource: "phone" });
    const desk = { ...blank, arrivedAt: new Date(T), arrivedSource: "desk" };
    expect(stopChange(ev("loaded", { wait_minutes: 45, seal: "S-1" }), desk)).toEqual({ data: { waitMinutes: 45, sealNumber: "S-1" }, clash: null });
    expect(stopChange(ev("loaded", { wait_minutes: 45, seal: "S-1" }), { ...desk, waitMinutes: 30, sealNumber: "S-9" }).clash).toBe("waited 45 min (the desk has 30 min); seal S-1 (the desk has S-9)");
  });
  it("leaving empty carries the wait, never a seal", () => {
    expect(stopChange(ev("emptied", { wait_minutes: 20, seal: "X" }), blank).data).toEqual({ waitMinutes: 20, arrivedSource: "phone" });
  });
  it("an arrival taken back clears only the phone's own arrival", () => {
    expect(stopChange(ev("arrival_undone"), { ...blank, arrivedAt: new Date(T), arrivedSource: "phone" }).data).toEqual({ arrivedAt: null, arrivedSource: "phone" });
    expect(stopChange(ev("arrival_undone"), { ...blank, arrivedAt: new Date(T), arrivedSource: "desk" })).toEqual({ data: null, clash: null });
  });
});

describe("a check call's place", () => {
  it("names the nearest town within 60 miles, with the position", () => {
    expect(checkCallPlace(35.222, -101.831)).toMatch(/Amarillo, TX \(35\.2220, -101\.8310\)$/);
  });
  it("is the position alone far from any town", () => {
    expect(checkCallPlace(0, -140)).toBe("0.0000, -140.0000");
  });
});

describe("Load Progress, stop by stop", () => {
  const base = { createdAt: new Date(T), completedAt: null, invoicedAt: null, paidAt: null, paymentStatus: null, firstArrivedAt: new Date(T), assignment: { status: "in_progress", createdAt: new Date(T), dispatchedAt: new Date(T), respondedAt: new Date(T) } };
  it("puts a step per stop between on the road and delivered; the next stop not reached is current", () => {
    const steps = deriveTimeline({ ...base, status: "in_progress", stops: [{ sequence: 1, role: "pickup", arrivedAt: new Date(T), waitMinutes: 45, fromPhone: true }, { sequence: 2, role: "delivery", arrivedAt: null, waitMinutes: null, fromPhone: false }] });
    expect(steps.map((s) => [s.key, s.state])).toEqual([["drafted", "done"], ["assigned", "done"], ["sent", "done"], ["answered", "done"], ["road", "done"], ["stop-1", "done"], ["stop-2", "current"], ["delivered", "pending"], ["invoiced", "pending"], ["paid", "pending"]]);
    expect(steps.find((s) => s.key === "stop-1")).toMatchObject({ label: "Stop 1 · Pickup", note: "waited 45 min · from the driver's phone" });
  });
  it("a delivered load has reached every stop", () => {
    const steps = deriveTimeline({ ...base, status: "completed", completedAt: new Date(T), stops: [{ sequence: 1, role: "pickup", arrivedAt: null, waitMinutes: null, fromPhone: false }] });
    expect(steps.find((s) => s.key === "stop-1")?.state).toBe("done");
  });
  it("no stops given: the eight steps as before", () => {
    expect(deriveTimeline({ ...base, status: "in_progress" })).toHaveLength(8);
  });
});
