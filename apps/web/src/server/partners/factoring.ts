import { prisma } from "@/lib/db";
import { FACTORING_PACKET, PACKET_LABEL, packetGaps, type PacketKind } from "@/truelane/partners/contract";
import { recordAudit } from "@/server/tl/audit";
import { documentKinds } from "@/server/tl/documents";
import { num } from "@/server/tl/convert";
import { currentWorkspaceId } from "@/server/tl/workspace";
import { callPartner, partnerState, providerName } from "./call";

/**
 * Factoring: an invoice that is out can be sent to a factor with its packet. The invoice is always required; the rate confirmation and the proof of delivery help the factor
 * and are skipped only by choice ("Send anyway"). What the factor answers moves `factoringStatus` and the reference on the load. Nothing is sent unless the provider's keys are
 * set and the fleet has connected it; until a company is chosen that is never, and the screen says why.
 */
export type PacketLine = { kind: PacketKind; label: string; required: boolean; present: boolean };
export type FactoringView = {
  loadId: string;
  status: string;
  referenceId: string | null;
  updatedAt: Date | null;
  manifest: PacketLine[];
  missingRequired: PacketKind[];
  missingOptional: PacketKind[];
  provider: string;
  /** Why it cannot be sent now, in words, or null when it can. */
  blocked: string | null;
};

const FACTORING_STATE: Record<string, string> = { none: "Not factored", requested: "Requested", submitted: "With the factor", funded: "Funded", rejected: "Rejected", paid: "Paid by the customer" };
export const factoringLabel = (s: string) => FACTORING_STATE[s] ?? s;

const SENDABLE_STATES = ["none", "rejected"];
/** A request that was claimed but never finished (the server stopped before the factor answered) can be sent again after this long. */
const CLAIM_MS = 10 * 60_000;
const isSendable = (l: { factoringStatus: string; factoringReferenceId: string | null; factoringUpdatedAt: Date | null }, now: Date) =>
  SENDABLE_STATES.includes(l.factoringStatus) || (l.factoringStatus === "requested" && l.factoringReferenceId == null && l.factoringUpdatedAt != null && l.factoringUpdatedAt.getTime() < now.getTime() - CLAIM_MS);

export async function getFactoringView(loadId: string, workspaceId = currentWorkspaceId()): Promise<FactoringView | null> {
  const l = await prisma.load.findFirst({ where: { id: loadId, workspaceId, deletedAt: null, status: "completed" }, include: { stops: { select: { podPhotoUrl: true } } } });
  if (!l) return null;
  const present: PacketKind[] = [];
  if (l.paymentStatus === "invoiced" || l.paymentStatus === "paid") present.push("invoice");
  // What is sent is what is kept: a rate confirmation or a proof of delivery counts only when its file is on the load (or the driver's phone sent the delivery photo). A file
  // NAME typed on the load, or a typed note about the proof, is not a document and is never taken for one.
  const docs = await documentKinds(loadId, workspaceId);
  if (docs.has("rate_con")) present.push("rate_confirmation");
  if (docs.has("pod") || l.stops.some((s) => s.podPhotoUrl)) present.push("proof_of_delivery");
  const gaps = packetGaps(present);
  const state = await partnerState("factoring", null, workspaceId);
  const blocked =
    l.paymentStatus !== "invoiced" ? (l.paymentStatus === "paid" ? "This invoice is paid." : "Invoice it first.")
    : !isSendable(l, new Date()) ? `Already ${factoringLabel(l.factoringStatus).toLowerCase()}.`
    : state.reason;
  return {
    loadId,
    status: l.factoringStatus,
    referenceId: l.factoringReferenceId,
    updatedAt: l.factoringUpdatedAt,
    manifest: FACTORING_PACKET.map((i) => ({ kind: i.kind, label: PACKET_LABEL[i.kind], required: i.required, present: present.includes(i.kind) })),
    missingRequired: gaps.required,
    missingOptional: gaps.optional,
    provider: state.provider,
    blocked
  };
}

export type FactorResult = { ok: true; referenceId: string; status: string } | { ok: false; error: string; code?: string };

export async function factorInvoice(loadId: string, opts: { sendAnyway?: boolean } = {}, now = new Date(), workspaceId = currentWorkspaceId()): Promise<FactorResult> {
  const view = await getFactoringView(loadId, workspaceId);
  if (!view) return { ok: false, error: "That load is not a delivered load." };
  if (view.missingRequired.length > 0) return { ok: false, error: `The packet needs: ${view.missingRequired.map((k) => PACKET_LABEL[k]).join(", ")}.` };
  if (view.missingOptional.length > 0 && !opts.sendAnyway) return { ok: false, error: `Not in the packet: ${view.missingOptional.map((k) => PACKET_LABEL[k]).join(", ")}. Send anyway to go without.` };
  const load = await prisma.load.findFirstOrThrow({ where: { id: loadId, workspaceId } });
  if (!isSendable(load, now)) return { ok: false, error: `Already ${factoringLabel(load.factoringStatus).toLowerCase()}.` };
  // Claimed BEFORE the factor is called, in one step that only succeeds for an invoice nobody has sent: two clicks cannot both send it. If the call fails the claim is given back.
  const claimed = await prisma.load.updateMany({
    where: { id: loadId, workspaceId, OR: [{ factoringStatus: { in: SENDABLE_STATES } }, { factoringStatus: "requested", factoringReferenceId: null, factoringUpdatedAt: { lt: new Date(now.getTime() - CLAIM_MS) } }] },
    data: { factoringStatus: "requested", factoringReferenceId: null, factoringUpdatedAt: now }
  });
  if (claimed.count !== 1) return { ok: false, error: "This invoice was just sent, or is being sent, by someone else. Reload the page." };
  const release = () => prisma.load.updateMany({ where: { id: loadId, workspaceId, factoringStatus: "requested", factoringReferenceId: null, factoringUpdatedAt: now }, data: { factoringStatus: load.factoringStatus, factoringReferenceId: load.factoringReferenceId, factoringUpdatedAt: load.factoringUpdatedAt } });
  let called;
  try {
    called = await callPartner(
      "factoring",
      null,
      { loadId, loadNumber: load.loadNumber, invoiceNumber: load.invoiceNumber, amount: num(load.invoicedAmount ?? load.quotedRevenue), packet: view.manifest.filter((m) => m.present).map((m) => m.kind) },
      workspaceId
    );
  } catch (e) {
    await release();
    throw e;
  }
  const { provider, result } = called;
  if (!result.ok) {
    await release();
    return { ok: false, error: result.message ?? "The factor could not be reached.", code: result.code };
  }
  const { referenceId, status } = result.data;
  const without = view.missingOptional.length > 0 ? `, without ${view.missingOptional.map((k) => PACKET_LABEL[k].toLowerCase()).join(" and ")}` : "";
  await prisma.$transaction(async (tx) => {
    await tx.load.update({ where: { id: loadId }, data: { factoringStatus: status, factoringReferenceId: referenceId, factoringUpdatedAt: now } });
    await recordAudit(
      { entity: "invoice", action: "factoring_requested", loadId, loadNumber: load.loadNumber, summary: `${load.invoiceNumber ?? "Invoice"} sent to ${providerName(provider)} (reference ${referenceId})${without}`, before: { Factoring: factoringLabel(view.status) }, after: { Factoring: factoringLabel(status), Reference: referenceId }, at: now, workspaceId },
      tx
    );
  });
  return { ok: true, referenceId, status };
}

/** What the factor later says (funded, rejected, paid), from a webhook when one is connected: moves the status and says so in the trail. */
export async function applyFactoringUpdate(loadId: string, status: string, referenceId: string | null, now = new Date(), workspaceId = currentWorkspaceId()): Promise<boolean> {
  const l = await prisma.load.findFirst({ where: { id: loadId, workspaceId } });
  if (!l || l.factoringStatus === status) return false;
  await prisma.$transaction(async (tx) => {
    await tx.load.update({ where: { id: loadId }, data: { factoringStatus: status, ...(referenceId ? { factoringReferenceId: referenceId } : {}), factoringUpdatedAt: now } });
    await recordAudit({ entity: "invoice", action: "factoring_updated", loadId, loadNumber: l.loadNumber, summary: `${l.invoiceNumber ?? "Invoice"}: ${factoringLabel(status).toLowerCase()}`, before: { Factoring: factoringLabel(l.factoringStatus) }, after: { Factoring: factoringLabel(status) }, at: now, workspaceId }, tx);
  });
  return true;
}
