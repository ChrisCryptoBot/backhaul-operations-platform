import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { journalFile } from "@/server/partners/accounting";
import { SANDBOX_REALM } from "@/server/partners/adapters/oauth-exchange";
import { resetSandboxBook, sandboxBook } from "@/server/partners/adapters/quickbooks";
import { beginOAuth, completeOAuth } from "@/server/partners/oauth";
import { syncAccounting } from "@/server/partners/qbo-sync";
import { recordAdvance, saveDeduction } from "@/server/tl/deductions";
import { finalizeSettlement, startSettlement, voidSettlement, type Draft } from "@/server/tl/settlement";

/**
 * Parity (docs/MONEY_PLAN.md, Wave 4 step 7): for real statements finalized on demo_test with every kind of line (loads, a deduction, escrow held and released, an advance repaid), the journal
 * CSV's entry and the QuickBooks bill pushed to the simulator say the same thing per account, to the cent, and both add up to the statement's frozen rows. An advance given outside a statement
 * is the same journal entry in both. A voided statement leaves both (the bill pushed before is deleted); a W-2 driver's statement is in neither.
 *   DATABASE_URL=postgresql://demo:demo@localhost:54330/demo_test RUN_DB_INTEGRATION=true npx vitest run tests/integration/accounting-statement-lines.integration.test.ts
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const W = "acct-rows";
const ORIGIN = "http://localhost:3101";
const ENV_KEYS = ["DESK_CREDENTIAL_KEY", "DESK_CREDENTIAL_KEY_PREVIOUS", "QUICKBOOKS_CLIENT_ID", "QUICKBOOKS_CLIENT_SECRET", "DESK_AUTH"];
const saved: Record<string, string | undefined> = {};
const NOW = new Date("2026-11-12T18:00:00Z");
const noon = (d: string) => new Date(`${d}T17:00:00Z`);
const blank = (over: Partial<Draft> = {}): Draft => ({ hours: {}, adjustments: [], ...over });

const book = () => sandboxBook(SANDBOX_REALM, W);
const objs = (e: string) => [...(book().objects.get(e as never)?.values() ?? [])] as Array<Record<string, unknown>>;
const accountName = (id: unknown) => objs("Account").find((a) => a.Id === id)?.Name as string;
const cents = (n: unknown) => new Prisma.Decimal(n as number).times(100).toDecimalPlaces(0).toNumber();

/** The journal CSV as entries: account name to signed cents (debit positive). */
function parseJournal(csv: string): Map<string, Map<string, number>> {
  const lines = csv.replace(/^﻿/, "").trim().split("\r\n").slice(1);
  const out = new Map<string, Map<string, number>>();
  for (const l of lines) {
    // Date, Journal entry, Account, Account number, Debit, Credit, ... (no commas in these fields)
    const [, id, account, , debit, credit] = l.split(",");
    const e = out.get(id!) ?? new Map<string, number>();
    e.set(account!, (e.get(account!) ?? 0) + (debit ? cents(Number.parseFloat(debit)) : 0) - (credit ? cents(Number.parseFloat(credit)) : 0));
    out.set(id!, e);
  }
  return out;
}

async function wipe() {
  await prisma.externalRef.deleteMany({ where: { workspaceId: W } });
  await prisma.auditEvent.deleteMany({ where: { workspaceId: W } });
  await prisma.driverLedgerEntry.deleteMany({ where: { workspaceId: W } });
  await prisma.settlement.deleteMany({ where: { workspaceId: W } });
  await prisma.assignment.deleteMany({ where: { load: { workspaceId: W } } });
  await prisma.workspace.deleteMany({ where: { id: W } });
}

describe.skipIf(!run)("journal and QuickBooks agree with the statement rows", () => {
  let owner = "";
  let employee = "";
  let advanceId = "";
  const st: Record<string, string> = {};

  beforeAll(async () => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.DESK_CREDENTIAL_KEY = randomBytes(32).toString("base64");
    process.env.QUICKBOOKS_CLIENT_ID = "sandbox_qbo_client_rows";
    process.env.QUICKBOOKS_CLIENT_SECRET = "sandbox_qbo_secret_rows";
    await wipe();
    await prisma.workspace.create({ data: { id: W, name: "Rows desk", plan: "enterprise" } });
    resetSandboxBook(SANDBOX_REALM, W);
    owner = (await prisma.driver.create({ data: { workspaceId: W, name: "Sam Owner", payrollWorkerType: "contractor" } })).id;
    employee = (await prisma.driver.create({ data: { workspaceId: W, name: "Pat Employee", payrollWorkerType: "employee" } })).id;
    const load = (n: string, d: string, driverId: string) =>
      prisma.load.create({ data: { workspaceId: W, loadNumber: n, status: "completed", completedAt: noon(d), quotedRevenue: 2000, loadedMiles: 800, originAddress: "Dallas, TX", destinationAddress: "Austin, TX", assignment: { create: { driverId, payKind: "cpm", payRate: 0.5, status: "completed" } } } });
    for (const [n, d] of [["R-1", "2026-10-06"], ["R-2", "2026-10-13"], ["R-3", "2026-10-20"], ["R-4", "2026-10-27"]] as const) await load(n, d, owner);
    await load("E-1", "2026-10-06", employee);
    expect(await saveDeduction({ kind: "lease", label: "Truck lease", amount: "50" }, owner, null, NOW, W)).toMatchObject({ ok: true });
    expect(await saveDeduction({ kind: "escrow", label: "Escrow", amount: "100", goal: "300" }, owner, null, NOW, W)).toMatchObject({ ok: true });
    const a = await recordAdvance({ amount: "500", givenOn: "2026-10-01", method: "cash", repay: "150" }, owner, NOW, W);
    if (!a.ok) throw new Error("no advance");
    advanceId = a.id;
    const week = async (key: string, driverId: string, start: string, end: string, at: string, draft: Draft = blank(), confirm = false) => {
      const s = await startSettlement({ driverId, start, end }, NOW, W);
      if (!s.ok) throw new Error(`no statement ${key}`);
      st[key] = s.id;
      expect(await finalizeSettlement(s.id, draft, noon(at), W, null, confirm)).toMatchObject({ ok: true });
    };
    await week("w1", owner, "2026-10-05", "2026-10-11", "2026-10-13"); // 400 - 50 lease - 100 escrow - 150 advance = 100
    await week("w2", owner, "2026-10-12", "2026-10-18", "2026-10-20"); // the same: 100
    await week("w3", owner, "2026-10-19", "2026-10-25", "2026-10-27", blank({ adjustments: [{ label: "Bonus", amount: "25" }], deductions: { skips: {}, release: { amount: "60", reason: "Partial release" } } })); // 400 + 25 - 50 - 100 - 150 + 60 = 185
    await week("w4", owner, "2026-10-26", "2026-11-01", "2026-11-03"); // pushed, then voided
    await week("e1", employee, "2026-10-05", "2026-10-11", "2026-10-13");
    for (const id of Object.values(st)) numbers.set(id, (await prisma.settlement.findUniqueOrThrow({ where: { id } })).number);

    const p = await beginOAuth("quickbooks", { origin: ORIGIN, who: "Test admin" }, NOW, W);
    if (!p.ok) throw new Error(p.error);
    const q = Object.fromEntries(new URL(p.url).searchParams);
    expect(await completeOAuth("quickbooks", { state: q.state, code: q.code, accountId: q.realmId }, { origin: ORIGIN }, NOW, W)).toMatchObject({ ok: true });
  });

  afterAll(async () => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetSandboxBook(SANDBOX_REALM, W);
    await wipe();
  });

  test("the rows have every new kind, and each statement's rows add up to its total", async () => {
    const kinds = new Set((await prisma.settlementLine.findMany({ where: { workspaceId: W }, select: { kind: true } })).map((r) => r.kind));
    for (const k of ["load", "adjustment", "deduction", "escrow", "escrow_release", "advance_repaid"]) expect(kinds.has(k), k).toBe(true);
    for (const id of Object.values(st)) {
      const sum = await prisma.settlementLine.aggregate({ where: { settlementId: id }, _sum: { amount: true } });
      expect(sum._sum.amount!.toString()).toBe((await prisma.settlement.findUniqueOrThrow({ where: { id } })).total!.toString());
    }
  });

  test("the first sync pushes a bill per 1099 statement, from the rows, that matches the journal per account to the cent", async () => {
    const synced = await syncAccounting({ who: "test" }, NOW, W);
    expect(synced).toMatchObject({ ok: true });
    const j = await journalFile({}, W);
    if (!j.ok) throw new Error(`${j.error} ${j.problems.join(" ")} ${j.unmapped.join(" ")}`);
    const entries = parseJournal(j.csv);
    for (const key of ["w1", "w2", "w3", "w4"]) {
      const s = await prisma.settlement.findUniqueOrThrow({ where: { id: st[key]! }, include: { lineRows: true } });
      const rowsNet = s.lineRows.reduce((n, r) => n + cents(r.amount), 0);
      const entry = entries.get(`settlement:${s.id}`)!;
      expect(entry, key).toBeTruthy();
      // Balanced, and payables carry exactly the rows' net.
      expect([...entry.values()].reduce((a, b) => a + b, 0)).toBe(0);
      expect(entry.get("Accounts Payable")).toBe(-rowsNet);
      const bills = objs("Bill").filter((b) => b.DocNumber === s.number && b.status === "active");
      expect(bills, key).toHaveLength(1);
      const lines = bills[0]!.Line as Array<{ Amount: number; AccountBasedExpenseLineDetail: { AccountRef: { value: string } } }>;
      const billBy = new Map<string, number>();
      for (const l of lines) billBy.set(accountName(l.AccountBasedExpenseLineDetail.AccountRef.value), (billBy.get(accountName(l.AccountBasedExpenseLineDetail.AccountRef.value)) ?? 0) + cents(l.Amount));
      const journalBy = new Map([...entry.entries()].filter(([a]) => a !== "Accounts Payable"));
      expect(Object.fromEntries(billBy), key).toEqual(Object.fromEntries(journalBy));
      expect([...billBy.values()].reduce((a, b) => a + b, 0)).toBe(rowsNet);
    }
    // Week 3 in detail: pay and the bonus to Driver Pay, the lease to Deduction Income, escrow net of the release to Driver Escrow, the repayment out of Driver Advances.
    expect(Object.fromEntries(entries.get(`settlement:${st.w3}`)!)).toEqual({ "Driver Pay": 42500, "Driver Deduction Income": -5000, "Driver Escrow": -4000, "Driver Advances": -15000, "Accounts Payable": -18500 });
    // The W-2 statement is payroll's: in neither.
    expect(entries.has(`settlement:${st.e1}`)).toBe(false);
    expect(s_number(st.e1!)).toMatch(/^ST-/);
    expect(objs("Bill").some((b) => b.DocNumber === s_number(st.e1!))).toBe(false);
  });

  test("the advance given outside a statement is one journal entry in both: the asset against cash", async () => {
    const j = await journalFile({}, W);
    if (!j.ok) throw new Error(j.error);
    expect(Object.fromEntries(parseJournal(j.csv).get(`advance:${advanceId}`)!)).toEqual({ "Driver Advances": 50000, "Undeposited Funds": -50000 });
    const je = objs("JournalEntry").filter((e) => e.status === "active" && String(e.DocNumber).startsWith("ADV-"));
    expect(je).toHaveLength(1);
    const lines = je[0]!.Line as Array<{ Amount: number; JournalEntryLineDetail: { PostingType: string; AccountRef: { value: string } } }>;
    expect(lines.map((l) => [l.JournalEntryLineDetail.PostingType, accountName(l.JournalEntryLineDetail.AccountRef.value), cents(l.Amount)])).toEqual([["Debit", "Driver Advances", 50000], ["Credit", "Undeposited Funds", 50000]]);
    // Across the journal, the asset is what is still owed: $500 given, repaid $150 on each of three statements and the last $50 on the fourth (still standing here): nothing owed.
    expect(owedInJournal(j.csv)).toBe(0);
  });

  test("a voided statement leaves both: its journal entry is gone and the bill pushed for it is deleted", async () => {
    expect(await voidSettlement(st.w4!, "Wrong week", NOW, W)).toMatchObject({ ok: true });
    expect(await syncAccounting({ who: "test" }, NOW, W)).toMatchObject({ ok: true });
    const j = await journalFile({}, W);
    if (!j.ok) throw new Error(j.error);
    expect(parseJournal(j.csv).has(`settlement:${st.w4}`)).toBe(false);
    // Its $50 repayment went back with it: the asset again shows $50 owed.
    expect(owedInJournal(j.csv)).toBe(5000);
    expect(objs("Bill").filter((b) => b.DocNumber === s_number(st.w4!) && b.status === "active")).toHaveLength(0);
    // The others are unchanged, still one bill each.
    for (const key of ["w1", "w2", "w3"]) expect(objs("Bill").filter((b) => b.DocNumber === s_number(st[key]!) && b.status === "active"), key).toHaveLength(1);
  });
});

const owedInJournal = (csv: string) => [...parseJournal(csv).values()].reduce((n, e) => n + (e.get("Driver Advances") ?? 0), 0);
const numbers = new Map<string, string>();
function s_number(id: string): string {
  return numbers.get(id) ?? "";
}
