import { Prisma } from "@prisma/client";

/**
 * What an invoice bills, in one place: the amount stored when it was made, else (an invoice from before amounts were kept) what it would have been: a TONU's fee, or the agreed rate plus
 * the fuel surcharge. The Ready list, the aging, a payment, the invoice sheet, the load page and the files all use this, so they cannot bill three different amounts for one invoice.
 * (Aging does the same in SQL, server/tl/aging.ts.) In whole cents. Pure.
 */
export type BilledInput = { invoicedAmount: number | null | undefined; status: string; quotedRevenue: number; fuelSurcharge: number | null | undefined; tonuRevenue: number | null | undefined };

export function billedOf(l: BilledInput): number {
  if (l.invoicedAmount != null) return new Prisma.Decimal(l.invoicedAmount).toDecimalPlaces(2).toNumber();
  if (l.status === "tonu") return new Prisma.Decimal(l.tonuRevenue ?? 0).toDecimalPlaces(2).toNumber();
  return new Prisma.Decimal(l.quotedRevenue).plus(l.fuelSurcharge ?? 0).toDecimalPlaces(2).toNumber();
}
