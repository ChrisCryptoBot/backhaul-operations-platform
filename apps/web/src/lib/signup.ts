/**
 * Who signs themselves up and who gets a person. The line is one number: a fleet of ENTERPRISE_TRUCKS or more is set up by a person (it has terminals, imports and
 * connections that need hands), everyone under it creates their own account. The server decides from the truck count; a form can never choose its own kind.
 */
export const ENTERPRISE_TRUCKS = 50;
export const MAX_TRUCKS = 100_000;

export type SignupKind = "self_serve" | "enterprise";

export const kindFor = (trucks: number): SignupKind => (trucks >= ENTERPRISE_TRUCKS ? "enterprise" : "self_serve");

/** A whole number of trucks from what was typed ("12", " 1,500 "), or null when it is not one (empty, negative, fractional, absurd). */
export function parseTrucks(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isInteger(raw) && raw >= 1 && raw <= MAX_TRUCKS ? raw : null;
  if (typeof raw !== "string") return null;
  const t = raw.trim().replace(/,/g, "");
  if (!/^\d{1,6}$/.test(t)) return null;
  const n = Number(t);
  return n >= 1 && n <= MAX_TRUCKS ? n : null;
}

export type RequestValues = {
  name: string;
  company: string;
  role: string;
  email: string;
  phone: string;
  trucks: string;
  mcNumber: string;
  bestTime: string;
  note: string;
};

export const EMPTY_REQUEST: RequestValues = { name: "", company: "", role: "", email: "", phone: "", trucks: "", mcNumber: "", bestTime: "", note: "" };

export type RequestErrors = Partial<Record<keyof RequestValues, string>>;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const LIMITS: Partial<Record<keyof RequestValues, number>> = { name: 120, company: 160, role: 120, email: 200, phone: 40, mcNumber: 40, bestTime: 160, note: 1500 };

/** Read the fields of a request form as trimmed strings (anything that is not text counts as empty). */
export function readRequest(form: FormData): RequestValues {
  const out = { ...EMPTY_REQUEST };
  for (const k of Object.keys(out) as Array<keyof RequestValues>) {
    const v = form.get(k);
    out[k] = typeof v === "string" ? v.trim() : "";
  }
  return out;
}

/** What is wrong with a request, field by field. `enterprise` also asks for a phone number or a best time to call, since a person will phone. */
export function checkRequest(v: RequestValues, kind: SignupKind): RequestErrors {
  const e: RequestErrors = {};
  if (!v.name) e.name = "Tell us your name.";
  if (!v.company) e.company = "Tell us the company.";
  if (!v.email) e.email = "An email is how we reach you.";
  else if (!EMAIL.test(v.email)) e.email = "That does not look like an email.";
  if (parseTrucks(v.trucks) == null) e.trucks = "Enter how many trucks, as a whole number.";
  if (kind === "enterprise" && !v.phone && !v.bestTime) e.phone = "Give a phone number, or a time that suits for us to reach you.";
  for (const [k, max] of Object.entries(LIMITS) as Array<[keyof RequestValues, number]>) {
    if (!e[k] && v[k].length > max) e[k] = `Keep this under ${max} characters.`;
  }
  return e;
}
