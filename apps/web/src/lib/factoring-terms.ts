/**
 * A fleet's own factoring terms (docs/MONEY_PLAN.md, Wave 2): where a factored invoice must be paid, the notice of assignment wording, and the advance and fee the factor charges.
 * Pure: the form checks with `validateTerms`, the server saves what it returns, and the invoice PDF reads the remit-to with `remitToOf`.
 */
/** How the factor takes invoices: through its API, or as a batch of files (schedule of accounts and packets) by SFTP or email. */
export type Transport = "api" | "batch_sftp" | "batch_email";
export const TRANSPORTS: Array<{ key: Transport; label: string }> = [
  { key: "api", label: "Through the factor's API" },
  { key: "batch_sftp", label: "A batch of files by SFTP" },
  { key: "batch_email", label: "A batch of files by email" }
];

export type TermsForm = {
  transport: Transport;
  /** Where a batch goes: an SFTP address or an email address. */
  batchDestination: string;
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

export const BLANK_TERMS: TermsForm = { transport: "api", batchDestination: "", factorName: "", remitName: "", remitAddress: "", lockboxBank: "", routingNumber: "", accountNumber: "", noaText: "", advancePct: "", feePct: "" };

export type TermsValue = {
  transport: "api" | "batch";
  batchMethod: "sftp" | "email" | null;
  batchDestination: string | null;
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
  const transport: Transport = f.transport === "batch_sftp" || f.transport === "batch_email" ? f.transport : "api";
  const method = transport === "batch_sftp" ? "sftp" : transport === "batch_email" ? "email" : null;
  const dest = f.batchDestination.trim();
  if (method) {
    const problem = destinationProblem(method, dest);
    if (problem) errors.batchDestination = problem;
  }
  if (adv === "bad") errors.advancePct = "A percentage from 0 to 100, like 90.";
  if (fee === "bad") errors.feePct = "A percentage from 0 to 100, like 2.5.";
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      transport: method ? "batch" : "api",
      batchMethod: method,
      batchDestination: method ? dest : null,
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

/** Where a batch goes, as typed: an email address, or an SFTP address (sftp://host[:port]/path, or host:/path). Null when it is right; the problem in words when not. */
export function destinationProblem(method: "sftp" | "email", destination: string): string | null {
  const d = destination.trim();
  if (d === "") return method === "email" ? "Type the factor's email address for batches." : "Type the factor's SFTP address, like sftp://files.factor.com/inbox.";
  if (d.length > 200) return "200 characters at most.";
  if (method === "email") return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d) ? null : "That is not an email address.";
  return /^sftp:\/\/[A-Za-z0-9.-]+(:\d{1,5})?(\/[^\s]*)?$/.test(d) || /^[A-Za-z0-9.-]+:\/(?!\/)[^\s]*$/.test(d) ? null : "Type it as sftp://host/path (or host:/path).";
}
