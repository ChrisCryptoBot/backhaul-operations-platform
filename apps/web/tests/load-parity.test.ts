import { describe, expect, it } from "vitest";
import { searchBoard } from "../src/lib/board-filter";
import { deriveAlerts, POD_ALERT_DAYS, type AlertLoad } from "../src/lib/alerts";
import { invoiceReadiness } from "../src/lib/invoicing";
import { otherExpenseTotal, validateCorrection, validateExpenses } from "../src/lib/trip";

/** The phone's minimum abilities on the desk: search that reads like a person types, itemised costs, miles, corrections, and the proof-of-delivery file alert. */
const row = (over: Record<string, unknown>) => ({ status: "draft", verdict: null, loadNumber: null, brokerName: null, origin: null, destination: null, vehicleName: null, driverName: null, ...over });

describe("board search", () => {
  const rows = [row({ loadNumber: "DM-40013", brokerName: "Sample Freight Co", origin: "Dallas, TX", destination: "Tulsa, OK" }), row({ loadNumber: "DM-40014", brokerName: "Northline", origin: "Austin, TX", destination: "Dallas, TX" })];
  it("needs every word, in any order, ignoring punctuation", () => {
    expect(searchBoard(rows, "tx dallas").length).toBe(2);
    expect(searchBoard(rows, "dallas tulsa")).toHaveLength(1);
    expect(searchBoard(rows, "Dallas, TX")).toHaveLength(2);
  });
  it("finds a load number typed with or without its dash", () => {
    expect(searchBoard(rows, "dm-40013")).toHaveLength(1);
    expect(searchBoard(rows, "dm40013")).toHaveLength(1);
    expect(searchBoard(rows, "40014 northline")).toHaveLength(1);
  });
  it("keeps everything for a blank search and nothing for a word that is not there", () => {
    expect(searchBoard(rows, "  ")).toHaveLength(2);
    expect(searchBoard(rows, "tulsa austin")).toHaveLength(0);
  });
});

describe("expenses with items, a rider, miles and a note", () => {
  const base = { fuel: "100", tolls: "", misc: "10" };
  it("adds the items to other and keeps only the ones typed", () => {
    const ok = validateExpenses({ ...base, items: { lumper: "75", parking: "20.50", wash: "" } });
    expect(ok.ok && ok.value.items).toEqual({ lumper: 75, parking: 20.5 });
    expect(ok.ok && otherExpenseTotal(ok.value)).toBe(105.5);
  });
  it("refuses a bad item, rider or miles figure with the field named", () => {
    const bad = validateExpenses({ ...base, items: { scale: "abc" }, rider: "-5", miles: { pickup: "7000", loaded: "250.123", home: "" } });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(Object.keys(bad.errors).sort()).toEqual(["item.scale", "miles.pickup", "rider"]);
  });
  it("leaves out whatever was not typed, so a blank keeps what the load has", () => {
    const ok = validateExpenses({ ...base, rider: "", revenueNote: " ", miles: { pickup: "", loaded: "", home: "" } });
    expect(ok.ok && ok.value).toEqual({ fuel: 100, tolls: 0, misc: 10, layover: 0 });
  });
  it("takes miles to four places, the way the load stores them", () => {
    const ok = validateExpenses({ ...base, miles: { pickup: "25", loaded: "257.2", home: "0.1234" }, backhaul: true, tonuMiles: "30" });
    expect(ok.ok && ok.value).toMatchObject({ miles: { pickup: 25, loaded: 257.2, home: 0.1234 }, backhaul: true, tonuMiles: 30 });
  });
});

describe("correcting waits and seals", () => {
  const stops = [{ id: "a", arrivedAt: "2026-10-01T08:00", waitMinutes: "45", seal: "S-1" }];
  it("needs a reason and checks each stop", () => {
    expect(validateCorrection({ stops, reason: "" }).ok).toBe(false);
    const bad = validateCorrection({ stops: [{ id: "a", arrivedAt: "2026-10-01T08:00", waitMinutes: "-3", seal: "x".repeat(31) }], reason: "typo" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(Object.keys(bad.errors).sort()).toEqual(["stop0.seal", "stop0.waitMinutes"]);
  });
  it("carries the load's own detention terms only when typed", () => {
    const ok = validateCorrection({ stops, reason: "Rate con says $75 after 90 min", detentionRate: "75", detentionGraceMinutes: "90" });
    expect(ok.ok && ok.value).toMatchObject({ detentionRate: 75, detentionGraceMinutes: 90 });
    const blank = validateCorrection({ stops, reason: "seal typo" });
    expect(blank.ok && blank.value.detentionRate).toBeUndefined();
  });
});

describe("the proof of delivery file", () => {
  const NOW = new Date("2026-10-31T12:00:00Z");
  const delivered = (daysAgo: number, over: Partial<AlertLoad> = {}): AlertLoad => ({
    id: "L1", loadNumber: "L1", status: "completed", paymentStatus: null, invoiceNumber: null, invoicedAt: null, payTermsDays: null, verdict: null, stops: [], assignment: null,
    completedAt: new Date(NOW.getTime() - daysAgo * 86_400_000), podStopsMissing: 1, deliveryStops: 1, ...over
  });
  const pod = (l: AlertLoad) => deriveAlerts([l], NOW).filter((a) => a.code === "MISSING_POD");
  it("is flagged once a delivered load has gone three weeks without one", () => {
    expect(pod(delivered(POD_ALERT_DAYS - 1))).toHaveLength(0);
    expect(pod(delivered(POD_ALERT_DAYS))).toHaveLength(1);
  });
  it("names how many delivery stops are missing it on a load with more than one", () => {
    expect(pod(delivered(30, { podStopsMissing: 1, deliveryStops: 3 }))[0]!.message).toMatch(/1 of 3 delivery stops/);
  });
  it("is quiet when the file is there, or the load was closed without one on purpose (that has its own flag)", () => {
    expect(pod(delivered(30, { podStopsMissing: 0 }))).toHaveLength(0);
    expect(pod(delivered(30, { closedWithoutPod: true })).map((a) => a.level)).toEqual(["info"]);
  });
  it("is a caution on the invoice, and silent when the answer is not known", () => {
    const load = { loadNumber: "L1", brokerName: "Acme", brokerEmail: "ap@acme.test", brokerPhone: null, deliveredAt: new Date(), status: "completed", closedWithoutPod: false, podNote: "signed", quotedRevenue: 1000 };
    expect(invoiceReadiness({ ...load, podStopsMissing: 1 } as never).cautions.join(" ")).toMatch(/No proof of delivery file/);
    expect(invoiceReadiness({ ...load, podStopsMissing: 0 } as never).cautions.join(" ")).not.toMatch(/proof of delivery/);
    expect(invoiceReadiness({ ...load } as never).cautions.join(" ")).not.toMatch(/proof of delivery/);
  });
});
