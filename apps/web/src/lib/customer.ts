import { normalizeMcNumber } from "./fmcsa";

/**
 * A customer as a record: what kind it is, its MC if it is a broker or carrier, who to write to about an invoice, the terms it usually pays on,
 * and a note. A load keeps its customer's name as text; this is the profile attached to that name. Checked here and again on the server. Pure.
 */
export const CUSTOMER_KINDS = [
  { key: "broker", label: "Broker" },
  { key: "shipper", label: "Shipper or direct customer" },
  { key: "other", label: "Other" }
] as const;

export type CustomerKind = (typeof CUSTOMER_KINDS)[number]["key"];

export const kindLabel = (key: string | null | undefined): string => CUSTOMER_KINDS.find((k) => k.key === key)?.label ?? "";

export type CustomerValues = {
  name: string;
  kind: string;
  mcNumber: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  /** Whole days, blank for none. */
  defaultPayTermsDays: string;
  notes: string;
};

export type CustomerInput = {
  name: string;
  kind: CustomerKind;
  mcNumber: string | null;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  defaultPayTermsDays: number | null;
  notes: string | null;
};

export const BLANK_CUSTOMER: CustomerValues = { name: "", kind: "broker", mcNumber: "", contactName: "", contactEmail: "", contactPhone: "", defaultPayTermsDays: "", notes: "" };

export type CustomerCheck = { ok: true; value: CustomerInput } | { ok: false; errors: Partial<Record<keyof CustomerValues, string>> };

const t = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const orNull = (s: string) => (s === "" ? null : s);

export function validateCustomer(v: CustomerValues): CustomerCheck {
  const errors: Partial<Record<keyof CustomerValues, string>> = {};
  const name = t(v.name).replace(/\s+/g, " ");
  if (name.length < 2) errors.name = "Who is it? The name as it is on the rate confirmation or invoice.";
  else if (name.length > 80) errors.name = "Too long (80 characters at most).";
  const kind = CUSTOMER_KINDS.find((k) => k.key === t(v.kind));
  if (!kind) errors.kind = "Pick what kind of customer this is.";
  // A broker or carrier has an MC. A shipper or direct customer has none, and leaving it blank is never a problem.
  const raw = t(v.mcNumber);
  const mc = raw === "" ? null : normalizeMcNumber(raw);
  if (raw !== "" && (mc == null || !/^\d{3,8}$/.test(mc))) errors.mcNumber = "Digits only, for example 123456.";
  const email = t(v.contactEmail);
  if (email !== "" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.contactEmail = "An email address, for example ap@example.com.";
  const phone = t(v.contactPhone);
  const digits = phone.replace(/\D/g, "");
  if (phone !== "" && (digits.length < 7 || digits.length > 15 || /[^\d\s()+.\-x]/i.test(phone))) errors.contactPhone = "A phone number, for example 555-0142.";
  if (t(v.contactName).length > 60) errors.contactName = "Too long (60 characters at most).";
  const termsRaw = t(v.defaultPayTermsDays);
  let terms: number | null = null;
  if (termsRaw !== "") {
    const n = Number(termsRaw);
    if (!Number.isInteger(n) || n < 0 || n > 120) errors.defaultPayTermsDays = "Whole days, 0 to 120.";
    else terms = n;
  }
  if (t(v.notes).length > 1000) errors.notes = "Too long (1,000 characters at most).";
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: { name, kind: kind!.key, mcNumber: mc, contactName: orNull(t(v.contactName)), contactEmail: orNull(email), contactPhone: orNull(phone), defaultPayTermsDays: terms, notes: orNull(t(v.notes)) } };
}

export function toCustomerValues(c: { name: string; kind: string; mcNumber: string | null; contactName: string | null; contactEmail: string | null; contactPhone: string | null; defaultPayTermsDays: number | null; notes: string | null }): CustomerValues {
  return { name: c.name, kind: c.kind, mcNumber: c.mcNumber ?? "", contactName: c.contactName ?? "", contactEmail: c.contactEmail ?? "", contactPhone: c.contactPhone ?? "", defaultPayTermsDays: c.defaultPayTermsDays == null ? "" : String(c.defaultPayTermsDays), notes: c.notes ?? "" };
}
