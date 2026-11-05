import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { computeStatement, statementOf, type FuelLine, type SettlementLoad } from "@/lib/settlement";

const src = (p: string) => fs.readFileSync(path.join(__dirname, "..", p), "utf8").replace(/\r\n/g, "\n");

const load = (n: number, over: Partial<SettlementLoad> = {}): SettlementLoad => ({
  loadId: `l${n}`, loadNumber: `L-${n}`, origin: "Dallas, TX", destination: "Atlanta, GA", deliveredAt: "2026-11-04T18:00:00.000Z", loadedMiles: 800, payKind: "cpm", payRate: 0.5, rateConTotal: 1500, assignedHours: null, brokerStatus: "paid", ...over
});
const fuel = (n: number, amount: number, over: Partial<FuelLine> = {}): FuelLine => ({ id: `f${n}`, on: "2026-11-03", location: "Pilot, Dallas, TX", gallons: 100, pricePerGallon: 4, discount: 25, amount, loadNumber: "L-1", ...over });

describe("net pay: pay for the loads, less fuel, plus the adjustments", () => {
  it("with no fuel it is the statement it always was", () => {
    const st = computeStatement({ loads: [load(1)], hours: {}, adjustments: [{ label: "Advance", amount: "-100" }] });
    expect(st).toMatchObject({ loadsTotal: 400, fuelTotal: 0, adjustmentsTotal: -100, total: 300, fuel: [] });
  });

  it("takes each purchase off, to the cent, and keeps the pieces", () => {
    const st = computeStatement({ loads: [load(1), load(2)], hours: {}, adjustments: [{ label: "Bonus", amount: "50.25" }], fuel: [fuel(1, 375.4), fuel(2, 311.04), fuel(3, 0.1)] });
    expect(st.loadsTotal).toBe(800);
    expect(st.fuelTotal).toBe(686.54);
    expect(st.adjustmentsTotal).toBe(50.25);
    expect(st.total).toBe(163.71); // 800 - 686.54 + 50.25
    expect(st.fuel.map((f) => f.id)).toEqual(["f1", "f2", "f3"]);
  });

  it("adds cents, never floats: a hundred purchases of ten cents come to exactly ten dollars", () => {
    const st = computeStatement({ loads: [load(1)], hours: {}, adjustments: [], fuel: Array.from({ length: 100 }, (_, i) => fuel(i, 0.1)) });
    expect(st.fuelTotal).toBe(10);
    expect(st.total).toBe(390);
  });

  it("fuel bigger than the pay makes a negative statement, and says the driver owes it", () => {
    const st = computeStatement({ loads: [load(1)], hours: {}, adjustments: [], fuel: [fuel(1, 900)] });
    expect(st.total).toBe(-500);
    expect(st.cautions.join(" ")).toContain("more than the pay");
  });

  it("fuel alone is not something to pay: a statement with no loads and no adjustments still has nothing on it", () => {
    const st = computeStatement({ loads: [], hours: {}, adjustments: [], fuel: [fuel(1, 100)] });
    expect(st.blockers).toContain("There is nothing to pay on this statement.");
  });

  it("a statement read back from what was frozen comes to the same net", () => {
    const live = computeStatement({ loads: [load(1)], hours: {}, adjustments: [{ label: "Advance", amount: "-40" }], fuel: [fuel(1, 123.45)] });
    const back = statementOf(live.lines, live.adjustments, live.fuel);
    expect(back).toMatchObject({ loadsTotal: live.loadsTotal, fuelTotal: 123.45, adjustmentsTotal: -40, total: live.total, fuel: live.fuel });
    // A statement frozen before fuel existed has none, and reads as it did.
    expect(statementOf(live.lines, live.adjustments)).toMatchObject({ fuel: [], fuelTotal: 0, total: 360 });
  });
});

describe("the statement shows its fuel, and the sheet prints it", () => {
  it("the final page, the draft sheet and the editor use the ledger and the net table", () => {
    for (const f of ["src/app/(desk)/settlements/[id]/page.tsx", "src/components/desk/settlement-forms.tsx"]) {
      const text = src(f);
      expect(text, f).toContain("<FuelLedger");
      expect(text, f).toContain("<NetPay");
      expect(text, f).toContain('"Net pay"');
    }
  });

  it("with no fuel the sheet still says Gross pay and one total line", () => {
    expect(src("src/app/(desk)/settlements/[id]/page.tsx")).toContain('st.fuel.length > 0 ? "Net pay" : "Gross pay"');
    expect(src("src/components/desk/statement-fuel.tsx")).toContain("Total to ${driverName}");
  });

  it("the ledger is plain table markup that prints, with deductions as real minus signs and no controls", () => {
    const f = src("src/components/desk/statement-fuel.tsx");
    expect(f).toContain("usd(-f.amount, 2)");
    expect(f).not.toMatch(/<button|<input|onClick/);
    expect(f).toContain("Fuel card, ");
  });

  it("a fuel purchase can be picked only on the draft, and the finalize takes each once", () => {
    const server = src("src/server/tl/settlement.ts");
    expect(server).toContain("settlementId: null, postedAt");
    expect(server).toContain("where: { id: { in: statement.fuel.map((f) => f.id) }, workspaceId, settlementId: null }");
    expect(server).toContain("throw new FuelTaken()");
    expect(server).toContain("where: { settlementId: id, workspaceId }, data: { settlementId: null }"); // a voided statement gives them back
  });
});
