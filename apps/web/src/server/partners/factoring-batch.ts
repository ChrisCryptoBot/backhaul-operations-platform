import { Prisma } from "@prisma/client";
import type { Terminals } from "@/lib/scope";
import { prisma } from "@/lib/db";
import { scheduleCsv, splitReady, type ScheduleRow } from "@/lib/factoring-schedule";
import { recordAudit } from "@/server/tl/audit";
import { currentWorkspaceId } from "@/server/tl/workspace";
import { liveBatchTransport, sandboxBatchTransport, EMAIL_BATCH_LIMIT_BYTES, type BatchFile, type BatchMethod, type BatchTransport } from "./adapters/factoring-batch";
import { keyMode } from "./adapters/sandbox";
import { partnerState, providerName } from "./call";
import { workspaceReader } from "./credentials";
import { assertMoneyMovingAllowed } from "./gates";
import { buildPacket } from "./factoring-packet";
import { scheduleRows, SCHEDULE_CAP } from "./factoring-schedule";
import { getFactoringTerms } from "./factoring-terms";

/**
 * Sending invoices to a factor as a batch (docs/MONEY_PLAN.md, Wave 2): the open invoices that are not with a factor and have their rate confirmations and proofs of delivery kept as files
 * go out together as one schedule of accounts (CSV) and one PDF packet each, by SFTP or email, as the fleet's factoring terms say. The invoices are claimed ("requested") when the batch is
 * made, so nothing can send them twice; a delivery that goes through moves them to "submitted" with the batch number as their reference; one that fails keeps them in the batch, to be tried
 * again or cancelled (which gives them back). The delivery is the transport's (adapters/factoring-batch.ts): the simulator on a sandbox_ key, and "not implemented" for a real one until a
 * factor's server or mailbox is set up, in which case nothing is written at all.
 */
export type BatchResult =
  | { ok: true; batchId: string; number: string; status: "sent" | "failed"; invoices: number; total: number; error?: string; held: Array<{ number: string; lacks: string }>; leftOver: number }
  | { ok: false; error: string; code?: "not_implemented" | "not_connected" | "money_moving_off" | "not_batch" | "nothing_ready"; held?: Array<{ number: string; lacks: string }> };

const OPEN = ["none", "rejected"];

/** Which transport this fleet's factoring key asks for, or why none can be used. Read before anything is written. */
async function transportFor(workspaceId: string): Promise<{ ok: true; transport: BatchTransport; provider: string } | { ok: false; error: string; code: "not_implemented" | "not_connected" | "money_moving_off" }> {
  const state = await partnerState("factoring", null, workspaceId);
  if (!state.connected) return { ok: false, error: state.reason ?? "The factor is not connected for this fleet.", code: "not_connected" };
  const mode = keyMode(state.provider, await workspaceReader(state.provider, workspaceId));
  if (mode === "refused") return { ok: false, error: "A key that starts with sandbox_ runs the built-in simulator, which is only on the demo desk. Use the factor's real key.", code: "not_connected" };
  if (mode === "live") {
    // A batch to a real factor sells invoices: it needs the money-moving switch before the live transport is even asked.
    const gate = await assertMoneyMovingAllowed("factoring", mode, workspaceId);
    if (!gate.ok) return { ok: false, error: gate.error, code: "money_moving_off" };
    const answer = await liveBatchTransport.deliver({ method: "sftp", destination: "", batchNumber: "", files: [], attempt: 0 });
    return { ok: false, error: answer.ok ? "" : answer.error, code: "not_implemented" };
  }
  return { ok: true, transport: sandboxBatchTransport, provider: state.provider };
}

/** The next batch number for this fleet: FB-0001, FB-0002, ... */
async function nextNumber(tx: Prisma.TransactionClient, workspaceId: string): Promise<string> {
  const n = await tx.factoringBatch.count({ where: { workspaceId } });
  return `FB-${String(n + 1).padStart(4, "0")}`;
}

/** The files a batch carries: the schedule of accounts, then one packet per invoice. Built fresh from what is kept, so a retry sends what is on file now. */
async function filesFor(rows: ScheduleRow[], number: string, workspaceId: string): Promise<{ files: BatchFile[]; problems: Array<{ number: string; lacks: string }>; sizes: Map<string, number> }> {
  const files: BatchFile[] = [{ name: `${number}-schedule-of-accounts.csv`, mime: "text/csv", bytes: new TextEncoder().encode(scheduleCsv(rows)) }];
  const problems: Array<{ number: string; lacks: string }> = [];
  // Each invoice's packet size, by its invoice id: what decides how many fit an email.
  const sizes = new Map<string, number>();
  for (const r of rows) {
    const p = await buildPacket(r.loadIds![0]!, workspaceId);
    if (p.ok) {
      files.push({ name: p.filename, mime: "application/pdf", bytes: p.bytes });
      sizes.set(r.invoiceId!, p.bytes.length);
    } else problems.push({ number: r.number, lacks: p.error });
  }
  return { files, problems, sizes };
}

/**
 * Make a batch of the invoices that are ready and send it. `invoiceIds` narrows it to those invoices (still only the ready ones go). By email, invoices are taken in order until the
 * attachments would pass what a mailbox takes; the rest wait for the next batch (`leftOver`).
 */
export async function sendFactoringBatch(opts: { invoiceIds?: string[]; who?: string; terminal?: Terminals; /** Tests only: a smaller mailbox. */ emailLimitBytes?: number } = {}, now = new Date(), workspaceId = currentWorkspaceId()): Promise<BatchResult> {
  const terms = await getFactoringTerms(workspaceId);
  if (!terms || terms.transport !== "batch" || !terms.batchMethod || !terms.batchDestination) return { ok: false, code: "not_batch", error: "This fleet's factor takes invoices through its API. To send batches, choose SFTP or email in Settings, Factoring terms." };
  const t = await transportFor(workspaceId);
  if (!t.ok) return { ok: false, error: t.error, code: t.code };
  const method: BatchMethod = terms.batchMethod;

  const { rows: all } = await scheduleRows(workspaceId, opts.terminal ?? null, null);
  const asked = opts.invoiceIds ? new Set(opts.invoiceIds) : null;
  const { ready, held: heldRows } = splitReady(asked ? all.filter((r) => asked.has(r.invoiceId!)) : all);
  const held = heldRows.map((h) => ({ number: h.row.number, lacks: h.lacks.join(" and ") }));
  if (ready.length === 0) return { ok: false, code: "nothing_ready", error: held.length > 0 ? "No invoice is ready: each needs its rate confirmation and proof of delivery kept as files." : "No open invoice is waiting to go to the factor.", held };

  // The packets decide what fits: by email, invoices go in order until the attachments would pass a mailbox's limit.
  const probe = await filesFor(ready, "FB-PROBE", workspaceId);
  const failed = new Set(probe.problems.map((p) => p.number));
  const limit = opts.emailLimitBytes ?? EMAIL_BATCH_LIMIT_BYTES;
  let budget = probe.files[0]!.bytes.length;
  const going: ScheduleRow[] = [];
  let leftOver = 0;
  for (const r of ready) {
    if (failed.has(r.number)) continue;
    const size = probe.sizes.get(r.invoiceId!) ?? 0;
    if (method === "email" && going.length > 0 && budget + size > limit) {
      leftOver++;
      continue;
    }
    budget += size;
    going.push(r);
  }
  for (const p of probe.problems) held.push(p);
  if (going.length === 0) return { ok: false, code: "nothing_ready", error: "No invoice could be packed for the factor.", held };

  const total = going.reduce((s, r) => s.plus(r.amount), new Prisma.Decimal(0));
  let batchId = "";
  let number = "";
  try {
    await prisma.$transaction(async (tx) => {
      number = await nextNumber(tx, workspaceId);
      const b = await tx.factoringBatch.create({
        data: { workspaceId, number, status: "queued", method, destination: terms.batchDestination!, invoiceCount: going.length, total, createdBy: opts.who ?? null, invoices: { create: going.map((r) => ({ invoiceId: r.invoiceId! })) } },
        select: { id: true }
      });
      batchId = b.id;
      // Claimed with the batch, all or none: an invoice another person sent a moment ago stops the whole batch.
      for (const r of going) {
        const rec = await tx.invoice.updateMany({ where: { id: r.invoiceId!, workspaceId, status: "open", factoringStatus: { in: OPEN } }, data: { factoringStatus: "requested", factoringReferenceId: number, factoringUpdatedAt: now } });
        const loads = await tx.load.updateMany({ where: { id: { in: r.loadIds! }, workspaceId, factoringStatus: { in: OPEN } }, data: { factoringStatus: "requested", factoringReferenceId: number, factoringUpdatedAt: now } });
        if (rec.count !== 1 || loads.count !== r.loadIds!.length) throw new Taken(r.number);
      }
    });
  } catch (e) {
    if (e instanceof Taken) return { ok: false, error: `${e.number} was just sent to the factor by someone else. Reload and try again.` };
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return { ok: false, error: "Another batch was made at the same moment. Try again." };
    throw e;
  }
  const out = await deliverBatch(batchId, t.transport, now, workspaceId);
  return { ok: true, batchId, number, status: out.status, invoices: going.length, total: total.toNumber(), ...(out.error ? { error: out.error } : {}), held, leftOver };
}

class Taken extends Error {
  constructor(readonly number: string) {
    super("taken");
  }
}

/** Deliver a batch that is queued or failed: one more attempt. A delivery that goes through moves every invoice in it (and its loads) to "submitted". */
async function deliverBatch(batchId: string, transport: BatchTransport, now: Date, workspaceId: string): Promise<{ status: "sent" | "failed"; error?: string }> {
  const batch = await prisma.factoringBatch.findFirstOrThrow({ where: { id: batchId, workspaceId }, include: { invoices: true } });
  const { rows } = await scheduleRows(workspaceId, null, null, batch.invoices.map((i) => i.invoiceId));
  const { files, problems } = await filesFor(rows, batch.number, workspaceId);
  const attempt = batch.attempts + 1;
  const bytes = files.reduce((s, f) => s + f.bytes.length, 0);
  const answer =
    problems.length > 0
      ? { ok: false as const, error: `Could not pack ${problems.map((p) => p.number).join(", ")}: ${problems[0]!.lacks}`, retryable: true }
      : await transport.deliver({ method: batch.method as BatchMethod, destination: batch.destination, batchNumber: batch.number, files, attempt });
  const via = batch.method === "email" ? "email" : "SFTP";
  if (!answer.ok) {
    await prisma.$transaction(async (tx) => {
      await tx.factoringBatch.update({ where: { id: batchId }, data: { status: "failed", attempts: attempt, bytes, lastError: answer.error.slice(0, 300) } });
      await recordAudit({ entity: "invoice", action: "factoring_batch_failed", loadId: rows[0]?.loadIds?.[0] ?? null, loadNumber: null, summary: `${batch.number} (${rows.length} invoices) did not reach the factor by ${via}, try ${attempt}`, reason: answer.error.slice(0, 200), before: { Batch: "Queued" }, after: { Batch: "Failed", Tries: String(attempt) }, at: now, workspaceId }, tx);
    });
    return { status: "failed", error: answer.error };
  }
  await prisma.$transaction(async (tx) => {
    await tx.factoringBatch.update({ where: { id: batchId }, data: { status: "sent", attempts: attempt, bytes, lastError: null, receipt: answer.receipt.slice(0, 200), sentAt: now } });
    for (const r of rows) {
      await tx.invoice.update({ where: { id: r.invoiceId! }, data: { factoringStatus: "submitted", factoringReferenceId: batch.number, factoringUpdatedAt: now, noaAppliedAt: now } });
      await tx.load.updateMany({ where: { id: { in: r.loadIds! }, workspaceId }, data: { factoringStatus: "submitted", factoringReferenceId: batch.number, factoringUpdatedAt: now } });
      await recordAudit({ entity: "invoice", action: "factoring_requested", loadId: r.loadIds![0] ?? null, loadNumber: null, summary: `${r.number} sent to the factor in ${batch.number} by ${via}`, before: { Factoring: "Requested" }, after: { Factoring: "With the factor", Reference: batch.number }, at: now, workspaceId }, tx);
    }
    await recordAudit({ entity: "invoice", action: "factoring_batch_sent", loadId: rows[0]?.loadIds?.[0] ?? null, loadNumber: null, summary: `${batch.number}: ${rows.length} invoices, $${batch.total.toNumber().toFixed(2)}, sent by ${via} to ${batch.destination}`, before: { Batch: attempt > 1 ? "Failed" : "Queued" }, after: { Batch: "Sent", Tries: String(attempt), Receipt: answer.receipt.slice(0, 80) }, at: now, workspaceId }, tx);
  });
  return { status: "sent" };
}

export type RetryResult = { ok: true; status: "sent" | "failed"; error?: string } | { ok: false; error: string };

/** Try a failed batch again. Its invoices are still claimed by it, so nothing else can have sent them. */
export async function retryFactoringBatch(batchId: string, now = new Date(), workspaceId = currentWorkspaceId()): Promise<RetryResult> {
  const batch = await prisma.factoringBatch.findFirst({ where: { id: batchId, workspaceId } });
  if (!batch) return { ok: false, error: "That batch does not exist." };
  if (batch.status !== "failed") return { ok: false, error: batch.status === "sent" ? `${batch.number} has already gone to the factor.` : `${batch.number} cannot be sent again.` };
  const t = await transportFor(workspaceId);
  if (!t.ok) return { ok: false, error: t.error };
  // One attempt at a time: a second click while one is running finds the batch no longer "failed".
  const claimed = await prisma.factoringBatch.updateMany({ where: { id: batchId, status: "failed" }, data: { status: "queued" } });
  if (claimed.count !== 1) return { ok: false, error: "That batch is being sent right now. Reload in a moment." };
  const out = await deliverBatch(batchId, t.transport, now, workspaceId);
  return { ok: true, ...out };
}

/** Give a failed batch's invoices back (not with a factor), so they can go another way or in another batch. The batch is kept, cancelled, with its history. */
export async function cancelFactoringBatch(batchId: string, reason: string, now = new Date(), workspaceId = currentWorkspaceId()): Promise<{ ok: boolean; error?: string }> {
  const why = reason.trim();
  if (why.length < 3) return { ok: false, error: "Say why the batch is cancelled." };
  const batch = await prisma.factoringBatch.findFirst({ where: { id: batchId, workspaceId }, include: { invoices: { include: { invoice: { include: { loads: true } } } } } });
  if (!batch) return { ok: false, error: "That batch does not exist." };
  if (batch.status !== "failed") return { ok: false, error: batch.status === "sent" ? `${batch.number} has gone to the factor; what the factor does with it now comes from the factor.` : `${batch.number} cannot be cancelled now.` };
  const done = await prisma.$transaction(async (tx) => {
    const c = await tx.factoringBatch.updateMany({ where: { id: batchId, status: "failed" }, data: { status: "cancelled", lastError: why.slice(0, 300) } });
    if (c.count !== 1) return false;
    for (const bi of batch.invoices) {
      await tx.invoice.updateMany({ where: { id: bi.invoiceId, factoringStatus: "requested", factoringReferenceId: batch.number }, data: { factoringStatus: "none", factoringReferenceId: null, factoringUpdatedAt: now } });
      await tx.load.updateMany({ where: { id: { in: bi.invoice.loads.map((l) => l.loadId) }, workspaceId, factoringStatus: "requested", factoringReferenceId: batch.number }, data: { factoringStatus: "none", factoringReferenceId: null, factoringUpdatedAt: now } });
    }
    await recordAudit({ entity: "invoice", action: "factoring_batch_cancelled", loadId: batch.invoices[0]?.invoice.loads[0]?.loadId ?? null, loadNumber: null, summary: `${batch.number} cancelled; its ${batch.invoices.length} invoices are not with a factor`, reason: why, before: { Batch: "Failed" }, after: { Batch: "Cancelled" }, at: now, workspaceId }, tx);
    return true;
  });
  return done ? { ok: true } : { ok: false, error: "That batch changed while you were looking at it. Reload." };
}

/** The fleet's recent batches, newest first, for the Invoices screen. */
export async function listFactoringBatches(workspaceId = currentWorkspaceId(), take = 20) {
  const rows = await prisma.factoringBatch.findMany({ where: { workspaceId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take, include: { invoices: { include: { invoice: { select: { number: true } } } } } });
  return rows.map((b) => ({
    id: b.id,
    number: b.number,
    status: b.status as "queued" | "sent" | "failed" | "cancelled",
    method: b.method,
    destination: b.destination,
    invoiceCount: b.invoiceCount,
    invoiceNumbers: b.invoices.map((i) => i.invoice.number),
    total: b.total.toNumber(),
    bytes: b.bytes,
    attempts: b.attempts,
    lastError: b.lastError,
    receipt: b.receipt,
    sentAt: b.sentAt,
    createdAt: b.createdAt
  }));
}

export { SCHEDULE_CAP, providerName };
