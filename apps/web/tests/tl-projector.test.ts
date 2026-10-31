import { describe, expect, it } from "vitest";
import { assertDriverSafe, payEstimate, projectLoadToSummary, type ProjectableLoad } from "@/server/tl/projector";

const load: ProjectableLoad = {
  loadNumber: "DM-40021",
  poNumber: "PO-88213",
  brokerName: "Sample Freight Co",
  trailerType: "dry_van",
  originAddress: "Harrisburg, PA",
  destinationAddress: "Columbus, OH",
  loadedMiles: 257.2,
  estimatedHours: 6,
  stops: [
    { stopSequence: 1, stopType: "pickup", addressString: "Harrisburg, PA", timeWindowEarliest: new Date("2026-10-20T12:00:00Z"), timeWindowLatest: new Date("2026-10-20T14:00:00Z"), referenceNumbers: ["PU-1001"] },
    { stopSequence: 2, stopType: "delivery", addressString: "Columbus, OH", timeWindowEarliest: new Date("2026-10-21T13:00:00Z"), timeWindowLatest: new Date("2026-10-21T15:00:00Z"), referenceNumbers: ["DEL-2002"], stopNotes: "Dock 4" }
  ]
};

describe("driver payload projector", () => {
  it("pays the estimate by kind: flat = rate, cpm = rate x loaded miles, hourly = rate x hours", () => {
    expect(payEstimate({ kind: "flat", rate: 400 }, 257.2, 6)).toBe(400);
    expect(payEstimate({ kind: "cpm", rate: 0.65 }, 257.2, 6)).toBe(167.18);
    expect(payEstimate({ kind: "hourly", rate: 28 }, 257.2, 6)).toBe(168);
  });

  it("builds origin, destination, stops, equipment, pay and reference", () => {
    const s = projectLoadToSummary(load, { kind: "cpm", rate: 0.65 });
    expect(s.schema).toBe(3);
    expect(s.origin?.address).toBe("Harrisburg, PA");
    expect(s.destination?.address).toBe("Columbus, OH");
    expect(s.driver_pay).toEqual({ kind: "cpm", rate: 0.65, estimate: 167.18 });
    expect(s.reference).toEqual({ broker_name: "Sample Freight Co", load_number: "DM-40021" });
    expect(s.equipment.trailer_type).toBe("dry_van");
  });

  it("passes the confidentiality gate: no revenue, margin, cost or rate-con key, and no secret value under any key", () => {
    const s = projectLoadToSummary(load, { kind: "cpm", rate: 0.65 });
    expect(() => assertDriverSafe(s, { numbers: [650, 1.19, 149, 799] })).not.toThrow();
  });

  it("fails the gate when a forbidden key or a secret value leaks", () => {
    const s = projectLoadToSummary(load, { kind: "flat", rate: 400 });
    expect(() => assertDriverSafe({ ...s, quoted_revenue: 650 } as never)).toThrow(/leaks keys/);
    expect(() => assertDriverSafe({ ...s, stops: [{ seq: 2, type: "delivery", address: "B", dock_notes: "Rate is $650 flat" }] } as never, { numbers: [650] })).toThrow(/secret value/);
    // Coincidences are not leaks: a time of 13:45, miles of 45, the broker's own load number or the driver's own pay equal to a surcharge of 45 or a rate of 650.
    const same = { ...s, reference: { ...s.reference, load_number: "650" }, miles: { loaded: 45 }, origin: { address: "A", window_earliest: "2026-11-02T13:45:00.000Z", window_latest: "2026-11-02T15:45:00Z" } };
    expect(() => assertDriverSafe(same as never, { numbers: [650, 45] })).not.toThrow();
    expect(() => assertDriverSafe({ ...s, driver_pay: { ...s.driver_pay, margin: 1 } as never })).toThrow();
  });
});
