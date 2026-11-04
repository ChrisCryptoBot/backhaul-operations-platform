import { prisma } from "@/lib/db";
import { termsLabel } from "@/lib/invoicing";
import { validateBillingDetails, type BillingDetailsValues } from "@/lib/billing-details";
import { recordAudit } from "./audit";
import { findTwinLoad, duplicateMessage } from "./twins";
import { currentWorkspaceId } from "./workspace";

/**
 * The billing office's edit of a load: the customer and how to reach them, the PO, the terms and the revenue note, and nothing else (no stops, no driver, no rate: those are the
 * dispatcher's, in saveLoadDetails). Once the load is invoiced, the customer, the PO and the terms are what the invoice carries and stay as billed; the contact and the note can still
 * be corrected. Written only if the load is still as it was read. One transaction with its audit event.
 */
export type BillingResult = { ok: true; changed: boolean } | { ok: false; error?: string; errors?: Record<string, string> };

export async function saveBillingDetails(loadId: string, values: BillingDetailsValues, now = new Date(), workspaceId = currentWorkspaceId()): Promise<BillingResult> {
  const check = validateBillingDetails(values);
  if (!check.ok) return { ok: false, errors: check.errors };
  const v = check.value;
  const load = await prisma.load.findFirst({ where: { id: loadId, workspaceId, deletedAt: null, status: { not: "quote" } } });
  if (!load) return { ok: false, error: "That load does not exist." };
  if (load.paymentStatus) {
    const held: string[] = [];
    if (v.brokerName !== (load.brokerName ?? "")) held.push("customer");
    if ((v.poNumber ?? null) !== (load.poNumber ?? null)) held.push("PO number");
    if ((v.payTermsDays ?? null) !== (load.payTermsDays ?? null)) held.push("pay terms");
    if (held.length > 0) return { ok: false, error: `This load has been invoiced, so its ${held.join(", ")} ${held.length === 1 ? "is" : "are"} what the invoice carries. Take the invoice back first to change ${held.length === 1 ? "it" : "them"}.` };
  }
  if (v.brokerName !== (load.brokerName ?? "") && load.loadNumber) {
    const twin = await findTwinLoad(workspaceId, load.loadNumber, v.brokerName, load.id);
    if (twin) return { ok: false, errors: { brokerName: `${duplicateMessage(twin)} Use another customer or number.` } };
  }
  const changes: Array<[string, string | null, string | null]> = [];
  const note = (label: string, was: string | number | null | undefined, next: string | number | null) => {
    const a = was == null || was === "" ? null : String(was);
    const b = next == null || next === "" ? null : String(next);
    if (a !== b) changes.push([label, a, b]);
  };
  note("Customer", load.brokerName, v.brokerName);
  note("MC", load.brokerMcNumber, v.brokerMcNumber);
  note("Phone", load.brokerPhone, v.brokerPhone);
  note("Email", load.brokerEmail, v.brokerEmail);
  note("PO", load.poNumber, v.poNumber);
  note("Terms", load.payTermsDays == null ? null : termsLabel(load.payTermsDays), v.payTermsDays == null ? null : termsLabel(v.payTermsDays));
  note("Revenue note", load.revenueNote, v.revenueNote);
  if (changes.length === 0) return { ok: true, changed: false };
  const done = await prisma.$transaction(async (tx) => {
    const out = await tx.load.updateMany({
      where: { id: load.id, workspaceId, deletedAt: null, updatedAt: load.updatedAt, paymentStatus: load.paymentStatus },
      data: { brokerName: v.brokerName, brokerMcNumber: v.brokerMcNumber, brokerPhone: v.brokerPhone, brokerEmail: v.brokerEmail, poNumber: v.poNumber, payTermsDays: v.payTermsDays, revenueNote: v.revenueNote }
    });
    if (out.count !== 1) return false;
    await recordAudit(
      {
        entity: "load",
        action: "load_edited",
        loadId: load.id,
        loadNumber: load.loadNumber,
        summary: `Billing details changed: ${changes.map(([l]) => l.toLowerCase()).join(", ")}`,
        before: Object.fromEntries(changes.map(([l, a]) => [l, a])),
        after: Object.fromEntries(changes.map(([l, , b]) => [l, b])),
        at: now, workspaceId
      },
      tx
    );
    return true;
  });
  if (!done) return { ok: false, error: "This load was just changed by someone else. Reload it and try again." };
  return { ok: true, changed: true };
}
