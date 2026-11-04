import { Prisma } from "@prisma/client";
import { usd } from "./desk-format";

/**
 * Where an invoice's money stands, in the same words on every screen: the Loads History, the Invoices lists, the invoice sheet, the load page, the reminder and the files. One
 * function, so a short payment is never "short of" on one screen, "short" on another and "written off" on a third. Pure.
 */
export type MoneyState = {
  key: "not_invoiced" | "out" | "overdue" | "part" | "part_overdue" | "paid" | "paid_short" | "closed_short" | "paid_over";
  label: string;
  tone: "info" | "warn" | "bad" | "ok";
  /** The figures behind the label, or null when there are none to add. */
  detail: string | null;
  /** What is still owed (0 once paid). */
  balance: number;
};

export type MoneyInput = {
  paymentStatus: string | null;
  billed: number;
  received: number | null;
  writeOffAmount?: number | null;
  writeOffReason?: string | null;
  /** Calendar days past due (positive when late); null when unknown. */
  overdueDays?: number | null;
};

const cents = (n: number) => new Prisma.Decimal(n).toDecimalPlaces(2).toNumber();

export function moneyState(i: MoneyInput): MoneyState {
  const received = i.received ?? 0;
  if (i.paymentStatus === "paid") {
    const diff = cents(new Prisma.Decimal(received).minus(i.billed).toNumber());
    if ((i.writeOffAmount ?? 0) > 0) return { key: "closed_short", label: "Closed short", tone: "bad", detail: `${usd(i.writeOffAmount ?? 0, 2)} written off${i.writeOffReason ? `: ${i.writeOffReason}` : ""}`, balance: 0 };
    if (diff < 0) return { key: "paid_short", label: "Paid short", tone: "bad", detail: `${usd(-diff, 2)} short of ${usd(i.billed, 2)}`, balance: 0 };
    if (diff > 0) return { key: "paid_over", label: "Paid, over", tone: "info", detail: `${usd(diff, 2)} over ${usd(i.billed, 2)}`, balance: 0 };
    return { key: "paid", label: "Paid", tone: "ok", detail: null, balance: 0 };
  }
  if (i.paymentStatus === "invoiced") {
    const balance = Math.max(0, cents(new Prisma.Decimal(i.billed).minus(received).toNumber()));
    const late = (i.overdueDays ?? 0) > 0 ? (i.overdueDays as number) : 0;
    const lateWords = late > 0 ? `${late} ${late === 1 ? "day" : "days"} overdue` : null;
    if (received > 0) return { key: late > 0 ? "part_overdue" : "part", label: "Part paid", tone: late > 0 ? "bad" : "warn", detail: `${usd(received, 2)} in, ${usd(balance, 2)} to come${lateWords ? ` · ${lateWords}` : ""}`, balance };
    if (late > 0) return { key: "overdue", label: "Overdue", tone: "bad", detail: lateWords, balance };
    return { key: "out", label: "Out and waiting", tone: "warn", detail: null, balance };
  }
  return { key: "not_invoiced", label: "Not invoiced yet", tone: "info", detail: null, balance: 0 };
}
