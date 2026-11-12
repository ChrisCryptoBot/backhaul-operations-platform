import { Prisma } from "@prisma/client";
import type { Terminals } from "@/lib/scope";
import { prisma } from "@/lib/db";
import { reconcile, type ReconRow, type ReconTotals } from "@/lib/factoring-reconciliation";
import { inTerminal } from "@/server/tl/terminal-sql";
import { currentWorkspaceId } from "@/server/tl/workspace";

/**
 * The factoring reconciliation (docs/MONEY_PLAN.md, Wave 2): every invoice record that has been with a factor (sent, funded, rejected, paid or charged back), read straight from the
 * record, newest change first, narrowed to the loads of the person's terminals. The totals are lib/factoring-reconciliation.ts reconcile() over exactly these rows.
 */
export const RECON_CAP = 2_000;

export async function factoringReconciliation(workspaceId = currentWorkspaceId(), terminal: Terminals = null): Promise<{ rows: ReconRow[]; totals: ReconTotals; cut: boolean }> {
  const invoices = await prisma.invoice.findMany({
    where: {
      workspaceId,
      kind: "invoice",
      status: { not: "void" },
      OR: [{ factoringStatus: { not: "none" } }, { factoringChargeback: { not: null } }],
      loads: { some: { load: { is: { deletedAt: null, ...inTerminal(terminal) } } } }
    },
    orderBy: [{ factoringUpdatedAt: { sort: "desc", nulls: "last" } }, { id: "asc" }],
    take: RECON_CAP + 1,
    include: { payments: { select: { amount: true, source: true } }, lines: { select: { loadId: true, sort: true } }, loads: { select: { loadId: true } } }
  });
  const cut = invoices.length > RECON_CAP;
  const rows: ReconRow[] = invoices.slice(0, RECON_CAP).map((i) => {
    const first = [...i.lines].sort((a, b) => a.sort - b.sort).find((l) => l.loadId)?.loadId ?? i.loads[0]?.loadId ?? null;
    return {
      invoiceId: i.id,
      loadId: first,
      number: i.number,
      customer: i.billToName,
      factoring: i.factoringStatus,
      invoiceStatus: i.status,
      total: i.total.toNumber(),
      advance: i.factoringAdvance?.toNumber() ?? null,
      fee: i.factoringFee?.toNumber() ?? null,
      reserve: i.factoringReserve?.toNumber() ?? null,
      reserveReleased: i.factoringReserveReleased?.toNumber() ?? null,
      chargeback: i.factoringChargeback?.toNumber() ?? null,
      paidByCustomer: i.payments.filter((p) => p.source !== "credit").reduce((s, p) => s.plus(p.amount), new Prisma.Decimal(0)).toNumber(),
      reference: i.factoringReferenceId,
      updatedAt: i.factoringUpdatedAt
    };
  });
  return { rows, totals: reconcile(rows), cut };
}
