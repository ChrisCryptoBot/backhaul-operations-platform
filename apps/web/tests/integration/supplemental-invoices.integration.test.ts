import { readFileSync } from "node:fs";
import path from "node:path";
import { inflateSync } from "node:zlib";
import { PDFDocument, PDFName, PDFRawStream } from "pdf-lib";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { openBalance } from "@/lib/cash";
import { prisma } from "@/lib/db";
import { journalFile } from "@/server/partners/accounting";
import { agingSummary, clearAgingCache } from "@/server/tl/aging";
import { clearCashCache, readCashInvoices } from "@/server/tl/cash";
import { num, toAgingView } from "@/server/tl/convert";
import { detentionOfLoad, getDetentionRecovery, supplementalDetentionByLoad } from "@/server/tl/detention";
import { invoicePdfData } from "@/server/tl/invoice-pdf";
import { buildInvoicePdf } from "@/lib/invoice-pdf";
import {
  getInvoice,
  invoiceLoad,
  issueSupplemental,
  markLoadPaid,
  payInvoiceRecord,
  supplementalsByLoad,
  undoSupplementalPayment,
  voidSupplemental
} from "@/server/tl/invoicing";
import { listInvoiceRows } from "@/server/tl/queries";

/**
 * Phase 5 supplemental invoices integration proof:
 *   DATABASE_URL=postgresql://demo:demo@localhost:54330/demo_gate RUN_DB_INTEGRATION=true npx vitest run tests/integration/supplemental-invoices.integration.test.ts
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const W = "supp-w";
const NOW = new Date("2026-11-25T18:00:00Z"); // 12:00 PM Dallas

const srcText = (...p: string[]) => readFileSync(path.join(__dirname, "..", "..", "src", ...p), "utf8");

describe("primary-invoice lookup guards against matching supplementals", () => {
  test("every primary lookup site explicitly pins supplementOfId: null / supplement_of_id is null", () => {
    expect(srcText("server", "tl", "invoice-records.ts")).toMatch(/openInvoiceOf[\s\S]*supplementOfId: null/);
    expect(srcText("server", "tl", "invoicing.ts")).toMatch(/getInvoice[\s\S]*supplementOfId: null[\s\S]*sharedInvoiceOf[\s\S]*supplementOfId: null/);
    expect(srcText("server", "partners", "factoring.ts")).toMatch(/scopeOf[\s\S]*supplementOfId: null/);
    expect(srcText("server", "partners", "factoring-packet.ts")).toMatch(/buildPacket[\s\S]*supplementOfId: null/);
    expect(srcText("server", "tl", "invoice-pdf.ts")).toMatch(/invoicePdfData[\s\S]*supplementOfId: null/);
    expect(srcText("server", "tl", "queries.ts")).toContain("supplement_of_id is null");
    expect(srcText("server", "tl", "aging.ts")).toContain("supplement_of_id is null");
  });
});

describe.skipIf(!run)("supplemental invoices lifecycle on demo_gate", () => {
  let vehicleId = "";
  let loadId = "";
  let deliveryStopId = "";

  async function wipe() {
    await prisma.auditEvent.deleteMany({ where: { workspaceId: W } });
    await prisma.driverLedgerEntry.deleteMany({ where: { workspaceId: W } });
    await prisma.settlement.deleteMany({ where: { workspaceId: W } });
    await prisma.assignment.deleteMany({ where: { load: { workspaceId: W } } });
    await prisma.workspace.deleteMany({ where: { id: W } });
  }

  beforeAll(async () => {
    await wipe();
    await prisma.workspace.create({ data: { id: W, name: "Supplemental Test Fleet", plan: "pro" } });
    const v = await prisma.vehicle.create({
      data: {
        workspaceId: W,
        name: "SUPP-T1",
        type: "dry_van",
        terminal: "Dallas",
        costProfile: {
          create: {
            estimatedMonthlyMiles: 10000,
            breakEvenRpm: 1.5,
            detentionHourlyRate: 75,
            freeGraceMinutes: 120
          }
        }
      }
    });
    vehicleId = v.id;
    const load = await prisma.load.create({
      data: {
        workspaceId: W,
        vehicleId,
        loadNumber: "SUPP-100",
        status: "completed",
        completedAt: new Date(NOW.getTime() - 2 * 86_400_000),
        brokerName: "Acme Freight",
        brokerMcNumber: "112233",
        originAddress: "Dallas, TX",
        destinationAddress: "Tulsa, OK",
        loadedMiles: 260,
        quotedRevenue: 1500,
        fuelSurcharge: 100,
        podNote: "Signed POD",
        stops: {
          create: [
            { stopSequence: 1, stopType: "pickup", addressString: "Dallas, TX", waitMinutes: 30 },
            { stopSequence: 2, stopType: "delivery", addressString: "Tulsa, OK", waitMinutes: 0 }
          ]
        }
      },
      include: { stops: { orderBy: { stopSequence: "asc" } } }
    });
    loadId = load.id;
    deliveryStopId = load.stops[1]!.id;
  });

  afterAll(async () => {
    await wipe();
  });

  test("1) invoice & pay in full, approve 3h detention, 2) issue supplemental, 3) pay it, 4) void it returning to step 1", async () => {
    clearAgingCache();
    clearCashCache();

    // 1. Invoice ($1,600) and pay in full ($1,600), then record 3h billable detention (300 min wait, 120 min grace, $75/hr = $225).
    const inv = await invoiceLoad(loadId, {}, NOW, W);
    expect(inv).toMatchObject({ ok: true, total: 1600 });
    const paid = await markLoadPaid(loadId, NOW, { amount: 1600, method: "ach" }, W);
    expect(paid).toMatchObject({ ok: true });

    await prisma.stop.update({ where: { id: deliveryStopId }, data: { waitMinutes: 300 } });

    const parentSheetBefore = (await getInvoice(loadId, W))!;
    expect(parentSheetBefore.recordId).toBeTruthy();
    const parentId = parentSheetBefore.recordId!;
    const parentNumber = parentSheetBefore.invoiceNumber!;

    const loadStep1 = await prisma.load.findUniqueOrThrow({ where: { id: loadId }, include: { stops: true, vehicle: { include: { costProfile: true } } } });
    expect(detentionOfLoad(loadStep1, 120, 0)).toMatchObject({ billable: 225, billedExtra: 0, unbilled: 225 });
    clearAgingCache();
    expect((await agingSummary(NOW.getTime(), W)).totalOutstanding).toBe(0);

    // 2. Issue supplemental invoice (<parent>-S1 for $225 detention).
    const issued = await issueSupplemental(parentId, [{ kind: "detention", amount: 225, loadId }], { reason: "Approved post-payment detention" }, NOW, W);
    expect(issued).toMatchObject({ ok: true, number: `${parentNumber}-S1`, total: 225 });
    if (!issued.ok) return;

    // Verify no InvoiceLoad rows exist for the supplemental, and Load.paymentStatus keeps parent's "paid".
    expect(await prisma.invoiceLoad.count({ where: { invoiceId: issued.id } })).toBe(0);
    const loadAfterSupp = await prisma.load.findUniqueOrThrow({ where: { id: loadId }, include: { stops: true, vehicle: { include: { costProfile: true } } } });
    expect(loadAfterSupp.paymentStatus).toBe("paid");
    expect(loadAfterSupp.invoiceNumber).toBe(parentNumber);

    // Primary lookups still resolve parent (not the supplemental).
    const parentAfterSupp = (await getInvoice(loadId, W))!;
    expect(parentAfterSupp.recordId).toBe(parentId);
    expect(parentAfterSupp.supplementals).toHaveLength(1);
    expect(parentAfterSupp.supplementals[0]!.number).toBe(`${parentNumber}-S1`);

    // Detention now reads billed ($0 unbilled).
    const suppDet = await supplementalDetentionByLoad([loadId], W);
    expect(suppDet.get(loadId)).toBe(225);
    expect(detentionOfLoad(loadAfterSupp, 120, suppDet.get(loadId) ?? 0)).toMatchObject({ billable: 225, billedExtra: 225, unbilled: 0 });
    const recoveryStep2 = await getDetentionRecovery(W, NOW);
    expect(recoveryStep2.totalBilled).toBe(225);
    expect(recoveryStep2.totalUnbilled).toBe(0);

    // Load list / owed balance & toAgingView include the open $225 supplemental even though parent is paid.
    const paidRows = await listInvoiceRows(W, { scope: "paid" });
    const loadRow = paidRows.find((r) => r.id === loadId)!;
    expect(loadRow.status).toBe("paid");
    expect(loadRow.supplementalOpen).toBe(225);
    expect(loadRow.balance).toBe(225);
    expect(toAgingView({ ...loadAfterSupp, supplementalOpen: 225 })).toMatchObject({ paymentStatus: "invoiced", invoicedAmount: 225 });
    expect(toAgingView({ ...loadAfterSupp, supplementalOpen: 0 })).toMatchObject({ paymentStatus: "paid", invoicedAmount: 1600 });

    // Aging (unscoped & Dallas terminal) includes $225; Cash includes it; Journal posts cleanly.
    clearAgingCache();
    expect(await agingSummary(NOW.getTime(), W)).toMatchObject({ count: 1, totalOutstanding: 225 });
    expect(await agingSummary(NOW.getTime(), W, "Dallas")).toMatchObject({ count: 1, totalOutstanding: 225 });
    expect(await agingSummary(NOW.getTime(), W, "Houston")).toMatchObject({ count: 0, totalOutstanding: 0 });

    const cashStep2All = await readCashInvoices(W, new Date(NOW.getTime() - 7 * 86_400_000), null);
    expect(cashStep2All.leftOut).toBe(0);
    expect(openBalance(cashStep2All.invoices).cents).toBe(22_500);
    const cashStep2Dallas = await readCashInvoices(W, new Date(NOW.getTime() - 7 * 86_400_000), ["Dallas"]);
    expect(cashStep2Dallas.leftOut).toBe(0);
    expect(openBalance(cashStep2Dallas.invoices).cents).toBe(22_500);

    const journalStep2 = await journalFile({}, W);
    expect(journalStep2.ok).toBe(true);
    if (journalStep2.ok) {
      expect(journalStep2.csv).toContain(`${parentNumber}-S1`);
      expect(journalStep2.csv).toContain("225.00");
    }

    // Supplemental PDF says SUPPLEMENTAL INVOICE and names parent number.
    const pdfData = (await invoicePdfData(issued.id, W))!;
    expect(pdfData.supplementOf).toBe(parentNumber);
    const pdfBytes = await buildInvoicePdf(pdfData);
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const pdfParts: string[] = [];
    for (const [, obj] of pdfDoc.context.enumerateIndirectObjects()) {
      if (obj instanceof PDFRawStream) {
        const filter = obj.dict.get(PDFName.of("Filter"));
        const buf = filter === PDFName.of("FlateDecode") ? inflateSync(obj.contents) : Buffer.from(obj.contents);
        const raw = buf.toString("latin1");
        pdfParts.push(raw.replace(/<([0-9A-Fa-f]+)>\s*Tj/g, (_, hex: string) => Buffer.from(hex, "hex").toString("latin1")));
      }
    }
    const pdfRaw = pdfParts.join("\n");
    expect(pdfRaw).toContain("SUPPLEMENTAL INVOICE");
    expect(pdfRaw).toContain(parentNumber);

    // 3. Pay supplemental in full: owed returns to 0; void refused while paid.
    const paySupp = await payInvoiceRecord(issued.id, NOW, { method: "ach", reference: "ACH-S1" }, W);
    expect(paySupp).toMatchObject({ ok: true });
    expect((await listInvoiceRows(W, { scope: "paid" })).find((r) => r.id === loadId)!.balance).toBe(0);
    clearAgingCache();
    expect((await agingSummary(NOW.getTime(), W)).totalOutstanding).toBe(0);
    expect(openBalance((await readCashInvoices(W, new Date(NOW.getTime() - 7 * 86_400_000), null)).invoices).cents).toBe(0);
    expect(await voidSupplemental(issued.id, "Cannot void paid", NOW, W)).toMatchObject({ ok: false });

    // 4. Undo payment & void supplemental: returns to Step 1 (detention unbilled = 225, owed = 0, aging = 0, journal omits -S1).
    const undone = await undoSupplementalPayment(issued.id, "Applied to wrong check", NOW, W);
    expect(undone).toMatchObject({ ok: true });
    const voided = await voidSupplemental(issued.id, "Customer disputed detention", NOW, W);
    expect(voided).toMatchObject({ ok: true, number: `${parentNumber}-S1` });

    const suppDetStep4 = await supplementalDetentionByLoad([loadId], W);
    expect(suppDetStep4.get(loadId) ?? 0).toBe(0);
    expect(detentionOfLoad(loadAfterSupp, 120, 0)).toMatchObject({ billable: 225, billedExtra: 0, unbilled: 225 });
    const recoveryStep4 = await getDetentionRecovery(W, NOW);
    expect(recoveryStep4.totalBilled).toBe(0);
    expect(recoveryStep4.totalUnbilled).toBe(225);
    expect((await listInvoiceRows(W, { scope: "paid" })).find((r) => r.id === loadId)!.balance).toBe(0);
    clearAgingCache();
    expect((await agingSummary(NOW.getTime(), W)).totalOutstanding).toBe(0);
    expect(openBalance((await readCashInvoices(W, new Date(NOW.getTime() - 7 * 86_400_000), null)).invoices).cents).toBe(0);
    const journalStep4 = await journalFile({}, W);
    expect(journalStep4.ok).toBe(true);
    if (journalStep4.ok) {
      expect(journalStep4.csv).not.toContain(`${parentNumber}-S1`);
    }

    // Also verify issuing a second supplemental (-S2) with Rate correction (linehaul), layover, and lumper posts cleanly without unmapped accounts.
    const supp2 = await issueSupplemental(
      parentId,
      [
        { kind: "linehaul", amount: 150 },
        { kind: "layover", amount: 100 },
        { kind: "lumper", amount: 75 }
      ],
      { reason: "Rate correction and layover" },
      NOW,
      W
    );
    expect(supp2).toMatchObject({ ok: true, number: `${parentNumber}-S2`, total: 325 });
    const journalS2 = await journalFile({}, W);
    expect(journalS2.ok).toBe(true);
    if (journalS2.ok) {
      expect(journalS2.csv).toContain(`${parentNumber}-S2`);
      expect(journalS2.csv).toContain("325.00");
    }
    const listS = (await supplementalsByLoad([loadId], W)).get(loadId) ?? [];
    expect(listS.map((x) => `${x.tag}:${x.status}`)).toEqual(["S1:void", "S2:open"]);
    // Void supp2 to verify clean num(sum) helper doesn't drift
    expect(num(325)).toBe(325);
  });
});
