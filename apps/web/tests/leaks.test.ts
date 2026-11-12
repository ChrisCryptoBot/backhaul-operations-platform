import { describe, expect, test } from "vitest";
import { INTAKE_FLOOR_TAG, INTAKE_TERMS_TAG, LEAKS, buildLeakLedger, dollarsOf, dwellForgone, leakMeta, loadLeaks, type LeakItem, type LeakLoad } from "@/lib/leaks";
import { EMPTY_INTAKE, type LeakIntake } from "@/lib/leak-intake";

const TZ = "America/Chicago";
const NOW = Date.UTC(2026, 10, 5, 18, 0, 0);
const DAY = 86_400_000;
const daysAgo = (d: number) => NOW - d * DAY;

const load = (over: Partial<LeakLoad> = {}): LeakLoad => ({ loadId: "l1", loadNumber: "L-1", doneAt: daysAgo(2), lane: "Dallas, TX → Atlanta, GA", customer: "Acme", truck: "Unit 1", driver: "Ana", isTonu: false, emptyMiles: 0, drivenMiles: 500, gross: 1000, expenses: 100, floor: 1.5, tonuRevenue: 0, invoiced: true, ...over });
const item = (key: LeakItem["key"], dollars: number | null, daysBack: number, over: Partial<LeakItem> = {}): LeakItem => ({ key, at: daysAgo(daysBack), dollars, miles: 0, loadId: "l1", label: "L-1", lane: "A → B", customer: "Acme", truck: "Unit 1", ...over });

describe("what one finished load leaks", () => {
  test("empty miles are priced at the truck's frozen floor", () => {
    const [i] = loadLeaks(load({ emptyMiles: 120, floor: 1.5 }));
    expect(i).toMatchObject({ key: "empty_miles", dollars: 180, miles: 120 });
  });

  test("with no frozen floor the empty miles are counted but not priced, and nothing is invented", () => {
    const items = loadLeaks(load({ emptyMiles: 120, floor: null }));
    expect(items).toEqual([expect.objectContaining({ key: "empty_miles", dollars: null, miles: 120 })]);
    expect(loadLeaks(load({ emptyMiles: 120, floor: 0 }))[0]!.dollars).toBeNull();
  });

  test("no empty miles, no empty-mile leak", () => {
    expect(loadLeaks(load({ emptyMiles: 0 })).some((i) => i.key === "empty_miles")).toBe(false);
  });

  test("a load that paid under the floor (after its own costs) leaks the shortfall; one that cleared leaks nothing", () => {
    // Floor 1.50 x 500 miles = 750 needed; paid 1000 - 100 = 900: cleared.
    expect(loadLeaks(load()).some((i) => i.key === "below_floor")).toBe(false);
    // Paid 600 - 100 = 500 against 750: 250 short.
    const [i] = loadLeaks(load({ gross: 600 }));
    expect(i).toMatchObject({ key: "below_floor", dollars: 250 });
    // No floor, or no miles driven: it cannot be judged.
    expect(loadLeaks(load({ gross: 600, floor: null })).some((x) => x.key === "below_floor")).toBe(false);
    expect(loadLeaks(load({ gross: 600, drivenMiles: 0 })).some((x) => x.key === "below_floor")).toBe(false);
  });

  test("a TONU fee not on an invoice is owed; an invoiced one is not; a TONU has no empty-mile or floor leak", () => {
    expect(loadLeaks(load({ isTonu: true, tonuRevenue: 150, invoiced: false, emptyMiles: 80, gross: 0 }))).toEqual([expect.objectContaining({ key: "tonu_uninvoiced", dollars: 150 })]);
    expect(loadLeaks(load({ isTonu: true, tonuRevenue: 150, invoiced: true }))).toEqual([]);
    expect(loadLeaks(load({ isTonu: true, tonuRevenue: 0, invoiced: false }))).toEqual([]);
  });
});

describe("the ledger", () => {
  const items: LeakItem[] = [
    item("empty_miles", 180.1, 2, { lane: "Dallas → Atlanta", truck: "Unit 1", miles: 120 }),
    item("empty_miles", 0.2, 3, { lane: "Dallas → Atlanta", truck: "Unit 2" }),
    item("empty_miles", null, 3, { lane: "Memphis → Dallas", truck: "Unit 2", miles: 90, loadId: "l9" }),
    item("below_floor", 250, 2),
    item("detention_unbilled", 165, 4, { customer: "Beta" }),
    item("tonu_uninvoiced", 150, 9, { customer: "Beta", lane: "Dallas → Atlanta" }),
    item("detention_waived", 75, 12, { lane: "Memphis → Dallas" }),
    item("dwell_forgone", 90, 1, { loadId: null, label: "TR-7", lane: null, customer: null, truck: null }),
    item("empty_miles", 40, 40) // outside a four-week window
  ];
  const ledger = buildLeakLedger(items, { period: "4w", compare: false }, NOW, TZ);
  const line = (k: string) => ledger.current.lines.find((l) => l.key === k)!;

  test("one line per leak with its dollars, its item count and how many could not be priced", () => {
    expect(ledger.current.lines.map((l) => l.key)).toEqual(LEAKS.map((l) => l.key));
    expect(line("empty_miles")).toMatchObject({ dollars: 180.3, items: 3, unpriced: 1, unpricedMiles: 90 }); // 180.10 + 0.20 in cents, the 40-day-old one left out
    expect(line("detention_unbilled")).toMatchObject({ dollars: 165, items: 1, unpriced: 0 });
  });

  test("the total adds the counted lines only: the below-floor lens overlaps empty miles and is never added", () => {
    expect(line("below_floor").counted).toBe(false);
    expect(ledger.current.total).toBe(180.3 + 165 + 150 + 75 + 90);
    expect(ledger.current.unpriced).toBe(1);
  });

  test("every line says its basis in words", () => {
    for (const l of ledger.current.lines) expect(l.basis.length).toBeGreaterThan(30);
    expect(line("empty_miles").basis).toMatch(/frozen/);
  });

  test("weeks are the twelve trailing seven-day buckets, newest last, each with the same total rule", () => {
    expect(ledger.weeks).toHaveLength(12);
    const last = ledger.weeks[11]!;
    expect(last.byKey.empty_miles).toBe(180.3); // the two priced items in the last seven days
    expect(last.byKey.dwell_forgone).toBe(90);
    expect(last.total).toBe(180.3 + 165 + 90); // empty, unbilled detention (4 days ago), dwell; the below-floor lens is excluded
    expect(ledger.weeks.reduce((s, w) => s + w.byKey.empty_miles, 0)).toBe(180.3 + 40);
  });

  test("the lanes, customers and trucks it came from, biggest first, counted lines only", () => {
    expect(ledger.byLane[0]).toMatchObject({ name: "Dallas → Atlanta", dollars: 180.3 + 150 });
    expect(ledger.byTruck.map((t) => t.name)).toEqual(["Unit 1", "Unit 2"]);
    expect(ledger.byCustomer[0]).toMatchObject({ name: "Beta", dollars: 165 + 150 });
    expect(ledger.byLane.find((l) => l.name === "Memphis → Dallas")).toMatchObject({ unpriced: 1, items: 2 });
  });

  test("the biggest single items exclude the lens and anything unpriced", () => {
    expect(ledger.top.map((t) => `${t.key}:${t.dollars}`)).toEqual(["empty_miles:180.1", "detention_unbilled:165", "tonu_uninvoiced:150", "dwell_forgone:90", "detention_waived:75", "empty_miles:0.2"]);
  });

  test("a comparison reads the period before it on the same rules", () => {
    const cmp = buildLeakLedger(items, { period: "4w", compare: true }, NOW, TZ);
    expect(cmp.prior).not.toBeNull();
    expect(cmp.prior!.lines.find((l) => l.key === "empty_miles")!.dollars).toBe(40);
    expect(buildLeakLedger(items, { period: "all", compare: true }, NOW, TZ).prior).toBeNull();
  });

  test("an empty ledger is zeros, not an error", () => {
    const none = buildLeakLedger([], { period: "month", compare: true }, NOW, TZ);
    expect(none.current.total).toBe(0);
    expect(none.weeks.every((w) => w.total === 0)).toBe(true);
    expect(none.top).toEqual([]);
    expect(none.openDwell).toEqual({ dollars: 0, trailers: 0, rows: [] });
  });

  test("cents add exactly (0.1 and 0.2 are 0.3, not 0.30000000000000004)", () => {
    const l = buildLeakLedger([item("tonu_uninvoiced", 0.1, 1), item("tonu_uninvoiced", 0.2, 1)], { period: "4w", compare: false }, NOW, TZ);
    expect(l.current.total).toBe(0.3);
  });
});

describe("an imported load, priced from the carrier's intake", () => {
  const intake = (over: Partial<LeakIntake> = {}): LeakIntake => ({ ...EMPTY_INTAKE, costPerMile: 1.5, ...over });
  const imported = (over: Partial<LeakLoad> = {}) => load({ imported: true, floor: null, emptyMiles: 120, ...over });

  test("empty miles are priced at the truck's own intake figure, else the fleet's, as an intake line and never as a frozen one", () => {
    const fleet = loadLeaks(imported(), intake());
    expect(fleet).toEqual([expect.objectContaining({ key: "empty_miles_intake", dollars: 180, miles: 120, basisNote: expect.stringMatching(/fleet's intake figure/) })]);
    const own = loadLeaks(imported(), intake({ trucks: [{ name: "Unit 1", costPerMile: 2 }] }));
    expect(own[0]).toMatchObject({ key: "empty_miles_intake", dollars: 240, basisNote: expect.stringMatching(/Unit 1's intake figure/) });
    expect(own.some((i) => i.key === "empty_miles")).toBe(false);
  });

  test("with no intake figure for the truck the empty miles are counted and not priced; nothing is invented", () => {
    for (const given of [undefined, null, EMPTY_INTAKE, intake({ costPerMile: null, trucks: [{ name: "Unit 9", costPerMile: 2 }] })]) {
      expect(loadLeaks(imported(), given)).toEqual([expect.objectContaining({ key: "empty_miles_intake", dollars: null, miles: 120, basisNote: null })]);
    }
  });

  test("a floor frozen on the load always wins, even on an imported one, and its lines stay the frozen ones", () => {
    const items = loadLeaks(imported({ floor: 1.2, gross: 600 }), intake({ costPerMile: 9 }));
    expect(items.map((i) => i.key)).toEqual(["empty_miles", "below_floor"]);
    expect(items[0]!.dollars).toBe(144);
  });

  test("a load booked on the desk with no frozen floor stays unpriced: the intake speaks for imported history only", () => {
    expect(loadLeaks(load({ floor: null, emptyMiles: 120 }), intake())).toEqual([expect.objectContaining({ key: "empty_miles", dollars: null })]);
  });

  test("the lens on the intake floor is the intake figure times the miles driven, less the pay and the costs; it needs a figure, and only a shortfall counts", () => {
    // 1.50 x 500 driven = 750 needed; paid 600 and no costs in a file: 150 short.
    const [, lens] = loadLeaks(imported({ gross: 600, expenses: 0 }), intake());
    expect(lens).toMatchObject({ key: "below_floor_intake", dollars: 150 });
    expect(loadLeaks(imported({ gross: 900, expenses: 0 }), intake()).some((i) => i.key === "below_floor_intake")).toBe(false);
    expect(loadLeaks(imported({ gross: 600, emptyMiles: 0 }), EMPTY_INTAKE)).toEqual([]);
    expect(leakMeta("below_floor_intake")).toMatchObject({ counted: false, group: "lens", intake: true });
  });

  test("every intake line says so in its name and its basis, and no frozen line does", () => {
    const intakeLines = LEAKS.filter((l) => l.intake);
    expect(intakeLines.map((l) => l.key).sort()).toEqual(["below_floor_intake", "detention_unbilled_intake", "detention_waived_intake", "empty_miles_intake"]);
    for (const l of intakeLines) {
      expect(l.label, l.key).toMatch(/imported loads/);
      expect(l.label, l.key).toMatch(l.key.startsWith("detention") ? new RegExp(INTAKE_TERMS_TAG) : new RegExp(INTAKE_FLOOR_TAG));
      expect(l.basis, l.key).toMatch(/intake|booking/);
    }
    expect(INTAKE_FLOOR_TAG).toBe("intake floor, not frozen at booking");
    for (const l of LEAKS.filter((x) => !x.intake)) expect(l.label, l.key).not.toMatch(/intake/i);
  });

  test("keys come in pairs: each frozen line has its intake twin in the same group, and the lens twin is not counted either", () => {
    for (const [frozen, twin] of [["empty_miles", "empty_miles_intake"], ["below_floor", "below_floor_intake"], ["detention_unbilled", "detention_unbilled_intake"], ["detention_waived", "detention_waived_intake"]] as const) {
      expect(leakMeta(twin).group).toBe(leakMeta(frozen).group);
      expect(leakMeta(twin).counted).toBe(leakMeta(frozen).counted);
    }
  });

  const items: LeakItem[] = [
    item("empty_miles", 180, 2, { lane: "Dallas → Atlanta", customer: "Acme" }),
    item("empty_miles_intake", 100.1, 2, { lane: "Dallas → Atlanta", customer: "Acme", basisNote: "$1.50 a mile, the fleet's intake figure", loadId: "i1", label: "I-1", miles: 66 }),
    item("empty_miles_intake", null, 3, { lane: "Tulsa → Joplin", customer: "Globex", miles: 50, loadId: "i2", label: "I-2" }),
    item("below_floor_intake", 175, 3, { lane: "Tulsa → Joplin", customer: "Globex", loadId: "i2", label: "I-2" }),
    item("detention_unbilled_intake", 120.2, 4, { lane: "Dallas → Atlanta", customer: "Acme", loadId: "i1", label: "I-1", basisNote: "$90.00 an hour (customer's intake terms), 60 minutes free (customer's intake terms)" }),
    item("detention_unbilled_intake", null, 4, { lane: "Tulsa → Joplin", customer: "Globex", loadId: "i3", label: "I-3" }),
    item("detention_unbilled", 165, 4, { customer: "Beta" })
  ];
  const ledger = buildLeakLedger(items, { period: "4w", compare: false }, NOW, TZ);
  const line = (k: string) => ledger.current.lines.find((l) => l.key === k)!;

  test("the ledger keeps the two bases on separate lines: a frozen line never holds an intake dollar", () => {
    expect(line("empty_miles")).toMatchObject({ dollars: 180, items: 1, intake: false });
    expect(line("empty_miles_intake")).toMatchObject({ dollars: 100.1, items: 2, unpriced: 1, unpricedMiles: 50, intake: true });
    expect(line("detention_unbilled")).toMatchObject({ dollars: 165, items: 1 });
    expect(line("detention_unbilled_intake")).toMatchObject({ dollars: 120.2, items: 2, unpriced: 1 });
  });

  test("the total adds the counted lines of both bases in whole cents; the lens, frozen or intake, is never added", () => {
    expect(ledger.current.total).toBe(565.3); // 180 + 100.10 + 165 + 120.20
    expect(line("below_floor_intake")).toMatchObject({ dollars: 175, counted: false });
    expect(ledger.current.total).not.toBe(740.3);
  });

  test("the part that rests on the intake is stated beside the total, inside it, with its items and what could not be priced", () => {
    expect(ledger.current.intake).toEqual({ dollars: 220.3, items: 4, unpriced: 2 });
    expect(ledger.current.intake.dollars).toBeLessThan(ledger.current.total);
    expect(buildLeakLedger([item("empty_miles", 10, 1)], { period: "4w", compare: false }, NOW, TZ).current.intake).toEqual({ dollars: 0, items: 0, unpriced: 0 });
  });

  test("lanes, customers and trucks split out how much of each row's dollars is the intake's", () => {
    const acme = ledger.byCustomer.find((r) => r.name === "Acme")!;
    expect(acme).toMatchObject({ dollars: 400.3, intake: 220.3 });
    expect(ledger.byCustomer.find((r) => r.name === "Beta")).toMatchObject({ intake: 0 });
    expect(ledger.byLane.find((r) => r.name === "Tulsa → Joplin")).toMatchObject({ dollars: 0, intake: 0, unpriced: 2 });
  });

  test("the biggest items say which basis they rest on and the intake figure used", () => {
    const top = ledger.top.find((t) => t.label === "I-1" && t.key === "detention_unbilled_intake")!;
    expect(top).toMatchObject({ intake: true, basisNote: expect.stringMatching(/customer's intake terms/) });
    expect(ledger.top.find((t) => t.key === "empty_miles")).toMatchObject({ intake: false, basisNote: null });
    expect(ledger.top.some((t) => t.key === "below_floor_intake")).toBe(false);
  });

  test("the weeks carry a figure for every key, intake ones included", () => {
    const last = ledger.weeks[11]!;
    expect(Object.keys(last.byKey).sort()).toEqual(LEAKS.map((l) => l.key).sort());
    expect(ledger.weeks.reduce((s, w) => s + w.byKey.empty_miles_intake, 0)).toBe(100.1);
  });

  test("what the file could not be checked for rides along, and is nothing when it is not given", () => {
    expect(ledger.coverage).toEqual({ importedLoads: 0, noStopTimes: { loads: 0, sample: [] } });
    const cov = { importedLoads: 5, noStopTimes: { loads: 2, sample: [{ loadId: "i9", label: "I-9" }] } };
    expect(buildLeakLedger([], { period: "4w", compare: false, coverage: cov }, NOW, TZ).coverage).toEqual(cov);
  });
});

describe("reading the audit trail's dwell figures", () => {
  test("dollar text is read, anything else is not", () => {
    expect(dollarsOf("$165.00")).toBe(165);
    expect(dollarsOf("$1,250.50")).toBe(1250.5);
    expect(dollarsOf(" 90 ")).toBe(90);
    expect(dollarsOf("Waived")).toBeNull();
    expect(dollarsOf(undefined)).toBeNull();
  });

  test("a waiver or a lowered figure gave up the drop; a raise or an unreadable one gave up nothing", () => {
    expect(dwellForgone("$165.00", "$0.00")).toBe(165);
    expect(dwellForgone("$165.00", "Waived")).toBe(165);
    expect(dwellForgone("$165.00", "$90.00")).toBe(75);
    expect(dwellForgone("$90.00", "$165.00")).toBeNull();
    expect(dwellForgone("$0.00", "$0.00")).toBeNull();
    expect(dwellForgone("Company", "$10.00")).toBeNull();
  });
});
