import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { driverSummaryFor, DispatchError, recordDriverResponse } from "@/server/tl/dispatch";
import { completeTrip, startTrip } from "@/server/tl/execution";
import { recordAudit } from "@/server/tl/audit";
import { currentWorkspaceId } from "@/server/tl/workspace";
import { num } from "@/server/tl/convert";
import { workspaceTimezone } from "@/server/tl/zone";
import { toCentralLocal } from "@/lib/zoned";
import { assertDriverSafe } from "@/server/tl/projector";
export { bridgeServerReady, driverMode, enqueueBridge, enqueueForLoad, type OutboxKind } from "./outbox";
import { BridgeTransportError, type BridgeTransport } from "./transport";
import { deliverDriverMessage } from "./messages";
export { enqueueMessage, pullDriverMessages, purgeDriverMessages, type MessagePullResult } from "./messages";
import { BRIDGE_ENV, FAILURE_TEXT, MAX_ATTEMPTS, closeDispatchRow, interpretRow, newDispatchRow, nextAttemptAt, parseDriverResponse, phoneCompletionValues, replacementFor, updateDispatchRow, wholeOf, type FailureWord } from "./core";

const failureOf = (e: unknown): FailureWord => {
  if (e instanceof BridgeTransportError) return e.code === "unreachable" ? "unreachable" : "rejected";
  if (e instanceof DispatchError) return e.code === "not_ready" ? "unsafe" : "rejected";
  return "rejected";
};

export type FlushResult = { delivered: number; failed: number; retrying: number; skipped: number };

/** How long a run holds the rows it claimed. Longer than one delivery takes; a run that dies frees them when it runs out. */
export const OUTBOX_LEASE_MS = 2 * 60_000;

/**
 * Deliver what is waiting, oldest first: rebuild the driver's summary from the load as it is now, check it once more for anything a driver must not see, and write it with a version-checked
 * update. A failure is kept as a word and tried again later (1, 5, 15, 60 minutes, then daily); after five the load says it was not delivered. Never throws for a delivery problem.
 * Rows are claimed with FOR UPDATE SKIP LOCKED and a short lease (G10, as webhook deliveries are), and an outcome is written only while this run still holds the lease, so two runs at once
 * (two cron ticks, a Retry pressed during one) never deliver the same row twice.
 */
export async function flushBridgeOutbox(transport: BridgeTransport, opts: { workspaceId?: string; now?: Date; limit?: number } = {}): Promise<FlushResult> {
  const workspaceId = opts.workspaceId ?? currentWorkspaceId();
  const now = opts.now ?? new Date();
  const ws = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { bridgeOrgId: true } });
  const out: FlushResult = { delivered: 0, failed: 0, retrying: 0, skipped: 0 };
  if (!ws?.bridgeOrgId) return out;
  const orgId = ws.bridgeOrgId;
  const lease = new Date(now.getTime() + OUTBOX_LEASE_MS);
  const claimed = await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
    UPDATE "bridge_outbox" o SET "lease_until" = ${lease}
    WHERE o."id" IN (
      SELECT x."id" FROM "bridge_outbox" x
      WHERE x."workspace_id" = ${workspaceId} AND x."status" = 'pending' AND x."next_attempt_at" <= ${now}
        AND (x."lease_until" IS NULL OR x."lease_until" < ${now})
      ORDER BY x."created_at", x."id"
      LIMIT ${opts.limit ?? 50}
      FOR UPDATE OF x SKIP LOCKED)
    RETURNING o."id"`);
  if (claimed.length === 0) return out;
  const due = await prisma.bridgeOutbox.findMany({ where: { id: { in: claimed.map((c) => c.id) } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  for (const item of due) {
    const held = { id: item.id, leaseUntil: lease };
    if (item.kind === "message") {
      // Phase 2 step 3: a desk message for the driver's phone. Same lease, same retry words; success stamps the desk message delivered.
      try {
        const sent = await deliverDriverMessage(transport, orgId, workspaceId, item);
        const wrote = await prisma.$transaction(async (tx) => {
          const w = await tx.bridgeOutbox.updateMany({ where: held, data: { status: "done", doneAt: now, lastError: null, leaseUntil: null } });
          if (w.count !== 1) return false;
          if (sent) await tx.message.updateMany({ where: { id: sent.messageId, deliveredAt: null }, data: { deliveredAt: now } });
          return true;
        });
        if (wrote) {
          if (sent) out.delivered += 1;
          else out.skipped += 1;
        }
      } catch (e) {
        const word = failureOf(e);
        const attempts = item.attempts + 1;
        const giveUp = attempts >= MAX_ATTEMPTS;
        const w = await prisma.bridgeOutbox.updateMany({ where: held, data: { attempts, status: giveUp ? "failed" : "pending", lastError: word, nextAttemptAt: nextAttemptAt(now, attempts), leaseUntil: null } });
        if (w.count === 1) {
          if (giveUp) out.failed += 1;
          else out.retrying += 1;
        }
      }
      continue;
    }
    const loadId = item.loadId;
    if (!loadId) {
      // A load kind without a load cannot be delivered; close it rather than retry forever.
      const w = await prisma.bridgeOutbox.updateMany({ where: held, data: { status: "failed", lastError: "rejected", leaseUntil: null } });
      if (w.count === 1) out.failed += 1;
      continue;
    }
    try {
      const done = await deliver(transport, orgId, workspaceId, { ...item, loadId }, now);
      if (!done) {
        const w = await prisma.bridgeOutbox.updateMany({ where: held, data: { status: "done", doneAt: now, lastError: null, leaseUntil: null } });
        if (w.count === 1) out.skipped += 1;
        continue;
      }
      const wrote = await prisma.$transaction(async (tx) => {
        const w = await tx.bridgeOutbox.updateMany({ where: held, data: { status: "done", doneAt: now, lastError: null, leaseUntil: null } });
        // The lease ran out and another run took the row: that run writes the outcome.
        if (w.count !== 1) return false;
        await tx.assignment.updateMany({ where: { loadId }, data: { bridgeDispatchId: done.rowId, bridgeSyncedAt: now, bridgeError: null } });
        return true;
      });
      if (wrote) out.delivered += 1;
    } catch (e) {
      const word = failureOf(e);
      const attempts = item.attempts + 1;
      const giveUp = attempts >= MAX_ATTEMPTS || word === "unsafe";
      const wrote = await prisma.$transaction(async (tx) => {
        const w = await tx.bridgeOutbox.updateMany({ where: held, data: { attempts, status: giveUp ? "failed" : "pending", lastError: word, nextAttemptAt: nextAttemptAt(now, attempts), leaseUntil: null } });
        if (w.count !== 1) return false;
        await tx.assignment.updateMany({ where: { loadId }, data: { bridgeError: giveUp ? word : null } });
        return true;
      });
      if (!wrote) continue;
      if (giveUp) out.failed += 1;
      else out.retrying += 1;
    }
  }
  return out;
}

/** Put one waiting item on the phone's table. Returns the bridge row id, or null when there is nothing left to send (the load or the assignment is gone). */
async function deliver(transport: BridgeTransport, orgId: string, workspaceId: string, item: { kind: string; loadId: string; phoneUserId: string; dispatchId: string | null }, now: Date): Promise<{ rowId: string } | null> {
  void now;
  const a = await prisma.assignment.findFirst({ where: { loadId: item.loadId, load: { workspaceId, deletedAt: null } }, select: { assignmentVersion: true, status: true, bridgeDispatchId: true, driver: { select: { phoneUserId: true } } } });
  if (item.kind === "reassign_old" || item.kind === "cancel") {
    const existing = await transport.findOpenRow(orgId, item.loadId, item.phoneUserId);
    if (!existing) return null;
    // G10: a reassigned row says which row replaced it, when the new driver's row is already there (otherwise the new row's insert fills it in).
    const replacedBy = item.kind === "reassign_old" ? replacementFor(existing, await transport.rowsForLoad(orgId, item.loadId)) : null;
    const closed = await transport.patch(existing.id, existing.assignment_version, closeDispatchRow(item.kind === "cancel" ? "cancelled" : "reassigned", existing.assignment_version + 1, replacedBy));
    if (!closed) throw new BridgeTransportError("rejected", "The driver link refused the request.");
    return { rowId: closed.id };
  }
  // dispatch or update: only while the driver on the desk is still the one this was queued for (a later reassign has its own item).
  if (!a || a.driver.phoneUserId !== item.phoneUserId || !["dispatched", "accepted", "in_progress"].includes(a.status)) return null;
  const summary = await driverSummaryFor(item.loadId, workspaceId);
  const load = await prisma.load.findFirst({ where: { id: item.loadId, workspaceId }, select: { quotedRevenue: true, actualRevenue: true, fuelSurcharge: true } });
  assertDriverSafe(summary, { numbers: [num(load?.quotedRevenue), num(load?.actualRevenue), num(load?.fuelSurcharge)] });
  const existing = await transport.findOpenRow(orgId, item.loadId, item.phoneUserId);
  if (!existing) {
    const row = await transport.insert(newDispatchRow({ orgId, phoneUserId: item.phoneUserId, loadId: item.loadId, summary, assignmentVersion: a.assignmentVersion }));
    await markReplaced(transport, orgId, item.loadId, row);
    return { rowId: row.id };
  }
  // A re-offer (the desk's version moved past the row's) clears the driver's answer so they answer again; a plain update leaves it.
  const reoffer = item.kind === "dispatch" && a.assignmentVersion > existing.assignment_version;
  const patched = await transport.patch(existing.id, existing.assignment_version, updateDispatchRow({ summary, assignmentVersion: Math.max(a.assignmentVersion, existing.assignment_version + 1), reoffer }));
  if (!patched) {
    // The row moved under us (another dispatcher): read it again once and try on the fresh version.
    const fresh = await transport.findOpenRow(orgId, item.loadId, item.phoneUserId);
    if (!fresh) throw new BridgeTransportError("rejected", "The driver link refused the request.");
    const second = await transport.patch(fresh.id, fresh.assignment_version, updateDispatchRow({ summary, assignmentVersion: fresh.assignment_version + 1, reoffer }));
    if (!second) throw new BridgeTransportError("rejected", "The driver link refused the request.");
    return { rowId: second.id };
  }
  return { rowId: patched.id };
}

/**
 * G10: a row closed as reassigned before the new driver's row existed gets the new row's id now (replaced_by_dispatch_id). Best effort and version-checked: a row someone else moved is left
 * as it is, and a failure never fails the delivery it follows.
 */
async function markReplaced(transport: BridgeTransport, orgId: string, loadId: string, row: { id: string; assigned_driver_id: string }): Promise<void> {
  try {
    const rows = await transport.rowsForLoad(orgId, loadId);
    for (const r of rows) {
      if (r.status !== "reassigned" || r.replaced_by_dispatch_id || r.assigned_driver_id === row.assigned_driver_id) continue;
      await transport.patch(r.id, r.assignment_version, { replaced_by_dispatch_id: row.id, updated_by: "desk" });
    }
  } catch {
    /* the closed row stays without its pointer; nothing the phone relies on */
  }
}

export type PullResult = { read: number; applied: number; flagged: number; ignored: number; cursor: number };

const ACTOR = "Driver's phone";

/**
 * Read what the phones have written since the last pull and apply it to the desk in order. At least once and idempotent: a row already applied (its execution version is not above the one
 * the desk has) is skipped, and the cursor moves only after the whole batch is through. A row the desk cannot apply is recorded as an alert, never forced.
 */
export async function pullBridgeResponses(transport: BridgeTransport, opts: { workspaceId?: string; now?: Date; limit?: number } = {}): Promise<PullResult> {
  const workspaceId = opts.workspaceId ?? currentWorkspaceId();
  const now = opts.now ?? new Date();
  const ws = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { bridgeOrgId: true, bridgeCursor: true } });
  const res: PullResult = { read: 0, applied: 0, flagged: 0, ignored: 0, cursor: wholeOf(ws?.bridgeCursor) };
  if (!ws?.bridgeOrgId) return res;
  const orgId = ws.bridgeOrgId;
  // A time the phone reports is placed on the carrier's own clock when it is put into the desk's trip form.
  const tz = await workspaceTimezone(workspaceId);
  const rows = await transport.changedSince(orgId, wholeOf(ws.bridgeCursor), opts.limit ?? 200);
  res.read = rows.length;
  for (const row of rows) {
    const a = row.source_load_id
      ? await prisma.assignment.findFirst({ where: { loadId: row.source_load_id, load: { workspaceId, deletedAt: null } }, include: { driver: { select: { name: true, phoneUserId: true } }, load: { select: { id: true, loadNumber: true } } } })
      : null;
    if (!a || row.kind !== "dispatch") {
      res.ignored += 1;
      continue;
    }
    const it = interpretRow({ row, orgId, phoneUserId: a.driver.phoneUserId, deskStatus: a.status, seenExecutionVersion: a.bridgeExecutionVersion });
    if (it.kind === "ignore") {
      res.ignored += 1;
      continue;
    }
    if (it.kind === "flag") {
      await prisma.$transaction(async (tx) => {
        await tx.assignment.update({ where: { loadId: a.loadId }, data: { bridgeExecutionVersion: row.execution_version } });
        await recordAudit({ entity: "assignment", action: "driver_link_flag", loadId: a.load.id, loadNumber: a.load.loadNumber, summary: it.why, at: now, workspaceId, actor: ACTOR }, tx);
      });
      res.flagged += 1;
      continue;
    }
    const answer = parseDriverResponse(row.driver_response, orgId)!;
    let stopped: string | null = null;
    for (const step of it.steps) {
      if (step === "accepted" || step === "declined") {
        await recordDriverResponse(a.loadId, step, now, step === "declined" ? (answer.declinedReason ?? undefined) : undefined, workspaceId, "phone");
      } else if (step === "in_progress") {
        const r = await startTrip(a.loadId, { arrivedAt: toCentralLocal(Date.parse(answer.startedAt ?? now.toISOString()), tz), waitMinutes: "", seal: "" }, now, workspaceId);
        if (!r.ok) {
          stopped = `The phone says the driver picked up, but the desk could not record the pickup: ${r.error ?? "the pickup needs its details"}. Enter it on the load.`;
          break;
        }
      } else {
        // G10: delivered on the phone is applied: the delivery time on the carrier's clock, proof received when the phone filed proof inside the fleet's or the driver's folder, and what
        // the phone reported in the note. Costs and stop times stay for the desk (the phone does not send them); a delivery the desk's rules refuse is shown, not forced.
        const deliveredLocal = toCentralLocal(Date.parse(answer.completedAt ?? now.toISOString()), tz);
        const r = await completeTrip(a.loadId, phoneCompletionValues(answer, deliveredLocal), now, workspaceId);
        if (!r.ok) {
          const why = r.error ?? Object.values(r.errors ?? {})[0] ?? "the delivery needs its details";
          stopped = `The phone says the driver delivered${answer.actualMiles != null ? ` (${answer.actualMiles} mi driven)` : ""}${answer.podRefs.length > 0 ? ` and filed ${answer.podRefs.length} proof of delivery` : ""}, but the desk could not record it: ${why}. Enter the delivery on the load.`;
          break;
        }
      }
    }
    await prisma.$transaction(async (tx) => {
      await tx.assignment.update({ where: { loadId: a.loadId }, data: { bridgeExecutionVersion: row.execution_version } });
      if (stopped) await recordAudit({ entity: "assignment", action: "driver_link_flag", loadId: a.load.id, loadNumber: a.load.loadNumber, summary: stopped, at: now, workspaceId, actor: ACTOR }, tx);
    });
    if (stopped) res.flagged += 1;
    else res.applied += 1;
  }
  const was = wholeOf(ws.bridgeCursor);
  const last = rows.length > 0 ? Math.max(...rows.map((r) => wholeOf(r.sync_seq))) : was;
  if (last > was) await prisma.workspace.update({ where: { id: workspaceId }, data: { bridgeCursor: BigInt(last) } });
  res.cursor = last;
  return res;
}

export { BRIDGE_ENV, FAILURE_TEXT };
