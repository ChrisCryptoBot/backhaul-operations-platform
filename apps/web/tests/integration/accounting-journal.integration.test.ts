import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { invoiceLoad, issueCreditMemo, markLoadPaid } from "@/server/tl/invoicing";
import { saveFactoringTerms } from "@/server/partners/factoring-terms";
import { applyFactoringUpdate } from "@/server/partners/factoring";
import { accountMapOf, journalFile, requireMapped, saveAccounts } from "@/server/partners/accounting";

/**
 * The accounting accounts and the journal (docs/MONEY_PLAN.md, Wave 3, step 2) on the demo database, in a workspace of its own: real invoices, a payment, a factored invoice funded and paid
 * through the factoring steps, a credit memo, a 1099 statement and a fuel card purchase. The journal balances, its receivables add up to the invoice records, and a kind with no account stops it.
 *   DATABASE_URL=postgresql://demo:demo@localhost:54330/demo RUN_DB_INTEGRATION=true npx vitest run tests/integration/accounting-journal.integration.test.ts
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const W = "acct-journal";
const NOW = new Date("2026-11-20T18:00:00Z");
const TERMS = { transport: "api" as const, batchDestination: "", factorName: "Apex Capital", remitName: "", remitAddress: "", lockboxBank: "", routingNumber: "", accountNumber: "", noaText: "", advancePct: "90", feePct: "2.5" };
const FORM = { terms: "30", detention: false, lumper: "", layover: "", otherLabel: "", other: "" };

type Row = string[];
const parse = (csv: string): Row[] => {
  const out: Row[] = [];
  for (const line of csv.replace(/^﻿/, "").trim().split("\r\n").slice(1)) {
    const cells: string[] = [];
    let cur = "";
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
      if (q) {
        if (ch === '"' && line[i + 1] === '"') (cur += '"'), i++;
        else if (ch === '"') q = false;
        else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === ",") cells.push(cur), (cur = "");
      else cur += ch;
    }
    cells.push(cur);
    out.push(cells);
  }
  return out;
};
const cents = (s: string | undefined) => (s ? Math.round(Number.parseFloat(s) * 100) : 0);

describe.skipIf(!run)("the journal and the accounts", () => {
  const loads: Record<string, string> = {};
  beforeAll(async () => {
    await prisma.driverLedgerEntry.deleteMany({ where: { workspace: { id: W } } });
    await prisma.assignment.deleteMany({ where: { OR: [{ load: { workspace: { id: W } } }, { driver: { workspace: { id: W } } }] } });
    await prisma.workspace.deleteMany({ where: { id: W } });
    await prisma.workspace.create({ data: { id: W, name: "Journal desk", plan: "enterprise", timezone: "America/Chicago" } as never });
    expect(await saveFactoringTerms(TERMS, "test", NOW, W)).toMatchObject({ ok: true });
    for (const [n, rate] of [["A", 1000], ["B", 2000], ["F", 1000]] as const) {
      const l = await prisma.load.create({ data: { workspaceId: W, loadNumber: `J-${n}`, brokerName: "Acme Logistics", status: "completed", completedAt: NOW, quotedRevenue: rate, podNote: "Signed" } as never });
      loads[n] = l.id;
      expect(await invoiceLoad(l.id, { form: { ...FORM, number: `JINV-${n}` } }, NOW, W)).toMatchObject({ ok: true });
    }
    // A is paid in full; B gets a credit memo of 200; F goes to the factor, is funded, and the customer pays the factor.
    expect(await markLoadPaid(loads.A!, NOW, { amount: 1000, source: "desk" } as never, W)).toMatchObject({ ok: true });
    expect(await issueCreditMemo(loads.B!, { amount: 200, reason: "Late delivery" }, NOW, W)).toMatchObject({ ok: true });
    const f = await prisma.invoice.findFirstOrThrow({ where: { workspaceId: W, number: "JINV-F" } });
    await prisma.invoice.update({ where: { id: f.id }, data: { factoringStatus: "submitted" } });
    await prisma.load.update({ where: { id: loads.F! }, data: { factoringStatus: "submitted" } });
    expect(await applyFactoringUpdate(loads.F!, "funded", "APX-9", new Date("2026-11-21T18:00:00Z"), W)).toBe(true);
    expect(await markLoadPaid(loads.F!, new Date("2026-12-01T18:00:00Z"), { payer: "Apex Capital", source: "factor", shortAction: "balance" } as never, W)).toMatchObject({ ok: true });
    // A 1099 driver's finalized statement with fuel taken off, and the fuel card purchase itself.
    const d = await prisma.driver.create({ data: { workspaceId: W, name: "Sam Owner", payrollWorkerType: "contractor" } as never });
    await prisma.settlement.create({ data: { workspaceId: W, driverId: d.id, number: "ST-1", status: "final", periodStart: new Date("2026-11-16"), periodEnd: new Date("2026-11-22"), total: new Prisma.Decimal("1500.00"), fuel: [{ id: "x", amount: 300 }] as never, finalizedAt: new Date("2026-11-23T18:00:00Z"), lineRows: { create: [{ workspaceId: W, sort: 0, kind: "load", label: "Load", amount: 1800 }, { workspaceId: W, sort: 10000, kind: "fuel", label: "Fuel card", amount: -300 }] } } });
    await prisma.fuelTransaction.create({ data: { workspaceId: W, provider: "wex", externalId: "t-1", postedAt: new Date("2026-11-18T18:00:00Z"), amount: new Prisma.Decimal("300.00"), location: "Amarillo, TX" } });
  });
  afterAll(async () => {
    await prisma.driverLedgerEntry.deleteMany({ where: { workspace: { id: W } } });
    await prisma.assignment.deleteMany({ where: { OR: [{ load: { workspace: { id: W } } }, { driver: { workspace: { id: W } } }] } });
    await prisma.workspace.deleteMany({ where: { id: W } });
  });

  test("funding an invoice keeps the day it was funded", async () => {
    const f = await prisma.invoice.findFirstOrThrow({ where: { workspaceId: W, number: "JINV-F" } });
    expect([f.factoringFundedAt?.toISOString(), f.factoringAdvance?.toNumber(), f.factoringFee?.toNumber(), f.factoringReserveReleased?.toNumber()]).toEqual(["2026-11-21T18:00:00.000Z", 900, 25, 75]);
  });

  test("a kind with no account stops the journal and the sync guard, naming it; choosing one lets it through", async () => {
    const b = await prisma.invoice.findFirstOrThrow({ where: { workspaceId: W, number: "JINV-B" } });
    expect((await prisma.invoice.findFirstOrThrow({ where: { workspaceId: W, creditOfId: b.id } })).kind).toBe("credit_memo");
    // The memo's line is a "credit" line, and Credits has no default.
    expect(await requireMapped(["linehaul", "credit"], W)).toMatchObject({ ok: false, unmapped: ["credit"] });
    const blocked = await journalFile({}, W);
    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;
    expect(blocked.unmapped).toEqual(["credit"]);
    expect(await saveAccounts({ credit: { account: "Discounts Given", number: "4900" }, linehaul: { account: "", number: "" } }, "Test admin", NOW, W)).toEqual({ ok: true, changed: 1 });
    expect((await accountMapOf(W)).credit).toEqual({ account: "Discounts Given", number: "4900", fallback: false });
    expect(await prisma.auditEvent.count({ where: { workspaceId: W, action: "accounting_accounts_saved" } })).toBe(1);
    const out = await journalFile({ from: "2026-11-01", to: "2026-11-30" }, W);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.filename).toBe("journal-2026-11-01-to-2026-11-30.csv");
    expect(out.csv).toContain("Discounts Given,4900,200.00");
    // The span is days in the fleet's zone: the December release is not in November's journal.
    expect(out.csv).not.toContain("factoring_release");
    // Saving the same again changes nothing and writes no second audit row.
    expect(await saveAccounts({ credit: { account: "Discounts Given", number: "4900" } }, "Test admin", NOW, W)).toEqual({ ok: true, changed: 0 });
  });

  test("the journal balances, every entry and in all; receivables add up to the invoice records; the fleet's cash is what it actually received", async () => {
    const out = await journalFile({}, W);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const rows = parse(out.csv);
    const byEntry = new Map<string, number>();
    for (const r of rows) byEntry.set(r[1]!, (byEntry.get(r[1]!) ?? 0) + cents(r[4]) - cents(r[5]));
    expect([...byEntry.values()].every((v) => v === 0)).toBe(true);
    const sum = (acct: string) => rows.filter((r) => r[2] === acct).reduce((s, r) => s + cents(r[4]) - cents(r[5]), 0);

    const recs = await prisma.invoice.findMany({ where: { workspaceId: W, status: { not: "void" } } });
    const recordTotal = recs.reduce((s, r) => s + Math.round(r.total.toNumber() * 100), 0);
    // Receivables raised by the invoices and memos equal the records' totals: 1000 + 2000 + 1000 - 200.
    const arRaised = rows.filter((r) => r[2] === "Accounts Receivable" && (r[7] === "invoice" || r[7] === "credit_memo")).reduce((s, r) => s + cents(r[4]) - cents(r[5]), 0);
    expect([arRaised, recordTotal]).toEqual([380000, 380000]);
    // What is still owed: B's 2000 less its 200 credit. A was paid; F was sold to the factor.
    expect(sum("Accounts Receivable")).toBe(180000);
    // Cash: A's 1000, F's advance 900 and released reserve 75; the 300 card purchase and the statement are not paid yet.
    expect(sum("Undeposited Funds")).toBe(197500);
    expect([sum("Factoring Fees"), sum("Factoring Reserve"), sum("Freight Income"), sum("Discounts Given"), sum("Driver Pay"), sum("Fuel"), sum("Accounts Payable"), sum("Fuel Card Payable")]).toEqual([2500, 0, -400000, 20000, 180000, 0, -150000, -30000]);
    expect(out.check).toMatchObject({ arFromInvoices: 380000 });
  });

  test("a blank account goes back to its default, or to unmapped when it has none", async () => {
    // Blank goes back to unmapped (Credits has no default).
    expect(await saveAccounts({ credit: { account: "", number: "" } }, "Test admin", NOW, W)).toEqual({ ok: true, changed: 1 });
    expect((await accountMapOf(W)).credit).toBeNull();
  });

  test("a funded invoice with no advance recorded is a problem the journal names, not a guess", async () => {
    const f = await prisma.invoice.findFirstOrThrow({ where: { workspaceId: W, number: "JINV-F" } });
    await prisma.invoice.update({ where: { id: f.id }, data: { factoringAdvance: null } });
    const out = await journalFile({}, W);
    expect(out).toMatchObject({ ok: false, problems: [expect.stringContaining("JINV-F: the factor funded it but no advance")] });
    await prisma.invoice.update({ where: { id: f.id }, data: { factoringAdvance: new Prisma.Decimal("900.00") } });
  });
});
