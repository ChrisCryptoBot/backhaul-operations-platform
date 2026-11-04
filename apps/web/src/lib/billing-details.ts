/**
 * What the accounting office may change on a load: who it is billed to and how to reach them, the customer's PO, the terms, and a note on why the money is what it is. Nothing about
 * the freight, the stops or the driver. Checked here and again on the server. Pure.
 */
export type BillingDetailsValues = { brokerName: string; brokerMcNumber: string; brokerPhone: string; brokerEmail: string; poNumber: string; payTermsDays: string; revenueNote: string };
export type BillingDetailsInput = { brokerName: string; brokerMcNumber: string | null; brokerPhone: string | null; brokerEmail: string | null; poNumber: string | null; payTermsDays: number | null; revenueNote: string | null };
export type BillingDetailsErrors = Record<string, string>;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const t = (v: unknown) => (typeof v === "string" ? v.trim().replace(/\s+/g, " ") : "");

export function validateBillingDetails(v: BillingDetailsValues): { ok: true; value: BillingDetailsInput } | { ok: false; errors: BillingDetailsErrors } {
  const errors: BillingDetailsErrors = {};
  const brokerName = t(v.brokerName);
  if (brokerName === "") errors.brokerName = "Who is it billed to?";
  else if (brokerName.length > 120) errors.brokerName = "120 characters at most.";
  const mc = t(v.brokerMcNumber).replace(/^mc[\s#-]*/i, "");
  if (mc !== "" && !/^\d{1,10}$/.test(mc)) errors.brokerMcNumber = "An MC number is digits only.";
  const phone = t(v.brokerPhone);
  if (phone.length > 30) errors.brokerPhone = "30 characters at most.";
  const email = t(v.brokerEmail).toLowerCase();
  if (email !== "" && (!EMAIL.test(email) || email.length > 120)) errors.brokerEmail = "That does not look like an email.";
  const po = t(v.poNumber);
  if (po.length > 60) errors.poNumber = "60 characters at most.";
  let payTermsDays: number | null = null;
  const termsRaw = t(v.payTermsDays);
  if (termsRaw !== "") {
    const n = /^\d{1,3}$/.test(termsRaw) ? Number(termsRaw) : Number.NaN;
    if (!Number.isInteger(n) || n < 0 || n > 120) errors.payTermsDays = "Whole days, 0 to 120. 0 is due on receipt.";
    else payTermsDays = n;
  }
  const note = t(v.revenueNote);
  if (note.length > 300) errors.revenueNote = "300 characters at most.";
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: { brokerName, brokerMcNumber: mc === "" ? null : mc, brokerPhone: phone === "" ? null : phone, brokerEmail: email === "" ? null : email, poNumber: po === "" ? null : po, payTermsDays, revenueNote: note === "" ? null : note } };
}
