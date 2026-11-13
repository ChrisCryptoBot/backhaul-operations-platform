import { terminalFilter, type Terminals } from "@/lib/scope";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { recordAudit } from "@/server/tl/audit";
import { num } from "@/server/tl/convert";
import { currentWorkspaceId } from "@/server/tl/workspace";
import { callPartner, partnerState, providerName } from "./call";
import { applyPayrollPaid, applyPayrollRejected } from "./events";
import { checkMoneyMoving } from "./gates";

/**
 * Payroll: a finalized driver statement can be sent to the payroll company once, when its driver is set up there (a worker type and the id payroll knows them by). Sending marks
 * the statement and records one audit event for the batch. Gross pay only, as the statement is: no taxes or deductions are worked out here.
 */
export const WORKER_TYPES = [
  { key: "employee", label: "Employee" },
  { key: "contractor", label: "Contractor" }
] as const;

export type PayrollRow = {
  id: string;
  number: string;
  driverId: string;
  driverName: string;
  periodStart: Date;
  periodEnd: Date;
  total: number;
  finalizedAt: Date | null;
  workerType: string | null;
  employeeId: string | null;
  sentAt: Date | null;
  reference: string | null;
  /** When the payroll company's run cleared, and how the statement was paid ("payroll" when its event said so). */
  paidAt: Date | null;
  paidMethod: string | null;
  /** When payroll refused it and why (the statement was released to be sent again). Cleared when it is sent again. */
  rejectedAt: Date | null;
  rejectReason: string | null;
  /** What keeps it from being sent now, in words, or null when it is ready. */
  notReady: string | null;
};

export const PAYROLL_PAGE = 50;
export const PAYROLL_MAX_BATCH = 200;

/** A claim on a statement while it is being sent. One that was never finished (the server stopped) is free again after this long. */
const CLAIM_MS = 10 * 60_000;
const CLAIM = "pending:";

const readiness = (d: { payrollWorkerType: string | null; payrollEmployeeId: string | null }, sentAt: Date | null, extra: { paidAt?: Date | null; total?: number } = {}): string | null =>
  sentAt
    ? "Already sent."
    : extra.paidAt
      ? "Already marked paid (by check or transfer), so sending it to payroll would pay the driver twice."
      : extra.total != null && extra.total <= 0
        ? "It comes to nothing or less: the driver owes money. Carry it as an adjustment on the next statement."
        : !d.payrollWorkerType
          ? "Set the driver's worker type."
          : !d.payrollEmployeeId
            ? "Add the driver's payroll id."
            : null;

/** Final statements, newest first, a page at a time, with whether each is ready to go. */
export async function listPayroll(opts: { page?: number; filter?: "ready" | "sent" | "all"; terminal?: Terminals; now?: Date } = {}, workspaceId = currentWorkspaceId()) {
  const page = Math.max(1, opts.page ?? 1);
  const now = opts.now ?? new Date();
  const stale = new Date(now.getTime() - CLAIM_MS);
  const terminalDriver = opts.terminal != null ? { terminal: terminalFilter(opts.terminal) } : {};
  const baseFinal = { workspaceId, status: "final" as const, ...(opts.terminal != null ? { driver: { terminal: terminalFilter(opts.terminal) } } : {}) };
  const unsentWhere = { OR: [{ payrollSentAt: null }, { payrollSentAt: { lt: stale }, payrollReference: { startsWith: CLAIM } }] };
  const sentWhere = { payrollSentAt: { not: null }, NOT: { payrollSentAt: { lt: stale }, payrollReference: { startsWith: CLAIM } } };
  const where = { ...baseFinal, ...(opts.filter === "sent" ? sentWhere : opts.filter === "ready" ? unsentWhere : {}) };
  // Ready is what could be sent now: the driver is set up there, nothing has been paid by hand, and the statement comes to something.
  const readyWhere = {
    workspaceId,
    status: "final" as const,
    paidAt: null,
    total: { gt: 0 },
    ...unsentWhere,
    driver: { payrollWorkerType: { not: null }, payrollEmployeeId: { not: null }, ...terminalDriver }
  };

  const [rows, total, sent, unsent, ready, readyRows, unscopedFinal, state] = await Promise.all([
    prisma.settlement.findMany({ where, include: { driver: true }, orderBy: [{ finalizedAt: "desc" }, { createdAt: "desc" }, { id: "asc" }], skip: (page - 1) * PAYROLL_PAGE, take: PAYROLL_PAGE }),
    prisma.settlement.count({ where }),
    prisma.settlement.count({ where: { ...baseFinal, ...sentWhere } }),
    prisma.settlement.count({ where: { ...baseFinal, ...unsentWhere } }),
    prisma.settlement.count({ where: readyWhere }),
    prisma.settlement.findMany({ where: readyWhere, orderBy: [{ finalizedAt: "desc" }, { createdAt: "desc" }, { id: "asc" }], take: PAYROLL_MAX_BATCH, select: { id: true } }),
    opts.terminal ? prisma.settlement.count({ where: { workspaceId, status: "final" } }) : Promise.resolve(0),
    partnerState("payroll", null, workspaceId)
  ]);
  const list: PayrollRow[] = rows.map((s) => {
    const unfinished = !!(s.payrollReference?.startsWith(CLAIM) && s.payrollSentAt != null && s.payrollSentAt.getTime() < stale.getTime());
    const effectiveSentAt = unfinished ? null : s.payrollSentAt;
    return {
      id: s.id,
      number: s.number,
      driverId: s.driverId,
      driverName: s.driver.name,
      periodStart: s.periodStart,
      periodEnd: s.periodEnd,
      total: num(s.total),
      finalizedAt: s.finalizedAt,
      workerType: s.driver.payrollWorkerType,
      employeeId: s.driver.payrollEmployeeId,
      sentAt: effectiveSentAt,
      reference: unfinished ? null : s.payrollReference,
      paidAt: s.paidAt,
      paidMethod: s.paidMethod,
      rejectedAt: s.payrollRejectedAt,
      rejectReason: s.payrollRejectReason,
      notReady: readiness(s.driver, effectiveSentAt, { paidAt: s.paidAt, total: num(s.total) })
    };
  });
  const hiddenByTerminal = opts.terminal ? Math.max(0, unscopedFinal - (sent + unsent)) : 0;
  return { rows: list, readyIds: readyRows.map((r) => r.id), hiddenByTerminal, total, page, pageSize: PAYROLL_PAGE, sent, unsent, ready, state };
}

export type SendResult = { ok: true; sent: number; reference: string } | { ok: false; error: string; code?: string };

export async function sendToPayroll(statementIds: string[], now = new Date(), workspaceId = currentWorkspaceId()): Promise<SendResult> {
  const ids = [...new Set(statementIds)];
  if (ids.length < 1 || ids.length > PAYROLL_MAX_BATCH) return { ok: false, error: `Pick one to ${PAYROLL_MAX_BATCH} statements.` };
  const statements = await prisma.settlement.findMany({ where: { id: { in: ids }, workspaceId, status: "final" }, include: { driver: true } });
  if (statements.length !== ids.length) return { ok: false, error: "A statement is not final or does not exist." };
  for (const s of statements) {
    // A claim that was never finished (the server stopped mid-send) does not count as sent once it is old.
    const unfinished = s.payrollReference?.startsWith(CLAIM) && s.payrollSentAt != null && s.payrollSentAt.getTime() < now.getTime() - CLAIM_MS;
    const why = readiness(s.driver, unfinished ? null : s.payrollSentAt, { paidAt: s.paidAt, total: num(s.total) });
    if (why) return { ok: false, error: `${s.number} (${s.driver.name}): ${why}` };
  }
  // A live send needs the money-moving switch (counsel's sign-off on the server and the fleet's own switch), checked before anything is claimed. The simulator passes.
  const gate = await checkMoneyMoving("payroll", workspaceId);
  if (!gate.ok) return { ok: false, error: gate.error, code: gate.code };
  // Claimed BEFORE the company is called, in one step that only succeeds for statements nobody else has claimed or sent: two clicks, or two tabs, cannot both send the same
  // statement, and a statement is never paid twice. If the call then fails, the claim is released so it can be sent again.
  const claimRef = `${CLAIM}${randomUUID()}`;
  const stale = new Date(now.getTime() - CLAIM_MS);
  const claimed = await prisma.settlement.updateMany({
    where: { id: { in: ids }, workspaceId, status: "final", paidAt: null, OR: [{ payrollSentAt: null }, { payrollSentAt: { lt: stale }, payrollReference: { startsWith: CLAIM } }] },
    data: { payrollSentAt: now, payrollReference: claimRef }
  });
  if (claimed.count !== ids.length) {
    // Some were taken by someone else in the meantime: give back the ones this call got, and say so.
    await prisma.settlement.updateMany({ where: { id: { in: ids }, workspaceId, payrollReference: claimRef }, data: { payrollSentAt: null, payrollReference: null } });
    return { ok: false, error: "A statement was just sent, or is being sent, by someone else. Reload the page." };
  }
  const release = () => prisma.settlement.updateMany({ where: { id: { in: ids }, workspaceId, payrollReference: claimRef }, data: { payrollSentAt: null, payrollReference: null } });
  let called;
  try {
    called = await callPartner(
      "payroll",
      null,
      {
        statements: statements.map((s) => ({
          id: s.id,
          idempotencyKey: `statement:${s.id}`,
          number: s.number,
          employeeId: s.driver.payrollEmployeeId,
          workerType: s.driver.payrollWorkerType,
          total: num(s.total),
          periodStart: s.periodStart.toISOString().slice(0, 10),
          periodEnd: s.periodEnd.toISOString().slice(0, 10)
        }))
      },
      workspaceId
    );
  } catch (e) {
    await release();
    throw e;
  }
  const { provider, result } = called;
  if (!result.ok) {
    await release();
    return { ok: false, error: result.message ?? "Payroll could not be reached.", code: result.code };
  }
  const { reference } = result.data;
  await prisma.$transaction(async (tx) => {
    // Sent again after a refusal: the refusal is history now (it stays in the audit log).
    await tx.settlement.updateMany({ where: { id: { in: ids }, workspaceId, payrollReference: claimRef }, data: { payrollReference: reference, payrollCheckedAt: null, payrollRejectedAt: null, payrollRejectReason: null } });
    await tx.driver.updateMany({ where: { id: { in: statements.map((s) => s.driverId) }, workspaceId }, data: { payrollStatus: "sent" } });
    const total = statements.reduce((sum, s) => sum.plus(new Prisma.Decimal(num(s.total))), new Prisma.Decimal(0)).toDecimalPlaces(2).toNumber();
    await recordAudit(
      {
        entity: "settlement",
        action: "payroll_sent",
        summary: `${ids.length} ${ids.length === 1 ? "statement" : "statements"} ($${total.toFixed(2)}) sent to ${providerName(provider)} (reference ${reference})`,
        before: null,
        after: { Statements: statements.map((s) => s.number).slice(0, 8).join(", ") + (ids.length > 8 ? `, and ${ids.length - 8} more` : ""), Reference: reference },
        at: now,
        workspaceId
      },
      tx
    );
  });
  return { ok: true, sent: ids.length, reference };
}

// ── The status poll (docs/MONEY_PLAN.md, Wave 4 step 5, gap 12) ─────────────────────────────────

/** A run is asked about once it has been with payroll this long without word of it clearing, and then at most this often. */
export const PAYROLL_POLL_AFTER_DAYS = 3;
export const PAYROLL_POLL_EVERY_HOURS = 12;
export const PAYROLL_POLL_MAX_RUNS = 50;

export type PayrollPollResult = { runs: number; paid: number; rejected: number; pending: number; failed: number; duplicate: number };

/**
 * One poll outcome, recorded the way a webhook event is (partner_events, one row per event id, so a repeat is a "duplicate" and does nothing) and applied through the same function the webhook
 * uses. The poll's event id is its own and stable for the run (and the statement, for a refusal), so asking twice is one event; a company's webhook for the same run arrives under the
 * company's id and finds nothing left to move.
 */
async function recordPolled(i: { workspaceId: string; provider: string; eventId: string; kind: "payroll.paid" | "payroll.rejected"; now: Date; apply: () => Promise<boolean> }): Promise<"applied" | "ignored" | "duplicate"> {
  const eventKey = `${i.workspaceId}:${i.eventId}`;
  try {
    await prisma.partnerEvent.create({ data: { workspaceId: i.workspaceId, provider: i.provider, eventId: eventKey, kind: i.kind, outcome: "ignored", detail: "Found by the payroll status check.", receivedAt: i.now } });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return "duplicate";
    throw e;
  }
  const applied = await i.apply();
  await prisma.partnerEvent.update({ where: { provider_eventId: { provider: i.provider, eventId: eventKey } }, data: { outcome: applied ? "applied" : "ignored", detail: applied ? "Found by the payroll status check." : "No sent statements on that run." } });
  return applied ? "applied" : "ignored";
}

/**
 * Ask payroll about every run that was sent, has not been heard of for PAYROLL_POLL_AFTER_DAYS, and is still unpaid: paid marks it paid (on the day it cleared), a refusal releases the statement
 * and says why, exactly as the webhook would. A run still pending writes nothing but the time it was asked (no audit, no event), so the poll can run every heartbeat and ask each run at most every
 * PAYROLL_POLL_EVERY_HOURS. A company that cannot be reached is asked again at that rhythm too, never hammered. Counts only.
 */
export async function pollPayrollStatus(opts: { now?: Date; workspaceId?: string; limit?: number } = {}): Promise<PayrollPollResult> {
  const now = opts.now ?? new Date();
  const out: PayrollPollResult = { runs: 0, paid: 0, rejected: 0, pending: 0, failed: 0, duplicate: 0 };
  const sentBefore = new Date(now.getTime() - PAYROLL_POLL_AFTER_DAYS * 86_400_000);
  const checkedBefore = new Date(now.getTime() - PAYROLL_POLL_EVERY_HOURS * 3_600_000);
  const due = await prisma.settlement.findMany({
    where: {
      ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}),
      status: "final",
      paidAt: null,
      payrollSentAt: { lt: sentBefore },
      AND: [{ payrollReference: { not: null } }, { NOT: { payrollReference: { startsWith: CLAIM } } }, { OR: [{ payrollCheckedAt: null }, { payrollCheckedAt: { lt: checkedBefore } }] }]
    },
    select: { id: true, workspaceId: true, payrollReference: true, payrollSentAt: true, driver: { select: { payrollEmployeeId: true } } },
    orderBy: [{ payrollSentAt: "asc" }, { id: "asc" }],
    take: 5000
  });
  const runs = new Map<string, typeof due>();
  for (const s of due) {
    const k = `${s.workspaceId}|${s.payrollReference}`;
    const list = runs.get(k) ?? [];
    list.push(s);
    runs.set(k, list);
  }
  for (const group of [...runs.values()].slice(0, opts.limit ?? PAYROLL_POLL_MAX_RUNS)) {
    const { workspaceId, payrollReference: reference } = group[0]!;
    if (!reference) continue;
    out.runs += 1;
    const ids = group.map((s) => s.id);
    const sentAt = group.reduce((m, s) => (s.payrollSentAt! < m ? s.payrollSentAt! : m), group[0]!.payrollSentAt!);
    let called;
    try {
      called = await callPartner("payroll", null, { op: "status", reference, sentAt: sentAt.toISOString(), asOf: now.toISOString(), statements: group.map((s) => ({ id: s.id, employeeId: s.driver.payrollEmployeeId })) }, workspaceId);
    } catch {
      called = null;
    }
    // Asked: whatever the answer, this run waits PAYROLL_POLL_EVERY_HOURS before it is asked again. A timestamp, not an event: "still pending" leaves no trail.
    await prisma.settlement.updateMany({ where: { id: { in: ids }, workspaceId, payrollReference: reference }, data: { payrollCheckedAt: now } });
    if (!called || !called.result.ok) {
      out.failed += 1;
      continue;
    }
    const { provider } = called;
    const answer = called.result.data;
    const payments = answer.payments ?? [];
    let moved = false;
    for (const p of payments.filter((x) => x.status === "rejected" && ids.includes(x.id))) {
      const r = await recordPolled({ workspaceId, provider, eventId: `poll:payroll.rejected:${reference}:${p.id}`, kind: "payroll.rejected", now, apply: () => applyPayrollRejected(reference, now, workspaceId, { statementIds: [p.id], reason: p.reason ?? null, via: "poll" }) });
      if (r === "applied") out.rejected += 1;
      else if (r === "duplicate") out.duplicate += 1;
      moved = true;
    }
    const paidIds = answer.state === "paid" ? ids.filter((id) => !payments.some((p) => p.id === id && p.status === "rejected")) : payments.filter((p) => p.status === "paid" && ids.includes(p.id)).map((p) => p.id);
    if (paidIds.length > 0) {
      const paidAt = answer.paidAt ? new Date(answer.paidAt) : null;
      const r = await recordPolled({ workspaceId, provider, eventId: `poll:payroll.paid:${reference}`, kind: "payroll.paid", now, apply: () => applyPayrollPaid(reference, now, workspaceId, { statementIds: paidIds, paidAt: paidAt && !Number.isNaN(paidAt.getTime()) ? paidAt : null, via: "poll" }) });
      if (r === "applied") out.paid += 1;
      else if (r === "duplicate") out.duplicate += 1;
      moved = true;
    }
    if (!moved) out.pending += 1;
  }
  return out;
}

export { partnerState };
