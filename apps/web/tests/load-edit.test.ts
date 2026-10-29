import { describe, expect, it } from "vitest";
import { toEditValues, validateLoadEdit, type LoadEditValues } from "../src/lib/load-edit";

const base = (): LoadEditValues => ({
  brokerName: "Acme Freight",
  brokerMc: "MC-123456",
  brokerPhone: "555-0142",
  brokerEmail: "ap@acme.example",
  loadNumber: "AF-1",
  poNumber: " PO-9 ",
  trailer: "",
  weightLbs: "12,000",
  lengthFt: "40",
  widthFt: "8",
  heightIn: "96",
  hazmat: "",
  liftgate: false,
  ramp: true,
  palletJack: false,
  payTermsDays: "30",
  notes: "",
  stops: [
    { id: "s1", role: "pickup", address: "100 Dock Rd, Dallas, TX", facility: "Dock A", earliest: "2026-10-30T08:00", latest: "2026-10-30T10:00", refs: "PU-1, PU-2", contactName: "", contactPhone: "", notes: "" },
    { id: "s2", role: "delivery", address: "9 Main St, Memphis, TN", facility: "", earliest: "2026-10-31T08:00", latest: "", refs: "", contactName: "Sam", contactPhone: "(901) 555-0100", notes: "" }
  ]
});

describe("validateLoadEdit", () => {
  it("accepts a good form and tidies it: MC prefix and commas dropped, blanks become null, refs split", () => {
    const out = validateLoadEdit(base());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value).toMatchObject({ brokerMc: "123456", poNumber: "PO-9", weightLbs: 12000, ramp: true, hazmat: null, notes: null, payTermsDays: 30 });
    expect(out.value.stops[0]!.refs).toEqual(["PU-1", "PU-2"]);
    expect(out.value.stops[1]!.latest).toBeNull();
    // 8:00 on the Dallas clock in late October is 13:00 UTC.
    expect(out.value.stops[0]!.earliest!.toISOString()).toBe("2026-10-30T13:00:00.000Z");
  });

  it("names each wrong field next to where it is, and saves nothing", () => {
    const v = base();
    v.brokerMc = "12";
    v.brokerEmail = "not an email";
    v.weightLbs = "90000";
    v.payTermsDays = "7.5";
    v.stops[0]!.address = "x";
    v.stops[1]!.earliest = "2026-10-31T08:00";
    v.stops[1]!.latest = "2026-10-31T06:00";
    v.stops[1]!.contactPhone = "abc";
    const out = validateLoadEdit(v);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(Object.keys(out.errors).sort()).toEqual(["brokerEmail", "brokerMc", "payTermsDays", "stop0.address", "stop1.contactPhone", "stop1.latest", "weightLbs"]);
  });

  it("a window that closes with no opening time asks for the opening", () => {
    const v = base();
    v.stops[1]!.earliest = "";
    v.stops[1]!.latest = "2026-10-31T10:00";
    const out = validateLoadEdit(v);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.errors["stop1.earliest"]).toMatch(/opens/);
  });

  it("more than ten references on a stop is refused", () => {
    const v = base();
    v.stops[0]!.refs = Array.from({ length: 11 }, (_, i) => `R${i}`).join(",");
    const out = validateLoadEdit(v);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.errors["stop0.refs"]).toBeDefined();
  });

  it("an unknown trailer is refused", () => {
    const v = base();
    v.trailer = "hovercraft";
    const out = validateLoadEdit(v);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.errors.trailer).toBeDefined();
  });
});

describe("toEditValues", () => {
  it("fills the form from a stored load, with times on the Dallas clock and blanks for what is not set", () => {
    const v = toEditValues({
      brokerName: "Acme",
      quotedRevenue: "1000",
      brokerMcNumber: null,
      brokerPhone: null,
      brokerEmail: null,
      loadNumber: "AF-1",
      poNumber: null,
      trailerType: null,
      weightLbs: 12000,
      lengthFt: "40",
      widthFt: null,
      loadHeightIn: null,
      hazmatClass: null,
      requiresLiftgate: true,
      requiresRamp: null,
      requiresPalletJack: null,
      payTermsDays: 30,
      notes: null,
      stops: [{ id: "s1", stopRole: null, stopType: "delivery", addressString: "9 Main St, Memphis, TN", facilityName: null, timeWindowEarliest: new Date("2026-10-30T13:00:00Z"), timeWindowLatest: null, referenceNumbers: ["A", 2], contactName: null, contactPhone: null, stopNotes: null }]
    });
    expect(v).toMatchObject({ brokerMc: "", weightLbs: "12000", lengthFt: "40", liftgate: true, ramp: false, payTermsDays: "30" });
    expect(v.stops[0]).toMatchObject({ role: "delivery", earliest: "2026-10-30T08:00", latest: "", refs: "A, 2" });
  });

  it("a form filled from a stored load validates as it stands", () => {
    const v = toEditValues({
      brokerName: "Acme",
      quotedRevenue: "1000",
      brokerMcNumber: "123456",
      brokerPhone: null,
      brokerEmail: null,
      loadNumber: "AF-1",
      poNumber: null,
      trailerType: null,
      weightLbs: null,
      lengthFt: null,
      widthFt: null,
      loadHeightIn: null,
      hazmatClass: null,
      requiresLiftgate: null,
      requiresRamp: null,
      requiresPalletJack: null,
      payTermsDays: null,
      notes: null,
      stops: [{ id: "s1", stopRole: "pickup", stopType: "pickup", addressString: "Dallas, TX", facilityName: null, timeWindowEarliest: new Date("2026-10-30T13:00:00Z"), timeWindowLatest: new Date("2026-10-30T15:00:00Z"), referenceNumbers: null, contactName: null, contactPhone: null, stopNotes: null }]
    });
    expect(validateLoadEdit(v).ok).toBe(true);
  });
});
