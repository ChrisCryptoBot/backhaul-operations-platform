import { describe, expect, it } from "vitest";
import { demoKeyOf, readRateCon } from "@/server/ratecon/reader";
import { assertSavable, ReviewRequiredError, type ReviewedDraft } from "@/server/ratecon/save";

/** The two fictional sample rate cons, read through the canned path: same normalizer as a live reading, no key. */
describe("rate-con reader (demo readings)", () => {
  it("recognises the demo files by name", () => {
    expect(demoKeyOf("RC-AFB-482913_dallas-to-houston_cargo-van.pdf")).toBe("RC-AFB-482913");
    expect(demoKeyOf("some-real-ratecon.pdf")).toBeNull();
  });

  it("reads the simple one: one pickup, one delivery, $800", async () => {
    const out = await readRateCon({ fileName: "RC-AFB-482913_dallas-to-houston_cargo-van.pdf" }, {});
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.source).toBe("demo");
    const { load, stops } = out.draft;
    expect(load.brokerName).toBe("Acme Freight Brokers");
    expect(load.loadNumber).toBe("AFB-482913");
    expect(load.poNumber).toBe("5521084");
    expect(load.quotedRevenue).toBe(800);
    // The $60 surcharge is inside the $800, and the load must not carry it a second time: its surcharge field is a per-mile or percent rate.
    expect(load).not.toHaveProperty("fuelSurcharge");
    expect(out.draft.printed.fuelSurchargeIncluded).toBe(60);
    expect(out.draft.printed.dockTerms).toMatch(/TONU \$100/);
    expect(out.draft.printed.detentionHourlyRate).toBe(45);
    expect(out.draft.printed.commodity).toBe("Palletized goods");
    expect(load.loadedMiles).toBe(242);
    expect(load.payTermsDays).toBe(30);
    expect(load.originAddress).toBe("Dallas, TX");
    expect(load.destinationAddress).toBe("Houston, TX");
    expect(load.pickupNumbers).toEqual(["PU-77410"]);
    expect(load.deliveryNumbers).toEqual(["DL-3390"]);
    expect(stops).toHaveLength(2);
    expect(stops[0]!.timeWindowEarliest?.toISOString()).toBe("2026-11-10T15:00:00.000Z");
    expect(stops[1]!.stopType).toBe("delivery");
  });

  it("reads the multi-stop one: a pickup and two deliveries with windows, $640", async () => {
    const out = await readRateCon({ fileName: "RC-RDL-77315_fort-worth-waco-austin_box-truck.pdf" }, {});
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const { load, stops } = out.draft;
    expect(load.quotedRevenue).toBe(640);
    expect(load.stopsCount).toBe(3);
    expect(stops.map((s) => s.stopType)).toEqual(["pickup", "delivery", "delivery"]);
    expect(stops[0]!.timeWindowEarliest?.toISOString()).toBe("2026-11-12T13:00:00.000Z");
    expect(stops[0]!.timeWindowLatest?.toISOString()).toBe("2026-11-12T15:00:00.000Z");
    expect(load.payTermsDays).toBe(21);
  });

  it("never carries a verdict: a rate confirmation is for a load already accepted", async () => {
    const out = await readRateCon({ fileName: "RC-AFB-482913.pdf" }, {});
    if (!out.ok) throw new Error("expected a reading");
    expect(JSON.stringify(out.draft)).not.toMatch(/verdict|reject|accept|floor|margin/i);
  });

  it("does not guess without a key or for a file it cannot read", async () => {
    expect(await readRateCon({ fileName: "unknown.pdf", mime: "application/pdf", bytes: new Uint8Array([1]) }, {})).toEqual({ ok: false, reason: "no_key" });
    expect(await readRateCon({ fileName: "unknown.docx" }, { ANTHROPIC_API_KEY: "x" })).toEqual({ ok: false, reason: "unsupported_file" });
  });
});

describe("the review gate", () => {
  const base = async (): Promise<ReviewedDraft> => {
    const out = await readRateCon({ fileName: "RC-AFB-482913.pdf" }, {});
    if (!out.ok) throw new Error("expected a reading");
    return { ...out.draft, confirmed: false };
  };

  it("refuses to save a draft nobody confirmed", async () => {
    const d = await base();
    expect(() => assertSavable(d)).toThrow(ReviewRequiredError);
  });

  it("saves once confirmed, and still needs a rate and a stop", async () => {
    const d = await base();
    expect(() => assertSavable({ ...d, confirmed: true })).not.toThrow();
    expect(() => assertSavable({ ...d, confirmed: true, load: { ...d.load, quotedRevenue: null } })).toThrow(/rate/);
    expect(() => assertSavable({ ...d, confirmed: true, stops: [] })).toThrow(/stop/);
  });
});
