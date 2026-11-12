/**
 * A fleet's own factoring terms (docs/MONEY_PLAN.md, Wave 2): where a factored invoice must be paid, the notice of assignment wording, and the advance and fee the factor charges.
 * Pure: the form checks with `validateTerms`, the server saves what it returns, and the invoice PDF reads the remit-to with `remitToOf`.
 */
export type TermsForm = {
  factorName: string;
  remitName: string;
  remitAddress: string;
  lockboxBank: string;
  routingNumber: string;
  accountNumber: string;
  noaText: string;
  advancePct: string;
  feePct: string;
};

export const BLANK_TERMS: TermsForm = { factorName: "", remitName: "", remitAddress: "", lockboxBank: "", routingNumber: "", accountNumber: "", noaText: "", advancePct: "", feePct: "" };

export type TermsValue = {
  factorName: string | null;
  remitName: string | null;
  remitAddress: string | null;
  lockboxBank: string | null;
  routingNumber: string | null;
  accountNumber: string | null;
  noaText: string | null;
  advancePct: string | null;
  feePct: string | null;
};

export type TermsCheck = { ok: true; value: TermsValue } | { ok: false; errors: Partial<Record<keyof TermsForm, string>> };

const clean = (s: string) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim();
const orNull = (s: string) => (s === "" ? null : s);

/** A percentage typed as 90, 90.5 or 2.25: 0 to 100 with at most two decimals. Kept as text so a figure never passes through floating point. */
function pct(text: string): string | null | "bad" {
  const t = text.trim().replace(/%$/, "").trim();
  if (t === "") return null;
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(t)) return "bad";
  const whole = Number.parseInt(t.split(".")[0]!, 10);
  if (whole > 100 || (whole === 100 && /\.\d*[1-9]/.test(t))) return "bad";
  return t;
}

export function validateTerms(f: TermsForm): TermsCheck {
  const errors: Partial<Record<keyof TermsForm, string>> = {};
  const factorName = clean(f.factorName);
  const remitName = clean(f.remitName);
  const remitAddress = f.remitAddress.split("\n").map(clean).filter(Boolean).join("\n");
  const lockboxBank = clean(f.lockboxBank);
  const routing = f.routingNumber.replace(/[\s-]/g, "");
  const account = f.accountNumber.replace(/[\s-]/g, "");
  const noa = clean(f.noaText);
  if (factorName.length > 80) errors.factorName = "80 characters at most.";
  if (remitName.length > 120) errors.remitName = "120 characters at most.";
  if (remitAddress.length > 300) errors.remitAddress = "300 characters at most.";
  if (lockboxBank.length > 120) errors.lockboxBank = "120 characters at most.";
  if (routing !== "" && !/^\d{9}$/.test(routing)) errors.routingNumber = "A routing number is nine digits.";
  if (account !== "" && !/^\d{4,17}$/.test(account)) errors.accountNumber = "An account number is 4 to 17 digits.";
  if (noa.length > 600) errors.noaText = "600 characters at most.";
  const adv = pct(f.advancePct);
  const fee = pct(f.feePct);
  if (adv === "bad") errors.advancePct = "A percentage from 0 to 100, like 90.";
  if (fee === "bad") errors.feePct = "A percentage from 0 to 100, like 2.5.";
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      factorName: orNull(factorName),
      remitName: orNull(remitName),
      remitAddress: orNull(remitAddress),
      lockboxBank: orNull(lockboxBank),
      routingNumber: orNull(routing),
      accountNumber: orNull(account),
      noaText: orNull(noa),
      advancePct: adv as string | null,
      feePct: fee as string | null
    }
  };
}

/** What the invoice PDF prints as the factor's remit-to: the payee, the address, and the lockbox bank with its routing and account. Null when nothing is on file. */
export function remitToOf(t: Pick<TermsValue, "remitName" | "remitAddress" | "lockboxBank" | "routingNumber" | "accountNumber"> | null): string | null {
  if (!t) return null;
  const bank = [t.lockboxBank, t.routingNumber ? `routing ${t.routingNumber}` : null, t.accountNumber ? `account ${t.accountNumber}` : null].filter(Boolean).join(", ");
  const parts = [t.remitName, t.remitAddress ? t.remitAddress.split("\n").join(", ") : null, bank || null].filter(Boolean);
  return parts.length > 0 ? parts.join(". ") : null;
}

/** The account number with all but its last four digits hidden, for the audit trail and the screen. */
export const maskAccount = (a: string | null): string | null => (a ? `${"*".repeat(Math.max(0, a.length - 4))}${a.slice(-4)}` : null);
