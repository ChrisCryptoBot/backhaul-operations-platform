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
  /** What keeps it from being sent now, in words, or null when it is ready. */
  notReady: string | null;
};

export const PAYROLL_PAGE = 50;

const readiness = (d: { payrollWorkerType: string | null; payrollEmployeeId: string | null }, sentAt: Date | null): string | null =>
  sentAt ? "Already sent." : !d.payrollWorkerType ? "Set the driver's worker type." : !d.payrollEmployeeId ? "Add the driver's payroll id." : null;

/** Final statements, newest first, a page at a time, with whether each is ready to go. */
export async function listPayroll(opts: { page?: number; filter?: "ready" | "sent" | "all" } = {}, workspaceId = currentWorkspaceId()) {
  const page = Math.max(1, opts.page ?? 1);
  const where = { workspaceId, status: "final", ...(opts.filter === "sent" ? { payrollSentAt: { not: null } } : opts.filter === "ready" ? { payrollSentAt: null } : {}) };
  const [rows, total, sent, unsent, state] = await Promise.all([
    prisma.settlement.findMany({ where, include: { driver: true }, orderBy: [{ finalizedAt: "desc" }, { createdAt: "desc" }], skip: (page - 1) * PAYROLL_PAGE, take: PAYROLL_PAGE }),
    prisma.settlement.count({ where }),
    prisma.settlement.count({ where: { workspaceId, status: "final", payrollSentAt: { not: null } } }),
    prisma.settlement.count({ where: { workspaceId, status: "final", payrollSentAt: null } }),
    partnerState("payroll", null, workspaceId)
  ]);
  const list: PayrollRow[] = rows.map((s) => ({
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
    sentAt: s.payrollSentAt,
    reference: s.payrollReference,
    notReady: readiness(s.driver, s.payrollSentAt)
  }));
  return { rows: list, total, page, pageSize: PAYROLL_PAGE, sent, unsent, state };
}

export type SendResult = { ok: true; sent: number; reference: string } | { ok: false; error: string; code?: string };

export async function sendToPayroll(statementIds: string[], now = new Date(), workspaceId = currentWorkspaceId()): Promise<SendResult> {
  const ids = [...new Set(statementIds)];
  if (ids.length < 1 || ids.length > 200) return { ok: false, error: "Pick one to 200 statements." };
  const statements = await prisma.settlement.findMany({ where: { id: { in: ids }, workspaceId, status: "final" }, include: { driver: true } });
  if (statements.length !== ids.length) return { ok: false, error: "A statement is not final or does not exist." };
  for (const s of statements) {
    const why = readiness(s.driver, s.payrollSentAt);
    if (why) return { ok: false, error: `${s.number} (${s.driver.name}): ${why}` };
  }
  const { provider, result } = await callPartner(
    "payroll",
    null,
    { statements: statements.map((s) => ({ id: s.id, number: s.number, employeeId: s.driver.payrollEmployeeId, workerType: s.driver.payrollWorkerType, total: num(s.total), periodStart: s.periodStart.toISOString().slice(0, 10), periodEnd: s.periodEnd.toISOString().slice(0, 10) })) },
    workspaceId
  );
  if (!result.ok) return { ok: false, error: result.message ?? "Payroll could not be reached.", code: result.code };
  const { reference } = result.data;
  await prisma.$transaction(async (tx) => {
    await tx.settlement.updateMany({ where: { id: { in: ids }, workspaceId }, data: { payrollSentAt: now, payrollReference: reference } });
    await tx.driver.updateMany({ where: { id: { in: statements.map((s) => s.driverId) }, workspaceId }, data: { payrollStatus: "sent" } });
    const total = statements.reduce((sum, s) => sum + num(s.total) * 100, 0) / 100;
    await recordAudit(
      { entity: "settlement", action: "payroll_sent", summary: `${ids.length} ${ids.length === 1 ? "statement" : "statements"} ($${total.toFixed(2)}) sent to ${providerName(provider)} (reference ${reference})`, before: null, after: { Statements: statements.map((s) => s.number).slice(0, 8).join(", ") + (ids.length > 8 ? `, and ${ids.length - 8} more` : ""), Reference: reference }, at: now, workspaceId },
      tx
    );
  });
  return { ok: true, sent: ids.length, reference };
}

export { partnerState };
