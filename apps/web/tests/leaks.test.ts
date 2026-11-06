import { describe, expect, test } from "vitest";
import { LEAKS, buildLeakLedger, dollarsOf, dwellForgone, loadLeaks, type LeakItem, type LeakLoad } from "@/lib/leaks";

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
