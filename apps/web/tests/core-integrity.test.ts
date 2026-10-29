import { describe, expect, it } from "vitest";
import { BLANK_COMPANY, companyLine, toCompanyValues, validateCompany } from "../src/lib/company";
import { toEditValues, validateLoadEdit, type LoadEditValues } from "../src/lib/load-edit";
import { isPaidMethod, paidMethodLabel, PAID_METHODS } from "../src/lib/pay-method";
import { ACTION_LABEL, ACTION_TONE, AUDIT_GROUPS } from "../src/lib/audit-diff";
import { DELETE_REASONS, isDeleteReason, reasonLabel } from "../src/lib/disruptions";
import { BLANK_QUOTE, readQuote, validateQuote } from "../src/lib/quote";
import { buildPlanner, planDays, type PlannerLoad } from "../src/lib/planner";

const form = (over: Partial<LoadEditValues> = {}): LoadEditValues => ({
  brokerName: "Acme",
  brokerMc: "",
  brokerPhone: "",
  brokerEmail: "",
  loadNumber: "A-1",
  poNumber: "",
  trailer: "",
  weightLbs: "",
  lengthFt: "",
  widthFt: "",
  heightIn: "",
  hazmat: "",
  liftgate: false,
  ramp: false,
  palletJack: false,
  payTermsDays: "",
  notes: "",
  stops: [{ id: "s1", role: "pickup", address: "Dallas, TX", facility: "", earliest: "", latest: "", refs: "", contactName: "", contactPhone: "", notes: "" }],
  deal: { vehicleId: "t1", rate: "1,500", fuelSurcharge: "", loadedMiles: "250.5", emptyToPickup: "20", emptyHome: "" },
  ...over
});

describe("the deal on a load edit", () => {
  it("reads the rate, the miles and the truck, with a blank surcharge or empty figure as none", () => {
    const out = validateLoadEdit(form());
    if (!out.ok) throw new Error(JSON.stringify(out.errors));
    expect(out.value.deal).toEqual({ vehicleId: "t1", rate: 1500, fuelSurcharge: null, loadedMiles: 250.5, emptyToPickup: 20, emptyHome: 0 });
  });

  it("is left out entirely when the form carries no deal, so a details-only caller changes no money", () => {
    const rest = { ...form() };
    delete rest.deal;
    const out = validateLoadEdit(rest);
    if (!out.ok) throw new Error("expected ok");
    expect(out.value.deal).toBeNull();
  });

  it("names each wrong figure next to its field", () => {
    const out = validateLoadEdit(form({ deal: { vehicleId: "t1", rate: "", fuelSurcharge: "-3", loadedMiles: "6000", emptyToPickup: "x", emptyHome: "9999" } }));
    if (out.ok) throw new Error("expected errors");
    expect(Object.keys(out.errors).sort()).toEqual(["deal.emptyHome", "deal.emptyToPickup", "deal.fuelSurcharge", "deal.loadedMiles", "deal.rate"]);
  });

  it("shows stored decimals without trailing zeros and a zero as blank", () => {
    const v = toEditValues({
      vehicleId: "t9",
      quotedRevenue: "1250.00",
      fuelSurcharge: null,
      loadedMiles: "452.6000",
      pickupDeadheadMiles: "0.0000",
      returnDeadheadMiles: "31.5",
      brokerName: null,
      brokerMcNumber: null,
      brokerPhone: null,
      brokerEmail: null,
      loadNumber: null,
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
      stops: []
    });
    expect(v.deal).toEqual({ vehicleId: "t9", rate: "1250", fuelSurcharge: "", loadedMiles: "452.6", emptyToPickup: "", emptyHome: "31.5" });
  });
});

describe("the company on the paperwork", () => {
  const full = { ...BLANK_COMPANY, name: " WC Freight LLC ", mcNumber: "MC-123456", dotNumber: "USDOT 7654321", phone: "555-0142", email: "billing@wc.example", address: "1 Main St\nDallas, TX" };

  it("tidies a good form: prefixes dropped, blanks become null", () => {
    const out = validateCompany(full);
    if (!out.ok) throw new Error(JSON.stringify(out.errors));
    expect(out.value).toMatchObject({ name: "WC Freight LLC", mcNumber: "123456", dotNumber: "7654321", remitTo: null, paymentNote: null });
    expect(companyLine(out.value)).toBe("MC 123456 · DOT 7654321 · 555-0142 · billing@wc.example");
    expect(toCompanyValues(out.value).mcNumber).toBe("123456");
  });

  it("needs only a name, and names what is wrong", () => {
    expect(validateCompany({ ...BLANK_COMPANY, name: "Solo Hauling" }).ok).toBe(true);
    const out = validateCompany({ ...BLANK_COMPANY, name: "x", mcNumber: "12", phone: "abc", email: "nope", remitTo: "r".repeat(301) });
    if (out.ok) throw new Error("expected errors");
    expect(Object.keys(out.errors).sort()).toEqual(["email", "mcNumber", "name", "phone", "remitTo"]);
  });
});

describe("how a payment came in", () => {
  it("knows its methods", () => {
    expect(PAID_METHODS.map((m) => m.key)).toEqual(["ach", "check", "wire", "card", "factoring", "other"]);
    expect(isPaidMethod("wire")).toBe(true);
    expect(isPaidMethod("barter")).toBe(false);
    expect(paidMethodLabel("ach")).toBe("ACH");
    expect(paidMethodLabel(null)).toBe("");
  });
});

describe("deleting a load", () => {
  it("has its own short list of reasons, none of them a cancellation", () => {
    expect(DELETE_REASONS.map((r) => r.key)).toEqual(["duplicate", "mistake", "test", "other"]);
    expect(isDeleteReason("duplicate")).toBe(true);
    expect(isDeleteReason("broker_cancelled")).toBe(false);
    expect(reasonLabel("mistake")).toBe("Entered by mistake");
  });

  it("is labelled, toned and grouped in the audit log like every other action", () => {
    for (const a of ["deleted", "restored", "company_changed"]) {
      expect(ACTION_LABEL[a]).toBeTruthy();
      expect(ACTION_TONE[a]).toBeTruthy();
      expect(AUDIT_GROUPS.some((g) => g.actions.includes(a))).toBe(true);
    }
  });
});

describe("the broker's paperwork on a quote", () => {
  const base = { ...BLANK_QUOTE, stops: [{ role: "pickup" as const, address: "Dallas, TX", appointment: "" }, { role: "delivery" as const, address: "Tulsa, OK", appointment: "" }], offer: "1500", loadedMiles: "260" };

  it("is optional, and tidied when given", () => {
    expect(validateQuote(base).ok).toBe(true);
    const input = readQuote({ ...base, brokerMc: "MC 123456", loadNumber: " AF-9 ", poNumber: "PO-1", brokerPhone: "555-0142", brokerEmail: "ap@acme.example" });
    expect(input).toMatchObject({ brokerMc: "123456", loadNumber: "AF-9", poNumber: "PO-1", brokerPhone: "555-0142", brokerEmail: "ap@acme.example" });
    expect(readQuote(base)).toMatchObject({ brokerMc: null, loadNumber: null, poNumber: null });
  });

  it("names what is wrong", () => {
    const out = validateQuote({ ...base, brokerMc: "12", loadNumber: "x".repeat(41), poNumber: "y".repeat(41), brokerPhone: "abc", brokerEmail: "nope" });
    if (out.ok) throw new Error("expected errors");
    expect(Object.keys(out.errors).sort()).toEqual(["brokerEmail", "brokerMc", "brokerPhone", "loadNumber", "poNumber"]);
  });
});

describe("loads with no times on the planner", () => {
  const NOW = Date.parse("2026-10-28T17:00:00Z");
  const days = planDays(NOW, 7, NOW);
  const base = (id: string, over: Partial<PlannerLoad>): PlannerLoad => ({ id, loadNumber: `DM-${id}`, origin: "Dallas, TX", destination: "Atlanta, GA", status: "draft", driverId: null, driverName: null, assignmentStatus: null, stops: [], ...over });

  it("are listed instead of dropped, when open, with their driver if they have one", () => {
    const { untimed, tray } = buildPlanner(
      [
        base("a", {}),
        base("b", { status: "accepted", driverId: "d1", driverName: "Alex Rivera", assignmentStatus: "accepted" }),
        base("c", { status: "completed" }),
        base("d", { status: "cancelled" })
      ],
      [{ id: "d1", name: "Alex Rivera" }],
      days,
      NOW
    );
    expect(untimed.map((u) => [u.loadId, u.driverName])).toEqual([
      ["a", null],
      ["b", "Alex Rivera"]
    ]);
    expect(untimed[0]).toMatchObject({ lane: "Dallas → Atlanta", status: "draft" });
    expect(tray.flat()).toEqual([]); // they cannot sit on a day
  });
});
