import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { invoiceLoads, issueCreditMemo, markLoadPaid, undoPaid } from "@/server/tl/invoicing";
import { applyFactoringUpdate, getFactoringView, recordChargeback } from "@/server/partners/factoring";
import { getFactoringTerms, saveFactoringTerms, termsForm } from "@/server/partners/factoring-terms";
import { buildPacket } from "@/server/partners/factoring-packet";
import { scheduleRows } from "@/server/partners/factoring-schedule";
import { invoicePdfData } from "@/server/tl/invoice-pdf";
import { removeFiles, storeFile } from "@/server/tl/message-files";

/**
 * Wave 2 of docs/MONEY_PLAN.md on the demo database, in a workspace of its own: the fleet's factoring terms, a factored invoice of several loads (one invoice to the factor), the advance,
 * fee and reserve worked out when it is funded, the reserve released when the customer pays, a chargeback, the packet and the schedule of accounts.
 *   DATABASE_URL=postgresql://demo:demo@localhost:54330/demo RUN_DB_INTEGRATION=true npx vitest run tests/integration/factoring-wave2.integration.test.ts
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const W = "fw2";
const NOW = new Date("2026-11-20T18:00:00Z");

const BLANK = { factorName: "", remitName: "", remitAddress: "", lockboxBank: "", routingNumber: "", accountNumber: "", noaText: "", advancePct: "", feePct: "" };

async function pdfBytes(pages = 1): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([612, 792]);
  return Buffer.from(await doc.save());
}

describe.skipIf(!run)("factoring terms, a factored invoice of several loads, the packet and the schedule", () => {
  const ids: string[] = [];
  const keys: string[] = [];
  let invoiceId = "";

  beforeAll(async () => {
    await prisma.workspace.deleteMany({ where: { id: W } });
    await prisma.workspace.create({ data: { id: W, name: "FW2 desk", plan: "enterprise" } });
    for (const [n, rate] of [["F-1", 1000], ["F-2", 2000]] as const) {
      const l = await prisma.load.create({ data: { workspaceId: W, loadNumber: n, brokerName: "Acme Logistics", brokerEmail: "ap@acme.invalid", status: "completed", completedAt: NOW, quotedRevenue: rate, podNote: "Signed" } as never });
      ids.push(l.id);
    }
    expect(await invoiceLoads(ids, { number: "FW2-1", terms: "30" }, NOW, W)).toMatchObject({ ok: true, total: 3000 });
    invoiceId = (await prisma.invoice.findFirstOrThrow({ where: { workspaceId: W, number: "FW2-1" } })).id;
  });
  afterAll(async () => {
    await removeFiles(keys);
    await prisma.workspace.deleteMany({ where: { id: W } });
  });

  test("terms are checked, saved once with an audit entry that hides the account number, and a repeat changes nothing", async () => {
    expect(await saveFactoringTerms({ ...BLANK, routingNumber: "123" }, "Chris", NOW, W)).toMatchObject({ ok: false, errors: { routingNumber: expect.any(String) } });
    expect(await getFactoringTerms(W)).toBeNull();
    const form = { ...BLANK, factorName: "Apex Capital", remitName: "Apex Capital LLC", remitAddress: "PO Box 100\nDallas, TX 75201", lockboxBank: "Bank of Dallas", routingNumber: "111000025", accountNumber: "12345678", noaText: "Pay only to Apex Capital.", advancePct: "90", feePct: "2.5" };
    expect(await saveFactoringTerms(form, "Chris", NOW, W)).toEqual({ ok: true, changed: true });
    expect(await saveFactoringTerms(form, "Chris", NOW, W)).toEqual({ ok: true, changed: false });
    expect(termsForm(await getFactoringTerms(W))).toEqual(form);
    const audit = await prisma.auditEvent.findMany({ where: { workspaceId: W, action: "factoring_terms_saved" } });
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0]!.after)).toContain("****5678");
    expect(JSON.stringify(audit[0]!.after)).not.toContain("12345678");
  });

  test("the view of an invoice of several loads asks for every load's documents", async () => {
    const view = await getFactoringView(ids[1]!, W);
    expect(view).toMatchObject({ loadCount: 2, invoiceNumber: "FW2-1" });
    expect(view!.missingRequired).toEqual([]);
    expect(view!.money!.expected).toMatchObject({ advance: 2700, reserveHeld: 300, fee: 75, reserveReleasable: 225, netToCarrier: 2925 });
    const row = await prisma.loadDocument.create({ data: { workspaceId: W, loadId: ids[0]!, kind: "rate_con", name: "rc.pdf", mime: "application/pdf", bytes: 1, sha256: "x", storageKey: `${W}/00000000-0000-0000-0000-000000000001`, addedBy: "t" } });
    // One load's rate confirmation is not the invoice's: the other load has none.
    expect((await getFactoringView(ids[0]!, W))!.manifest.find((m) => m.kind === "rate_confirmation")!.present).toBe(false);
    await prisma.loadDocument.delete({ where: { id: row.id } });
  });

  test("a delivery photo from the driver's phone is a link, not a kept file: the view, the packet and the schedule all say the proof of delivery is missing", async () => {
    await prisma.stop.create({ data: { loadId: ids[0]!, stopSequence: 1, stopType: "delivery", stopRole: "delivery", addressString: "Tulsa, OK", podPhotoUrl: "https://phone.invalid/pod.jpg" } as never });
    const view = await getFactoringView(ids[0]!, W);
    expect(view!.podPhotoOnly).toBe(1);
    expect(view!.manifest.find((m) => m.kind === "proof_of_delivery")!.present).toBe(false);
    expect((await scheduleRows(W, null)).rows[0]!.pod).toBe(false);
    const packet = await buildPacket(ids[0]!, W);
    expect(packet.ok ? "" : packet.error).toContain("F-1: proof of delivery");
  });

  test("the packet is refused until every load has a rate confirmation and a proof of delivery, then stitches them, in order, after the invoice", async () => {
    const refused = await buildPacket(ids[0]!, W);
    expect(refused).toMatchObject({ ok: false, error: expect.stringContaining("F-1: rate confirmation") });
    expect(refused.ok ? "" : refused.error).toContain("F-2: proof of delivery");
    for (const id of ids) {
      for (const [kind, pages] of [["rate_con", 2], ["pod", 1]] as const) {
        const stored = await storeFile(W, { ok: true, name: `${kind}.pdf`, data: await pdfBytes(pages), type: { kind: "file", mime: "application/pdf" } } as never);
        keys.push(stored.storageKey);
        await prisma.loadDocument.create({ data: { id: stored.id, workspaceId: W, loadId: id, kind, name: stored.name, mime: stored.mime, bytes: stored.bytes, sha256: stored.sha256, storageKey: stored.storageKey, addedBy: "t" } });
      }
    }
    const view = await getFactoringView(ids[0]!, W);
    expect(view!.missingRequired).toEqual([]);
    expect(view!.manifest.every((m) => m.present)).toBe(true);
    expect(view!.podPhotoOnly).toBe(0);
    const got = await buildPacket(ids[1]!, W);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.filename).toBe("FW2-1-packet.pdf");
    // The invoice, then for each of the two loads a two-page rate confirmation and a one-page proof of delivery.
    expect(got.included).toHaveLength(1 + 4);
    const doc = await PDFDocument.load(got.bytes);
    const invoicePages = doc.getPageCount() - 2 * 3;
    expect(invoicePages).toBeGreaterThanOrEqual(1);
    expect(got.pages).toBe(doc.getPageCount());
  });

  test("a full-size phone photo kept as a proof of delivery goes in the packet fitted to 1600 px, so the packet stays small", async () => {
    const w = 4032;
    const h = 3024;
    const raw = Buffer.alloc(w * h * 3);
    let x = 7;
    for (let i = 0; i < raw.length; i++) {
      x = (x * 1103515245 + 12345) & 0x7fffffff;
      raw[i] = x & 0xff;
    }
    const photo = await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
    const stored = await storeFile(W, { ok: true, name: "pod-photo.jpg", data: photo, type: { kind: "image", mime: "image/jpeg" } } as never);
    keys.push(stored.storageKey);
    await prisma.loadDocument.create({ data: { id: stored.id, workspaceId: W, loadId: ids[0]!, kind: "pod", name: stored.name, mime: stored.mime, bytes: stored.bytes, sha256: stored.sha256, storageKey: stored.storageKey, addedBy: "t" } });
    const got = await buildPacket(ids[0]!, W);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.included).toContain("F-1: pod-photo.jpg");
    // The photo alone was several megabytes; in the packet it is a fraction of that.
    expect(photo.length).toBeGreaterThan(5 * 1024 * 1024);
    expect(got.bytes.length).toBeLessThan(photo.length / 3);
  }, 60_000);

  test("the schedule lists the invoice once, with its documents on file", async () => {
    const { rows } = await scheduleRows(W, null);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ number: "FW2-1", loads: "F-1, F-2", amount: 3000, balance: 3000, rateCon: true, pod: true });
    expect((await scheduleRows(W, null, [ids[1]!])).rows).toHaveLength(1);
    expect((await scheduleRows(W, null, ["no-such-load"])).rows).toHaveLength(0);
  });

  test("funded works out the advance, fee and reserve on the invoice and moves every load; the customer paying releases the reserve less the fee; taking the payment back undoes it", async () => {
    await prisma.load.updateMany({ where: { id: { in: ids } }, data: { factoringStatus: "requested", factoringReferenceId: "FACT-1" } });
    await prisma.invoice.update({ where: { id: invoiceId }, data: { factoringStatus: "requested", factoringReferenceId: "FACT-1" } });
    expect(await applyFactoringUpdate(ids[0]!, "funded", null, NOW, W)).toBe(true);
    const funded = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect([funded.factoringStatus, funded.factoringAdvance!.toNumber(), funded.factoringReserve!.toNumber(), funded.factoringFee!.toNumber()]).toEqual(["funded", 2700, 300, 75]);
    expect((await prisma.load.findMany({ where: { id: { in: ids } } })).map((l) => l.factoringStatus)).toEqual(["funded", "funded"]);
    // A credit memo on an invoice the factor has is the factor's to settle: refused, and no reserve is released for it.
    expect(await issueCreditMemo(ids[1]!, { amount: 2900, reason: "Customer discount agreed" }, NOW, W)).toMatchObject({ ok: false, error: expect.stringContaining("factoring company") });
    const still = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect([still.status, still.paidTotal.toNumber(), still.factoringStatus, still.factoringReserveReleased]).toEqual(["open", 0, "funded", null]);
    // The notice goes on the invoice's PDF once it is factored: the factor's remit-to and wording.
    const data = await invoicePdfData(ids[0]!, W);
    expect(data!.factoring).toMatchObject({ factor: "Apex Capital", noaText: "Pay only to Apex Capital." });
    expect(data!.factoring!.remitTo).toContain("routing 111000025");

    expect(await markLoadPaid(ids[0]!, new Date("2026-11-25T18:00:00Z"), {}, W)).toMatchObject({ ok: true });
    const paid = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect([paid.status, paid.factoringStatus, paid.factoringReserveReleased!.toNumber()]).toEqual(["paid", "paid", 225]);
    expect(await undoPaid(ids[0]!, "Entered on the wrong invoice", new Date("2026-11-26T18:00:00Z"), W)).toMatchObject({ ok: true });
    const back = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect([back.status, back.factoringStatus, back.factoringReserveReleased]).toEqual(["open", "funded", null]);
  });

  test("a chargeback needs a funded invoice and a reason, owes the advance back, and frees the invoice to be sent again", async () => {
    expect(await recordChargeback(ids[0]!, "no", NOW, W)).toMatchObject({ ok: false });
    expect(await recordChargeback(ids[1]!, "Customer went out of business", NOW, W)).toEqual({ ok: true, amount: 2700 });
    const rec = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect([rec.factoringStatus, rec.factoringChargeback!.toNumber(), rec.factoringReserve]).toEqual(["rejected", 2700, null]);
    expect((await prisma.load.findMany({ where: { id: { in: ids } } })).map((l) => l.factoringStatus)).toEqual(["rejected", "rejected"]);
    expect(await recordChargeback(ids[0]!, "Again", NOW, W)).toMatchObject({ ok: false });
    expect((await prisma.auditEvent.count({ where: { workspaceId: W, action: "factoring_chargeback" } }))).toBe(1);
  });
});
