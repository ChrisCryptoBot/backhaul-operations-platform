import { describe, expect, test } from "vitest";
import { deriveAlerts, RULES, type AlertLoad } from "@/lib/alerts";
import { checkTrailerRows, importTemplate, parseCsv, readHeader } from "@/lib/import-csv";
import { validateLoadEdit } from "@/lib/load-edit";
import { complianceState, trailerBlocker, trailerClearanceSoon } from "@/lib/trailer-clearance";
import { trailerFit, type TrailerFacts } from "@/lib/trailer-fit";
import { validateTrailer } from "@/lib/trailer-forms";

const now = new Date("2026-10-30T12:00:00Z");
const days = (n: number) => new Date(now.getTime() + n * 86_400_000);

const trailer = (over: Partial<TrailerFacts> = {}): TrailerFacts => ({ number: "T-1", type: "dry_van", maxPayloadLbs: 44000, lengthFt: 53, currentVehicleId: null, status: "available", registrationExpiry: days(200), inspectionExpiry: days(200), ...over });

describe("whether a trailer can go out", () => {
  test("in the shop, out of service and each lapsed date block it, in that order", () => {
    expect(trailerBlocker({ status: "in_shop", registrationExpiry: null, inspectionExpiry: null }, now)).toBe("In the shop");
    expect(trailerBlocker({ status: "out_of_service", registrationExpiry: days(-1), inspectionExpiry: null }, now)).toBe("Out of service");
    expect(trailerBlocker({ status: "available", registrationExpiry: days(-1), inspectionExpiry: days(-1) }, now)).toBe("Registration expired");
    expect(trailerBlocker({ status: "available", registrationExpiry: days(5), inspectionExpiry: days(-1) }, now)).toBe("Inspection expired");
    expect(trailerBlocker({ status: "available", registrationExpiry: null, inspectionExpiry: null }, now)).toBeNull();
  });

  test("the first date to lapse inside the window is named, and a lapsed one is not 'soon'", () => {
    expect(trailerClearanceSoon({ registrationExpiry: days(20), inspectionExpiry: days(8) }, now, 30)).toMatchObject({ what: "inspection", inDays: 8 });
    expect(trailerClearanceSoon({ registrationExpiry: days(-3), inspectionExpiry: days(90) }, now, 30)).toBeNull();
    expect(trailerClearanceSoon({ registrationExpiry: null, inspectionExpiry: null }, now, 30)).toBeNull();
  });

  test("compliance is lapsed, soon or ok", () => {
    expect(complianceState({ registrationExpiry: days(-1), inspectionExpiry: days(5) }, now, 30)).toBe("lapsed");
    expect(complianceState({ registrationExpiry: days(10), inspectionExpiry: null }, now, 30)).toBe("soon");
    expect(complianceState({ registrationExpiry: days(100), inspectionExpiry: days(100) }, now, 30)).toBe("ok");
  });
});

describe("whether a trailer takes a load", () => {
  const load = { trailerType: null, weightLbs: null, lengthFt: null, vehicleId: null };

  test("a load that says nothing is taken by any trailer that can go out", () => {
    expect(trailerFit(load, trailer(), now, 30)).toEqual({ blocker: null, warnings: [] });
  });

  test("the wrong kind of trailer, too much weight and too much length each block, in words", () => {
    const fit = trailerFit({ trailerType: "reefer", weightLbs: 50000, lengthFt: 60, vehicleId: null }, trailer(), now, 30);
    expect(fit.blocker).toContain("needs reefer");
    expect(fit.blocker).toContain("50,000 lb");
    expect(fit.blocker).toContain("60 ft long");
  });

  test("equipment typed as other is not a mismatch, and neither is a trailer with no type", () => {
    expect(trailerFit({ ...load, trailerType: "other:Hopper" }, trailer(), now, 30).blocker).toBeNull();
    expect(trailerFit({ ...load, trailerType: "flatbed" }, trailer({ type: null }), now, 30).blocker).toBeNull();
  });

  test("a trailer in the shop or with a lapsed date blocks; a date coming due warns", () => {
    expect(trailerFit(load, trailer({ status: "in_shop" }), now, 30).blocker).toBe("T-1: in the shop.");
    expect(trailerFit(load, trailer({ inspectionExpiry: days(-2) }), now, 30).blocker).toBe("T-1: inspection expired.");
    const soon = trailerFit(load, trailer({ registrationExpiry: days(1) }), now, 30);
    expect(soon.blocker).toBeNull();
    expect(soon.warnings).toEqual(["T-1's registration lapses in 1 day."]);
  });

  test("a trailer hooked to another tractor than the load's is a warning, not a stop", () => {
    const fit = trailerFit({ ...load, vehicleId: "a" }, trailer({ currentVehicleId: "b" }), now, 30);
    expect(fit.blocker).toBeNull();
    expect(fit.warnings[0]).toMatch(/hooked to another tractor/);
    expect(trailerFit({ ...load, vehicleId: "a" }, trailer({ currentVehicleId: "a" }), now, 30).warnings).toEqual([]);
  });
});

describe("the Add trailer form", () => {
  test("a number alone is enough, and the rest are read as the form says", () => {
    const ok = validateTrailer({ number: " T-2041 ", plate: "abc123", plateState: "tx", vin: "1hgbh41jxmn109186", lengthFt: "53", maxPayloadLbs: "44,000", registrationExpiry: "2027-03-31" });
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.value).toMatchObject({ number: "T-2041", plate: "ABC123", plateState: "TX", vin: "1HGBH41JXMN109186", ownership: "owned", status: "available" });
    expect(ok.numbers.maxPayloadLbs).toBe(44000);
    expect(ok.numbers.registrationExpiry).toBeInstanceOf(Date);
  });

  test("what is wrong is said per field", () => {
    const bad = validateTrailer({ number: "", type: "spaceship", vin: "123", plateState: "Texas", lengthFt: "99", axles: "2.5", ownership: "stolen", status: "gone", registrationExpiry: "soon" });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(Object.keys(bad.errors).sort()).toEqual(["axles", "lengthFt", "number", "ownership", "plateState", "registrationExpiry", "status", "type", "vin"]);
  });
});

describe("trailer rows from a file", () => {
  const file = (...rows: string[]) => parseCsv(["Number,Type,Plate,Ownership,Registration good through,Liftgate,Status", ...rows].join("\n"));

  test("the columns, the template and a date typed month/day/year", () => {
    expect(readHeader("trailers", ["Trailer #", "Registration", "Inspection", "E-track"]).matched.map((m) => m.field)).toEqual(["Number", "Registration good through", "Inspection good through", "E-track"]);
    const check = checkTrailerRows(file("T-1,dry_van,ABC1,Customer's,3/31/2027,yes,In shop"), new Set());
    expect(check.problemCount).toBe(0);
    expect(check.good[0]!.item.values).toMatchObject({ number: "T-1", ownership: "customer", hasLiftgate: "yes", status: "in_shop", registrationExpiry: "2027-03-31" });
    const template = checkTrailerRows(parseCsv(importTemplate("trailers")), new Set());
    expect(template.problemCount).toBe(0);
    expect(template.good).toHaveLength(1);
  });

  test("a number in service, in any capitalisation, or repeated in the file is left out", () => {
    const check = checkTrailerRows(file("t-9,,,,,,", "T-7,,,,,,", "t-7,,,,,,", ",dry_van,,,,,"), new Set(["t-9"]));
    expect(check.good.map((g) => g.item.values.number)).toEqual(["T-7"]);
    expect(check.problems.map((p) => [p.line, p.errors[0]])).toEqual([
      [2, "Number: A trailer numbered t-9 is already in service."],
      [4, "Number: t-7 is also on line 3 of this file."],
      [5, "Number: Give the trailer a number, for example T-2041."]
    ]);
  });
});

describe("the trailer alert", () => {
  const load = (over: Partial<AlertLoad> = {}): AlertLoad => ({ id: "L1", loadNumber: "L-1", status: "accepted", paymentStatus: null, invoiceNumber: null, invoicedAt: null, payTermsDays: null, verdict: null, stops: [], assignment: null, ...over });
  const codes = (l: AlertLoad) => deriveAlerts([l], now).filter((a) => a.code === "TRAILER_COMPLIANCE");

  test("a trailer that cannot go out blocks the open load it is on", () => {
    const [a] = codes(load({ trailer: { number: "T-5", status: "available", registrationExpiry: days(-3), inspectionExpiry: null } }));
    expect(a).toMatchObject({ level: "block", message: "Trailer T-5: registration expired." });
  });

  test("a date coming due warns; a good trailer, no trailer and a finished load say nothing", () => {
    expect(codes(load({ trailer: { number: "T-5", status: "available", registrationExpiry: null, inspectionExpiry: days(10) } }))[0]).toMatchObject({ level: "warn" });
    expect(codes(load({ trailer: { number: "T-5", status: "available", registrationExpiry: days(200), inspectionExpiry: days(200) } }))).toEqual([]);
    expect(codes(load())).toEqual([]);
    expect(codes(load({ status: "completed", trailer: { number: "T-5", status: "in_shop", registrationExpiry: null, inspectionExpiry: null } }))).toEqual([]);
  });

  test("the rule is in the catalogue the Rules page lists", () => {
    const rule = RULES.find((r) => r.code === "TRAILER_COMPLIANCE")!;
    expect(rule.level).toBe("block");
    expect(rule.trigger({ pickupHours: 24, sentNoAnswerHours: 4, clearanceDays: 30 })).toMatch(/30 days.*\.$/);
  });
});

describe("saving a load's trailer", () => {
  test("the equipment a rate confirmation can read (other:text, the retired hopper) is accepted back, an unknown word is not", () => {
    const errorOf = (trailer: string) => {
      const out = validateLoadEdit({ brokerName: "", brokerMc: "", brokerPhone: "", brokerEmail: "", loadNumber: "", poNumber: "", trailer, weightLbs: "", lengthFt: "", widthFt: "", heightIn: "", hazmat: "", liftgate: false, ramp: false, palletJack: false, payTermsDays: "", notes: "", stops: [] });
      return out.ok ? null : (out.errors as Record<string, string>).trailer ?? null;
    };
    expect(errorOf("other:Hopper")).toBeNull();
    expect(errorOf("hopper")).toBeNull();
    expect(errorOf("dry_van")).toBeNull();
    expect(errorOf("")).toBeNull();
    expect(errorOf("spaceship")).toMatch(/Pick a trailer/);
    expect(errorOf(`other:${"x".repeat(60)}`)).toMatch(/too long/);
  });
});
