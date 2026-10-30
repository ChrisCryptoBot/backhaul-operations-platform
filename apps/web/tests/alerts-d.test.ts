import { describe, expect, test } from "vitest";
import { RULES, deriveAlerts, type AlertLoad } from "@/lib/alerts";
import { summarizeDetention } from "@/lib/detention";

const NOW = new Date("2027-03-10T15:00:00Z");
const h = (n: number) => new Date(NOW.getTime() + n * 3_600_000);
const driver = { id: "d1", name: "Pat", cdlExpiry: h(24 * 400), medicalCardExpiry: h(24 * 400) };
const load = (over: Partial<AlertLoad>): AlertLoad => ({
  id: "L1", loadNumber: "L-1", status: "draft", paymentStatus: null, invoiceNumber: null, invoicedAt: null, payTermsDays: null, verdict: null, hasTruck: true,
  stops: [{ timeWindowEarliest: h(-10), timeWindowLatest: h(-8), referenceNumbers: ["PU1"] }, { timeWindowEarliest: h(10), timeWindowLatest: h(12), referenceNumbers: ["DL1"] }],
  assignment: null, ...over
});
const codes = (l: AlertLoad[]) => deriveAlerts(l, NOW).map((a) => `${a.loadId}:${a.code}`);

describe("the alerts added for the desk's own gaps", () => {
  test("a pickup window that closed with the driver holding the load and no pickup entered is late to pickup; once the load is on the road it is not", () => {
    const sent = load({ assignment: { status: "dispatched", dispatchedAt: h(-30), driver } });
    expect(codes([sent])).toContain("L1:LATE_TO_PICKUP");
    expect(codes([load({ status: "accepted", assignment: { status: "accepted", dispatchedAt: h(-30), driver } })])).toContain("L1:LATE_TO_PICKUP");
    expect(codes([load({ status: "in_progress", assignment: { status: "in_progress", dispatchedAt: h(-30), driver } })])).not.toContain("L1:LATE_TO_PICKUP");
    expect(codes([load({ assignment: null })])).not.toContain("L1:LATE_TO_PICKUP"); // no driver: the pickup-no-driver block covers it
    expect(codes([load({ assignment: { status: "declined", dispatchedAt: h(-30), driver } })])).not.toContain("L1:LATE_TO_PICKUP");
    const future = load({ stops: [{ timeWindowEarliest: h(5), timeWindowLatest: h(7), referenceNumbers: ["PU1"] }], assignment: { status: "dispatched", dispatchedAt: h(-1), driver } });
    expect(codes([future])).not.toContain("L1:LATE_TO_PICKUP");
  });

  test("one truck on two open loads whose windows overlap is a block on both, whoever drives; a day apart is fine", () => {
    const veh = { id: "v1", name: "Unit 7" };
    const a = load({ id: "A", loadNumber: "A-1", vehicle: veh, stops: [{ timeWindowEarliest: h(2), timeWindowLatest: h(3), referenceNumbers: [] }, { timeWindowEarliest: h(9), timeWindowLatest: h(10), referenceNumbers: [] }] });
    const b = load({ id: "B", loadNumber: "B-1", vehicle: veh, stops: [{ timeWindowEarliest: h(5), timeWindowLatest: h(6), referenceNumbers: [] }, { timeWindowEarliest: h(12), timeWindowLatest: h(13), referenceNumbers: [] }] });
    expect(codes([a, b])).toEqual(expect.arrayContaining(["A:TRUCK_DOUBLE_BOOKED", "B:TRUCK_DOUBLE_BOOKED"]));
    const later = load({ id: "C", loadNumber: "C-1", vehicle: veh, stops: [{ timeWindowEarliest: h(50), timeWindowLatest: h(51), referenceNumbers: [] }, { timeWindowEarliest: h(60), timeWindowLatest: h(61), referenceNumbers: [] }] });
    expect(codes([a, later])).not.toContain("A:TRUCK_DOUBLE_BOOKED");
    expect(codes([a, { ...b, vehicle: { id: "v2", name: "Unit 8" } }])).not.toContain("A:TRUCK_DOUBLE_BOOKED");
    expect(codes([a, { ...b, status: "completed" }])).not.toContain("A:TRUCK_DOUBLE_BOOKED");
  });

  test("a delivery closed with no proof of delivery is flagged; one with proof is not", () => {
    expect(codes([load({ status: "completed", closedWithoutPod: true })])).toContain("L1:MISSING_POD");
    expect(codes([load({ status: "completed", closedWithoutPod: false })])).not.toContain("L1:MISSING_POD");
    expect(codes([load({ status: "completed", closedWithoutPod: null })])).not.toContain("L1:MISSING_POD");
  });

  test("the rules page lists every code the alerts can raise", () => {
    const listed = RULES.map((r) => r.code);
    for (const c of ["LATE_TO_PICKUP", "TRUCK_DOUBLE_BOOKED", "MISSING_POD"]) expect(listed).toContain(c);
    expect(new Set(listed).size).toBe(listed.length);
  });
});

describe("what an invoice carried as detention", () => {
  const base = { stops: [{ stopSequence: 1, stopType: "pickup", waitMinutes: 240 }, { stopSequence: 2, stopType: "delivery", waitMinutes: 0 }], dockWaitMinutes: null, rate: 50, graceMinutes: 120, workspaceGraceMinutes: 120 };
  const inv = (lines: Array<{ label: string; amount: number }> | null, total: number) => ({ invoiced: true, invoicedAmount: total, quotedRevenue: 1000, fuelSurcharge: 0, lines });

  test("only the Detention line is detention: a lumper or layover charge on the same invoice is not, so detention still owed is not hidden by it", () => {
    const lumperOnly = summarizeDetention({ ...base, invoice: inv([{ label: "Line haul", amount: 1000 }, { label: "Lumper", amount: 100 }], 1100) });
    expect(lumperOnly.billedExtra).toBe(0);
    expect(lumperOnly.unbilled).toBe(lumperOnly.billable);
    expect(lumperOnly.billable).toBeGreaterThan(0);
    const withDetention = summarizeDetention({ ...base, invoice: inv([{ label: "Line haul", amount: 1000 }, { label: "Detention", amount: 100 }, { label: "Lumper", amount: 75 }], 1175) });
    expect(withDetention.billedExtra).toBe(100);
    expect(withDetention.unbilled).toBe(Math.max(0, withDetention.billable - 100));
  });

  test("an invoice made before lines were kept reads whatever is above the rate as detention, as it always did; one not invoiced has none billed", () => {
    expect(summarizeDetention({ ...base, invoice: inv(null, 1100) }).billedExtra).toBe(100);
    expect(summarizeDetention({ ...base, invoice: { invoiced: false, invoicedAmount: null, quotedRevenue: 1000, fuelSurcharge: 0, lines: null } }).billedExtra).toBe(0);
  });
});
