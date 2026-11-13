/**
 * Invoices as their own records (docs/MONEY_PLAN.md, Wave 1): the pure parts. Which kind a line is, what an invoice's state is from its money, and what the load's
 * projected invoice fields must be for a given invoice, so the write path and the parity test use one rule. Pure: no database, no React.
 */
import { Prisma } from "@prisma/client";

export const LINE_KINDS = ["linehaul", "fuel_surcharge", "detention", "lumper", "layover", "tonu", "stop_off", "credit", "other"] as const;
export type LineKind = (typeof LINE_KINDS)[number];

/** Why an invoice closed short, as a code a report can count. The person's own words are kept beside it. */
export const SHORT_CODES = ["quick_pay_fee", "factor_fee", "customer_deduction", "damage_claim", "negotiated", "other"] as const;
export type ShortCode = (typeof SHORT_CODES)[number];
export const SHORT_CODE_LABEL: Record<ShortCode, string> = {
  quick_pay_fee: "Quick-pay fee",
  factor_fee: "Factoring fee",
  customer_deduction: "Customer deduction",
  damage_claim: "Damage or claim",
  negotiated: "Negotiated discount",
  other: "Other"
};
export const isShortCode = (v: unknown): v is ShortCode => typeof v === "string" && (SHORT_CODES as readonly string[]).includes(v);
/** The short codes that are a fee for being paid early (a quick-pay or a factor's fee), not money lost: gap 6, rule 2, books them as a cost of money (Factoring Fees), never as revenue lost. */
export const FEE_SHORT_CODES: readonly ShortCode[] = ["quick_pay_fee", "factor_fee"];
export const isFeeShortCode = (v: unknown): boolean => isShortCode(v) && FEE_SHORT_CODES.includes(v);

/** The labels the invoice dialog has always written, read back as kinds. Anything else typed by a person is "other". */
export function lineKindOf(label: string): LineKind {
  switch (label.trim().toLowerCase()) {
    case "line haul":
    case "linehaul":
      return "linehaul";
    case "fuel surcharge":
      return "fuel_surcharge";
    case "detention":
      return "detention";
    case "lumper":
      return "lumper";
    case "layover":
      return "layover";
    case "tonu fee":
    case "tonu":
      return "tonu";
    case "stop off":
    case "stop-off":
    case "stop charge":
      return "stop_off";
    default:
      return "other";
  }
}

const cents = (n: Prisma.Decimal.Value) => new Prisma.Decimal(n).toDecimalPlaces(2);

export type InvoiceMoney = { total: Prisma.Decimal.Value; paidTotal: Prisma.Decimal.Value; status: "open" | "paid" | "void" };

/** What is still owed: the total less what came in, never below zero (an overpayment is not a negative balance). A paid or void invoice owes nothing. */
export function balanceOf(i: InvoiceMoney): number {
  if (i.status !== "open") return 0;
  const left = cents(i.total).minus(cents(i.paidTotal));
  return left.isNegative() ? 0 : left.toNumber();
}

/** The words for where an invoice stands. */
export function invoiceStateLabel(i: InvoiceMoney): string {
  if (i.status === "void") return "Void";
  if (i.status === "paid") return "Paid";
  return cents(i.paidTotal).gt(0) ? "Part paid" : "Open";
}

/**
 * What the load's own invoice fields must say for this invoice (the projection the older readers use). One load per invoice keeps its total and what came in; on an invoice of
 * several loads each load shows its own lines' total, and what came in is shared out across the loads in line order (first load first), so the sum of the loads equals the invoice.
 */
export type ProjectionInput = {
  number: string;
  status: "open" | "paid" | "void";
  issuedAt: Date;
  termsDays: number;
  paidTotal: Prisma.Decimal.Value;
  paidAt: Date | null;
  /** Each load on the invoice with the total of its own lines, in line order. */
  loads: Array<{ loadId: string; amount: Prisma.Decimal.Value }>;
};
export type LoadProjection = {
  loadId: string;
  invoiceNumber: string | null;
  invoicedAmount: number | null;
  invoicedAt: Date | null;
  paidAmount: number | null;
  paidAt: Date | null;
  paymentStatus: "invoiced" | "paid" | null;
  payTermsDays: number;
};

export function projectToLoads(i: ProjectionInput): LoadProjection[] {
  if (i.status === "void") {
    return i.loads.map((l) => ({ loadId: l.loadId, invoiceNumber: null, invoicedAmount: null, invoicedAt: null, paidAmount: null, paidAt: null, paymentStatus: null, payTermsDays: i.termsDays }));
  }
  let left = cents(i.paidTotal);
  return i.loads.map((l, n) => {
    const amount = cents(l.amount);
    const last = n === i.loads.length - 1;
    // The last load takes whatever is left, so an overpayment is not lost and the loads always add up to the invoice.
    const share = last ? left : Prisma.Decimal.min(left, amount);
    left = left.minus(share);
    const paid = share.gt(0) ? share.toNumber() : null;
    return {
      loadId: l.loadId,
      invoiceNumber: i.number,
      invoicedAmount: amount.toNumber(),
      invoicedAt: i.issuedAt,
      paidAmount: paid,
      paidAt: i.status === "paid" ? i.paidAt : null,
      paymentStatus: i.status === "paid" ? "paid" : "invoiced",
      payTermsDays: i.termsDays
    };
  });
}
