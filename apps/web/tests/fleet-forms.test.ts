import { describe, expect, test } from "vitest";
import { canonicalTruckType, endOfCentralDay, industryValues, PROFILE_FIELDS, previewOf, profileFieldApplies, profileFloors, profileWarnings, truckMpg, validateDriver, validateProfile, validateTruck, ymdOf, type ProfileKey } from "../src/lib/fleet-forms";

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
    if (r.ok) {
      expect(r.cdlExpiry).toBeNull();
      expect(r.payRate).toBeNull();
    }
  });

  test("each problem is named next to its field", () => {
    const r = validateDriver({ name: "A", phone: "call me", email: "nope", cdlClass: "Z", cdlExpiry: "2027-02-31", medicalCardExpiry: "soon" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(["cdlClass", "cdlExpiry", "email", "medicalCardExpiry", "name", "phone"]);
  });

  test("a usual pay is a kind and a rate that go together, within what that kind can be", () => {
    expect(validateDriver({ name: "Jo", payKind: "cpm", payRate: "0.65" })).toMatchObject({ ok: true, payRate: 0.65 });
    expect(validateDriver({ name: "Jo", payKind: "flat", payRate: "450" })).toMatchObject({ ok: true, payRate: 450 });
    const noRate = validateDriver({ name: "Jo", payKind: "hourly", payRate: "" });
    expect(!noRate.ok && noRate.errors.payRate).toBe("Type the rate.");
    const tooBig = validateDriver({ name: "Jo", payKind: "cpm", payRate: "65" });
    expect(!tooBig.ok && tooBig.errors.payRate).toMatch(/at most 5/);
    const noKind = validateDriver({ name: "Jo", payKind: "", payRate: "0.65" });
    expect(!noKind.ok && noKind.errors.payKind).toBe("Pick how they are paid.");
    const badKind = validateDriver({ name: "Jo", payKind: "tips", payRate: "1" });
    expect(!badKind.ok && badKind.errors.payKind).toBe("Per mile, hourly or flat.");
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
    expect(validateTruck({ name: "Unit 104", type: "heavy_duty", fuelType: "diesel", mpg: "6.8" })).toMatchObject({ ok: true, mpg: 6.8 });
    const bad = validateTruck({ name: "", type: "spaceship", fuelType: "steam", mpg: "200" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(Object.keys(bad.errors).sort()).toEqual(["fuelType", "mpg", "name", "type"]);
  });

  test("an old type or fuel name reads as its current one, so an old truck can be saved again", () => {
    expect(canonicalTruckType("tractor")).toBe("heavy_duty");
    expect(canonicalTruckType("straight_truck")).toBe("box_truck");
    expect(canonicalTruckType(" ")).toBeNull();
    const r = validateTruck({ name: "Old", type: "tractor", fuelType: "gas" });
    expect(r.ok && r.value).toMatchObject({ type: "heavy_duty", fuelType: "gasoline" });
  });

  test("a truck's own miles per gallon wins; without one the type's typical figure is used and said to be typical", () => {
    expect(truckMpg("heavy_duty", 6.8)).toEqual({ mpg: 6.8, typical: false });
    const t = truckMpg("heavy_duty", null);
    expect(t.typical).toBe(true);
    expect(t.mpg).toBeGreaterThan(5);
  });
});

describe("cost profile form", () => {
  const filled = (over: Record<string, string> = {}) => {
    const base: Record<string, string> = {};
    for (const f of PROFILE_FIELDS) base[f.key] = "";
    return {
      ...base,
      monthlyInsurance: "1450",
      monthlyAuthority: "120",
      monthlyPhoneSubscriptions: "90",
      monthlyLoanPayment: "1900",
      annualFixedCosts: "2400",
      estimatedMonthlyMiles: "6500",
      maintenanceReservePerMile: "0.15",
      tireReservePerMile: "0.04",
      driverHourlyTarget: "30",
      archetype: "solo_owner",
      ...over
    };
  };
  const ok = (over: Record<string, string> = {}) => {
    const r = validateProfile(filled(over));
    if (!r.ok) throw new Error(`invalid: ${JSON.stringify(r.errors)}`);
    return r;
  };
  const errorsOf = (over: Record<string, string>) => {
    const r = validateProfile(filled(over));
    return r.ok ? {} : r.errors;
  };

  test("blank means zero (or the default for free time) except the miles and the pay target, which are required", () => {
    const r = ok();
    expect(r.numbers.truckReplacementMonthly).toBeNull();
    expect(errorsOf({ estimatedMonthlyMiles: "" }).estimatedMonthlyMiles).toBe("Required.");
    expect(errorsOf({ driverHourlyTarget: "" }).driverHourlyTarget).toBe("Required.");
    expect(errorsOf({ driverHourlyTarget: "0" }).driverHourlyTarget).toMatch(/Between 1 and 200/);
  });

  test("text, whole-number fields and ranges are held to", () => {
    const r = validateProfile(filled({ monthlyInsurance: "lots", freeGraceMinutes: "90.5", maintenanceReservePerMile: "9", estimatedMonthlyMiles: "10" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(["estimatedMonthlyMiles", "freeGraceMinutes", "maintenanceReservePerMile", "monthlyInsurance"]);
  });

  test("the floor is TrueLane's: fixed costs over monthly miles, plus maintenance and tires", () => {
    const r = ok();
    const f = profileFloors(r.numbers, r.choices);
    const fixed = 1450 + 120 + 90 + 1900 + 2400 / 12;
    expect(f.totalFixedMonthly).toBeCloseTo(fixed, 6);
    expect(f.survivalFloorRpm).toBeCloseTo(fixed / 6500, 6);
    expect(f.breakEvenRpm).toBeCloseTo(fixed / 6500 + 0.15 + 0.04, 6);
  });

  test("more miles a month lower the floor, a higher insurance bill raises it", () => {
    const at = (over: Record<string, string>) => {
      const r = ok(over);
      return profileFloors(r.numbers, r.choices).breakEvenRpm;
    };
    expect(at({ estimatedMonthlyMiles: "8000" })).toBeLessThan(at({}));
    expect(at({ monthlyInsurance: "1800" })).toBeGreaterThan(at({}));
  });

  test("itemised insurance is the sum of its five buckets, and the typed total is ignored while they are shown", () => {
    const r = ok({ insuranceItemised: "1", monthlyInsurance: "9999", insuranceLiabilityMonthly: "900", insuranceCargoMonthly: "100", insurancePhysicalDamageMonthly: "50" });
    expect(r.numbers.monthlyInsurance).toBe(1050);
    expect(profileFloors(r.numbers, r.choices).totalInsuranceMonthly).toBe(1050);
    // The same buckets typed while hidden are not read at all.
    const hidden = ok({ insuranceLiabilityMonthly: "900", insuranceCargoMonthly: "100" });
    expect(hidden.numbers.insuranceLiabilityMonthly).toBeNull();
    expect(profileFloors(hidden.numbers, hidden.choices).totalInsuranceMonthly).toBe(1450);
  });

  test("an Owner + driver truck needs what the driver is paid, by the basis chosen, and starts at an 18% burden", () => {
    expect(errorsOf({ archetype: "hired_driver", payKind: "hourly" }).hiredDriverHourlyRate).toBeTruthy();
    expect(errorsOf({ archetype: "hired_driver", payKind: "cpm" }).hiredDriverRatePerMile).toBeTruthy();
    // The other basis's field is not asked for.
    expect(errorsOf({ archetype: "hired_driver", payKind: "cpm" }).hiredDriverHourlyRate).toBeUndefined();
    const r = ok({ archetype: "hired_driver", payKind: "hourly", hiredDriverHourlyRate: "24" });
    expect(r.numbers.hiredDriverHourlyRate).toBe(24);
    expect(r.numbers.laborBurdenPct).toBe(18);
    expect(ok({ archetype: "hired_driver", payKind: "cpm", hiredDriverRatePerMile: "0.6", laborBurdenPct: "12" }).numbers.laborBurdenPct).toBe(12);
  });

  test("a leased-on truck needs the carrier's cut (0 is allowed) and the answer about fuel surcharge", () => {
    const e = errorsOf({ archetype: "leased_on" });
    expect(e.carrierCutPct).toMatch(/Type 0/);
    expect(e.fscCut).toBeTruthy();
    expect(ok({ archetype: "leased_on", carrierCutPct: "0", fscCut: "no" }).numbers.carrierCutPct).toBe(0);
    expect(errorsOf({ archetype: "leased_on", carrierCutPct: "20", fscCut: "maybe" }).fscCut).toBe("Yes, No or Not sure.");
    expect(errorsOf({ archetype: "spaceship" }).archetype).toBe("Pick one of the three.");
  });

  test("a field the answers do not use is neither checked nor read", () => {
    // A solo owner's leftover carrier cut or route fields, however wrong, do not stop the save.
    const r = ok({ carrierCutPct: "abc", routeBaseMinimum: "abc", hiredDriverRatePerMile: "abc" });
    expect(r.numbers.carrierCutPct).toBeNull();
    expect(r.numbers.routeBaseMinimum).toBeNull();
    const choices = r.choices;
    expect(profileFieldApplies("carrierCutPct", choices)).toBe(false);
    expect(profileFieldApplies("laborBurdenPct", { ...choices, archetype: "hired_driver" })).toBe(true);
    expect(profileFieldApplies("routeBaseMinimum", { ...choices, routeMinimumOn: true })).toBe(true);
  });

  test("a route minimum needs its base amount when it is on", () => {
    expect(errorsOf({ routeMinimumOn: "1" }).routeBaseMinimum).toBeTruthy();
    const r = ok({ routeMinimumOn: "1", routeBaseMinimum: "180", routeIncludedMiles: "60", routeIncludedStops: "6" });
    expect(r.numbers.routeBaseMinimum).toBe(180);
    expect(r.numbers.routeIncludedStops).toBe(6);
    expect(errorsOf({ routeMinimumOn: "1", routeBaseMinimum: "180", routeIncludedStops: "2.5" }).routeIncludedStops).toBe("Whole numbers only.");
  });

  test("percents are typed as percents and kept to 0 through 100", () => {
    expect(errorsOf({ archetype: "hired_driver", payKind: "cpm", hiredDriverRatePerMile: "0.6", laborBurdenPct: "180" }).laborBurdenPct).toBe("Between 0 and 100.");
    expect(ok({ factoringFeePct: "3" }).numbers.factoringFeePct).toBe(3);
  });

  test("a percent of 50 or more, and a fuel price or reserve outside the usual range, are confirmed before saving, in the phone's words", () => {
    expect(profileWarnings(ok().numbers, ok().choices)).toEqual([]);
    const burden = ok({ archetype: "hired_driver", payKind: "cpm", hiredDriverRatePerMile: "0.6", laborBurdenPct: "55" });
    expect(profileWarnings(burden.numbers, burden.choices)[0]).toMatch(/Payroll burden on the driver is 55%/);
    const cut = ok({ archetype: "leased_on", carrierCutPct: "60", fscCut: "yes" });
    expect(profileWarnings(cut.numbers, cut.choices)[0]).toMatch(/carrier's cut is 60%/);
    const odd = ok({ lastFuelPricePerGallon: "20", maintenanceReservePerMile: "2.2", tireReservePerMile: "1.1" });
    expect(profileWarnings(odd.numbers, odd.choices)).toHaveLength(2); // fuel and maintenance; $1.10 tires is inside the usual range
  });

  test("the industry numbers for a type fill the bills, the miles and the upkeep, and an old type name still finds them", () => {
    const v = industryValues("heavy_duty");
    expect(Number(v.monthlyInsurance)).toBeGreaterThan(0);
    expect(Number(v.estimatedMonthlyMiles)).toBeGreaterThan(0);
    expect(v.laborBurdenPct).toBe("18");
    expect(industryValues("tractor")).toEqual(v);
    expect(Number(industryValues(null).monthlyInsurance)).toBeGreaterThan(0);
  });

  test("the preview stays live while a required labour number is still blank, and waits only for miles", () => {
    const p = previewOf(filled({ archetype: "hired_driver", payKind: "hourly" }));
    expect(p).not.toBeNull();
    expect(p!.floors.breakEvenRpm).toBeCloseTo(ok().numbers.estimatedMonthlyMiles ? profileFloors(ok().numbers, ok().choices).breakEvenRpm : 0, 6);
    expect(previewOf(filled({ estimatedMonthlyMiles: "" }))).toBeNull();
    // Itemised: the preview sums the buckets as they are typed.
    const itemised = previewOf(filled({ insuranceItemised: "1", insuranceLiabilityMonthly: "700", insuranceCargoMonthly: "50" }));
    expect(itemised!.numbers.monthlyInsurance).toBe(750);
  });

  test("the profile's own keys are the ones this test file fills in", () => {
    const keys: ProfileKey[] = PROFILE_FIELDS.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain("laborBurdenPct");
  });
});
