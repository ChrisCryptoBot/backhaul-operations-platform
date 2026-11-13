/**
 * Money on the demo desk (docs/MONEY_PLAN.md, Waves 1-6), on top of scripts/seed-demo.ts: driver pay statements with every kind of line, payroll in every state, the driver ledger
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
import { placeParts } from "../src/lib/fuel-normalize";
import { recentQuarters, sampleIftaRates } from "../src/lib/ifta-rates-csv";
import { clearFuelFlag } from "../src/server/partners/fuel-flags";
import { calculateIfta } from "../src/server/partners/ifta";
import { fileIftaReturn } from "../src/server/partners/ifta-filing";
import { quarterBounds, syncIftaMileage } from "../src/server/partners/ifta-mileage";
import { commitIftaRates } from "../src/server/partners/ifta-rates";
import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { createApiKey } from "../src/server/api/keys";
import { INVOICE_INCLUDE, SETTLEMENT_SELECT, shapeInvoice, shapePayment, shapeSettlement } from "../src/server/api/reads";
import { checkFeature } from "../src/server/partners/gates";
import { createEndpoint } from "../src/server/webhooks/endpoints";
import { envelope } from "../src/server/webhooks/emit";
import type { WebhookEvent } from "../src/lib/webhook-events";

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

// ── Wave 6: cash, cost of money, chargeback repaid ───────────────────────────────────────────

/**
 * Money moving in this week and the one before, so the KPI's cash card and Why it moved's cash bridge have something to show, and the Leak ledger's fee lines have items: the charged-back invoice
 * repaid by its customer, a quick-pay fee taken short, a part payment and a factor funding in the week before. Each step checks whether it was done before (its own reference, or the state it
 * leaves), so a re-run changes nothing, and every step goes through the desk's own functions, so Data health's money checks stay clean.
 */
async function seedWave6() {
  const ago = (d: number) => notAfterNow(new Date(NOW.getTime() - d * DAY));
  // Open invoices no factor and no credit has touched, oldest first, one load each.
  const free = async () =>
    (
      await prisma.invoice.findMany({
        where: { workspaceId: W, kind: "invoice", status: "open", factoringStatus: "none", factoringChargeback: null, credits: { none: {} }, paidTotal: 0 },
        orderBy: [{ issuedAt: "asc" }, { number: "asc" }],
        select: { id: true, number: true, total: true, loads: { select: { loadId: true } } }
      })
    ).filter((i) => i.loads.length === 1);

  // 1. The charged-back invoice, paid by its customer after the chargeback.
  const charged = await prisma.invoice.findFirst({ where: { workspaceId: W, kind: "invoice", factoringChargeback: { not: null } }, select: { id: true, status: true, factoringChargedBackAt: true, loads: { select: { loadId: true } } } });
  if (charged && charged.status === "open") {
    const back = charged.factoringChargedBackAt?.getTime() ?? NOW.getTime() - DAY;
    must("chargeback repaid", await markLoadPaid(charged.loads[0]!.loadId, notAfterNow(new Date(Math.max(back + 6 * 3_600_000, NOW.getTime() - 12 * 3_600_000))), { source: "desk", method: "ach", reference: "SEED-W6-REPAY", payer: "Customer, after the chargeback", shortAction: "balance" }, W));
  }
  // 2. A quick-pay fee taken short (2%): Factoring Fees in the journal, a fee line in the Leak ledger.
  if ((await prisma.invoice.count({ where: { workspaceId: W, writeOffCode: "quick_pay_fee" } })) === 0) {
    const i = (await free())[0];
    if (!i) throw new Error("no open invoice for the quick-pay fee");
    const amount = Math.round(Number(i.total) * 0.98 * 100) / 100;
    must("quick-pay fee", await markLoadPaid(i.loads[0]!.loadId, ago(3), { amount, shortAction: "writeoff", shortReason: "Quick pay: 2% taken for payment in 2 days", shortCode: "quick_pay_fee", method: "ach", reference: "SEED-W6-QP", source: "desk" }, W));
  }
  // 3. The week before: a customer's part payment, and a factor funding an invoice (still with the factor, so part of what is owed is funded).
  if ((await prisma.invoicePayment.count({ where: { workspaceId: W, reference: "SEED-W6-PART" } })) === 0) {
    const i = (await free())[0];
    if (!i) throw new Error("no open invoice for the part payment");
    must("part payment", await markLoadPaid(i.loads[0]!.loadId, ago(9), { amount: Math.round(Number(i.total) * 0.5 * 100) / 100, method: "check", reference: "SEED-W6-PART", source: "desk" }, W));
  }
  if ((await prisma.invoice.count({ where: { workspaceId: W, factoringReferenceId: "APX-55123" } })) === 0) {
    const i = (await free())[0];
    if (!i) throw new Error("no open invoice to fund");
    const loadId = i.loads[0]!.loadId;
    await prisma.invoice.update({ where: { id: i.id }, data: { factoringStatus: "submitted" } });
    await prisma.load.update({ where: { id: loadId }, data: { factoringStatus: "submitted" } });
    if (!(await applyFactoringUpdate(loadId, "funded", "APX-55123", ago(10), W))) throw new Error(`fund ${i.number}`);
  }
}

// ── Fuel and fuel tax (Wave 5) ───────────────────────────────────────────────────────────────

/** The provider every seeded fuel purchase carries, so a re-run takes exactly these away. */
const SEED_FUEL = "seed-demo";
const PRICE = 3.65;

async function clearFuelTax() {
  // A filed return's rows are only frozen against edits (a trigger on UPDATE); the seed's own are deleted whole, lines with them.
  await prisma.iftaReturn.deleteMany({ where: { workspaceId: W } });
  await prisma.iftaMileage.deleteMany({ where: { workspaceId: W } });
  await prisma.iftaRate.deleteMany({ where: { workspaceId: W } });
  await prisma.fuelFlagReview.deleteMany({ where: { workspaceId: W, fuelTransaction: { provider: SEED_FUEL } } });
  await prisma.fuelTransaction.deleteMany({ where: { workspaceId: W, provider: SEED_FUEL } });
}

type Fill = { key: string; vehicleId: string | null; state: string | null; gallons: number; at: Date; taxPaid?: boolean; product?: string; status?: string; location?: string; /** Dollars; left out, the source said nothing. */ discount?: number; discountPerGallon?: number };

async function writeFills(fills: Fill[]) {
  await prisma.fuelTransaction.createMany({
    data: fills.map((f) => ({
      workspaceId: W,
      provider: SEED_FUEL,
      externalId: `SEED-${f.key}`,
      vehicleId: f.vehicleId,
      postedAt: new Date(Date.UTC(f.at.getUTCFullYear(), f.at.getUTCMonth(), f.at.getUTCDate(), 12)),
      purchasedAt: f.at,
      location: f.location ?? (f.state ? `Truck stop, ${f.state}` : null),
      purchaseState: f.state,
      product: f.product ?? "road_diesel",
      taxPaid: f.taxPaid ?? true,
      status: f.status ?? "settled",
      gallons: f.gallons.toFixed(1),
      pricePerGallon: PRICE.toFixed(4),
      amount: (Math.round(f.gallons * PRICE * 100) / 100).toFixed(2),
      discount: f.discount == null ? null : f.discount.toFixed(2),
      discountPerGallon: f.discountPerGallon == null ? null : f.discountPerGallon.toFixed(4)
    }))
  });
}

/**
 * A quarter's fuel for each truck that delivered in it: tax-paid road diesel at the states its loads left from (about 85% of what its miles burn at 6.5 mpg, one fill a load, each on its own
 * day, at most 200 gallons, under the trucks' 220-gallon tanks), and one bulk fill from the yard tank (no tax paid) for the rest. Deterministic: the same loads give the same fills.
 */
async function quarterFills(quarter: string, tag: string): Promise<{ fills: Fill[]; trucks: string[] }> {
  const { from, to } = quarterBounds(quarter, ZONE)!;
  const loads = await prisma.load.findMany({ where: { workspaceId: W, deletedAt: null, status: "completed", vehicleId: { not: null }, completedAt: { gte: from, lt: to } }, orderBy: [{ vehicleId: "asc" }, { completedAt: "asc" }], select: { id: true, vehicleId: true, originAddress: true, loadedMiles: true, completedAt: true } });
  const fills: Fill[] = [];
  const trucks = [...new Set(loads.map((l) => l.vehicleId!))];
  for (const v of trucks) {
    const mine = loads.filter((l) => l.vehicleId === v);
    const miles = mine.reduce((s, l) => s + Number(l.loadedMiles), 0);
    const burn = miles / 6.5;
    mine.forEach((l, i) => {
      const share = (Number(l.loadedMiles) / Math.max(1, miles)) * burn * 0.85;
      if (share < 1) return;
      fills.push({ key: `${tag}-${v.slice(-6)}-${i}`, vehicleId: v, state: placeParts(l.originAddress).state ?? "TX", gallons: Math.round(Math.min(share, 200) * 10) / 10, at: new Date(l.completedAt!.getTime() - (8 + i) * 3_600_000) });
    });
    const last = mine[mine.length - 1]!;
    fills.push({ key: `${tag}-${v.slice(-6)}-bulk`, vehicleId: v, state: "TX", gallons: Math.round(Math.min(burn * 0.15, 200) * 10) / 10, at: new Date(last.completedAt!.getTime() + 4 * 3_600_000), taxPaid: false, location: "Yard tank, Dallas, TX" });
  }
  return { fills, trucks };
}

/** The quarter's rate table as a file (the sample generator's figures, imported as a real file would be, so the screen shows a filed state; the desk itself says it is demo data). */
const ratesCsv = (quarter: string) => ["Jurisdiction,Diesel,Surcharge", ...sampleIftaRates(quarter).map((r) => `${r.jurisdiction},${r.rate},${r.surcharge === "0.0000" ? "" : r.surcharge}`)].join("\n");

/**
 * Fuel and fuel tax on the demo (Wave 5): the last finished quarter fuelled, its rates final, its miles read from the ELD for most trucks and routed for one, filed, and then a late receipt that
 * shows as "changed since filed"; the current quarter fuelled with the odd ones (reefer, DEF, pending, declined) and an over-tank fill left flagged, on provisional rates, not filed. The ELD and
 * the mileage company are reached through their simulators, connected for this run only (the demo desk itself stays unconnected).
 */
async function seedFuelTax() {
  const [current, last] = recentQuarters(NOW, ZONE);
  if (!current || !last) throw new Error("no quarters");
  await clearFuelTax();

  const q3 = await quarterFills(last, "P");
  const q4 = await quarterFills(current, "C");
  if (q3.trucks.length === 0 || q4.trucks.length === 0) throw new Error("no delivered loads in the last two quarters: run seed-demo.ts first");
  const tanker = q3.trucks[0]!;
  await prisma.vehicle.updateMany({ where: { workspaceId: W, id: { in: [...new Set([...q3.trucks, ...q4.trucks])] } }, data: { tankCapacityGallons: 220 } });
  const { from: q3From } = quarterBounds(last, ZONE)!;
  const { from: q4From } = quarterBounds(current, ZONE)!;
  const day = (base: Date, d: number, h = 14) => new Date(base.getTime() + d * DAY + h * 3_600_000);
  // The last quarter: one over-tank fill, cleared with a reason (saddle tanks), so the return can be filed.
  q3.fills.push({ key: "P-overfill", vehicleId: tanker, state: "OK", gallons: 260, at: day(q3From, 40) });
  // The current quarter: the purchases the return leaves out, and one over-tank fill left open (a blocker on the open return).
  const t4 = q4.trucks[0]!;
  q4.fills.push(
    { key: "C-reefer", vehicleId: t4, state: "TN", gallons: 48, at: day(q4From, 9), product: "reefer_diesel" },
    { key: "C-def", vehicleId: t4, state: "TN", gallons: 9, at: day(q4From, 9, 15), product: "def" },
    { key: "C-pending", vehicleId: t4, state: "AR", gallons: 120, at: notAfterNow(day(q4From, 30)), status: "pending" },
    { key: "C-declined", vehicleId: t4, state: "AR", gallons: 95, at: day(q4From, 11), status: "declined" },
    { key: "C-overfill", vehicleId: t4, state: "MO", gallons: 275, at: day(q4From, 20) }
  );
  // Wave 6: two fills the card recorded with no discount (one says $0.00, one $0.0000 a gallon), on two trucks, in this week and the one before: the Leak ledger counts them and never prices them.
  const t4b = q4.trucks[q4.trucks.length - 1]!;
  const recent = (d: number) => new Date(Math.max(q4From.getTime() + DAY, NOW.getTime() - d * DAY));
  q4.fills.push(
    { key: "C-nodisc-a", vehicleId: t4, state: "TX", gallons: 110, at: recent(4), discount: 0, discountPerGallon: 0, location: "Truck stop, Amarillo, TX" },
    { key: "C-nodisc-b", vehicleId: t4b, state: "OK", gallons: 95, at: recent(11), discountPerGallon: 0, location: "Truck stop, Oklahoma City, OK" }
  );
  await writeFills([...q3.fills, ...q4.fills]);
  const overfill = await prisma.fuelTransaction.findFirstOrThrow({ where: { workspaceId: W, provider: SEED_FUEL, externalId: "SEED-P-overfill" } });
  must("clear overfill", await clearFuelFlag(overfill.id, "over_capacity", "Saddle tanks fitted in July: 300 gallons", NOW, W));

  must(`rates ${last}`, await commitIftaRates(ratesCsv(last), null, last, "final", `ifta-rates-${last}.csv`, NOW, W));
  must(`rates ${current}`, await commitIftaRates(ratesCsv(current), null, current, "provisional", `ifta-rates-${current}-provisional.csv`, NOW, W));

  // The simulators, for this run only: keys in this process's environment and a connection row each, taken away again below unless the desk already had one.
  process.env.MOTIVE_API_KEY = "sandbox_seed_demo";
  process.env.PROMILES_API_KEY = "sandbox_seed_demo";
  const made: string[] = [];
  for (const [capability, provider] of [["eld", "motive"], ["ifta", "promiles"]] as const) {
    const had = await prisma.partnerConnection.findUnique({ where: { workspaceId_capability_provider: { workspaceId: W, capability, provider } } });
    if (!had) made.push((await prisma.partnerConnection.create({ data: { workspaceId: W, capability, provider, status: "connected", connectedAt: NOW } })).id);
  }
  try {
    for (const q of [last, current]) {
      must(`eld ${q}`, await syncIftaMileage(q, NOW, W));
      // One truck the ELD did not report: its miles are routed from its loads.
      const routedTruck = (await prisma.iftaMileage.findFirst({ where: { workspaceId: W, quarter: q, method: "eld" }, orderBy: { vehicleId: "desc" }, select: { vehicleId: true } }))?.vehicleId;
      if (routedTruck) await prisma.iftaMileage.deleteMany({ where: { workspaceId: W, quarter: q, method: "eld", vehicleId: routedTruck } });
      must(`route ${q}`, await calculateIfta(q, W, NOW));
    }
  } finally {
    if (made.length > 0) await prisma.partnerConnection.deleteMany({ where: { id: { in: made } } });
  }

  // File the last quarter, then a receipt that settled late: the screen shows it as changed since filed.
  must(`file ${last}`, await fileIftaReturn(last, {}, NOW, W));
  await writeFills([{ key: "P-late", vehicleId: q3.trucks[q3.trucks.length - 1]!, state: "AR", gallons: 88, at: day(q4From, -3) }]);
}

/**
 * Wave 7 (the partner surface): a read API key, an outbound webhook endpoint with a few deliveries (one dead, one failed), and one inbound company event that failed, so Settings, Integrations
 * and Partner issues have something to show. Only `demo-workspace` is touched (never `showcase-workspace`).
 *
 * Nothing here can reach a live server: the endpoint's host is on `.invalid` (RFC 2606: it never resolves), and it is created with a resolver that answers a public placeholder so creation
 * does not depend on DNS. Deliveries are written in end states (sent, dead) plus one failed whose next try is hours away; if a scheduler ever runs `POST /partners/cron` against the demo
 * database, that try fails at name lookup and no request is made. The failed inbound event names a TriumphPay event; the demo has no TriumphPay connection, so "Run again" on it answers that
 * TriumphPay is not connected, and "Settle" works.
 *
 * Idempotent: the key is made once (printed once, then only its masked form exists anywhere); the endpoint once; deliveries and the event are upserted by stable ids and put back to their
 * seeded state. While the money steps above run, the seeded endpoint is paused (pauseSeedEndpoint) so a re-run's own invoices and statements queue nothing to it.
 */
const SEED_KEY_LABEL = "Demo accounting sync (sample)";
const SEED_HOOK_URL = "https://hooks.truelane-demo.invalid/truelane";
const SEED_HOOK_EVENTS: WebhookEvent[] = ["invoice.created", "credit_memo.created", "payment.applied", "statement.finalized"];
const SEED_INBOUND_ID = "seed-w7-tp-funded-1";
const SEED_WHO = "Demo seed";
/** A stable evt_<32 hex>, so a re-run updates the same delivery. */
const seedEventId = (name: string) => `evt_${createHash("sha256").update(`seed-wave7:${name}`).digest("hex").slice(0, 32)}`;

/** Returns whether the seeded endpoint was on, so it can be put back. */
async function pauseSeedEndpoint(): Promise<boolean> {
  const ep = await prisma.webhookEndpoint.findFirst({ where: { workspaceId: W, url: SEED_HOOK_URL } });
  if (!ep) return true; // first run: it is made switched on
  if (ep.active) await prisma.webhookEndpoint.update({ where: { id: ep.id }, data: { active: false } });
  return ep.active;
}

async function seedWave7(endpointWasOn: boolean) {
  for (const f of ["read_api", "outbound_webhooks"] as const) must(`plan ${f}`, await checkFeature(f, W));

  // The read key: made once. The whole key is shown here, once; the database keeps its hash.
  const key = await prisma.partnerApiKey.findFirst({ where: { workspaceId: W, label: SEED_KEY_LABEL, revokedAt: null } });
  if (key) console.log(`read key: kept (${key.prefix}_…${key.last4})`);
  else {
    const made = await createApiKey({ label: SEED_KEY_LABEL, scopes: ["invoices", "payments", "settlements"] }, SEED_WHO, NOW, W, "test");
    if (!made.ok) throw new Error(`api key: ${made.error}`);
    console.log(`read key made (shown this once, not stored): ${made.key}`);
  }

  // The endpoint: made once, through the desk's own path (checked address, sealed secret, audited). The secret is never printed.
  let ep = await prisma.webhookEndpoint.findFirst({ where: { workspaceId: W, url: SEED_HOOK_URL } });
  if (!ep) {
    if (!process.env.DESK_CREDENTIAL_KEY) throw new Error("DESK_CREDENTIAL_KEY is not set: the endpoint's signing secret cannot be sealed. Set it from apps/web/.env.local for this run.");
    const placeholder = async () => [{ address: "93.184.216.34", family: 4 }];
    const made = await createEndpoint({ url: SEED_HOOK_URL, label: "Sample receiver (never resolves)", events: SEED_HOOK_EVENTS }, SEED_WHO, NOW, W, { resolver: placeholder });
    if (!made.ok) throw new Error(`endpoint: ${made.error}`);
    ep = await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: made.id } });
    console.log(`webhook endpoint made: ${SEED_HOOK_URL} (secret …${ep.secretLast4})`);
  } else {
    if (endpointWasOn) await prisma.webhookEndpoint.update({ where: { id: ep.id }, data: { active: true } });
    console.log(`webhook endpoint: kept (${endpointWasOn ? "on" : "left off, as it was"})`);
  }

  // Real-looking bodies from the demo's own records, shaped exactly as the desk sends them (invoices tied to loads only, so a stray test row is never described).
  const invoice = await prisma.invoice.findFirst({ where: { workspaceId: W, kind: "invoice", loads: { some: {} } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], include: INVOICE_INCLUDE });
  const memo = await prisma.invoice.findFirst({ where: { workspaceId: W, kind: "credit_memo" }, orderBy: { createdAt: "asc" }, include: INVOICE_INCLUDE });
  const payments = await prisma.invoicePayment.findMany({ where: { workspaceId: W, invoice: { loads: { some: {} } } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 2 });
  const statement = await prisma.settlement.findFirst({ where: { workspaceId: W, status: "final" }, orderBy: [{ finalizedAt: "desc" }, { id: "desc" }], select: SETTLEMENT_SELECT });
  if (!invoice || !memo || payments.length < 2 || !statement) throw new Error("wave 7: the demo has no invoice, credit memo, two payments and a final statement to describe (run the steps above first)");
  const hours = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
  type Seeded = { name: string; type: WebhookEvent; data: Record<string, unknown>; at: Date; state: Partial<Prisma.WebhookDeliveryUncheckedCreateInput> };
  const sent = (at: Date) => ({ status: "sent", attempts: 1, lastStatus: 200, lastError: null, sentAt: new Date(at.getTime() + 2_000), nextAttemptAt: at });
  const rows: Seeded[] = [
    // Dead first, then deliveries that went through after it, so the endpoint's dead-in-a-row count is honestly 0.
    { name: "memo-dead", type: "credit_memo.created", data: shapeInvoice(memo), at: hours(80), state: { status: "dead", attempts: 8, lastStatus: 503, lastError: "The receiver answered 503.", sentAt: null, nextAttemptAt: hours(30) } },
    { name: "statement-sent", type: "statement.finalized", data: shapeSettlement(statement), at: hours(26), state: sent(hours(26)) },
    { name: "invoice-sent", type: "invoice.created", data: shapeInvoice(invoice), at: hours(20), state: sent(hours(20)) },
    { name: "payment-sent", type: "payment.applied", data: shapePayment(payments[1]!), at: hours(6), state: sent(hours(6)) },
    { name: "payment-failed", type: "payment.applied", data: shapePayment(payments[0]!), at: hours(1), state: { status: "failed", attempts: 2, lastStatus: null, lastError: "The receiver's name does not resolve.", sentAt: null, nextAttemptAt: new Date(NOW.getTime() + 6 * 3_600_000) } }
  ];
  for (const r of rows) {
    const eventId = seedEventId(r.name);
    const payload = envelope(eventId, r.type, r.data, r.at) as Prisma.InputJsonObject;
    const state = { ...r.state, payload, type: r.type, leaseUntil: null, resolvedAt: null, resolvedBy: null, resolution: null, resolutionNote: null };
    await prisma.webhookDelivery.upsert({ where: { endpointId_eventId: { endpointId: ep.id, eventId } }, create: { workspaceId: W, endpointId: ep.id, eventId, createdAt: r.at, ...state }, update: state });
  }
  await prisma.webhookEndpoint.update({ where: { id: ep.id }, data: { deadInARow: 0 } });

  // One company event the desk could not apply, with its body kept: it shows on Partner issues.
  const target = (await prisma.load.findFirst({ where: { workspaceId: W, deletedAt: null, factoringStatus: "submitted", invoiceNumber: { not: null } }, select: { invoiceNumber: true } })) ?? (await prisma.load.findFirst({ where: { workspaceId: W, deletedAt: null, invoiceNumber: { not: null } }, orderBy: { invoicedAt: "desc" }, select: { invoiceNumber: true } }));
  if (!target?.invoiceNumber) throw new Error("wave 7: no invoiced load to name in the inbound event");
  const body = JSON.stringify({ id: SEED_INBOUND_ID, type: "factoring.funded", reference: target.invoiceNumber, reference_id: `TP-SBX-${target.invoiceNumber}` });
  const at = hours(3);
  const event = { workspaceId: W, kind: "factoring.funded", outcome: "failed", detail: "The desk could not apply it. It can be tried again.", payload: body, attemptedAt: at, receivedAt: at, resolvedAt: null, resolvedBy: null, resolution: null, resolutionNote: null };
  await prisma.partnerEvent.upsert({ where: { provider_eventId: { provider: "triumphpay", eventId: `${W}:${SEED_INBOUND_ID}` } }, create: { provider: "triumphpay", eventId: `${W}:${SEED_INBOUND_ID}`, ...event }, update: event });
}

async function main() {
  if (!(await prisma.workspace.findUnique({ where: { id: W } }))) throw new Error("no demo workspace: run seed-demo.ts first");
  const endpointWasOn = await pauseSeedEndpoint();
  await clearMoney();
  await seedPay();
  await seedInvoices();
  await seedWave6();
  await seedFuelTax();
  await seedWave7(endpointWasOn);
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
  const [fuel, miles, returns] = await Promise.all([
    prisma.fuelTransaction.groupBy({ by: ["product", "status", "taxPaid"], where: { workspaceId: W, provider: SEED_FUEL }, _count: { _all: true } }),
    prisma.iftaMileage.groupBy({ by: ["quarter", "method"], where: { workspaceId: W }, _count: { _all: true }, _sum: { miles: true } }),
    prisma.iftaReturn.findMany({ where: { workspaceId: W }, select: { quarter: true, status: true, total: true } })
  ]);
  console.log("fuel", fuel.map((s) => `${s.product}/${s.status}/${s.taxPaid ? "tax paid" : "bulk"} ${s._count._all}`).join(", "));
  console.log("ifta miles", miles.map((s) => `${s.quarter} ${s.method} ${s._count._all} pieces ${s._sum.miles}`).join(", "));
  console.log("ifta returns", returns.map((r) => `${r.quarter} ${r.status} ${r.total}`).join(", "));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
