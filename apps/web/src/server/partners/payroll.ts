import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { recordAudit } from "@/server/tl/audit";
import { num } from "@/server/tl/convert";
import { currentWorkspaceId } from "@/server/tl/workspace";
import { callPartner, partnerState, providerName } from "./call";

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
export async function listPayroll(opts: { page?: number; filter?: "ready" | "sent" | "all"; terminal?: string | null; now?: Date } = {}, workspaceId = currentWorkspaceId()) {
  const page = Math.max(1, opts.page ?? 1);
  const now = opts.now ?? new Date();
  const stale = new Date(now.getTime() - CLAIM_MS);
  const terminalDriver = opts.terminal ? { terminal: opts.terminal } : {};
  const baseFinal = { workspaceId, status: "final" as const, ...(opts.terminal ? { driver: { terminal: opts.terminal } } : {}) };
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
    await tx.settlement.updateMany({ where: { id: { in: ids }, workspaceId, payrollReference: claimRef }, data: { payrollReference: reference } });
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

export { partnerState };
