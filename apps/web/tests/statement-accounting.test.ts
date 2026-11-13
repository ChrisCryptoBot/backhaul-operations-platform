import { describe, expect, test } from "vitest";
import { ACCOUNT_KEYS, resolveAccounts } from "../src/lib/accounting-map";
import { advanceCreditKey, buildJournal, ROW_ACCOUNT, statementPostings, type JAdvance, type JSettlement } from "../src/lib/journal";
import { DEDUCTION_ROW_KINDS } from "../src/lib/deductions";

/**
 * Accounting for the statement's new lines (docs/MONEY_PLAN.md, Wave 4 step 7): every row kind to its account, escrow a liability and never income, an advance repaid out of the asset, the
 * net to payables; advances given outside a statement booked as the asset against cash or the fuel card; every entry balanced; W-2 left to payroll.
 */
const at = (s: string) => new Date(s);
const ZONE = "America/Chicago";
const rows = [
  { kind: "load", amount: 100000 },
  { kind: "adjustment", amount: 5000 },
  { kind: "adjustment", amount: -2000 },
  { kind: "fuel", amount: -30000 },
  { kind: "deduction", amount: -20000 },
  { kind: "escrow", amount: -10000 },
  { kind: "escrow_release", amount: 4000 },
  { kind: "advance_repaid", amount: -15000 }
];
const NET = 32000;
const statement = (o: Partial<JSettlement> = {}): JSettlement => ({ id: "s1", number: "ST-1", driver: "Sam", workerType: "contractor", finalizedAt: at("2026-11-07T18:00:00Z"), total: NET, rows, paidAt: at("2026-11-10T18:00:00Z"), ...o });

describe("the accounts", () => {
  test("the three new keys exist with defaults, in the right groups: escrow and advances are balance accounts, never income", () => {
    const by = Object.fromEntries(ACCOUNT_KEYS.map((k) => [k.key, k]));
    expect(by.escrow_liability).toMatchObject({ group: "balance", fallback: "Driver Escrow" });
    expect(by.driver_advances).toMatchObject({ group: "balance", fallback: "Driver Advances" });
    expect(by.deduction_income).toMatchObject({ group: "income", fallback: "Driver Deduction Income" });
    const map = resolveAccounts([]);
    for (const k of ["escrow_liability", "driver_advances", "deduction_income"]) expect(map[k]).toMatchObject({ fallback: true });
  });

  test("every statement row kind the desk writes has an account", () => {
    for (const k of ["load", "adjustment", "fuel", ...DEDUCTION_ROW_KINDS]) expect(ROW_ACCOUNT[k], k).toBeTruthy();
    expect(ROW_ACCOUNT.escrow).toBe("escrow_liability");
    expect(ROW_ACCOUNT.escrow_release).toBe("escrow_liability");
    expect(ROW_ACCOUNT.advance_repaid).toBe("driver_advances");
    expect(ROW_ACCOUNT.deduction).toBe("deduction_income");
  });
});

describe("a statement's postings", () => {
  test("each row at its own signed amount, netted per account, the net to payables; debits equal credits", () => {
    const p = statementPostings(statement());
    if ("problem" in p) throw new Error(p.problem);
    expect(p.net).toBe(NET);
    expect(Object.fromEntries(p.postings)).toEqual({ driver_pay_1099: 103000, fuel: -30000, deduction_income: -20000, escrow_liability: -6000, driver_advances: -15000, accounts_payable: -NET });
    expect(p.postings.reduce((s, [, v]) => s + v, 0)).toBe(0);
  });

  test("refused when a kind has no account or the rows do not add up to the total", () => {
    expect(statementPostings(statement({ rows: [...rows, { kind: "mystery", amount: 1 }] }))).toEqual({ problem: expect.stringContaining("mystery") });
    expect(statementPostings(statement({ total: NET + 1 }))).toEqual({ problem: expect.stringContaining("not the 320.01") });
  });
});

describe("the journal", () => {
  const adv = (o: Partial<JAdvance> & { id: string }): JAdvance => ({ driver: "Sam", workerType: "contractor", givenOn: "2026-11-02", method: "cash", amount: 50000, label: "Advance of $500.00", ...o });

  test("statement, payment and advances balance; the advance asset comes back down as it is repaid; W-2 is payroll's", () => {
    const out = buildJournal(
      { invoices: [], fuel: [], settlements: [statement(), statement({ id: "s2", number: "ST-2", workerType: "employee" })], advances: [adv({ id: "a1" }), adv({ id: "a2", method: "fuel_card", amount: 10000 }), adv({ id: "a3", workerType: "employee" })] },
      { zone: ZONE }
    );
    expect(out.problems).toEqual([]);
    expect(out.entries.map((e) => e.id).sort()).toEqual(["advance:a1", "advance:a2", "settlement:s1", "settlement_paid:s1"]);
    for (const e of out.entries) expect(e.lines.reduce((s, l) => s + l.debit, 0), e.id).toBe(e.lines.reduce((s, l) => s + l.credit, 0));
    const net = (key: string) => out.entries.flatMap((e) => e.lines).filter((l) => l.key === key).reduce((s, l) => s + l.debit - l.credit, 0);
    // Given $500 cash and $100 on the card, $150 repaid: $450 still owed.
    expect(net("driver_advances")).toBe(50000 + 10000 - 15000);
    expect(net("fuel_card_payable")).toBe(-10000);
    expect(net("cash")).toBe(-50000 - NET);
    expect(net("accounts_payable")).toBe(0);
    expect(net("escrow_liability")).toBe(-6000); // held for the driver: a credit balance, never income
    expect(out.keys).not.toContain("escrow_income");
    expect(advanceCreditKey("transfer")).toBe("cash");
    expect(out.notes[0]).toContain("company drivers (W-2)");
  });

  test("a statement whose rows do not match its total is a problem, not a guess", () => {
    const out = buildJournal({ invoices: [], fuel: [], settlements: [statement({ total: 1 })] }, { zone: ZONE });
    expect(out.problems).toEqual([expect.stringContaining("ST-1")]);
    expect(out.entries).toEqual([]);
  });
});
