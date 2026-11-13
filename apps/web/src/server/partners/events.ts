import { prisma } from "@/lib/db";
import { recordAudit } from "@/server/tl/audit";

/**
 * What a company's event does once the receiver has believed it (webhook.ts). Each is the same move a person's hand would make, guarded the same way, and returns whether anything moved, so a
 * repeat or an event for nothing we know is "ignored" and never an error.
 */

/**
 * Payroll's outcomes for a run, the same whether the company's webhook said it or the status poll found it (Wave 4 step 5): each moves only statements still on that run and unpaid, from the
 * state they were read in, so a second telling (a webhook right after a poll, a poll after a webhook, a repeat) moves nothing and writes nothing. `via` only changes the words in the audit.
 */
export type PayrollVia = "webhook" | "poll";
const viaText = (via: PayrollVia) => (via === "poll" ? " (found by the payroll status check)" : "");

/** A pay run cleared: the statements sent on that run (or the named ones on it) are paid, once, on the day it cleared when the company said, else now. A statement already paid, voided or not on that run is left alone. */
export async function applyPayrollPaid(reference: string | null, now: Date, workspaceId: string, opts: { statementIds?: string[]; paidAt?: Date | null; via?: PayrollVia } = {}): Promise<boolean> {
  if (!reference) return false;
  const only = opts.statementIds ? { id: { in: opts.statementIds } } : {};
  const rows = await prisma.settlement.findMany({ where: { workspaceId, status: "final", payrollReference: reference, paidAt: null, ...only }, select: { id: true, number: true } });
  if (rows.length === 0) return false;
  const paidAt = opts.paidAt && opts.paidAt.getTime() <= now.getTime() ? opts.paidAt : now;
  return prisma.$transaction(async (tx) => {
    const out = await tx.settlement.updateMany({ where: { id: { in: rows.map((r) => r.id) }, workspaceId, status: "final", payrollReference: reference, paidAt: null }, data: { paidAt, paidMethod: "payroll" } });
    if (out.count === 0) return false;
    await recordAudit({ entity: "settlement", action: "partner_event", summary: `${out.count} ${out.count === 1 ? "statement" : "statements"} paid by payroll (run ${reference})${viaText(opts.via ?? "webhook")}: ${rows.map((r) => r.number).slice(0, 6).join(", ")}${rows.length > 6 ? ", and more" : ""}`, at: now, workspaceId }, tx);
    return true;
  });
}

/**
 * Payroll refused a payment on a run: the statements named (all on the run when none are) are released, no longer sent and without the run's reference, so a person fixes what was wrong and
 * sends them again, and they say why until then. Their drivers' payroll setup reads failed. Only statements still on that run and unpaid move, once.
 */
export async function applyPayrollRejected(reference: string | null, now: Date, workspaceId: string, opts: { statementIds?: string[] | null; reason?: string | null; via?: PayrollVia } = {}): Promise<boolean> {
  if (!reference) return false;
  const only = opts.statementIds && opts.statementIds.length > 0 ? { id: { in: opts.statementIds } } : {};
  const rows = await prisma.settlement.findMany({ where: { workspaceId, status: "final", payrollReference: reference, paidAt: null, ...only }, select: { id: true, number: true, driverId: true } });
  if (rows.length === 0) return false;
  const reason = (opts.reason ?? "").trim().slice(0, 200) || "Payroll did not say why.";
  return prisma.$transaction(async (tx) => {
    const out = await tx.settlement.updateMany({ where: { id: { in: rows.map((r) => r.id) }, workspaceId, status: "final", payrollReference: reference, paidAt: null }, data: { payrollSentAt: null, payrollReference: null, payrollRejectedAt: now, payrollRejectReason: reason } });
    if (out.count === 0) return false;
    await tx.driver.updateMany({ where: { id: { in: [...new Set(rows.map((r) => r.driverId))] }, workspaceId }, data: { payrollStatus: "failed" } });
    await recordAudit({ entity: "settlement", action: "partner_event", summary: `${out.count} ${out.count === 1 ? "statement" : "statements"} rejected by payroll (run ${reference})${viaText(opts.via ?? "webhook")}: ${reason} ${rows.map((r) => r.number).slice(0, 6).join(", ")}${rows.length > 6 ? ", and more" : ""} can be sent again once fixed.`, at: now, workspaceId }, tx);
    return true;
  });
}

/** A truck crossed a stop's geofence on a load that is still open: said in the load's own trail, so the dispatcher sees it. It changes no stop, arrival or detention: those stay what a person or the driver's phone entered. */
export async function applyTrackingMilestone(i: { reference: string | null; stop: number | null; kind: "tracking.arrived" | "tracking.departed" }, now: Date, workspaceId: string): Promise<boolean> {
  if (!i.reference) return false;
  const load = await prisma.load.findFirst({ where: { workspaceId, deletedAt: null, loadNumber: i.reference, status: { in: ["draft", "accepted", "in_progress"] } }, select: { id: true, loadNumber: true } });
  if (!load) return false;
  await recordAudit({ entity: "load", action: "partner_event", loadId: load.id, loadNumber: load.loadNumber, summary: `Tracking: ${i.kind === "tracking.arrived" ? "arrived at" : "left"} ${i.stop != null ? `stop ${i.stop}` : "a stop"} (geofence)`, at: now, workspaceId });
  return true;
}
