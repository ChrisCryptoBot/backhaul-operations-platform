import { PDFDocument } from "pdf-lib";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { invoiceLoad } from "@/server/tl/invoicing";
import { connectPartner } from "@/server/partners/connections";
import { saveFactoringTerms } from "@/server/partners/factoring-terms";
import { cancelFactoringBatch, listFactoringBatches, retryFactoringBatch, sendFactoringBatch } from "@/server/partners/factoring-batch";
import { removeFiles, storeFile } from "@/server/tl/message-files";

/**
 * Factoring by batch (docs/MONEY_PLAN.md, Wave 2) on the demo database, in a workspace of its own, with the batch simulator (a sandbox_ key): what is refused before anything is written,
 * a batch that goes through, one that fails and goes through on the next try, one that keeps failing and is cancelled, and invoices that wait for their documents.
 *   DATABASE_URL=postgresql://demo:demo@localhost:54330/demo RUN_DB_INTEGRATION=true npx vitest run tests/integration/factoring-batch.integration.test.ts
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const W = "fbatch";
const NOW = new Date("2026-11-20T18:00:00Z");
const KEY = "TRIUMPHPAY_API_KEY";
const BLANK = { transport: "api" as const, batchDestination: "", factorName: "Apex Capital", remitName: "", remitAddress: "", lockboxBank: "", routingNumber: "", accountNumber: "", noaText: "", advancePct: "", feePct: "" };

async function pdf(): Promise<Buffer> {
  const d = await PDFDocument.create();
  d.addPage([612, 792]);
  return Buffer.from(await d.save());
}

describe.skipIf(!run)("factoring by batch, through the simulator", () => {
  const keys: string[] = [];
  const inv: Record<string, { id: string; loadId: string }> = {};
  let saved: string | undefined;

  /** A delivered load, invoiced on its own, with (or without) its rate confirmation and proof of delivery kept as files. */
  async function ready(n: string, withDocs = true) {
    const l = await prisma.load.create({ data: { workspaceId: W, loadNumber: n, brokerName: "Acme Logistics", brokerEmail: "ap@acme.invalid", status: "completed", completedAt: NOW, quotedRevenue: 1000, podNote: "Signed" } as never });
    const out = await invoiceLoad(l.id, { form: { number: `INV-${n}`, terms: "30", detention: false, lumper: "", layover: "", otherLabel: "", other: "" } }, NOW, W);
    expect(out).toMatchObject({ ok: true });
    if (withDocs) {
      for (const kind of ["rate_con", "pod"] as const) {
        const s = await storeFile(W, { ok: true, name: `${kind}.pdf`, data: await pdf(), type: { kind: "file", mime: "application/pdf" } } as never);
        keys.push(s.storageKey);
        await prisma.loadDocument.create({ data: { id: s.id, workspaceId: W, loadId: l.id, kind, name: s.name, mime: s.mime, bytes: s.bytes, sha256: s.sha256, storageKey: s.storageKey, addedBy: "t" } });
      }
    }
    const rec = await prisma.invoice.findFirstOrThrow({ where: { workspaceId: W, number: `INV-${n}` } });
    inv[n] = { id: rec.id, loadId: l.id };
  }
  const terms = (transport: "api" | "batch_sftp" | "batch_email", batchDestination = "") => saveFactoringTerms({ ...BLANK, transport, batchDestination }, "test", NOW, W);
  const state = async (n: string) => {
    const r = await prisma.invoice.findUniqueOrThrow({ where: { id: inv[n]!.id } });
    const l = await prisma.load.findUniqueOrThrow({ where: { id: inv[n]!.loadId } });
    return [r.factoringStatus, r.factoringReferenceId, l.factoringStatus];
  };

  beforeAll(async () => {
    saved = process.env[KEY];
    await prisma.driverLedgerEntry.deleteMany({ where: { workspace: { id: W } } });
    await prisma.assignment.deleteMany({ where: { OR: [{ load: { workspace: { id: W } } }, { driver: { workspace: { id: W } } }] } });
    await prisma.workspace.deleteMany({ where: { id: W } });
    await prisma.workspace.create({ data: { id: W, name: "Batch desk", plan: "enterprise" } });
    for (const n of ["B-1", "B-2", "B-3", "B-4", "B-5"]) await ready(n);
    await ready("B-NODOCS", false);
  });
  afterAll(async () => {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
    await removeFiles(keys);
    await prisma.driverLedgerEntry.deleteMany({ where: { workspace: { id: W } } });
    await prisma.assignment.deleteMany({ where: { OR: [{ load: { workspace: { id: W } } }, { driver: { workspace: { id: W } } }] } });
    await prisma.workspace.deleteMany({ where: { id: W } });
  });

  test("refused before anything is written: a factor that takes invoices by API, a factor not connected, and a real key with no live delivery", async () => {
    await terms("api");
    expect(await sendFactoringBatch({}, NOW, W)).toMatchObject({ ok: false, code: "not_batch" });
    expect(await terms("batch_sftp", "sftp://files.apex.example/inbox")).toMatchObject({ ok: true });
    process.env[KEY] = "sandbox_batch_test";
    expect(await sendFactoringBatch({}, NOW, W)).toMatchObject({ ok: false, code: "not_connected" });
    expect(await connectPartner("factoring", "triumphpay", "Apex", NOW, W)).toMatchObject({ ok: true });
    process.env[KEY] = "a-real-looking-key";
    expect(await sendFactoringBatch({}, NOW, W)).toMatchObject({ ok: false, code: "not_implemented" });
    expect(await prisma.factoringBatch.count({ where: { workspaceId: W } })).toBe(0);
    expect(await state("B-1")).toEqual(["none", null, "none"]);
    process.env[KEY] = "sandbox_batch_test";
  });

  test("a batch goes through: the ready invoices are submitted with the batch number, the one without documents waits, and the audit says so", async () => {
    const out = await sendFactoringBatch({ invoiceIds: [inv["B-1"]!.id, inv["B-2"]!.id, inv["B-NODOCS"]!.id] }, NOW, W);
    expect(out).toMatchObject({ ok: true, number: "FB-0001", status: "sent", invoices: 2, total: 2000, leftOver: 0 });
    expect(out.ok && out.held).toEqual([{ number: "INV-B-NODOCS", lacks: "rate confirmation and proof of delivery" }]);
    expect(await state("B-1")).toEqual(["submitted", "FB-0001", "submitted"]);
    expect(await state("B-NODOCS")).toEqual(["none", null, "none"]);
    const [b] = await listFactoringBatches(W);
    expect(b).toMatchObject({ number: "FB-0001", status: "sent", method: "sftp", invoiceCount: 2, attempts: 1, lastError: null });
    // The schedule and two packets went: three files, and the receipt says so.
    expect(b!.bytes).toBeGreaterThan(0);
    expect((await prisma.factoringBatch.findFirstOrThrow({ where: { workspaceId: W, number: "FB-0001" } })).receipt).toMatch(/^SBX-SFTP-FB-0001-3F-/);
    expect(await prisma.auditEvent.count({ where: { workspaceId: W, action: "factoring_batch_sent" } })).toBe(1);
    expect(await prisma.auditEvent.count({ where: { workspaceId: W, action: "factoring_requested" } })).toBe(2);
    // Sent invoices are with the factor: the same ones cannot go again.
    expect(await sendFactoringBatch({ invoiceIds: [inv["B-1"]!.id] }, NOW, W)).toMatchObject({ ok: false, code: "nothing_ready" });
  });

  test("a delivery that times out keeps its invoices claimed, and the next try goes through", async () => {
    await terms("batch_sftp", "sftp://flaky.apex.example/inbox");
    const out = await sendFactoringBatch({ invoiceIds: [inv["B-3"]!.id] }, NOW, W);
    expect(out).toMatchObject({ ok: true, number: "FB-0002", status: "failed", error: expect.stringContaining("timed out") });
    expect(await state("B-3")).toEqual(["requested", "FB-0002", "requested"]);
    // Claimed by the failed batch, so no other batch takes it.
    expect(await sendFactoringBatch({ invoiceIds: [inv["B-3"]!.id] }, NOW, W)).toMatchObject({ ok: false, code: "nothing_ready" });
    const id = (await prisma.factoringBatch.findFirstOrThrow({ where: { workspaceId: W, number: "FB-0002" } })).id;
    expect(await retryFactoringBatch(id, NOW, W)).toEqual({ ok: true, status: "sent" });
    expect(await state("B-3")).toEqual(["submitted", "FB-0002", "submitted"]);
    expect((await prisma.factoringBatch.findUniqueOrThrow({ where: { id } })).attempts).toBe(2);
    expect(await retryFactoringBatch(id, NOW, W)).toMatchObject({ ok: false, error: expect.stringContaining("already gone") });
  });

  test("a batch that keeps failing can be cancelled with a reason, which gives its invoices back; a sent batch cannot be cancelled", async () => {
    await terms("batch_sftp", "sftp://fail.apex.example/inbox");
    const out = await sendFactoringBatch({ invoiceIds: [inv["B-4"]!.id] }, NOW, W);
    expect(out).toMatchObject({ ok: true, number: "FB-0003", status: "failed" });
    const id = (await prisma.factoringBatch.findFirstOrThrow({ where: { workspaceId: W, number: "FB-0003" } })).id;
    expect(await retryFactoringBatch(id, NOW, W)).toMatchObject({ ok: true, status: "failed" });
    expect(await cancelFactoringBatch(id, "no", NOW, W)).toMatchObject({ ok: false });
    expect(await cancelFactoringBatch(id, "Factor's server is down this week, sending by email", NOW, W)).toEqual({ ok: true });
    expect(await state("B-4")).toEqual(["none", null, "none"]);
    expect((await prisma.factoringBatch.findUniqueOrThrow({ where: { id } })).status).toBe("cancelled");
    const sent = (await prisma.factoringBatch.findFirstOrThrow({ where: { workspaceId: W, number: "FB-0001" } })).id;
    expect(await cancelFactoringBatch(sent, "Changed my mind", NOW, W)).toMatchObject({ ok: false });
  });

  test("by email, invoices go in order until the attachments would pass the mailbox's limit; the rest wait for the next batch", async () => {
    await terms("batch_email", "batches@apex.example");
    // A mailbox that takes the schedule and one packet but not two: one invoice goes, the other waits (B-4, given back above, and B-5 are ready).
    const one = await sendFactoringBatch({ emailLimitBytes: 3_000 }, NOW, W);
    expect(one).toMatchObject({ ok: true, number: "FB-0004", status: "sent", invoices: 1, leftOver: 1 });
    expect((await prisma.factoringBatch.findFirstOrThrow({ where: { workspaceId: W, number: "FB-0004" } })).receipt).toMatch(/^SBX-EMAIL-FB-0004-2F-/);
  });

  test("by email the same loop works, and the cancelled invoice can go in a new batch", async () => {
    await terms("batch_email", "batches@apex.example");
    const out = await sendFactoringBatch({}, NOW, W);
    // What waited goes now; B-NODOCS still waits for its documents.
    expect(out).toMatchObject({ ok: true, number: "FB-0005", status: "sent", invoices: 1, leftOver: 0 });
    expect([await state("B-4"), await state("B-5")].map((x) => x[0])).toEqual(["submitted", "submitted"]);
  });
});
