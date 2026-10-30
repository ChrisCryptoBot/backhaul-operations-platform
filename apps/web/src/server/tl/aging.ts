import { prisma } from "@/lib/db";
import { computeAgingSummary } from "@/truelane/lib/invoice";
import { currentWorkspaceId } from "./workspace";

/**
 * What is owed and how late: TrueLane's own aging rule (computeAgingSummary) over the invoices still out, read as the few plain columns it needs. A fleet can have
 * thousands out at once, so this never reads a whole load. Used by the header's overdue count and the Invoices screen.
 */
export async function agingSummary(now = Date.now(), workspaceId = currentWorkspaceId()) {
  const owed = await prisma.$queryRaw<Array<{ invoicedAt: Date | null; payTermsDays: number | null; quotedRevenue: number; fuelSurcharge: number | null; invoicedAmount: number | null }>>`
    select invoiced_at as "invoicedAt", pay_terms_days as "payTermsDays", quoted_revenue::float8 as "quotedRevenue", fuel_surcharge::float8 as "fuelSurcharge", invoiced_amount::float8 as "invoicedAmount"
    from loads where workspace_id = ${workspaceId} and deleted_at is null and status <> 'quote' and payment_status = 'invoiced'`;
  return computeAgingSummary(
    owed.map((l) => ({ paymentStatus: "invoiced", invoicedAt: l.invoicedAt ? l.invoicedAt.getTime() : null, payTermsDays: l.payTermsDays, quotedRevenue: l.quotedRevenue, fuelSurcharge: l.fuelSurcharge, invoicedAmount: l.invoicedAmount })),
    now
  );
}
