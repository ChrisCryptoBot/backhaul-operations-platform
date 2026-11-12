import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { FACTOR_STATUS_LABEL, readFactorStatus, type FactorStatus, type StatusRow } from "@/lib/factor-status";
import { recordAudit } from "@/server/tl/audit";
import { markLoadPaid } from "@/server/tl/invoicing";
import { currentWorkspaceId } from "@/server/tl/workspace";
import { applyFactoringUpdate, recordChargeback } from "./factoring";
import { getFactoringTerms } from "./factoring-terms";

/**
 * A factor's status file, put into the desk (docs/MONEY_PLAN.md, Wave 2). Each line is matched to an invoice (by its number, or by the factor's reference when that names one invoice) and
 * planned against where the invoice stands now, the same steps a webhook may take:
 *   - submitted, funded, rejected go through applyFactoringUpdate (funded works out the advance, fee and reserve from the factoring terms; an amount on the line is the advance the factor
 *     actually paid, and replaces the worked-out one);
 *   - chargeback goes through recordChargeback (an amount on the line is what was charged back);
 *   - paid is the customer paying the invoice, so it goes through markLoadPaid like any payment (source "factor"): that closes the invoice and releases the reserve less the fee.
 * A check (dry run) writes nothing and says what each line would do. Applying runs the same plan. A line that is already true ("already") does nothing, so importing the same file again
 * changes nothing. Lines for the same invoice are planned in file order, each seeing what the line before it would have done.
 */
export type RowAction = "apply" | "already" | "error";
export type PlannedRow = { line: number; invoice: string | null; status: FactorStatus | null; statusText: string; action: RowAction; detail: string };
export type ImportResult =
  | { ok: true; applied: boolean; rows: PlannedRow[]; counts: Record<RowAction, number>; fingerprint: string }
  | { ok: false; error: string };

type Inv = { id: string; number: string; status: string; factoringStatus: string; factoringChargeback: Prisma.Decimal | null; total: Prisma.Decimal; paidTotal: Prisma.Decimal; loadIds: string[] };

/** Where an invoice stands while a file is planned: each line sees what the lines before it for the same invoice would have done (paidTotal included, so two part payments add up). */
type PlanState = { factoring: string; invoice: string; charged: boolean; paidTotal: Prisma.Decimal };

/** What a line does to an invoice in the state given, and the state after it. */
function plan(row: StatusRow, inv: Inv, f: PlanState): { action: RowAction; detail: string; next?: PlanState } {
  const st = row.status!;
  const with_ = ["requested", "submitted"].includes(f.factoring);
  const notSent = f.factoring === "none" || (f.factoring === "rejected" && !f.charged);
  if (st === "submitted") {
    if (["submitted", "funded", "paid"].includes(f.factoring) || f.charged) return { action: "already", detail: f.charged ? "Already past this: it was funded and then charged back." : "Already with the factor (or further along)." };
    if (f.factoring === "requested") return { action: "apply", detail: "Marked as with the factor.", next: { ...f, factoring: "submitted" } };
    return { action: "error", detail: notSent ? "The desk has not sent this invoice to a factor." : "This invoice was charged back; the factor no longer has it." };
  }
  if (st === "funded") {
    // A charged-back invoice was funded before it was charged back, so a funded line for it is already so (a factor's file often carries both lines).
    if (f.factoring === "funded" || f.factoring === "paid" || f.charged) return { action: "already", detail: f.charged ? "Already funded, and since charged back." : "Already funded." };
    // An advance the line states replaces the worked-out one, and the reserve is the rest of the invoice: zero, or more than the invoice (a batch total pasted on one row), is refused.
    // The fee stays as the terms work it out: it is a percentage of the invoice, not of the advance.
    if (with_ && row.amount != null && (row.amount <= 0 || inv.total.lt(new Prisma.Decimal(row.amount)))) return { action: "error", detail: "The amount funded has to be above zero and no more than the invoice." };
    if (with_) return { action: "apply", detail: row.amount != null ? `Funded: $${row.amount.toFixed(2)} advanced.` : "Funded: the advance, fee and reserve are worked out from the factoring terms.", next: { ...f, factoring: "funded" } };
    return { action: "error", detail: notSent ? "The desk has not sent this invoice to a factor." : "This invoice was charged back; send it to the factor again first." };
  }
  if (st === "rejected") {
    if (f.factoring === "rejected" && !f.charged) return { action: "already", detail: "Already rejected." };
    if (with_) return { action: "apply", detail: "Rejected: the invoice is the fleet's to collect, or to send again.", next: { ...f, factoring: "rejected" } };
    if (f.factoring === "funded") return { action: "error", detail: "A funded invoice cannot be rejected. If the factor took the advance back, the line should say chargeback." };
    return { action: "error", detail: f.factoring === "paid" ? "The customer has already paid this invoice." : "The desk has not sent this invoice to a factor." };
  }
  if (st === "chargeback") {
    if (f.charged) return { action: "already", detail: "Already charged back." };
    if (f.factoring === "funded") return { action: "apply", detail: row.amount != null ? `Charged back: $${row.amount.toFixed(2)} owed to the factor.` : "Charged back: the advance is owed to the factor.", next: { ...f, factoring: "rejected", charged: true } };
    return { action: "error", detail: f.factoring === "paid" ? "The customer has paid this invoice, so there is nothing to charge back." : "Only an invoice the factor has funded can be charged back." };
  }
  // paid: the customer paid the invoice (to the factor).
  if (f.invoice === "paid") return { action: "already", detail: "Already paid." };
  if (f.invoice !== "open") return { action: "error", detail: "This invoice was taken back." };
  if (!(with_ || f.factoring === "funded")) return { action: "error", detail: "This invoice is not with a factor. Record the customer's payment on the invoice itself." };
  const owing = inv.total.minus(f.paidTotal);
  const amount = row.amount != null ? new Prisma.Decimal(row.amount) : owing;
  const part = amount.lt(owing);
  const detail = part ? `Paid $${amount.toFixed(2)} of $${owing.toFixed(2)}; the rest stays owed.` : `Paid in full ($${amount.toFixed(2)}); the invoice closes${f.factoring === "funded" ? " and the reserve, less the fee, is released" : ""}.`;
  return { action: "apply", detail, next: { ...f, invoice: part ? "open" : "paid", factoring: part ? f.factoring : "paid", paidTotal: f.paidTotal.plus(amount) } };
}

export async function importFactorStatus(text: string, opts: { apply: boolean; who?: string }, now = new Date(), workspaceId = currentWorkspaceId()): Promise<ImportResult> {
  if (text.length > 2_000_000) return { ok: false, error: "That file is over 2 MB. Split it." };
  const file = readFactorStatus(text);
  if (!file.ok) return { ok: false, error: file.error };
  const fingerprint = createHash("sha256").update(text.replace(/\r\n/g, "\n").trim()).digest("hex").slice(0, 12);

  // The invoices the lines can name: by number, and by the factor's reference (only when it names one invoice: a batch number names many).
  const numbers = [...new Set(file.rows.map((r) => r.invoice).filter((x): x is string => !!x))];
  const refs = [...new Set(file.rows.map((r) => r.reference).filter((x): x is string => !!x))];
  const found = await prisma.invoice.findMany({
    where: { workspaceId, kind: "invoice", status: { not: "void" }, OR: [{ number: { in: numbers, mode: "insensitive" } }, { factoringReferenceId: { in: refs } }] },
    include: { loads: true, lines: { select: { loadId: true, sort: true } } }
  });
  const toInv = (i: (typeof found)[number]): Inv => {
    const ordered = [...i.lines].sort((a, b) => a.sort - b.sort).map((l) => l.loadId).filter((id): id is string => !!id);
    return { id: i.id, number: i.number, status: i.status, factoringStatus: i.factoringStatus, factoringChargeback: i.factoringChargeback, total: i.total, paidTotal: i.paidTotal, loadIds: [...new Set([...ordered, ...i.loads.map((l) => l.loadId)])] };
  };
  const byNumber = new Map(found.map((i) => [i.number.toLowerCase(), toInv(i)]));
  const byRef = new Map<string, Inv[]>();
  for (const i of found) if (i.factoringReferenceId) byRef.set(i.factoringReferenceId, [...(byRef.get(i.factoringReferenceId) ?? []), toInv(i)]);

  const state = new Map<string, PlanState>();
  const planned: Array<PlannedRow & { inv?: Inv; row: StatusRow }> = file.rows.map((row) => {
    const base = { line: row.line, invoice: row.invoice, status: row.status, statusText: row.statusText, row };
    if (row.errors.length > 0) return { ...base, action: "error" as const, detail: row.errors.join(" ") };
    let inv = row.invoice ? byNumber.get(row.invoice.toLowerCase()) : undefined;
    if (!inv && row.reference) {
      const named = byRef.get(row.reference) ?? [];
      if (named.length > 1) return { ...base, action: "error" as const, detail: `Reference ${row.reference} names ${named.length} invoices (a batch). Add the invoice number to the line.` };
      inv = named[0];
    }
    if (!inv) return { ...base, action: "error" as const, detail: row.invoice ? `No invoice ${row.invoice} on this desk.` : `No invoice with reference ${row.reference}.` };
    const now0 = state.get(inv.id) ?? { factoring: inv.factoringStatus, invoice: inv.status, charged: inv.factoringChargeback != null, paidTotal: inv.paidTotal };
    const p = plan(row, inv, now0);
    if (p.next) state.set(inv.id, p.next);
    return { ...base, invoice: inv.number, action: p.action, detail: p.detail, inv };
  });

  if (opts.apply) {
    const terms = await getFactoringTerms(workspaceId);
    const payer = terms?.factorName ?? "the factor";
    for (const p of planned) {
      if (p.action !== "apply" || !p.inv || !p.row.status) continue;
      const lead = p.inv.loadIds[0]!;
      const st = p.row.status;
      try {
        if (st === "submitted" || st === "funded" || st === "rejected") {
          const moved = await applyFactoringUpdate(lead, st, p.row.reference && st !== "rejected" ? p.row.reference : null, now, workspaceId);
          if (!moved) {
            p.action = "error";
            p.detail = "It changed on the desk while the file was read. Check the file again.";
            continue;
          }
          // The advance the factor actually paid, when the line says it: the reserve is what is left of the invoice.
          if (st === "funded" && p.row.amount != null) {
            const advance = new Prisma.Decimal(p.row.amount).toDecimalPlaces(2);
            await prisma.invoice.update({ where: { id: p.inv.id }, data: { factoringAdvance: advance, factoringReserve: p.inv.total.minus(advance) } });
          }
        } else if (st === "chargeback") {
          const out = await recordChargeback(lead, p.row.reason ?? "Charged back, per the factor's status file", now, workspaceId, p.row.amount ?? undefined);
          if (!out.ok) {
            p.action = "error";
            p.detail = out.error;
          }
        } else {
          const out = await markLoadPaid(lead, now, { amount: p.row.amount ?? undefined, payer, reference: p.row.reference ?? undefined, source: "factor", shortAction: "balance" }, workspaceId);
          if (!out.ok) {
            p.action = "error";
            p.detail = out.error ?? "The payment could not be recorded.";
          }
        }
      } catch {
        // Nothing the database or a guard threw is shown as text: the line is reported as not applied, and the rest go on.
        p.action = "error";
        p.detail = "It could not be applied. Check the invoice and import the file again.";
      }
    }
  }

  const rows: PlannedRow[] = planned.map(({ line, invoice, status, statusText, action, detail }) => ({ line, invoice, status, statusText, action, detail }));
  const counts = { apply: 0, already: 0, error: 0 } as Record<RowAction, number>;
  for (const r of rows) counts[r.action]++;
  if (opts.apply && counts.apply > 0) {
    const byStatus = rows.filter((r) => r.action === "apply" && r.status).reduce<Record<string, number>>((m, r) => ({ ...m, [FACTOR_STATUS_LABEL[r.status!]]: (m[FACTOR_STATUS_LABEL[r.status!]] ?? 0) + 1 }), {});
    await recordAudit({ entity: "invoice", action: "factoring_status_imported", loadId: null, loadNumber: null, summary: `Factor's status file ${fingerprint}: ${counts.apply} applied, ${counts.already} already so, ${counts.error} not applied`, before: null, after: { File: fingerprint, ...Object.fromEntries(Object.entries(byStatus).map(([k, v]) => [k, String(v)])) }, at: now, workspaceId });
  }
  return { ok: true, applied: opts.apply, rows, counts, fingerprint };
}
