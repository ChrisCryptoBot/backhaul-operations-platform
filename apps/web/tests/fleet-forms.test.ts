import { describe, expect, test } from "vitest";
import { endOfCentralDay, PROFILE_FIELDS, profileFloors, validateDriver, validateProfile, validateTruck, ymdOf, type ProfileKey } from "../src/lib/fleet-forms";

const utc = (s: string) => Date.parse(s);

describe("driver form", () => {
  const good = { name: "  Casey   Brooks ", phone: "555-0142", email: "casey@example.test", cdlClass: "a", cdlExpiry: "2027-03-31", medicalCardExpiry: "2026-12-15", assignedVehicleId: "v1" };

  test("a good form is tidied (spaces, class in capitals) and its dates become the end of that Dallas day", () => {
    const r = validateDriver(good);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.name).toBe("Casey Brooks");
      expect(r.value.cdlClass).toBe("A");
      expect(r.cdlExpiry!.getTime()).toBe(utc("2027-04-01T04:59:59.999Z")); // 31 March is daylight time (UTC-5): good until 23:59:59.999 there
      expect(r.medicalCardExpiry!.getTime()).toBe(utc("2026-12-16T05:59:59.999Z")); // 15 December is standard time (UTC-6)
    }
  });

  test("everything but the name may be left blank", () => {
    const r = validateDriver({ name: "Jo" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.cdlExpiry).toBeNull();
  });

  test("each problem is named next to its field", () => {
    const r = validateDriver({ name: "A", phone: "call me", email: "nope", cdlClass: "Z", cdlExpiry: "2027-02-31", medicalCardExpiry: "soon" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(["cdlClass", "cdlExpiry", "email", "medicalCardExpiry", "name", "phone"]);
  });

  test("a stored expiry reads back as the same date on the Dallas calendar, and a card is good through its last day", () => {
    const end = endOfCentralDay("2027-03-31")!;
    expect(ymdOf(end)).toBe("2027-03-31");
    expect(ymdOf(null)).toBe("");
    expect(endOfCentralDay("1989-01-01")).toBeNull();
    expect(endOfCentralDay("2027-13-01")).toBeNull();
  });
});

describe("truck form", () => {
  test("a name is all a truck needs; a type, fuel and miles per gallon are checked when given", () => {
    expect(validateTruck({ name: "Unit 104" })).toMatchObject({ ok: true, mpg: null });
    expect(validateTruck({ name: "Unit 104", type: "tractor", fuelType: "diesel", mpg: "6.8" })).toMatchObject({ ok: true, mpg: 6.8 });
    const bad = validateTruck({ name: "", type: "spaceship", fuelType: "steam", mpg: "200" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(Object.keys(bad.errors).sort()).toEqual(["fuelType", "mpg", "name", "type"]);
  });
});

describe("cost profile form", () => {
  const filled = (over: Partial<Record<ProfileKey, string>> = {}) => {
    const base: Record<string, string> = {};
    for (const f of PROFILE_FIELDS) base[f.key] = "";
    return { ...base, monthlyInsurance: "1450", monthlyAuthority: "120", monthlyPhoneSubscriptions: "90", monthlyLoanPayment: "1900", annualFixedCosts: "2400", estimatedMonthlyMiles: "6500", maintenanceReservePerMile: "0.15", tireReservePerMile: "0.04", ...over };
  };

  test("blank means zero (or the default for free time) except the monthly miles, which are required", () => {
    const r = validateProfile(filled());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.numbers.truckReplacementMonthly).toBeNull();
    const miss = validateProfile(filled({ estimatedMonthlyMiles: "" }));
    expect(miss.ok).toBe(false);
    if (!miss.ok) expect(miss.errors.estimatedMonthlyMiles).toBe("Required.");
  });

  test("text, whole-number fields and ranges are held to", () => {
    const r = validateProfile(filled({ monthlyInsurance: "lots", freeGraceMinutes: "90.5", maintenanceReservePerMile: "9", estimatedMonthlyMiles: "10" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(["estimatedMonthlyMiles", "freeGraceMinutes", "maintenanceReservePerMile", "monthlyInsurance"]);
  });

  test("the floor is TrueLane's: fixed costs over monthly miles, plus maintenance and tires", () => {
    const r = validateProfile(filled());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const f = profileFloors(r.numbers);
    const fixed = 1450 + 120 + 90 + 1900 + 2400 / 12;
    expect(f.totalFixedMonthly).toBeCloseTo(fixed, 6);
    expect(f.survivalFloorRpm).toBeCloseTo(fixed / 6500, 6);
    expect(f.breakEvenRpm).toBeCloseTo(fixed / 6500 + 0.15 + 0.04, 6);
  });

  test("more miles a month lower the floor, a higher insurance bill raises it", () => {
    const at = (over: Partial<Record<ProfileKey, string>>) => {
      const r = validateProfile(filled(over));
      if (!r.ok) throw new Error("invalid");
      return profileFloors(r.numbers).breakEvenRpm;
    };
    expect(at({ estimatedMonthlyMiles: "8000" })).toBeLessThan(at({}));
    expect(at({ monthlyInsurance: "1800" })).toBeGreaterThan(at({}));
  });

  test("what the form does not edit is carried through, so a number moves the floor as it would on the phone", () => {
    const r = validateProfile(filled({ monthlyInsurance: "0" }));
    if (!r.ok) throw new Error("invalid");
    const itemised = profileFloors(r.numbers, { insuranceLiabilityMonthly: 900, insuranceCargoMonthly: 100 });
    expect(itemised.totalInsuranceMonthly).toBe(1000);
    expect(profileFloors(r.numbers).totalInsuranceMonthly).toBe(0);
  });
});
