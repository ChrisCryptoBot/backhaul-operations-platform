import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { assertStatementSafe, driverSafeStatement, payLines, payPlan, payState, SHARE_OF_LOAD, toBalanceRow, toStatementRow, type DriverBalanceRow } from "@/lib/driver-pay";
import { statementOf, type StatementLine } from "@/lib/settlement";
import { statementPdfModel } from "@/lib/statement-pdf";

/** Sync plan Step 5a: a driver's pay as their own phone is told it, checked against the phone project's SQL. */
const SQL = readFileSync(join(__dirname, "../../../../supabase/migrations/20261122000500_bridge_driver_pay.sql"), "utf8");

const line = (o: Partial<StatementLine>): StatementLine => ({ loadId: "L1", loadNumber: "DM-1", lane: "Dallas, TX to Reno, NV", deliveredAt: "2026-11-10T18:00:00Z", basis: "$0.65 a mile × 400 mi", payKind: "cpm", payRate: 0.65, hours: null, amount: 260, brokerStatus: "paid_short", ...o });
const st = statementOf(
  [line({}), line({ loadId: "L2", loadNumber: "DM-2", payKind: "percent", payRate: 25, basis: "25% of $1,150.00", amount: 287.5 })],
  [{ label: "Detention", amount: 40 } as never],
  [{ id: "f1", on: "2026-11-09", location: "Amarillo, TX", gallons: 80, pricePerGallon: 3.5, discount: 0, amount: 280, loadNumber: null }],
  [{ deductionId: "d1", advanceId: null, kind: "escrow", label: "Maintenance escrow", basis: null, amount: -50 }]
);
const s = { id: "settle-0001", number: "ST-0101", status: "final", start: "2026-11-01", end: "2026-11-14", finalizedAt: "2026-11-15T00:00:00Z", paidAt: null, paidMethod: null, payrollSentAt: null, statement: st };
const row = toStatementRow({ orgId: "o", driverSub: "u", s, pdfPath: "org/o/desk/u/st.pdf", rev: "1:x" });

describe("a statement for the phone", () => {
  test("its lines add up to its total to the cent, and say no percent and no rate", () => {
    expect(row.total_cents).toBe(25750);
    expect(row.lines.reduce((n, l) => n + l.amount_cents, 0)).toBe(25750);
    expect(row.lines[0]).toEqual({ kind: "load", label: "DM-1, Dallas, TX to Reno, NV", detail: "Delivered Nov 10 · $0.65 a mile × 400 mi", amount_cents: 26000, load_number: "DM-1" });
    expect(row.lines[1]!.detail).toBe(`Delivered Nov 10 · ${SHARE_OF_LOAD}`);
    expect(JSON.stringify(row)).not.toMatch(/1,?150|25%|paid_short|brokerStatus/);
    expect(() => assertStatementSafe(row, [1150, 1.19])).not.toThrow();
  });

  test("the PDF is drawn from the same scrubbed lines", () => {
    const model = statementPdfModel({ number: "ST", status: "final", issuer: { name: "x", address: null, mc: null, dot: null, phone: null, email: null }, driver: { name: "d", code: null }, periodLabel: "", finalizedOn: null, payoutText: null, voidedOn: null, voidReason: null, statement: driverSafeStatement(st), balances: { escrowHeldCents: 0, advanceOwedCents: 0, asOf: "" }, ytd: null });
    expect(JSON.stringify(model)).not.toMatch(/1,?150|25%/);
    expect(JSON.stringify(model)).toContain(SHARE_OF_LOAD);
    // The desk's own copy is untouched.
    expect(st.lines[1]!.basis).toBe("25% of $1,150.00");
  });

  test("refused: an extra key, lines that do not add up, a load line that carries what the load pays", () => {
    expect(() => assertStatementSafe({ ...row, gross: 1 } as never)).toThrow(/unexpected keys/);
    expect(() => assertStatementSafe({ ...row, lines: [{ ...row.lines[0]!, rate: 1 } as never, ...row.lines.slice(1)] })).toThrow(/line has unexpected keys/);
    expect(() => assertStatementSafe({ ...row, total_cents: 1 })).toThrow(/total/);
    const leaky = { ...row, lines: [{ ...row.lines[0]!, detail: "25% of $1,150.00" }, ...row.lines.slice(1)] };
    expect(() => assertStatementSafe(leaky, [1150])).toThrow(/what the load pays/);
  });

  test("where it stands", () => {
    expect(payState({ status: "final", paidAt: null, payrollSentAt: null })).toBe("finalized");
    expect(payState({ status: "final", paidAt: null, payrollSentAt: "x" })).toBe("sent");
    expect(payState({ status: "final", paidAt: "x", payrollSentAt: "x" })).toBe("paid");
    expect(payState({ status: "void", paidAt: null, payrollSentAt: null })).toBe("void");
    expect(toStatementRow({ orgId: "o", driverSub: "u", s: { ...s, paidAt: "2026-11-16T17:00:00Z", paidMethod: "check" }, pdfPath: null, rev: "1" })).toMatchObject({ state: "paid", paid_on: "2026-11-16", paid_method: "Check" });
  });

  test("every key the desk sends is a column the phone project has", () => {
    for (const k of Object.keys(row)) expect(SQL).toMatch(new RegExp(`\\n  ${k} `));
    const b = toBalanceRow({ orgId: "o", driverSub: "u", deskDriverId: "d", escrowHeldCents: 0, advances: [], options: [], unsettled: { cents: 0, loads: 0, unpriced: 0 }, ytd: null });
    for (const k of Object.keys(b)) expect(SQL).toMatch(new RegExp(`\\n  ${k} `));
  });
});

describe("balances", () => {
  const b = toBalanceRow({
    orgId: "o",
    driverSub: "u",
    deskDriverId: "d",
    escrowHeldCents: 50000,
    advances: [{ label: "Advance of $500.00", owedCents: 20000 }, { label: "Cleared", owedCents: 0 }],
    options: [{ deductionId: "x", source: "rule", kind: "lease", label: "Truck lease", perStatementCents: 30000, proposedCents: 30000, goalCents: null, soFarCents: 0, note: null }, { deductionId: "y", source: "rule", kind: "eld", label: "ELD", perStatementCents: 1, proposedCents: 0, goalCents: 1, soFarCents: 1, note: null }],
    unsettled: { cents: 54000, loads: 2, unpriced: 1 },
    ytd: { year: 2026, statements: 3, grossCents: 900000, fuelCents: 0, adjustmentsOffCents: 0, deductionsCents: 0, advancesRepaidCents: 0, escrowReleasedCents: 0, netCents: 800000 }
  });
  test("what is owed, held and coming off; a cleared advance and a met cap are left out", () => {
    expect(b).toMatchObject({ escrow_cents: 50000, advances: [{ label: "Advance of $500.00", owed_cents: 20000 }], next_off: [{ label: "Truck lease", amount_cents: 30000 }], unsettled_cents: 54000, unsettled_loads: 2, unsettled_unpriced: 1, ytd: { year: 2026, statements: 3, pay_cents: 900000, net_cents: 800000 } });
  });

  test("only what moved is written: a statement by its revision, balances by their figures (key order does not matter)", () => {
    const there = { id: "r1", driver_sub: "u", desk_statement_id: "a", desk_rev: "1", pdf_path: null };
    const reordered = { ...b, ytd: { net_cents: 800000, pay_cents: 900000, statements: 3, year: 2026 } } as DriverBalanceRow;
    const same = payPlan({ statements: [{ driverSub: "u", id: "a", rev: "1" }], thereStatements: [there], balances: [b], thereBalances: [reordered] });
    expect(same).toEqual({ write: [], remove: [], balances: [], removeBalances: [] });
    const moved = payPlan({ statements: [{ driverSub: "u", id: "a", rev: "2" }, { driverSub: "u", id: "b", rev: "1" }], thereStatements: [there, { ...there, id: "r2", desk_statement_id: "gone" }], balances: [{ ...b, escrow_cents: 1 }], thereBalances: [b, { ...b, driver_sub: "left" }] });
    expect([moved.write.map((w) => w.id), moved.remove.map((r) => r.id), moved.balances.length, moved.removeBalances]).toEqual([["a", "b"], ["r2"], 1, ["left"]]);
  });
});

test("lines keep the statement's own order and name a deduction row", () => {
  expect(payLines(st).map((l) => l.kind)).toEqual(["load", "load", "fuel", "adjustment", "escrow"]);
  expect(payLines(st)[2]!.detail).toBe("Nov 9 · 80 gal");
  expect(payLines(st)[4]).toMatchObject({ label: "Maintenance escrow", detail: "Escrow held", amount_cents: -5000 });
});
