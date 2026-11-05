/**
 * Where a driver statement stands on being paid, as one badge: paid by the payroll company (its run cleared), paid another way (a check, a transfer), with payroll and not cleared yet, or
 * nothing yet. Pure, so the Settlements list, the statement and the Payroll screen say it the same way. A statement paid by payroll is the company's own event; one marked paid by hand
 * is a person's, and the two are not confused.
 */
export type PayBadge = { label: string; tone: "ok" | "warn"; detail: string };

const METHOD: Record<string, string> = { check: "Check", transfer: "Transfer", cash: "Cash", other: "Other", payroll: "Payroll" };

const day = (d: Date | string) => new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

export function statementPayBadge(s: { paidAt: Date | string | null; paidMethod: string | null; payrollSentAt: Date | string | null; payrollReference: string | null }): PayBadge | null {
  if (s.paidAt) {
    if (s.paidMethod === "payroll") return { label: "Paid by payroll", tone: "ok", detail: `${day(s.paidAt)}${s.payrollReference ? `, run ${s.payrollReference}` : ""}` };
    return { label: s.paidMethod ? `Paid, ${METHOD[s.paidMethod] ?? s.paidMethod}` : "Paid", tone: "ok", detail: day(s.paidAt) };
  }
  if (s.payrollSentAt) return { label: "With payroll", tone: "warn", detail: `sent ${day(s.payrollSentAt)}${s.payrollReference ? `, run ${s.payrollReference}` : ""}, not cleared yet` };
  return null;
}
