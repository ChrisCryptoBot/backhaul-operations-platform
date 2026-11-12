import { describe, expect, test } from "vitest";
import { EMPTY_INTAKE, INTAKE_LIMITS, emptyForm, floorFor, formOf, intakeIsEmpty, parseIntake, termsFor, validateIntake, type IntakeForm, type LeakIntake } from "@/lib/leak-intake";

const form = (over: Partial<IntakeForm> = {}): IntakeForm => ({ ...emptyForm(), ...over });
const ok = (f: IntakeForm): LeakIntake => {
  const c = validateIntake(f);
  if (!c.ok) throw new Error(JSON.stringify(c.errors));
  return c.intake;
};
const errors = (f: IntakeForm): Record<string, string> => {
  const c = validateIntake(f);
  return c.ok ? {} : c.errors;
};

describe("checking what the carrier typed", () => {
  test("nothing typed is a valid, empty intake: every imported load will be counted and none priced", () => {
    expect(ok(form())).toEqual(EMPTY_INTAKE);
    expect(intakeIsEmpty(ok(form()))).toBe(true);
  });

  test("the fleet figures are read: dollars with or without a sign, whole minutes", () => {
    const i = ok(form({ costPerMile: "$1.85", detentionRate: "60", freeMinutes: "120" }));
    expect(i).toMatchObject({ costPerMile: 1.85, detentionRate: 60, freeMinutes: 120, trucks: [], customers: [] });
    expect(intakeIsEmpty(i)).toBe(false);
    expect(ok(form({ freeMinutes: "0" })).freeMinutes).toBe(0); // no free time at all is a figure, not a blank
  });

  test("a figure that is not a figure, or is out of reach, is refused next to its own field", () => {
    expect(errors(form({ costPerMile: "abc", detentionRate: "-5", freeMinutes: "1.5" }))).toMatchObject({ costPerMile: expect.any(String), detentionRate: expect.any(String), freeMinutes: expect.any(String) });
    expect(errors(form({ costPerMile: "0" })).costPerMile).toMatch(/Between/);
    expect(errors(form({ costPerMile: "25" })).costPerMile).toMatch(/Between/);
    expect(errors(form({ detentionRate: "0" })).detentionRate).toMatch(/Between/); // no rate is a blank, not a zero
    expect(errors(form({ freeMinutes: "2000" })).freeMinutes).toMatch(/No more than 1440/);
    expect(errors(form({ costPerMile: "1.23456" })).costPerMile).toBeDefined(); // four places at most
  });

  test("trucks: blank rows and rows with no figure are dropped (the fleet's applies), names are tidied, a figure without a name is refused, and a truck is listed once", () => {
    const i = ok(form({ trucks: [{ name: "  Unit   104 ", costPerMile: "2.10" }, { name: "", costPerMile: "" }, { name: "Unit 7", costPerMile: "" }] }));
    expect(i.trucks).toEqual([{ name: "Unit 104", costPerMile: 2.1 }]);
    const e = errors(form({ trucks: [{ name: "Unit 1", costPerMile: "" }, { name: "", costPerMile: "1.5" }, { name: "Unit 2", costPerMile: "1.7" }, { name: "unit 2", costPerMile: "1.8" }] }));
    expect(e["trucks.0.costPerMile"]).toBeUndefined();
    expect(e["trucks.1.name"]).toMatch(/Name the truck/);
    expect(e["trucks.3.name"]).toMatch(/already in the list/);
    expect(e["trucks.2.name"]).toBeUndefined();
  });

  test("customers: either terms figure may be blank (it falls back to the fleet's); a row with neither is dropped; a figure without a name is refused; a customer is listed once", () => {
    const i = ok(form({ customers: [{ name: "Acme", detentionRate: "75", freeMinutes: "" }, { name: "Globex", detentionRate: "", freeMinutes: "60" }, { name: "Initech", detentionRate: "", freeMinutes: "" }] }));
    expect(i.customers).toEqual([{ name: "Acme", detentionRate: 75, freeMinutes: null }, { name: "Globex", detentionRate: null, freeMinutes: 60 }]);
    const e = errors(form({ customers: [{ name: "Acme", detentionRate: "", freeMinutes: "" }, { name: "ACME", detentionRate: "50", freeMinutes: "" }, { name: "Zed", detentionRate: "x", freeMinutes: "" }, { name: "", detentionRate: "", freeMinutes: "30" }, { name: "Acme", detentionRate: "55", freeMinutes: "" }] }));
    expect(e["customers.0.detentionRate"]).toBeUndefined();
    expect(e["customers.1.name"]).toBeUndefined(); // the first one never made the list, so the second is not a copy
    expect(e["customers.2.detentionRate"]).toMatch(/Dollars an hour/);
    expect(e["customers.3.name"]).toMatch(/Name the customer/);
    expect(e["customers.4.name"]).toMatch(/already in the list/);
  });

  test("the lists are capped", () => {
    const many = Array.from({ length: INTAKE_LIMITS.trucks + 1 }, (_, i) => ({ name: `T${i}`, costPerMile: "1.5" }));
    expect(errors(form({ trucks: many })).trucks).toMatch(/At most/);
  });

  test("what is saved reads back into the same form, and the same intake", () => {
    const i = ok(form({ costPerMile: "1.85", detentionRate: "60", freeMinutes: "90", trucks: [{ name: "Unit 1", costPerMile: "2" }], customers: [{ name: "Acme", detentionRate: "80", freeMinutes: "" }] }));
    expect(ok(formOf(i))).toEqual(i);
  });
});

describe("reading the stored document", () => {
  test("anything that is not a sound figure is dropped, so a hand-edited row can never price a load", () => {
    const i = parseIntake({
      costPerMile: -1,
      detentionRate: "60",
      freeMinutes: 90.5,
      trucks: [{ name: "A", costPerMile: 99 }, { name: "B", costPerMile: 1.7 }, { name: "", costPerMile: 2 }, null],
      customers: [{ name: "X" }, { name: "Y", detentionRate: 55 }, { name: "Z", freeMinutes: 30 }]
    });
    expect(i).toEqual({ costPerMile: null, detentionRate: null, freeMinutes: null, trucks: [{ name: "B", costPerMile: 1.7 }], customers: [{ name: "Y", detentionRate: 55, freeMinutes: null }, { name: "Z", detentionRate: null, freeMinutes: 30 }] });
    expect(parseIntake(null)).toEqual(EMPTY_INTAKE);
    expect(parseIntake("nonsense")).toEqual(EMPTY_INTAKE);
    expect(parseIntake({ trucks: "x", customers: 3 })).toEqual(EMPTY_INTAKE);
  });
});

describe("which figure prices a load", () => {
  const intake: LeakIntake = { costPerMile: 1.5, detentionRate: 60, freeMinutes: 120, trucks: [{ name: "Unit 104", costPerMile: 2 }], customers: [{ name: "Acme", detentionRate: 90, freeMinutes: 60 }, { name: "Globex", detentionRate: null, freeMinutes: 30 }] };

  test("a truck's own cost a mile wins (name matched without regard to case or spacing); every other truck gets the fleet's", () => {
    expect(floorFor(intake, "unit  104")).toMatchObject({ rpm: 2, from: "truck" });
    expect(floorFor(intake, "Unit 104")!.note).toMatch(/\$2\.00 a mile.*Unit 104/);
    expect(floorFor(intake, "Unit 9")).toMatchObject({ rpm: 1.5, from: "fleet" });
    expect(floorFor(intake, null)).toMatchObject({ rpm: 1.5, from: "fleet" });
  });

  test("with no fleet figure and no truck of its own there is no floor: nothing is invented", () => {
    expect(floorFor({ ...intake, costPerMile: null }, "Unit 9")).toBeNull();
    expect(floorFor({ ...intake, costPerMile: null }, "Unit 104")).toMatchObject({ rpm: 2 });
    expect(floorFor(null, "Unit 104")).toBeNull();
    expect(floorFor(EMPTY_INTAKE, "Unit 104")).toBeNull();
  });

  test("a customer's terms win figure by figure; the fleet's fill what the customer left blank; the desk's own free time is the last resort for free time only", () => {
    expect(termsFor(intake, "acme", 120)).toMatchObject({ rate: 90, freeMinutes: 60, rateFrom: "customer", freeFrom: "customer" });
    expect(termsFor(intake, "Globex", 120)).toMatchObject({ rate: 60, freeMinutes: 30, rateFrom: "fleet", freeFrom: "customer" });
    expect(termsFor(intake, "Initech", 120)).toMatchObject({ rate: 60, freeMinutes: 120, rateFrom: "fleet", freeFrom: "fleet" });
    const bare = termsFor({ ...intake, detentionRate: null, freeMinutes: null, customers: [] }, "Initech", 45);
    expect(bare).toMatchObject({ rate: null, freeMinutes: 45, rateFrom: null, freeFrom: "desk" });
    expect(bare.note).toMatch(/no rate given/);
    expect(termsFor(null, null, 120)).toMatchObject({ rate: null, freeMinutes: 120, freeFrom: "desk" });
  });

  test("the note says whose figure it is, in words", () => {
    expect(termsFor(intake, "Acme", 120).note).toBe("$90.00 an hour (customer's intake terms), 60 minutes free (customer's intake terms)");
    expect(termsFor(intake, "Initech", 120).note).toBe("$60.00 an hour (fleet's intake default), 120 minutes free (fleet's intake default)");
  });
});
