import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { invoiceLoad, issueCreditMemo, markLoadPaid, undoPaid, voidInvoice } from "@/server/tl/invoicing";
import { saveFactoringTerms } from "@/server/partners/factoring-terms";
import { applyFactoringUpdate, recordChargeback } from "@/server/partners/factoring";
import { saveAccounts } from "@/server/partners/accounting";
import { beginOAuth, completeOAuth } from "@/server/partners/oauth";
import { syncAccounting } from "@/server/partners/qbo-sync";
import { SANDBOX_REALM } from "@/server/partners/adapters/oauth-exchange";
import { resetSandboxBook, sandboxBook, sandboxQboClient, sandboxRecordPayment } from "@/server/partners/adapters/quickbooks";
import { refOf } from "@/server/partners/external-refs";
import { runPartnerSync } from "@/server/partners/sync";

/**
 * The QuickBooks Online sync (docs/MONEY_PLAN.md, Wave 3, step 3) end to end on the demo database, against the built-in QuickBooks simulator (a sandbox_ app key; no network):
 * requireMapped before any call, match before create, invoices, payments, credit memos, factoring and 1099 bills pushed once, a second run that changes nothing, a void and a chargeback
 * carried across, and a payment a bookkeeper entered in QuickBooks pulled back once.
 *   DATABASE_URL=postgresql://demo:demo@localhost:54330/demo RUN_DB_INTEGRATION=true npx vitest run tests/integration/accounting-qbo-sync.integration.test.ts
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const W = "qbo-sync";
const ORIGIN = "http://localhost:3101";
const ENV_KEYS = ["DESK_CREDENTIAL_KEY", "DESK_CREDENTIAL_KEY_PREVIOUS", "QUICKBOOKS_CLIENT_ID", "QUICKBOOKS_CLIENT_SECRET", "DESK_AUTH"];
const saved: Record<string, string | undefined> = {};
const TERMS = { transport: "api" as const, batchDestination: "", factorName: "Apex Capital", remitName: "", remitAddress: "", lockboxBank: "", routingNumber: "", accountNumber: "", noaText: "", advancePct: "90", feePct: "2.5" };
const FORM = { terms: "30", detention: false, lumper: "", layover: "", otherLabel: "", other: "" };
const T0 = new Date("2026-11-20T18:00:00Z");
const later = (h: number) => new Date(T0.getTime() + h * 3_600_000);

const book = () => sandboxBook(SANDBOX_REALM, W);
const objs = (e: string) => [...(book().objects.get(e as never)?.values() ?? [])] as Array<Record<string, unknown>>;
const active = (e: string) => objs(e).filter((o) => o.status === "active");
const byDoc = (e: string, n: string) => objs(e).filter((o) => o.DocNumber === n);

describe.skipIf(!run)("the QuickBooks sync, against the simulator", () => {
  const loads: Record<string, string> = {};
  beforeAll(async () => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.DESK_CREDENTIAL_KEY = randomBytes(32).toString("base64");
    process.env.QUICKBOOKS_CLIENT_ID = "sandbox_qbo_client_sync";
    process.env.QUICKBOOKS_CLIENT_SECRET = "sandbox_qbo_secret_sync";
    await prisma.workspace.deleteMany({ where: { id: W } });
    await prisma.workspace.create({ data: { id: W, name: "QBO sync desk", plan: "enterprise", timezone: "America/Chicago" } as never });
    resetSandboxBook(SANDBOX_REALM, W);
    expect(await saveFactoringTerms(TERMS, "test", T0, W)).toMatchObject({ ok: true });

    const make = async (n: string, broker: string, rate: number, form = FORM) => {
      const l = await prisma.load.create({ data: { workspaceId: W, loadNumber: `Q-${n}`, brokerName: broker, status: "completed", completedAt: T0, quotedRevenue: rate, podNote: "Signed" } as never });
      loads[n] = l.id;
      expect(await invoiceLoad(l.id, { form: { ...form, number: `QINV-${n}` } }, T0, W)).toMatchObject({ ok: true });
    };
    await make("A", "Acme Logistics", 1000, { ...FORM, lumper: "75" }); // matches the bookkeeper's "ACME LOGISTICS, LLC"
    await make("B", "Harbor Freight Co", 2000);
    await make("C", "Acme Logistics", 500); // typed into QuickBooks first, below
    await make("F", "Acme Logistics", 1000); // factored, funded, paid by the customer to the factor
    await make("G", "Acme Logistics", 1000); // factored, funded, later charged back
    await make("V", "Harbor Freight Co", 300); // later taken back on the desk
    expect(await markLoadPaid(loads.A!, T0, { amount: 1075, source: "desk" }, W)).toMatchObject({ ok: true });
    expect(await issueCreditMemo(loads.B!, { amount: 200, reason: "Late delivery" }, T0, W)).toMatchObject({ ok: true });
    for (const n of ["F", "G"]) {
      const rec = await prisma.invoice.findFirstOrThrow({ where: { workspaceId: W, number: `QINV-${n}` } });
      await prisma.invoice.update({ where: { id: rec.id }, data: { factoringStatus: "submitted" } });
      await prisma.load.update({ where: { id: loads[n]! }, data: { factoringStatus: "submitted" } });
      expect(await applyFactoringUpdate(loads[n]!, "funded", `APX-${n}`, later(1), W)).toBe(true);
    }
    expect(await markLoadPaid(loads.F!, later(2), { source: "factor", payer: "Apex Capital", shortAction: "balance" }, W)).toMatchObject({ ok: true });
    // Statements: a 1099 owner-operator (a bill) and a W-2 company driver (payroll's, never a bill).
    const owner = await prisma.driver.create({ data: { workspaceId: W, name: "Sam Owner", payrollWorkerType: "contractor" } as never });
    const employee = await prisma.driver.create({ data: { workspaceId: W, name: "Pat Employee", payrollWorkerType: "employee" } as never });
    for (const [d, n] of [[owner, "ST-1"], [employee, "ST-2"]] as const)
      await prisma.settlement.create({ data: { workspaceId: W, driverId: d.id, number: n, status: "final", periodStart: new Date("2026-11-16"), periodEnd: new Date("2026-11-22"), total: new Prisma.Decimal("1500.00"), fuel: [{ id: "x", amount: 300 }] as never, finalizedAt: later(3) } });

    // A bookkeeper typed QINV-C into QuickBooks before the desk synced (for $450, against the existing customer).
    const at = T0.toISOString();
    const auth = { accessToken: "sandbox_access_x", realmId: SANDBOX_REALM, tenant: W };
    const acme = active("Customer").find((c) => c.DisplayName === "ACME LOGISTICS, LLC")!;
    const income = active("Account").find((a) => a.Name === "Freight Income")!;
    const [item] = await sandboxQboClient.send(auth, at, { op: "create", entity: "Item", body: { Name: "Freight", Type: "Service", IncomeAccountRef: { value: income.Id } } });
    await sandboxQboClient.send(auth, at, { op: "create", entity: "Invoice", body: { DocNumber: "QINV-C", TxnDate: "2026-11-20", CustomerRef: { value: acme.Id }, Line: [{ Amount: 450, DetailType: "SalesItemLineDetail", SalesItemLineDetail: { ItemRef: { value: String(item!.obj.Id) } } }] } });

    const p = await beginOAuth("quickbooks", { origin: ORIGIN, who: "Test admin" }, T0, W);
    if (!p.ok) throw new Error(p.error);
    const q = Object.fromEntries(new URL(p.url).searchParams);
    expect(await completeOAuth("quickbooks", { state: q.state, code: q.code, accountId: q.realmId }, { origin: ORIGIN }, T0, W)).toMatchObject({ ok: true });
  });
  afterAll(async () => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetSandboxBook(SANDBOX_REALM, W);
    await prisma.workspace.deleteMany({ where: { id: W } });
  });

  test("a kind with no account stops the sync before QuickBooks is asked anything", async () => {
    const before = objs("Invoice").length;
    // The credit memo's line is a "credit" line, which has no default account.
    expect(await syncAccounting({}, later(4), W)).toMatchObject({ ok: false, unmapped: ["credit"] });
    expect([objs("Invoice").length, objs("CreditMemo").length, active("Customer").length]).toEqual([before, 0, 1]);
    // The nightly run never makes the first push: a person does, after looking at the accounts.
    expect(await runPartnerSync({ now: later(4), workspaceId: W })).toMatchObject({ ran: 1, waiting: 1, failed: 0 });
    expect(objs("Invoice").length).toBe(before);
  });

  test("an account QuickBooks does not have stops it too, named, and nothing is written", async () => {
    expect(await saveAccounts({ credit: { account: "Sales Discounts", number: "" }, linehaul: { account: "Linehaul Revenue", number: "" } }, "Test admin", later(4), W)).toMatchObject({ ok: true });
    const out = await syncAccounting({}, later(4), W);
    expect(out).toMatchObject({ ok: false, error: expect.stringContaining('"Linehaul Revenue"') });
    expect(objs("CreditMemo").length).toBe(0);
    expect(await saveAccounts({ linehaul: { account: "", number: "" } }, "Test admin", later(4), W)).toMatchObject({ ok: true });
  });

  test("the first run matches what QuickBooks already has, creates the rest, and pushes every document once", async () => {
    const out = await syncAccounting({ who: "Test admin" }, later(5), W);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.problems).toEqual([]);
    // Customers: Acme matched to the bookkeeper's one (no second Acme); Harbor created.
    expect(active("Customer").map((c) => c.DisplayName).sort()).toEqual(["ACME LOGISTICS, LLC", "Harbor Freight Co"]);
    // QINV-C was typed in first: taken over, not made twice, and now says what the desk says.
    expect(byDoc("Invoice", "QINV-C").map((i) => i.TotalAmt)).toEqual([500]);
    // Each invoice once, with its balance: A paid; B open less its credit; F sold to the factor; G funded; V open.
    const bal = (n: string) => byDoc("Invoice", n).map((i) => [i.TotalAmt, i.Balance]);
    expect([bal("QINV-A"), bal("QINV-B"), bal("QINV-F"), bal("QINV-G"), bal("QINV-V")]).toEqual([[[1075, 0]], [[2000, 1800]], [[1000, 0]], [[1000, 0]], [[300, 300]]]);
    // Items for the kinds used, each to its account (rule D).
    expect(active("Item").map((i) => i.Name).sort()).toEqual(["Credits and allowances", "Freight", "Linehaul", "Lumper"]);
    // Factoring: a funded entry for F and G with the fee from the reserve, and F's release.
    const je = (n: string) => objs("JournalEntry").filter((j) => j.DocNumber === n && j.status === "active");
    expect(je("QINV-F-F")[0]!.Line).toHaveLength(3);
    expect(je("QINV-F-R")).toHaveLength(1);
    expect(je("QINV-G-R")).toHaveLength(0);
    // Rule E: one bill, to the owner-operator as a vendor; the W-2 driver's statement is not a bill.
    expect(active("Bill").map((b) => [b.DocNumber, b.TotalAmt])).toEqual([["ST-1", 1500]]);
    expect(active("Vendor").map((v) => [v.DisplayName, v.Vendor1099])).toEqual([["Sam Owner", true]]);
    expect(out.matched).toBe(2); // the customer and QINV-C
    expect(await prisma.auditEvent.count({ where: { workspaceId: W, action: "accounting_synced" } })).toBe(1);
  });

  test("a second run with nothing changed sends nothing", async () => {
    const out = await syncAccounting({}, later(6), W);
    expect(out).toMatchObject({ ok: true, created: 0, updated: 0, voided: 0, matched: 0, pulled: 0, problems: [] });
    expect(byDoc("Invoice", "QINV-A")).toHaveLength(1);
  });

  test("an invoice taken back on the desk is voided in QuickBooks; a chargeback undoes the factor's payment and books the advance going back", async () => {
    expect(await voidInvoice(loads.V!, "Billed the wrong customer", later(7), W)).toMatchObject({ ok: true });
    expect(await recordChargeback(loads.G!, "Customer did not pay in 90 days", later(7), W)).toMatchObject({ ok: true });
    const out = await syncAccounting({}, later(8), W);
    expect(out).toMatchObject({ ok: true, problems: [] });
    expect(byDoc("Invoice", "QINV-V").map((i) => i.status)).toEqual(["voided"]);
    // G is the fleet's to collect again; its funding entry lost the fee, and the chargeback is booked.
    expect(byDoc("Invoice", "QINV-G").map((i) => i.Balance)).toEqual([1000]);
    const funded = objs("JournalEntry").find((j) => j.DocNumber === "QINV-G-F" && j.status === "active")!;
    expect((funded.Line as unknown[]).length).toBe(2);
    expect(objs("JournalEntry").filter((j) => j.DocNumber === "QINV-G-CB" && j.status === "active")).toHaveLength(1);
    expect(await refOf("quickbooks", "payment", `factoring:${(await prisma.invoice.findFirstOrThrow({ where: { workspaceId: W, number: "QINV-G" } })).id}`, W)).toBeNull();
  });

  test("a payment a bookkeeper enters in QuickBooks is pulled onto the desk once, and never pushed back", async () => {
    const b = await prisma.invoice.findFirstOrThrow({ where: { workspaceId: W, number: "QINV-B" } });
    const qboB = (await refOf("quickbooks", "invoice", b.id, W))!.externalId;
    sandboxRecordPayment(SANDBOX_REALM, W, { invoiceId: qboB, amount: 180000, txnDate: "2026-11-21", at: later(9).toISOString() });
    const out = await syncAccounting({}, later(10), W);
    expect(out).toMatchObject({ ok: true, pulled: 1, created: 0, problems: [] });
    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: b.id }, include: { payments: true } });
    expect([after.status, after.paidTotal.toNumber()]).toEqual(["paid", 2000]);
    expect(after.payments.filter((p) => p.source === "accounting").map((p) => p.amount.toNumber())).toEqual([1800]);
    // Again: nothing new to pull, and the pulled payment is not sent back as a second one.
    expect(await syncAccounting({}, later(11), W)).toMatchObject({ ok: true, pulled: 0, created: 0 });
    expect(objs("Payment").filter((p) => p.status === "active" && (p.Line as Array<{ LinkedTxn: Array<{ TxnId: string }> }>).some((l) => l.LinkedTxn.some((t) => t.TxnId === qboB))).length).toBe(2); // the credit applied, and the bookkeeper's payment
  });

  test("a pulled payment voided in QuickBooks is reported on the next sync, once", async () => {
    const b = await prisma.invoice.findFirstOrThrow({ where: { workspaceId: W, number: "QINV-B" } });
    const pulled = await prisma.invoicePayment.findFirstOrThrow({ where: { workspaceId: W, invoiceId: b.id, source: "accounting" } });
    const qboId = pulled.externalId!.split("#")[0]!;
    // Pulled payments are not in the ref map: the InvoicePayment row is their only record.
    expect(await prisma.externalRef.count({ where: { workspaceId: W, provider: "quickbooks", localId: pulled.id } })).toBe(0);
    const rec = book().objects.get("Payment")!.get(qboId)! as unknown as { Id: string; SyncToken: string };
    const auth = { accessToken: "sandbox_access_x", realmId: SANDBOX_REALM, tenant: W };
    await sandboxQboClient.send(auth, later(11.2).toISOString(), { op: "void", entity: "Payment", id: rec.Id, syncToken: rec.SyncToken });
    const out = await syncAccounting({}, later(11.4), W);
    expect(out).toMatchObject({ ok: true, voided: 0, problems: [`A payment pulled from QuickBooks (${qboId}) was voided or deleted there. If that is right, take it back on the desk too.`] });
    // The desk's record is left for a person to take back; the next run has nothing new to say.
    expect(await prisma.invoicePayment.count({ where: { id: pulled.id } })).toBe(1);
    expect(await syncAccounting({}, later(11.45), W)).toMatchObject({ ok: true, problems: [] });
  });

  test("a pulled payment taken back on the desk sends no void to QuickBooks", async () => {
    const c = await prisma.invoice.findFirstOrThrow({ where: { workspaceId: W, number: "QINV-C" } });
    const qboC = (await refOf("quickbooks", "invoice", c.id, W))!.externalId;
    const qboPay = sandboxRecordPayment(SANDBOX_REALM, W, { invoiceId: qboC, amount: 20000, txnDate: "2026-11-21", at: later(11.5).toISOString() });
    expect(await syncAccounting({}, later(11.55), W)).toMatchObject({ ok: true, pulled: 1, problems: [] });
    expect(await undoPaid(loads.C!, "Entered on the wrong invoice", later(11.6), W)).toMatchObject({ ok: true });
    expect(await prisma.invoicePayment.count({ where: { workspaceId: W, source: "accounting", externalId: { startsWith: `${qboPay}#` } } })).toBe(0);
    const out = await syncAccounting({}, later(11.65), W);
    expect(out).toMatchObject({ ok: true, voided: 0, problems: [] });
    // QuickBooks' payment is the bookkeeper's to undo there; the desk never voided it under a made-up id.
    expect((book().objects.get("Payment")!.get(qboPay) as unknown as { status: string }).status).toBe("active");
  });

  test("a payment entered in QuickBooks before funding is not counted as sold to the factor", async () => {
    const l = await prisma.load.create({ data: { workspaceId: W, loadNumber: "Q-H", brokerName: "Harbor Freight Co", status: "completed", completedAt: T0, quotedRevenue: 1000, podNote: "Signed" } as never });
    expect(await invoiceLoad(l.id, { form: { ...FORM, number: "QINV-H" } }, T0, W)).toMatchObject({ ok: true });
    expect(await syncAccounting({}, later(11.7), W)).toMatchObject({ ok: true, problems: [] });
    const h = await prisma.invoice.findFirstOrThrow({ where: { workspaceId: W, number: "QINV-H" } });
    const qboH = (await refOf("quickbooks", "invoice", h.id, W))!.externalId;
    sandboxRecordPayment(SANDBOX_REALM, W, { invoiceId: qboH, amount: 20000, txnDate: "2026-11-21", at: later(11.75).toISOString() });
    expect(await syncAccounting({}, later(11.8), W)).toMatchObject({ ok: true, pulled: 1, problems: [] });
    await prisma.invoice.update({ where: { id: h.id }, data: { factoringStatus: "submitted" } });
    await prisma.load.update({ where: { id: l.id }, data: { factoringStatus: "submitted" } });
    expect(await applyFactoringUpdate(l.id, "funded", "APX-H", later(11.85), W)).toBe(true);
    // The reserve payment covers only what was still open ($800); a $1,000 one would be refused (6000).
    expect(await syncAccounting({}, later(11.9), W)).toMatchObject({ ok: true, problems: [] });
    expect(byDoc("Invoice", "QINV-H").map((i) => i.Balance)).toEqual([0]);
  });

  test("two QuickBooks customers that both match one name are a problem to settle by hand, not a guess", async () => {
    const at = later(12).toISOString();
    const auth = { accessToken: "sandbox_access_x", realmId: SANDBOX_REALM, tenant: W };
    await sandboxQboClient.send(auth, at, { op: "create", entity: "Customer", body: { DisplayName: "Pine Freight Inc" } });
    await sandboxQboClient.send(auth, at, { op: "create", entity: "Customer", body: { DisplayName: "PINE FREIGHT, LLC" } });
    const l = await prisma.load.create({ data: { workspaceId: W, loadNumber: "Q-P", brokerName: "Pine Freight", status: "completed", completedAt: T0, quotedRevenue: 800, podNote: "Signed" } as never });
    expect(await invoiceLoad(l.id, { form: { ...FORM, number: "QINV-P" } }, T0, W)).toMatchObject({ ok: true });
    const out = await syncAccounting({}, later(12), W);
    expect(out).toMatchObject({ ok: true, problems: [expect.stringContaining('2 customers in QuickBooks match "Pine Freight"')] });
    expect(byDoc("Invoice", "QINV-P")).toHaveLength(0);
  });
});
