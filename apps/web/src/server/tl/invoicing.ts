import { prisma } from "@/lib/db";
import { invoiceTotalDue } from "@/truelane/lib/invoice";
import { recordAudit } from "./audit";
import { num, numOrNull } from "./convert";
import { detentionOfLoad } from "./detention";
import { getThresholds } from "./thresholds";

/**
 * Invoice a delivered load, and mark an invoice paid. Each writes its audit event with the change. The amount is TrueLane's
 * "total due": the agreed rate plus the billable fuel surcharge plus any extra charge switched on, which here is the load's detention.
 */
export async function invoiceLoad(loadId: string, opts: { includeDetention?: boolean } = {}, now = new Date()): Promise<{ ok: boolean; detention: number }> {
  const load = await prisma.load.findUniqueOrThrow({ where: { id: loadId }, include: { stops: true, vehicle: { include: { costProfile: true } } } });
  if (load.status !== "completed" || load.paymentStatus) return { ok: false, detention: 0 };
  const thresholds = await getThresholds();
  const detention = opts.includeDetention ? detentionOfLoad(load, thresholds.detentionGraceMinutes).billable : 0;
  const extras = detention > 0 ? [{ label: "Detention", amount: detention }] : [];
  const amount = invoiceTotalDue({ quotedRevenue: num(load.quotedRevenue), fuelSurcharge: numOrNull(load.fuelSurcharge) }, extras);
  const number = `INV-${load.loadNumber ?? loadId.slice(-6)}`;
  const terms = load.payTermsDays ?? thresholds.defaultPayTermsDays;
  await prisma.$transaction(async (tx) => {
    await tx.load.update({ where: { id: loadId }, data: { paymentStatus: "invoiced", invoicedAt: now, invoicedAmount: amount, invoiceNumber: number, payTermsDays: terms } });
    await recordAudit(
      {
        entity: "invoice",
        action: "invoiced",
        loadId,
        loadNumber: load.loadNumber,
        summary: `${number} created for $${amount.toFixed(2)}${detention > 0 ? `, with $${detention.toFixed(2)} of detention` : ""}`,
        before: { Invoice: null, Amount: null },
        after: { Invoice: number, Amount: `$${amount.toFixed(2)}`, ...(detention > 0 ? { Detention: `$${detention.toFixed(2)}` } : {}), Terms: `Net ${terms}` },
        at: now
      },
      tx
    );
  });
  return { ok: true, detention };
}

export async function markLoadPaid(loadId: string, now = new Date()): Promise<{ ok: boolean }> {
  const load = await prisma.load.findUniqueOrThrow({ where: { id: loadId } });
  if (load.paymentStatus !== "invoiced") return { ok: false };
  const amount = load.invoicedAmount ?? load.quotedRevenue;
  await prisma.$transaction(async (tx) => {
    await tx.load.update({ where: { id: loadId }, data: { paymentStatus: "paid", paidAt: now, paidAmount: amount } });
    await recordAudit(
      {
        entity: "invoice",
        action: "paid",
        loadId,
        loadNumber: load.loadNumber,
        summary: `${load.invoiceNumber ?? "Invoice"} paid, $${num(amount).toFixed(2)}`,
        before: { Status: "Invoiced" },
        after: { Status: "Paid", Amount: `$${num(amount).toFixed(2)}` },
        at: now
      },
      tx
    );
  });
  return { ok: true };
}
