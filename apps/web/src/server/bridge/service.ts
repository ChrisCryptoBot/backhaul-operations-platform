import { prisma } from "@/lib/db";
import { driverSummaryFor, DispatchError, recordDriverResponse } from "@/server/tl/dispatch";
import { startTrip } from "@/server/tl/execution";
import { recordAudit } from "@/server/tl/audit";
import { currentWorkspaceId } from "@/server/tl/workspace";
import { num } from "@/server/tl/convert";
import { assertDriverSafe } from "@/server/tl/projector";
export { bridgeServerReady, driverMode, enqueueBridge, enqueueForLoad, type OutboxKind } from "./outbox";
import { BridgeTransportError, type BridgeTransport } from "./transport";
import { BRIDGE_ENV, FAILURE_TEXT, MAX_ATTEMPTS, closeDispatchRow, interpretRow, newDispatchRow, nextAttemptAt, parseDriverResponse, updateDispatchRow, wholeOf, type FailureWord } from "./core";

const failureOf = (e: unknown): FailureWord => {
  if (e instanceof BridgeTransportError) return e.code === "unreachable" ? "unreachable" : "rejected";
  if (e instanceof DispatchError) return e.code === "not_ready" ? "unsafe" : "rejected";
  return "rejected";
};

export type FlushResult = { delivered: number; failed: number; retrying: number; skipped: number };

/**
 * Deliver what is waiting, oldest first: rebuild the driver's summary from the load as it is now, check it once more for anything a driver must not see, and write it with a version-checked
 * update. A failure is kept as a word and tried again later (1, 5, 15, 60 minutes, then daily); after five the load says it was not delivered. Never throws for a delivery problem.
 */
export async function flushBridgeOutbox(transport: BridgeTransport, opts: { workspaceId?: string; now?: Date; limit?: number } = {}): Promise<FlushResult> {
  const workspaceId = opts.workspaceId ?? currentWorkspaceId();
  const now = opts.now ?? new Date();
  const ws = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { bridgeOrgId: true } });
  const out: FlushResult = { delivered: 0, failed: 0, retrying: 0, skipped: 0 };
  if (!ws?.bridgeOrgId) return out;
  const orgId = ws.bridgeOrgId;
  const due = await prisma.bridgeOutbox.findMany({ where: { workspaceId, status: "pending", nextAttemptAt: { lte: now } }, orderBy: { createdAt: "asc" }, take: opts.limit ?? 50 });
  for (const item of due) {
    try {
      const done = await deliver(transport, orgId, workspaceId, item, now);
      if (!done) {
        out.skipped += 1;
        await prisma.bridgeOutbox.update({ where: { id: item.id }, data: { status: "done", doneAt: now, lastError: null } });
        continue;
      }
      await prisma.$transaction([
        prisma.bridgeOutbox.update({ where: { id: item.id }, data: { status: "done", doneAt: now, lastError: null } }),
        prisma.assignment.updateMany({ where: { loadId: item.loadId }, data: { bridgeDispatchId: done.rowId, bridgeSyncedAt: now, bridgeError: null } })
      ]);
      out.delivered += 1;
    } catch (e) {
      const word = failureOf(e);
      const attempts = item.attempts + 1;
      const giveUp = attempts >= MAX_ATTEMPTS || word === "unsafe";
      await prisma.$transaction([
        prisma.bridgeOutbox.update({ where: { id: item.id }, data: { attempts, status: giveUp ? "failed" : "pending", lastError: word, nextAttemptAt: nextAttemptAt(now, attempts) } }),
        prisma.assignment.updateMany({ where: { loadId: item.loadId }, data: { bridgeError: giveUp ? word : null } })
      ]);
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
    const closed = await transport.patch(existing.id, existing.assignment_version, closeDispatchRow(item.kind === "cancel" ? "cancelled" : "reassigned", existing.assignment_version + 1, null));
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
        await recordDriverResponse(a.loadId, step, now, step === "declined" ? (answer.declinedReason ?? undefined) : undefined, workspaceId);
      } else if (step === "in_progress") {
        const r = await startTrip(a.loadId, { arrivedAt: toLocalInput(answer.startedAt ?? now.toISOString()), waitMinutes: "", seal: "" }, now, workspaceId);
        if (!r.ok) {
          stopped = `The phone says the driver picked up, but the desk could not record the pickup: ${r.error ?? "the pickup needs its details"}. Enter it on the load.`;
          break;
        }
      } else {
        // Delivery needs the stops' times, the proof and the costs the desk checks; the phone's answer is shown, not forced into a completed load.
        stopped = `The phone says the driver delivered${answer.actualMiles != null ? ` (${answer.actualMiles} mi driven)` : ""}${answer.podRefs.length > 0 ? ` and filed ${answer.podRefs.length} proof of delivery` : ""}. Enter the delivery on the load.`;
        break;
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

/** An ISO time as the desk's trip form takes it: the Central wall clock, "YYYY-MM-DDTHH:mm". */
function toLocalInput(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(iso));
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

export { BRIDGE_ENV, FAILURE_TEXT };
