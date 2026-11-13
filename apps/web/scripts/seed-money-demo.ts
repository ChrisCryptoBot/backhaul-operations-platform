/**
 * Money on the demo desk (docs/MONEY_PLAN.md, Waves 1-4), on top of scripts/seed-demo.ts: driver pay statements with every kind of line, payroll in every state, the driver ledger
 * (deductions, escrow, advances), tax profiles for the 1099 page, and invoices in the states the billing screens show (short-paid, factored at each step, a chargeback, a credit memo).
 *
 * Everything goes through the desk's own functions (statements, finalize, void, mark paid, deductions, advances, tax profile, invoicing, factoring), so the rows, the ledger and the audit trail are
 * what a person would have made. The payroll states the company's webhook or the status poll would set (sent, pending, paid by payroll, rejected) are written directly: the demo has no payroll
 * connection. Nothing is real. Re-running replaces the statements, ledger, deductions and advances it made; the invoice changes are made once (it skips them when a credit memo exists).
 *
 *   DATABASE_URL=postgresql://demo:demo@localhost:54330/demo npx tsx scripts/seed-money-demo.ts
 * Run it after seed-demo.ts (which rebuilds the workspace and its loads).
 */
import { PrismaClient } from "@prisma/client";
import { finalizeSettlement, markSettlementPaid, saveDraft, startSettlement, voidSettlement, type Draft } from "../src/server/tl/settlement";
import { recordAdvance, saveDeduction } from "../src/server/tl/deductions";
import { saveDriverTax } from "../src/server/tl/fleet";
import { issueCreditMemo, markLoadPaid } from "../src/server/tl/invoicing";
import { applyFactoringUpdate, recordChargeback } from "../src/server/partners/factoring";
import { saveFactoringTerms } from "../src/server/partners/factoring-terms";
import { centralParts } from "../src/lib/zoned";

const prisma = new PrismaClient();
const W = "demo-workspace";
const ZONE = "America/Chicago";
const DAY = 86_400_000;
const NOW = new Date();
const blank = (over: Partial<Draft> = {}): Draft => ({ hours: {}, adjustments: [], ...over });
const ymd = (d: Date) => {
  const p = centralParts(d.getTime(), ZONE);
  return `${p.y}-${String(p.m0 + 1).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
};
/** A moment no later than now: the desk refuses a paid day that has not come. */
const notAfterNow = (d: Date) => (d.getTime() > NOW.getTime() ? new Date(NOW.getTime() - 3_600_000) : d);
const must = <T extends { ok: boolean }>(what: string, r: T): T => {
  if (!r.ok) throw new Error(`${what}: ${JSON.stringify(r)}`);
  return r;
};

async function clearMoney() {
  await prisma.driverLedgerEntry.deleteMany({ where: { workspaceId: W } });
  await prisma.settlementLoad.deleteMany({ where: { settlement: { workspaceId: W } } });
  await prisma.fuelTransaction.updateMany({ where: { workspaceId: W }, data: { settlementId: null } });
  await prisma.settlement.deleteMany({ where: { workspaceId: W } });
  await prisma.driverAdvance.deleteMany({ where: { workspaceId: W } });
  await prisma.driverDeduction.deleteMany({ where: { workspaceId: W } });
  await prisma.driver.updateMany({
    where: { workspaceId: W },
    data: { payrollWorkerType: null, payrollEmployeeId: null, payrollStatus: "none", legalName: null, tinType: null, tinLast4: null, tinStatus: "none", taxAddressLine1: null, taxAddressLine2: null, taxCity: null, taxState: null, taxZip: null }
  });
}

/** A driver's delivered loads not on any statement, oldest first. */
async function unsettled(driverId: string) {
  return prisma.load.findMany({
    where: { workspaceId: W, deletedAt: null, status: "completed", completedAt: { not: null }, settlement: { is: null }, assignment: { is: { driverId, status: "completed" } } },
    orderBy: { completedAt: "asc" },
    select: { id: true, loadNumber: true, completedAt: true }
  });
}

type Chunk = { start: string; end: string; last: Date };
const chunk = (loads: Array<{ completedAt: Date | null }>, from: number, to: number): Chunk => ({ start: ymd(loads[from]!.completedAt!), end: ymd(loads[to]!.completedAt!), last: loads[to]!.completedAt! });

/** Start a statement over a chunk of loads and finalize it two days after its last delivery. */
async function statement(driverId: string, c: Chunk, draft: Draft = blank(), finalize = true, confirmNegative = false) {
  const s = must(`start ${c.start}..${c.end}`, await startSettlement({ driverId, start: c.start, end: c.end }, NOW, W));
  if (!s.ok) throw new Error("unreachable");
  if (!finalize) {
    must("save draft", await saveDraft(s.id, draft, W));
    return { id: s.id, at: NOW };
  }
  const at = notAfterNow(new Date(c.last.getTime() + 2 * DAY));
  must(`finalize ${c.start}..${c.end}`, await finalizeSettlement(s.id, draft, at, W, null, confirmNegative));
  return { id: s.id, at };
}

async function seedPay() {
  const drivers = await prisma.driver.findMany({ where: { workspaceId: W }, orderBy: { name: "asc" } });
  const by = (name: string) => {
    const d = drivers.find((x) => x.name === name);
    if (!d) throw new Error(`no driver named ${name}: run seed-demo.ts first`);
    return d;
  };
  const alex = by("Alex Rivera");
  const casey = by("Casey Brooks");
  const jordan = by("Jordan Lee");
  const sam = by("Sam Okafor");

  // Who is paid how: three 1099 owner-operators and one W-2 company driver.
  await prisma.driver.update({ where: { id: alex.id }, data: { payrollWorkerType: "contractor", payrollEmployeeId: "GUS-W-1042" } });
  await prisma.driver.update({ where: { id: casey.id }, data: { payrollWorkerType: "contractor", payrollEmployeeId: "GUS-W-1077" } });
  await prisma.driver.update({ where: { id: sam.id }, data: { payrollWorkerType: "contractor", payrollEmployeeId: "GUS-W-1103" } });
  await prisma.driver.update({ where: { id: jordan.id }, data: { payrollWorkerType: "employee", payrollEmployeeId: "GUS-E-2210" } });

  // Tax profiles: Alex complete (an LLC, EIN verified), Sam complete (SSN collected), Casey missing the mailing address (flagged on the 1099 page). Last four digits only.
  must("tax alex", await saveDriverTax({ legalName: "Rivera Hauling LLC", tinType: "ein", tinLast4: "4417", tinStatus: "verified", taxAddressLine1: "2200 Commerce St", taxAddressLine2: "Suite 140", taxCity: "Dallas", taxState: "TX", taxZip: "75201" }, alex.id, NOW, W));
  must("tax sam", await saveDriverTax({ legalName: "Samuel Okafor", tinType: "ssn", tinLast4: "0388", tinStatus: "collected", taxAddressLine1: "814 Elm Ridge Dr", taxCity: "Fort Worth", taxState: "TX", taxZip: "76102" }, sam.id, NOW, W));
  must("tax casey", await saveDriverTax({ legalName: "Casey J. Brooks", tinType: "ssn", tinLast4: "7720", tinStatus: "collected" }, casey.id, NOW, W));

  const aLoads = await unsettled(alex.id);
  const cLoads = await unsettled(casey.id);
  const jLoads = await unsettled(jordan.id);
  const sLoads = await unsettled(sam.id);
  if (aLoads.length < 8 || cLoads.length < 7 || jLoads.length < 5 || sLoads.length < 5) throw new Error("not enough delivered loads: run seed-demo.ts first");

  // Alex (short regional loads): a truck lease, insurance, ELD and escrow building to $400; a cash advance repaid $60 a statement. Under the 1099 threshold.
  for (const r of [
    { kind: "lease", label: "Truck lease, Unit 101", amount: "95" },
    { kind: "insurance", label: "Occupational accident", amount: "25" },
    { kind: "eld", label: "ELD subscription", amount: "10" },
    { kind: "escrow", label: "Maintenance escrow", amount: "40", goal: "400" }
  ])
    must(`deduction ${r.label}`, await saveDeduction(r, alex.id, null, NOW, W));
  must("advance alex", await recordAdvance({ amount: "300", givenOn: ymd(new Date(aLoads[0]!.completedAt!.getTime() - 3 * DAY)), method: "cash", repay: "60", note: "Tires in Amarillo" }, alex.id, NOW, W));
  // A1: paid by check. A2: an escrow release on top of the deductions and the repayment, paid by payroll. A3: a draft, to skip a deduction or release escrow on.
  const a1 = await statement(alex.id, chunk(aLoads, 0, 2));
  must("paid a1", await markSettlementPaid(a1.id, { paidOn: ymd(notAfterNow(new Date(a1.at.getTime() + DAY))), method: "check" }, NOW, W));
  const a2 = await statement(alex.id, chunk(aLoads, 3, 5), blank({ deductions: { skips: {}, release: { amount: "25", reason: "Tire repair paid from escrow" } } }));
  await prisma.settlement.update({ where: { id: a2.id }, data: { payrollSentAt: notAfterNow(new Date(a2.at.getTime() + DAY)), payrollReference: "GUS-SBX-DEMOA2RUN", paidAt: notAfterNow(new Date(a2.at.getTime() + 5 * DAY)), paidMethod: "payroll" } });
  await statement(alex.id, chunk(aLoads, 6, aLoads.length - 1), blank(), false);

  // Casey: a heavier lease and insurance, an advance on the fuel card. C1 paid by check; C2 one small load the deductions take below zero (rule K, confirmed: the driver owes); C3 voided;
  // C4 with a detention share, paid by payroll: over the 1099 threshold with no mailing address on file, so the 1099 page flags it.
  for (const r of [
    { kind: "lease", label: "Truck lease, Unit 204", amount: "200" },
    { kind: "insurance", label: "Bobtail insurance", amount: "30" }
  ])
    must(`deduction ${r.label}`, await saveDeduction(r, casey.id, null, NOW, W));
  must("advance casey", await recordAdvance({ amount: "250", givenOn: ymd(new Date(cLoads[0]!.completedAt!.getTime() - 2 * DAY)), method: "fuel_card", repay: "80", note: "Fuel on the card, first week" }, casey.id, NOW, W));
  const c1 = await statement(casey.id, chunk(cLoads, 0, 2), blank(), true, true);
  must("paid c1", await markSettlementPaid(c1.id, { paidOn: ymd(notAfterNow(new Date(c1.at.getTime() + DAY))), method: "check" }, NOW, W));
  await statement(casey.id, chunk(cLoads, 3, 3), blank({ adjustments: [{ label: "Cargo claim deductible", amount: "-500" }] }), true, true);
  const c3 = await statement(casey.id, chunk(cLoads, 4, 5), blank(), true, true);
  must("void c3", await voidSettlement(c3.id, "Wrong period: a load belonged to the next week", notAfterNow(new Date(c3.at.getTime() + DAY)), W));
  const c4 = await statement(casey.id, chunk(cLoads, 4, 6), blank({ adjustments: [{ label: "Detention share, Memphis", amount: "450" }] }), true, true);
  await prisma.settlement.update({ where: { id: c4.id }, data: { payrollSentAt: notAfterNow(new Date(c4.at.getTime() + DAY)), payrollReference: "GUS-SBX-DEMOC4RUN", paidAt: notAfterNow(new Date(c4.at.getTime() + 4 * DAY)), paidMethod: "payroll" } });

  // Jordan (W-2): one paid by payroll, one sent and still pending.
  const j1 = await statement(jordan.id, chunk(jLoads, 0, 2));
  await prisma.settlement.update({ where: { id: j1.id }, data: { payrollSentAt: notAfterNow(new Date(j1.at.getTime() + DAY)), payrollReference: "GUS-SBX-DEMOJ1RUN", paidAt: notAfterNow(new Date(j1.at.getTime() + 4 * DAY)), paidMethod: "payroll" } });
  const j2 = await statement(jordan.id, chunk(jLoads, 3, 4));
  await prisma.settlement.update({ where: { id: j2.id }, data: { payrollSentAt: notAfterNow(new Date(NOW.getTime() - DAY)), payrollReference: "GUS-SBX-DEMOJ2RUN" } });
  await prisma.driver.update({ where: { id: jordan.id }, data: { payrollStatus: "sent" } });

  // Sam: one load paid by transfer (under the 1099 threshold), one refused by payroll (the bank account), and one ready to send.
  const s1 = await statement(sam.id, chunk(sLoads, 0, 0));
  must("paid s1", await markSettlementPaid(s1.id, { paidOn: ymd(notAfterNow(new Date(s1.at.getTime() + DAY))), method: "transfer" }, NOW, W));
  const s2 = await statement(sam.id, chunk(sLoads, 1, 2));
  await prisma.settlement.update({ where: { id: s2.id }, data: { payrollRejectedAt: notAfterNow(new Date(s2.at.getTime() + 2 * DAY)), payrollRejectReason: "The worker's bank account could not be verified." } });
  await prisma.driver.update({ where: { id: sam.id }, data: { payrollStatus: "failed" } });
  await statement(sam.id, chunk(sLoads, 3, 4));
}

const TERMS = { transport: "api" as const, batchDestination: "", factorName: "Apex Capital", remitName: "Apex Capital Corp", remitAddress: "PO Box 961029, Fort Worth, TX 76161", lockboxBank: "", routingNumber: "", accountNumber: "", noaText: "", advancePct: "90", feePct: "2.5" };

async function seedInvoices() {
  if ((await prisma.invoice.count({ where: { workspaceId: W, kind: "credit_memo" } })) > 0) {
    console.log("invoices already seeded (a credit memo exists): skipped");
    return;
  }
  must("factoring terms", await saveFactoringTerms(TERMS, "Demo admin", NOW, W));
  // Open invoices, newest first: the oldest stay open (some overdue) as the seed made them.
  const open = await prisma.load.findMany({ where: { workspaceId: W, deletedAt: null, paymentStatus: "invoiced" }, orderBy: { invoicedAt: "desc" }, select: { id: true, loadNumber: true, invoicedAmount: true, invoicedAt: true } });
  if (open.length < 7) throw new Error(`need 7 open invoices, have ${open.length}`);
  const [shortPaid, memo, submitted, funded, factorPaid, chargedBack] = open;
  const ago = (d: number) => new Date(NOW.getTime() - d * DAY);

  // Short-paid: the customer took 8% off for a late delivery, written off with the reason.
  const amt = Number(shortPaid!.invoicedAmount);
  must("short pay", await markLoadPaid(shortPaid!.id, ago(1), { amount: Math.round(amt * 0.92 * 100) / 100, shortAction: "writeoff", shortReason: "Customer deducted for a late delivery", shortCode: "customer_deduction", method: "ach", reference: "ACH-778120", source: "desk" }, W));
  // A credit memo on an open invoice.
  must("credit memo", await issueCreditMemo(memo!.id, { amount: 150, reason: "Detention billed in error" }, ago(1), W));
  // Factored: one submitted, one funded, one funded and paid by the customer to the factor, one charged back.
  for (const l of [submitted!, funded!, factorPaid!, chargedBack!]) {
    const rec = await prisma.invoice.findFirstOrThrow({ where: { workspaceId: W, kind: "invoice", loads: { some: { loadId: l.id } } } });
    await prisma.invoice.update({ where: { id: rec.id }, data: { factoringStatus: "submitted" } });
    await prisma.load.update({ where: { id: l.id }, data: { factoringStatus: "submitted" } });
  }
  for (const [l, ref] of [[funded!, "APX-55120"], [factorPaid!, "APX-55121"], [chargedBack!, "APX-55122"]] as const) if (!(await applyFactoringUpdate(l.id, "funded", ref, ago(6), W))) throw new Error(`fund ${l.loadNumber}`);
  must("factor paid", await markLoadPaid(factorPaid!.id, ago(2), { source: "factor", payer: "Apex Capital", shortAction: "balance" }, W));
  must("chargeback", await recordChargeback(chargedBack!.id, "Customer did not pay within 90 days", ago(1), W));
}

async function main() {
  if (!(await prisma.workspace.findUnique({ where: { id: W } }))) throw new Error("no demo workspace: run seed-demo.ts first");
  await clearMoney();
  await seedPay();
  await seedInvoices();
  const [statements, ledger, invoices] = await Promise.all([
    prisma.settlement.groupBy({ by: ["status"], where: { workspaceId: W }, _count: { _all: true } }),
    prisma.driverLedgerEntry.groupBy({ by: ["kind"], where: { workspaceId: W }, _count: { _all: true } }),
    prisma.invoice.groupBy({ by: ["kind", "status", "factoringStatus"], where: { workspaceId: W }, _count: { _all: true } })
  ]);
  for (const s of await prisma.settlement.findMany({ where: { workspaceId: W }, include: { driver: { select: { name: true } } }, orderBy: [{ driverId: "asc" }, { periodStart: "asc" }] }))
    console.log(`  ${s.number} ${s.driver.name.padEnd(13)} ${s.status.padEnd(5)} ${String(s.total ?? "").padStart(9)} ${s.paidMethod ?? (s.payrollRejectedAt ? "rejected" : s.payrollSentAt ? "sent" : "")}`);
  console.log("statements", statements.map((s) => `${s.status} ${s._count._all}`).join(", "));
  console.log("ledger", ledger.map((s) => `${s.kind} ${s._count._all}`).join(", "));
  console.log("invoices", invoices.map((s) => `${s.kind}/${s.status}/${s.factoringStatus} ${s._count._all}`).join(", "));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
