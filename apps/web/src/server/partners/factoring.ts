import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { FACTORING_PACKET, PACKET_LABEL, packetGaps, type PacketKind } from "@/truelane/partners/contract";
import { economicsOf, chargebackOf, type Economics } from "@/lib/factoring-economics";
import { recordAudit } from "@/server/tl/audit";
import { packetFiles } from "@/server/tl/documents";
import { num } from "@/server/tl/convert";
import { currentWorkspaceId } from "@/server/tl/workspace";
import { callPartner, partnerState, providerName } from "./call";
import { getFactoringTerms } from "./factoring-terms";
import { setInvoiceFactoring } from "@/server/tl/invoice-records";
import { checkMoneyMoving } from "./gates";

/**
 * Factoring: an invoice that is out can be sent to a factor with its packet. The invoice is always required; the rate confirmation and the proof of delivery help the factor
 * and are skipped only by choice ("Send anyway"). What the factor answers moves `factoringStatus` and the reference on the invoice and on every load it carries (an invoice of
 * several loads is one invoice to the factor, docs/MONEY_PLAN.md, rule G). Nothing is sent unless the provider's keys are set and the fleet has connected it; until a company is chosen
 * that is never, and the screen says why. When the factor funds the invoice the advance, the fee and the reserve are worked out from the fleet's factoring terms and kept on the invoice.
 */
export type PacketLine = { kind: PacketKind; label: string; required: boolean; present: boolean };
export type FactoringMoney = {
  advance: number | null;
  fee: number | null;
  reserveHeld: number | null;
  reserveReleased: number | null;
  chargeback: number | null;
  /** What the fleet's terms say this invoice should pay out, before the factor has funded it. Null when no advance rate is saved. */
  expected: Economics | null;
};
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
  /** How many loads the invoice carries (1 for an ordinary invoice). */
  loadCount: number;
  /** Loads whose only proof of delivery is the driver's phone photo, which is a link and not a kept file, so it cannot go in the packet. */
  podPhotoOnly: number;
  invoiceNumber: string | null;
  money: FactoringMoney | null;
};

const FACTORING_STATE: Record<string, string> = { none: "Not factored", requested: "Requested", submitted: "With the factor", funded: "Funded", rejected: "Rejected", paid: "Paid by the customer" };
export const factoringLabel = (s: string) => FACTORING_STATE[s] ?? s;

const SENDABLE_STATES = ["none", "rejected"];
/** A request that was claimed but never finished (the server stopped before the factor answered) can be sent again after this long. */
const CLAIM_MS = 10 * 60_000;
const isSendable = (l: { factoringStatus: string; factoringReferenceId: string | null; factoringUpdatedAt: Date | null }, now: Date) =>
  SENDABLE_STATES.includes(l.factoringStatus) || (l.factoringStatus === "requested" && l.factoringReferenceId == null && l.factoringUpdatedAt != null && l.factoringUpdatedAt.getTime() < now.getTime() - CLAIM_MS);

/** The invoice a load is on: every load it carries (the load asked about first), its number and total, and its record id. A load with no record is its own invoice (imported history). */
async function scopeOf(loadId: string, workspaceId: string) {
  const rec = await prisma.invoice.findFirst({
    where: { workspaceId, kind: "invoice", status: { not: "void" }, loads: { some: { loadId } } },
    orderBy: [{ issuedAt: "desc" }, { id: "desc" }],
    include: { loads: true }
  });
  const loadIds = rec ? [loadId, ...rec.loads.map((x) => x.loadId).filter((id) => id !== loadId)] : [loadId];
  return { rec, loadIds };
}

export async function getFactoringView(loadId: string, workspaceId = currentWorkspaceId()): Promise<FactoringView | null> {
  const { rec, loadIds } = await scopeOf(loadId, workspaceId);
  const loads = await prisma.load.findMany({ where: { id: { in: loadIds }, workspaceId, deletedAt: null, status: "completed" } });
  const l = loads.find((x) => x.id === loadId);
  if (!l || loads.length !== loadIds.length) return null;
  const present: PacketKind[] = [];
  if (l.paymentStatus === "invoiced" || l.paymentStatus === "paid") present.push("invoice");
  // What is sent is what is kept (server/tl/documents.ts, packetFiles, the same rule the packet and the schedule use): a rate confirmation or a proof of delivery counts only when its
  // file is kept on the load. A delivery photo the driver's phone sent is a link, not a file, and a file NAME or a typed note is not a document. On an invoice of several loads, every load must have it.
  const files = await packetFiles(loadIds, workspaceId);
  const have = loadIds.map((id) => files.get(id)!);
  if (have.every((h) => h.rateCon)) present.push("rate_confirmation");
  if (have.every((h) => h.pod)) present.push("proof_of_delivery");
  const gaps = packetGaps(present);
  const state = await partnerState("factoring", null, workspaceId);
  const blocked =
    l.paymentStatus !== "invoiced" ? (l.paymentStatus === "paid" ? "This invoice is paid." : "Invoice it first.")
    : !isSendable(l, new Date()) ? `Already ${factoringLabel(l.factoringStatus).toLowerCase()}.`
    : state.reason;
  const terms = await getFactoringTerms(workspaceId);
  const total = rec ? rec.total : l.invoicedAmount;
  const expected = total && terms?.advancePct ? economicsOf(total, { advancePct: terms.advancePct, feePct: terms.feePct }) : null;
  const money: FactoringMoney | null = rec
    ? {
        advance: rec.factoringAdvance?.toNumber() ?? null,
        fee: rec.factoringFee?.toNumber() ?? null,
        reserveHeld: rec.factoringReserve?.toNumber() ?? null,
        reserveReleased: rec.factoringReserveReleased?.toNumber() ?? null,
        chargeback: rec.factoringChargeback?.toNumber() ?? null,
        expected
      }
    : null;
  return {
    loadId,
    status: l.factoringStatus,
    referenceId: l.factoringReferenceId,
    updatedAt: l.factoringUpdatedAt,
    manifest: FACTORING_PACKET.map((i) => ({ kind: i.kind, label: PACKET_LABEL[i.kind], required: i.required, present: present.includes(i.kind) })),
    missingRequired: gaps.required,
    missingOptional: gaps.optional,
    provider: state.provider,
    blocked,
    loadCount: loadIds.length,
    podPhotoOnly: have.filter((h) => h.photoOnly).length,
    invoiceNumber: rec?.number ?? l.invoiceNumber,
    money
  };
}

export type FactorResult = { ok: true; referenceId: string; status: string } | { ok: false; error: string; code?: string };

class ClaimLost extends Error {}

export async function factorInvoice(loadId: string, opts: { sendAnyway?: boolean } = {}, now = new Date(), workspaceId = currentWorkspaceId()): Promise<FactorResult> {
  const view = await getFactoringView(loadId, workspaceId);
  if (!view) return { ok: false, error: "That load is not a delivered load." };
  if (view.missingRequired.length > 0) return { ok: false, error: `The packet needs: ${view.missingRequired.map((k) => PACKET_LABEL[k]).join(", ")}.` };
  if (view.missingOptional.length > 0 && !opts.sendAnyway) return { ok: false, error: `Not in the packet: ${view.missingOptional.map((k) => PACKET_LABEL[k]).join(", ")}. Send anyway to go without.` };
  const { rec, loadIds } = await scopeOf(loadId, workspaceId);
  const loads = await prisma.load.findMany({ where: { id: { in: loadIds }, workspaceId, deletedAt: null } });
  const load = loads.find((x) => x.id === loadId);
  if (!load || loads.length !== loadIds.length) return { ok: false, error: "That load could not be found." };
  if (!isSendable(load, now)) return { ok: false, error: `Already ${factoringLabel(load.factoringStatus).toLowerCase()}.` };
  // Before anything is claimed: a live send needs the money-moving switch (counsel's sign-off on the server and the fleet's own switch). The simulator passes.
  const gate = await checkMoneyMoving("factoring", workspaceId);
  if (!gate.ok) return { ok: false, error: gate.error, code: gate.code };
  const sendable = { OR: [{ factoringStatus: { in: SENDABLE_STATES } }, { factoringStatus: "requested", factoringReferenceId: null, factoringUpdatedAt: { lt: new Date(now.getTime() - CLAIM_MS) } }] };
  // Claimed BEFORE the factor is called, in one step that only succeeds for an invoice nobody has sent: two clicks cannot both send it. Every load of the invoice is claimed or none is.
  try {
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.load.updateMany({ where: { id: { in: loadIds }, workspaceId, ...sendable }, data: { factoringStatus: "requested", factoringReferenceId: null, factoringUpdatedAt: now } });
      if (claimed.count !== loadIds.length) throw new ClaimLost();
    });
  } catch (e) {
    if (e instanceof ClaimLost) return { ok: false, error: "This invoice was just sent, or is being sent, by someone else. Reload the page." };
    throw e;
  }
  const release = () =>
    prisma.$transaction(
      loads.map((x) => prisma.load.updateMany({ where: { id: x.id, workspaceId, factoringStatus: "requested", factoringReferenceId: null, factoringUpdatedAt: now }, data: { factoringStatus: x.factoringStatus, factoringReferenceId: x.factoringReferenceId, factoringUpdatedAt: x.factoringUpdatedAt } }))
    );
  const loadNumber = loads.map((x) => x.loadNumber).filter(Boolean).join(", ") || null;
  let called;
  try {
    called = await callPartner(
      "factoring",
      null,
      { loadId, loadNumber, invoiceNumber: rec?.number ?? load.invoiceNumber, amount: rec ? rec.total.toNumber() : num(load.invoicedAmount ?? load.quotedRevenue), packet: view.manifest.filter((m) => m.present).map((m) => m.kind) },
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
  const name = rec?.number ?? load.invoiceNumber ?? "Invoice";
  await prisma.$transaction(async (tx) => {
    await tx.load.updateMany({ where: { id: { in: loadIds } }, data: { factoringStatus: status, factoringReferenceId: referenceId, factoringUpdatedAt: now } });
    if (rec) {
      await setInvoiceFactoring(tx, rec.id, { status, referenceId, now });
      // The notice of assignment goes on the invoice from now on: its PDF names the factor and where to pay (rule C).
      await tx.invoice.update({ where: { id: rec.id }, data: { noaAppliedAt: now } });
    }
    await recordAudit(
      { entity: "invoice", action: "factoring_requested", loadId, loadNumber: load.loadNumber, summary: `${name} sent to ${providerName(provider)} (reference ${referenceId})${loadIds.length > 1 ? `, ${loadIds.length} loads` : ""}${without}`, before: { Factoring: factoringLabel(view.status) }, after: { Factoring: factoringLabel(status), Reference: referenceId }, at: now, workspaceId },
      tx
    );
  });
  return { ok: true, referenceId, status };
}

/** Where a factored invoice can go from where it is. Anything else (funded back to requested, a skipped step) is a wrong report, not a move. */
export const FACTORING_NEXT: Record<string, string[]> = { requested: ["submitted", "funded", "rejected"], submitted: ["funded", "rejected"], funded: ["paid"] };

/**
 * What the factor says next (funded, rejected, paid): from a webhook when one is connected, and until then from the desk, by hand, when the factor's own portal says so. It moves the
 * status one allowed step on the invoice and every load it carries, and says so in the trail. The move is made from the status it was read at, so the same report twice, or two people at
 * once, moves it once. False when nothing moved. Funded works out the advance, the fee and the reserve from the fleet's factoring terms; paid works out what the factor releases.
 */
export async function applyFactoringUpdate(loadId: string, status: string, referenceId: string | null, now = new Date(), workspaceId = currentWorkspaceId()): Promise<boolean> {
  const l = await prisma.load.findFirst({ where: { id: loadId, workspaceId, deletedAt: null } });
  if (!l || l.factoringStatus === status || !(FACTORING_NEXT[l.factoringStatus] ?? []).includes(status)) return false;
  // An invoice the customer has paid in full has nothing left to ask the factor: its status was closed with the payment, and only taking the payment back reopens it.
  if (l.paymentStatus === "paid" && status !== "paid") return false;
  const { rec, loadIds } = await scopeOf(loadId, workspaceId);
  const terms = status === "funded" ? await getFactoringTerms(workspaceId) : null;
  try {
    return await prisma.$transaction(async (tx) => {
      const out = await tx.load.updateMany({ where: { id: { in: loadIds }, workspaceId, factoringStatus: l.factoringStatus }, data: { factoringStatus: status, ...(referenceId ? { factoringReferenceId: referenceId } : {}), factoringUpdatedAt: now } });
      if (out.count !== loadIds.length) throw new ClaimLost();
      if (rec) {
        await setInvoiceFactoring(tx, rec.id, { status, ...(referenceId ? { referenceId } : {}), now });
        // The day the advance was paid: the journal dates the advance and the fee by it (docs/MONEY_PLAN.md, Wave 3).
        if (status === "funded") await tx.invoice.update({ where: { id: rec.id }, data: { factoringFundedAt: now } });
        if (status === "funded" && terms?.advancePct) {
          const e = economicsOf(rec.total, { advancePct: terms.advancePct, feePct: terms.feePct });
          if (e) await tx.invoice.update({ where: { id: rec.id }, data: { factoringAdvance: e.advance, factoringFee: e.fee, factoringReserve: e.reserveHeld } });
        }
        if (status === "paid" && rec.factoringReserve) {
          const left = rec.factoringReserve.minus(rec.factoringFee ?? 0);
          await tx.invoice.update({ where: { id: rec.id }, data: { factoringReserveReleased: left.isNegative() ? 0 : left, factoringReserveReleasedAt: now } });
        }
      }
      await recordAudit({ entity: "invoice", action: "factoring_updated", loadId, loadNumber: l.loadNumber, summary: `${rec?.number ?? l.invoiceNumber ?? "Invoice"}: ${factoringLabel(status).toLowerCase()}${loadIds.length > 1 ? ` (${loadIds.length} loads)` : ""}`, before: { Factoring: factoringLabel(l.factoringStatus) }, after: { Factoring: factoringLabel(status) }, at: now, workspaceId }, tx);
      return true;
    });
  } catch (e) {
    if (e instanceof ClaimLost) return false;
    throw e;
  }
}

export type ChargebackResult = { ok: true; amount: number } | { ok: false; error: string };

/**
 * The factor charges an invoice back (recourse: the customer did not pay it): the advance is owed back, the factor releases no reserve, and the invoice is the carrier's to collect again.
 * Only an invoice that was funded and not yet paid can be charged back. The invoice goes back to "rejected" (it can be sent to a factor again), and the amount is kept on its record.
 */
export async function recordChargeback(loadId: string, reason: string, now = new Date(), workspaceId = currentWorkspaceId(), /** What the factor says it charged back (its status file); the advance when not said. */ reported?: number): Promise<ChargebackResult> {
  const why = reason.trim();
  if (why.length < 3) return { ok: false, error: "Say why the factor charged it back." };
  const { rec, loadIds } = await scopeOf(loadId, workspaceId);
  if (!rec) return { ok: false, error: "This invoice has no record to charge back." };
  if (rec.factoringStatus !== "funded") return { ok: false, error: "Only an invoice the factor has funded, and the customer has not paid, can be charged back." };
  if (reported != null && (!Number.isFinite(reported) || !(reported > 0) || new Prisma.Decimal(reported).gt(rec.total))) return { ok: false, error: "The amount charged back has to be above zero and no more than the invoice." };
  if (reported == null && !rec.factoringAdvance) return { ok: false, error: "No advance is recorded on this invoice, so there is nothing to charge back. Save the factoring terms and fund it again, or fix it with the factor." };
  const amount = reported != null ? new Prisma.Decimal(reported).toDecimalPlaces(2).toNumber() : chargebackOf(rec.factoringAdvance!);
  const done = await prisma.$transaction(async (tx) => {
    const claimed = await tx.invoice.updateMany({ where: { id: rec.id, factoringStatus: "funded" }, data: { factoringStatus: "rejected", factoringChargeback: new Prisma.Decimal(amount), factoringChargedBackAt: now, factoringReserve: null, factoringFee: null, factoringReserveReleased: null, factoringReserveReleasedAt: null, factoringUpdatedAt: now } });
    if (claimed.count !== 1) return false;
    await tx.load.updateMany({ where: { id: { in: loadIds }, workspaceId }, data: { factoringStatus: "rejected", factoringUpdatedAt: now } });
    await recordAudit({ entity: "invoice", action: "factoring_chargeback", loadId, loadNumber: null, summary: `${rec.number}: the factor charged back $${amount.toFixed(2)}`, reason: why, before: { Factoring: "Funded", Advance: `$${amount.toFixed(2)}` }, after: { Factoring: "Rejected", "Owed back": `$${amount.toFixed(2)}` }, at: now, workspaceId }, tx);
    return true;
  });
  return done ? { ok: true, amount } : { ok: false, error: "That invoice changed while you were looking at it. Reload the page." };
}
