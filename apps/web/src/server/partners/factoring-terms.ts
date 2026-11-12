import { prisma } from "@/lib/db";
import { maskAccount, remitToOf, validateTerms, type TermsForm, type TermsValue } from "@/lib/factoring-terms";
import { recordAudit } from "@/server/tl/audit";
import { currentWorkspaceId } from "@/server/tl/workspace";

/**
 * A fleet's own factoring terms (docs/MONEY_PLAN.md, Wave 2): the factor's remit-to and notice of assignment, and the advance and fee it charges. Read by the invoice PDF and the
 * packet, so a factored invoice says where to pay; saved by an admin only. Bank details are the lockbox the factor publishes for customers to pay, printed on every factored invoice,
 * not the carrier's own account; the audit trail still shows the account number hidden but for its last four digits.
 */
export type StoredTerms = TermsValue & { updatedAt: Date; updatedBy: string | null };

export async function getFactoringTerms(workspaceId = currentWorkspaceId()): Promise<StoredTerms | null> {
  const r = await prisma.factoringTerms.findUnique({ where: { workspaceId } });
  if (!r) return null;
  return {
    factorName: r.factorName,
    remitName: r.remitName,
    remitAddress: r.remitAddress,
    lockboxBank: r.lockboxBank,
    routingNumber: r.routingNumber,
    accountNumber: r.accountNumber,
    noaText: r.noaText,
    advancePct: r.advancePct ? r.advancePct.toFixed(2).replace(/\.?0+$/, "") : null,
    feePct: r.feePct ? r.feePct.toFixed(2).replace(/\.?0+$/, "") : null,
    updatedAt: r.updatedAt,
    updatedBy: r.updatedBy
  };
}

/** The form's starting values: what is saved, as text. */
export const termsForm = (t: StoredTerms | null): TermsForm => ({
  factorName: t?.factorName ?? "",
  remitName: t?.remitName ?? "",
  remitAddress: t?.remitAddress ?? "",
  lockboxBank: t?.lockboxBank ?? "",
  routingNumber: t?.routingNumber ?? "",
  accountNumber: t?.accountNumber ?? "",
  noaText: t?.noaText ?? "",
  advancePct: t?.advancePct ?? "",
  feePct: t?.feePct ?? ""
});

export type SaveTermsResult = { ok: true; changed: boolean } | { ok: false; errors: Partial<Record<keyof TermsForm, string>> };

export async function saveFactoringTerms(form: TermsForm, who = "Admin", now = new Date(), workspaceId = currentWorkspaceId()): Promise<SaveTermsResult> {
  const check = validateTerms(form);
  if (!check.ok) return { ok: false, errors: check.errors };
  const v = check.value;
  const before = await getFactoringTerms(workspaceId);
  const was = termsForm(before);
  const now2 = termsForm({ ...v, updatedAt: now, updatedBy: who });
  const names: Array<[keyof TermsForm, string]> = [["factorName", "Factor"], ["remitName", "Pay to"], ["remitAddress", "Remit address"], ["lockboxBank", "Lockbox bank"], ["routingNumber", "Routing number"], ["accountNumber", "Account number"], ["noaText", "Notice of assignment"], ["advancePct", "Advance %"], ["feePct", "Fee %"]];
  const changed = names.filter(([k]) => was[k] !== now2[k]);
  if (changed.length === 0) return { ok: true, changed: false };
  const show = (k: keyof TermsForm, f: TermsForm) => (k === "accountNumber" ? (maskAccount(f.accountNumber || null) ?? "") : k === "noaText" ? (f.noaText ? "text set" : "") : f[k]);
  await prisma.$transaction(async (tx) => {
    await tx.factoringTerms.upsert({
      where: { workspaceId },
      create: { workspaceId, ...v, updatedBy: who },
      update: { ...v, updatedBy: who }
    });
    await recordAudit(
      {
        entity: "settings",
        action: "factoring_terms_saved",
        summary: `Factoring terms saved: ${changed.map(([, n]) => n.toLowerCase()).join(", ")}`,
        before: Object.fromEntries(changed.map(([k, n]) => [n, show(k, was) || null])),
        after: Object.fromEntries(changed.map(([k, n]) => [n, show(k, now2) || null])),
        at: now,
        workspaceId
      },
      tx
    );
  });
  return { ok: true, changed: true };
}

/** What a factored invoice's PDF prints: who to pay and the notice wording. Both null until an admin has filled the terms in. */
export async function factoringPrint(workspaceId = currentWorkspaceId()): Promise<{ factor: string | null; remitTo: string | null; noaText: string | null }> {
  const t = await getFactoringTerms(workspaceId);
  return { factor: t?.factorName ?? t?.remitName ?? null, remitTo: remitToOf(t), noaText: t?.noaText ?? null };
}
