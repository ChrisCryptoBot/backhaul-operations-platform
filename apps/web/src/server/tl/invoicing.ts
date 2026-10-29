import { prisma } from "@/lib/db";
import { recordAudit } from "./audit";
import { num } from "./convert";

/** Invoice a delivered load, and mark an invoice paid. Each writes its audit event with the change. */
export async function invoiceLoad(loadId: string, now = new Date()): Promise<{ ok: boolean }> {
  const load = await prisma.load.findUniqueOrThrow({ where: { id: loadId } });
  if (load.status !== "completed" || load.paymentStatus) return { ok: false };
  const amount = load.actualRevenue ?? load.quotedRevenue;
  const number = `INV-${load.loadNumber ?? loadId.slice(-6)}`;
  const terms = load.payTermsDays ?? 30;
  await prisma.$transaction(async (tx) => {
    await tx.load.update({ where: { id: loadId }, data: { paymentStatus: "invoiced", invoicedAt: now, invoicedAmount: amount, invoiceNumber: number, payTermsDays: terms } });
    await recordAudit(
      {
        entity: "invoice",
        action: "invoiced",
        loadId,
        loadNumber: load.loadNumber,
        summary: `${number} created for $${num(amount).toFixed(2)}`,
        before: { Invoice: null, Amount: null },
        after: { Invoice: number, Amount: `$${num(amount).toFixed(2)}`, Terms: `Net ${terms}` },
        at: now
      },
      tx
    );
  });
  return { ok: true };
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
