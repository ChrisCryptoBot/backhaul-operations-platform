/**
 * The yearly contractor 1099 figures (docs/MONEY_PLAN.md, Wave 4 step 2). Pure: the server reads the statement rows (`SettlementLine`, never the statement's JSON) and hands them here.
 *
 * Two figures per contractor:
 *   - gross compensation paid: what a 1099-NEC box 1 reports, and what the threshold is checked against. Pay lines only, before fuel, deductions and advances.
 *   - net cash paid: every row of the statement, which is the statement's total.
 *
 * A row kind is either pay (counts in gross) or money off (never lowers gross). Adjustments are typed by hand and signed today, so a positive one is pay (a bonus) and a negative one is
 * money off (it does not lower gross). Step 3 brings typed kinds (deduction, advance_repaid, escrow): each new kind only needs adding to one of the sets below. A kind in neither set is
 * named as unknown so it is never silently counted as pay.
 *
 * Money is counted in whole cents (integers), so a sum never drifts by a fraction of a cent.
 */

/**
 * The reporting threshold for payments made in a tax year: $2,000 for payments in 2026 and later (the 2025 change), $600 before. Subject to confirmation by the carrier's accountant before
 * filing season; every place it shows says so (THRESHOLD_NOTE).
 */
export function form1099Threshold(taxYear: number): number {
  return taxYear >= 2026 ? 2000 : 600;
}

/** The words that go with the threshold wherever it shows. */
export function thresholdNote(taxYear: number): string {
  return `Reporting threshold $${form1099Threshold(taxYear).toLocaleString("en-US")} for ${taxYear} payments (confirm with your accountant).`;
}

/** Always pay: counts in gross. */
export const GROSS_KINDS: readonly string[] = ["load"];
/** Pay when positive, money off when negative (typed by hand, signed). */
export const SIGNED_KINDS: readonly string[] = ["adjustment"];
/** Always money off: never lowers gross. */
export const MONEY_OFF_KINDS: readonly string[] = ["fuel"];

export type LineClass = "gross" | "off" | "unknown";

export function classifyLine(kind: string, cents: number): LineClass {
  if (GROSS_KINDS.includes(kind)) return "gross";
  if (SIGNED_KINDS.includes(kind)) return cents > 0 ? "gross" : "off";
  if (MONEY_OFF_KINDS.includes(kind)) return "off";
  return "unknown";
}

/** "123.45", "-80", "0.1" as whole cents. Two decimals at most, as the rows are stored; anything else is refused (null), never rounded. */
export function toCents(amount: string): number | null {
  const m = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(amount.trim());
  if (!m) return null;
  const whole = Number.parseInt(m[2]!, 10);
  const frac = Number.parseInt((m[3] ?? "0").padEnd(2, "0"), 10);
  const c = whole * 100 + frac;
  return m[1] && c !== 0 ? -c : c;
}

export const fromCents = (c: number): number => c / 100;

export type Tally = { grossCents: number; netCents: number; offCents: number; unknownKinds: string[] };

/** Gross and net for a set of rows. Net is the sum of every row; gross is the pay rows; off is the money taken off (zero or negative). */
export function tallyLines(lines: ReadonlyArray<{ kind: string; cents: number }>): Tally {
  let grossCents = 0;
  let netCents = 0;
  let offCents = 0;
  const unknown = new Set<string>();
  for (const l of lines) {
    netCents += l.cents;
    const c = classifyLine(l.kind, l.cents);
    if (c === "gross") grossCents += l.cents;
    else if (c === "off") offCents += l.cents;
    else unknown.add(l.kind);
  }
  return { grossCents, netCents, offCents, unknownKinds: [...unknown].sort() };
}

export type TaxProfile = {
  legalName: string | null;
  tinType: string | null;
  tinLast4: string | null;
  tinStatus: string;
  taxAddressLine1: string | null;
  taxCity: string | null;
  taxState: string | null;
  taxZip: string | null;
};

/** What a 1099 is missing for this driver, in words. Empty when it is complete. */
export function profileGaps(p: TaxProfile): string[] {
  const gaps: string[] = [];
  if (!p.legalName?.trim()) gaps.push("legal name");
  if (!p.tinLast4) gaps.push("TIN last four");
  if (p.tinStatus === "none") gaps.push("TIN not collected");
  if (!p.taxAddressLine1?.trim() || !p.taxCity?.trim() || !p.taxState?.trim() || !p.taxZip?.trim()) gaps.push("mailing address");
  return gaps;
}

/** One line of the mailing address, "12 Main St, Apt 4, Dallas, TX 75201", or null when none is set. */
export function addressText(a: { taxAddressLine1: string | null; taxAddressLine2?: string | null; taxCity: string | null; taxState: string | null; taxZip: string | null }): string | null {
  const parts = [a.taxAddressLine1, a.taxAddressLine2, a.taxCity].map((s) => s?.trim()).filter(Boolean);
  const tail = [a.taxState?.trim(), a.taxZip?.trim()].filter(Boolean).join(" ");
  const all = [...parts, tail].filter(Boolean);
  return all.length === 0 ? null : all.join(", ");
}

export const TIN_TYPES = [
  { key: "ssn", label: "SSN" },
  { key: "ein", label: "EIN" }
];
export const TIN_STATUSES = [
  { key: "none", label: "Not collected" },
  { key: "collected", label: "Collected by payroll" },
  { key: "verified", label: "Verified" }
];
export const tinTypeLabel = (k: string | null) => TIN_TYPES.find((t) => t.key === k)?.label ?? null;
export const tinStatusLabel = (k: string) => TIN_STATUSES.find((t) => t.key === k)?.label ?? k;

/** US postal codes a 1099 can be mailed to: the states, DC and the territories. */
export const POSTAL_STATES = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
  "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY", "AS", "GU", "MP", "PR", "VI"
] as const;

/** The tax year a 1099 page opens on: the year before the one it is now in the carrier's zone (filing season is early in the new year). */
export const defaultTaxYear = (currentYear: number) => currentYear - 1;
