import { describe, expect, it } from "vitest";
import { validateComplete, validateCorrection, validateStart } from "../src/lib/trip";
import { toEditValues, validateLoadEdit } from "../src/lib/load-edit";

// 2026-12-02 15:00 UTC: 9:00 AM in Chicago (CST), 10:00 AM in New York (EST), 7:00 AM in Los Angeles (PST).
const NOW = Date.parse("2026-12-02T15:00:00Z");
const ET = "America/New_York";
const PT = "America/Los_Angeles";
const CT = "America/Chicago";

describe("a time typed for a stop is the dock's time", () => {
  it("an arrival typed for a Boston pickup is read on Eastern time", () => {
    const out = validateStart({ arrivedAt: "2026-12-02T08:15", waitMinutes: "", seal: "", zone: ET }, NOW);
    expect(out.ok && out.value.arrivedAt.toISOString()).toBe("2026-12-02T13:15:00.000Z");
  });

  it("a Los Angeles dock is eight hours behind UTC", () => {
    const out = validateStart({ arrivedAt: "2026-12-02T06:15", waitMinutes: "", seal: "", zone: PT }, NOW);
    expect(out.ok && out.value.arrivedAt.toISOString()).toBe("2026-12-02T14:15:00.000Z");
  });

  it("with no zone it is the carrier's clock, as before", () => {
    const out = validateStart({ arrivedAt: "2026-12-02T08:15", waitMinutes: "", seal: "" }, NOW);
    expect(out.ok && out.value.arrivedAt.toISOString()).toBe("2026-12-02T14:15:00.000Z");
  });

  it("'in the future' is judged at the dock: 9:05 is past in Boston and ahead in Los Angeles", () => {
    expect(validateStart({ arrivedAt: "2026-12-02T09:05", waitMinutes: "", seal: "", zone: ET }, NOW).ok).toBe(true);
    const out = validateStart({ arrivedAt: "2026-12-02T09:05", waitMinutes: "", seal: "", zone: PT }, NOW);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.errors.arrivedAt).toMatch(/future/);
  });

  it("each stop of a delivery, and the delivery itself, is read on its own clock", () => {
    const out = validateComplete(
      {
        stops: [{ id: "s2", arrivedAt: "2026-12-02T08:00", waitMinutes: "", seal: "", zone: ET }],
        deliveredAt: "2026-12-02T08:30",
        deliveredZone: CT,
        pod: "received",
        podNote: "",
        fuel: "",
        tolls: "",
        misc: ""
      },
      NOW
    );
    if (!out.ok) throw new Error(JSON.stringify(out.errors));
    expect(out.value.stops[0]!.arrivedAt!.toISOString()).toBe("2026-12-02T13:00:00.000Z");
    expect(out.value.deliveredAt.toISOString()).toBe("2026-12-02T14:30:00.000Z");
  });

  it("a correction reads each stop's arrival on that stop's clock", () => {
    const out = validateCorrection({ stops: [{ id: "a", arrivedAt: "2026-12-02T08:00", waitMinutes: "", zone: ET }, { id: "b", arrivedAt: "2026-12-02T06:00", waitMinutes: "", zone: PT }], reason: "wrong day" }, NOW);
    if (!out.ok) throw new Error(JSON.stringify(out.errors));
    expect(out.value.stops.map((s) => s.arrivedAt!.toISOString())).toEqual(["2026-12-02T13:00:00.000Z", "2026-12-02T14:00:00.000Z"]);
  });
});

describe("the edit form shows and reads a stop's window on the same clock", () => {
  const stored = (opens: Date, closes: Date) => ({
    vehicleId: null, quotedRevenue: "900", fuelSurcharge: null, loadedMiles: "300", pickupDeadheadMiles: null, returnDeadheadMiles: null, brokerName: "Acme", brokerMcNumber: null, brokerPhone: null, brokerEmail: null,
    loadNumber: "T-1", poNumber: null, trailerType: null, weightLbs: null, lengthFt: null, widthFt: null, loadHeightIn: null, hazmatClass: null, requiresLiftgate: null, requiresRamp: null, requiresPalletJack: null,
    payTermsDays: null, notes: null,
    stops: [
      { id: "p1", stopRole: "pickup", stopType: "pickup", addressString: "Boston, MA", facilityName: null, timeWindowEarliest: opens, timeWindowLatest: closes, referenceNumbers: [], contactName: null, contactPhone: null, stopNotes: null }
    ]
  });
  const OPENS = new Date("2026-12-04T14:00:00Z"); // 9:00 AM Boston
  const CLOSES = new Date("2026-12-04T16:00:00Z"); // 11:00 AM Boston

  it("the dock's wall time is shown for an Eastern stop", () => {
    const v = toEditValues(stored(OPENS, CLOSES), { p1: ET });
    expect(v.stops[0]).toMatchObject({ earliest: "2026-12-04T09:00", latest: "2026-12-04T11:00", zone: ET });
  });

  it("what the form shows reads back to the same instants, so saving without a change moves nothing", () => {
    const v = toEditValues(stored(OPENS, CLOSES), { p1: ET });
    const out = validateLoadEdit(v);
    if (!out.ok) throw new Error(JSON.stringify(out.errors));
    expect(out.value.stops[0]!.earliest!.toISOString()).toBe(OPENS.toISOString());
    expect(out.value.stops[0]!.latest!.toISOString()).toBe(CLOSES.toISOString());
  });

  it("without zones it is the carrier's clock, as before", () => {
    const v = toEditValues(stored(OPENS, CLOSES));
    expect(v.stops[0]).toMatchObject({ earliest: "2026-12-04T08:00", zone: null });
  });
});
