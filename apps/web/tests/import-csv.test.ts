import { describe, expect, test } from "vitest";
import { IMPORT_MAX_PROBLEMS, asYmd, checkDriverRows, checkTruckRows, driverKey, importTemplate, parseCsv, problemsCsv, readHeader } from "@/lib/import-csv";

const none = new Set<string>();

describe("reading CSV text", () => {
  test("quoted cells hold commas, doubled quotes and line breaks; a byte order mark and CRLF are fine", () => {
    const rows = parseCsv('﻿Name,Note\r\n"Unit 1, east","said ""hi"""\r\n"two\nlines",x\r\n');
    expect(rows).toEqual([
      ["Name", "Note"],
      ["Unit 1, east", 'said "hi"'],
      ["two\nlines", "x"]
    ]);
  });

  test("a last line with no line break is still a row, and an empty file is no rows", () => {
    expect(parseCsv("a,b\n1,2")).toEqual([["a", "b"], ["1", "2"]]);
    expect(parseCsv("")).toEqual([]);
  });

  test("an empty cell between commas is kept", () => {
    expect(parseCsv("a,,c\n")).toEqual([["a", "", "c"]]);
  });
});

describe("matching the columns", () => {
  test("headers match by name, ignoring case, spaces and punctuation, in any order", () => {
    const h = readHeader("trucks", ["Home base", "UNIT #", "Cargo length (ft)", "Favourite colour"]);
    expect(h.matched.map((m) => m.field)).toEqual(["Home base", "Name", "Cargo length (ft)"]);
    expect(h.unknown).toEqual(["Favourite colour"]);
    expect(h.missing).toEqual([]);
  });

  test("a file with no Name column says so", () => {
    expect(readHeader("drivers", ["Phone", "Email"]).missing).toEqual(["Name"]);
  });

  test("a column is read once: a second column with the same meaning is not used", () => {
    const h = readHeader("trucks", ["Name", "Truck"]);
    expect(h.matched).toHaveLength(1);
    expect(h.unknown).toEqual(["Truck"]);
  });

  test("in a driver file Truck is the truck they drive, in a truck file it is the name", () => {
    expect(readHeader("drivers", ["Name", "Truck"]).matched.map((m) => m.field)).toEqual(["Name", "Truck"]);
    expect(readHeader("trucks", ["Truck"]).matched.map((m) => m.field)).toEqual(["Name"]);
  });
});

describe("checking truck rows", () => {
  const file = (...rows: string[]) => parseCsv(["Name,Type,MPG,Home base,Terminal,Liftgate", ...rows].join("\n"));

  test("good rows come back as the values the Add truck form would save", () => {
    const check = checkTruckRows(file("Unit 1,heavy_duty,6.8,\"Dallas, TX\",Dallas,yes", "Unit 2,box_truck,9,Houston TX,Houston,no"), none);
    expect(check.total).toBe(2);
    expect(check.problemCount).toBe(0);
    const [a, b] = check.good.map((g) => g.item);
    expect(a!.values).toMatchObject({ name: "Unit 1", type: "heavy_duty", homeBaseAddress: "Dallas, TX", terminal: "Dallas", hasLiftgate: "yes" });
    expect(a!.mpg).toBe(6.8);
    expect(b!.values.hasLiftgate).toBe("");
  });

  test("a row that breaks the form's rules is left out with the form's own words, named by its column", () => {
    const check = checkTruckRows(file(",heavy_duty,6.8,,,", "Unit 2,spaceship,99,,,"), none);
    expect(check.good).toHaveLength(0);
    expect(check.problems[0]).toMatchObject({ line: 2 });
    expect(check.problems[0]!.errors).toEqual(["Name: Give the truck a name, for example Unit 104."]);
    expect(check.problems[1]!.line).toBe(3);
    expect(check.problems[1]!.errors).toEqual(expect.arrayContaining([expect.stringMatching(/^Type: /), expect.stringMatching(/^Miles per gallon between 2 and 40/)]));
  });

  test("a name already in service, in any capitalisation, or repeated in the file is left out", () => {
    const check = checkTruckRows(file("UNIT 1,,,,,", "Unit 7,,,,,", "unit 7,,,,,"), new Set(["unit 1"]));
    expect(check.good.map((g) => g.item.values.name)).toEqual(["Unit 7"]);
    expect(check.problems.map((p) => [p.line, p.errors[0]])).toEqual([
      [2, "Name: A truck named UNIT 1 is already in service."],
      [4, "Name: unit 7 is also on line 3 of this file."]
    ]);
  });

  test("blank lines are not rows", () => {
    const check = checkTruckRows(parseCsv("Name\nUnit 1\n\n  \nUnit 2\n"), none);
    expect(check.total).toBe(2);
  });

  test("a file without a Name column checks nothing", () => {
    const check = checkTruckRows(parseCsv("Type\nbox_truck\n"), none);
    expect(check.header.missing).toEqual(["Name"]);
    expect(check.total).toBe(0);
  });

  test("a tick can be yes, y, true, 1 or x", () => {
    const check = checkTruckRows(parseCsv("Name,Liftgate,Ramp,Pallet jack\nA,Y,TRUE,1\nB,x,no,\n"), none);
    expect(check.good.map((g) => [g.item.values.hasLiftgate, g.item.values.hasRamp, g.item.values.hasPalletJack])).toEqual([
      ["yes", "yes", "yes"],
      ["yes", "", ""]
    ]);
  });

  test("the list of problems is capped but the count is exact", () => {
    const rows = ["Name,MPG", ...Array.from({ length: IMPORT_MAX_PROBLEMS + 50 }, (_, i) => `Unit ${i},999`)];
    const check = checkTruckRows(parseCsv(rows.join("\n")), none);
    expect(check.problemCount).toBe(IMPORT_MAX_PROBLEMS + 50);
    expect(check.problems).toHaveLength(IMPORT_MAX_PROBLEMS);
  });
});

describe("checking driver rows", () => {
  const trucks = new Map([["unit 104", "truck-104"]]);
  const file = (...rows: string[]) => parseCsv(["Name,Phone,CDL class,CDL good through,Medical card good through,Truck,Usual pay,Rate,Terminal", ...rows].join("\n"));

  test("a date typed as month/day/year is read, and the truck is found by name", () => {
    const check = checkDriverRows(file("Alex Rivera,555-0142,A,3/31/2027,2027-06-30,Unit 104,cpm,0.55,Dallas"), trucks, none);
    expect(check.problemCount).toBe(0);
    const d = check.good[0]!.item;
    expect(d.truckId).toBe("truck-104");
    expect(d.values).toMatchObject({ name: "Alex Rivera", cdlExpiry: "2027-03-31", terminal: "Dallas", payKind: "cpm" });
    expect(d.payRate).toBe(0.55);
    expect(d.cdlExpiry).toBeInstanceOf(Date);
  });

  test("a truck that is not in service is a problem that says to import the trucks first", () => {
    const check = checkDriverRows(file("Sam Lee,,A,,,Unit 999,,,"), trucks, none);
    expect(check.good).toHaveLength(0);
    expect(check.problems[0]!.errors).toEqual(["Truck: No truck named Unit 999 is in service. Import the trucks first."]);
  });

  test("no truck is fine", () => {
    const check = checkDriverRows(file("Sam Lee,,A,,,,,,"), trucks, none);
    expect(check.good[0]!.item.truckId).toBe("");
  });

  test("the form's rules apply: a bad phone, a pay kind with no rate", () => {
    const check = checkDriverRows(file("Sam Lee,abc,A,,,,hourly,,"), trucks, none);
    expect(check.problems[0]!.errors).toEqual(expect.arrayContaining([expect.stringMatching(/^Phone: /), expect.stringMatching(/^Rate: /)]));
  });

  test("the same name and phone as a driver already there, or earlier in the file, is left out; the same name with another phone is a different person", () => {
    const existing = new Set([driverKey("Jo Park", "555-0100")]);
    const check = checkDriverRows(file("Jo Park,(555) 0100,A,,,,,,", "Jo Park,555-0199,A,,,,,,", "jo  park,555-0199,A,,,,,,"), trucks, existing);
    expect(check.good.map((g) => g.item.values.phone)).toEqual(["555-0199"]);
    expect(check.problems.map((p) => p.line)).toEqual([2, 4]);
    expect(check.problems[1]!.errors[0]).toMatch(/also on line 3/);
  });
});

describe("the template and the problem file", () => {
  test("each template is a file the desk accepts as it stands", () => {
    const trucks = checkTruckRows(parseCsv(importTemplate("trucks")), none);
    expect(trucks.problemCount).toBe(0);
    expect(trucks.good).toHaveLength(1);
    const drivers = checkDriverRows(parseCsv(importTemplate("drivers")), new Map([["unit 104", "t"]]), none);
    expect(drivers.problemCount).toBe(0);
    expect(drivers.good).toHaveLength(1);
  });

  test("the problem file puts the line and the reason before the file's own cells", () => {
    const csv = problemsCsv(["Name", "MPG"], [{ line: 3, errors: ["Miles per gallon: Miles per gallon between 2 and 40."], cells: ["Unit 2", "999"] }]);
    const rows = parseCsv(csv);
    expect(rows[0]).toEqual(["Line", "What is wrong", "Name", "MPG"]);
    expect(rows[1]).toEqual(["3", "Miles per gallon: Miles per gallon between 2 and 40.", "Unit 2", "999"]);
  });
});

describe("dates", () => {
  test("month/day/year becomes year-month-day; anything else is left for the form to judge", () => {
    expect(asYmd("3/5/2027")).toBe("2027-03-05");
    expect(asYmd("12-31-2026")).toBe("2026-12-31");
    expect(asYmd("2027-03-31")).toBe("2027-03-31");
    expect(asYmd("next spring")).toBe("next spring");
  });
});
