import { prisma } from "@/lib/db";
import { recordAudit } from "@/server/tl/audit";

/**
 * What a company's event does once the receiver has believed it (webhook.ts). Each is the same move a person's hand would make, guarded the same way, and returns whether anything moved, so a
 * repeat or an event for nothing we know is "ignored" and never an error.
 */

/** A pay run cleared: the statements sent on that run are paid, once. A statement already paid, voided or not on that run is left alone. */
export async function applyPayrollPaid(reference: string | null, now: Date, workspaceId: string): Promise<boolean> {
  if (!reference) return false;
  const rows = await prisma.settlement.findMany({ where: { workspaceId, status: "final", payrollReference: reference, paidAt: null }, select: { id: true, number: true } });
  if (rows.length === 0) return false;
  return prisma.$transaction(async (tx) => {
    const out = await tx.settlement.updateMany({ where: { id: { in: rows.map((r) => r.id) }, workspaceId, status: "final", paidAt: null }, data: { paidAt: now, paidMethod: "payroll" } });
    if (out.count === 0) return false;
    await recordAudit({ entity: "settlement", action: "partner_event", summary: `${out.count} ${out.count === 1 ? "statement" : "statements"} paid by payroll (run ${reference}): ${rows.map((r) => r.number).slice(0, 6).join(", ")}${rows.length > 6 ? ", and more" : ""}`, at: now, workspaceId }, tx);
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
