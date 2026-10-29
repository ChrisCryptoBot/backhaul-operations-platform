/**
 * The company on invoices and driver statements: its name, its authority numbers, where it is and where payments go. Everything except the
 * name is optional, and a sheet prints only what is filled in. Checked here and again on the server. Pure.
 */
export type CompanyValues = {
  name: string;
  mcNumber: string;
  dotNumber: string;
  address: string;
  phone: string;
  email: string;
  remitTo: string;
  paymentNote: string;
};

export type Company = { [K in keyof CompanyValues]: K extends "name" ? string : string | null };

export const BLANK_COMPANY: CompanyValues = { name: "", mcNumber: "", dotNumber: "", address: "", phone: "", email: "", remitTo: "", paymentNote: "" };

export type CompanyCheck = { ok: true; value: Company } | { ok: false; errors: Partial<Record<keyof CompanyValues, string>> };

const t = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const orNull = (s: string) => (s === "" ? null : s);

export function validateCompany(v: CompanyValues): CompanyCheck {
  const errors: Partial<Record<keyof CompanyValues, string>> = {};
  const name = t(v.name);
  if (name.length < 2) errors.name = "The company's name, as it should print on an invoice.";
  else if (name.length > 80) errors.name = "Too long (80 characters at most).";
  const authority = (key: "mcNumber" | "dotNumber", prefix: RegExp) => {
    const s = t(v[key]).replace(prefix, "");
    if (s !== "" && !/^\d{3,8}$/.test(s)) errors[key] = "Digits only, for example 123456.";
    return s;
  };
  const mc = authority("mcNumber", /^mc[\s-]*/i);
  const dot = authority("dotNumber", /^(us)?dot[\s-]*/i);
  const address = t(v.address);
  if (address.length > 300) errors.address = "Too long (300 characters at most).";
  const phone = t(v.phone);
  const digits = phone.replace(/\D/g, "");
  if (phone !== "" && (digits.length < 7 || digits.length > 15 || /[^\d\s()+.\-x]/i.test(phone))) errors.phone = "A phone number, for example 555-0142.";
  const email = t(v.email);
  if (email !== "" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = "An email address, for example billing@example.com.";
  const remitTo = t(v.remitTo);
  if (remitTo.length > 300) errors.remitTo = "Too long (300 characters at most).";
  const paymentNote = t(v.paymentNote);
  if (paymentNote.length > 300) errors.paymentNote = "Too long (300 characters at most).";
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: { name, mcNumber: orNull(mc), dotNumber: orNull(dot), address: orNull(address), phone: orNull(phone), email: orNull(email), remitTo: orNull(remitTo), paymentNote: orNull(paymentNote) } };
}

/** One line of identity for a sheet's header: "MC 123456 · DOT 7890123 · 555-0142 · billing@example.com". */
export function companyLine(c: Company): string {
  return [c.mcNumber ? `MC ${c.mcNumber}` : null, c.dotNumber ? `DOT ${c.dotNumber}` : null, c.phone, c.email].filter(Boolean).join(" · ");
}

export function toCompanyValues(c: Company): CompanyValues {
  return { name: c.name, mcNumber: c.mcNumber ?? "", dotNumber: c.dotNumber ?? "", address: c.address ?? "", phone: c.phone ?? "", email: c.email ?? "", remitTo: c.remitTo ?? "", paymentNote: c.paymentNote ?? "" };
}
