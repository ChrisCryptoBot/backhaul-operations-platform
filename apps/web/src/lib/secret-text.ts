import { rateConTotal } from "./pay";

/**
 * Finds whether a secret load-money number `n` appears in free text sent to a driver (rate-con/load notes, stop dock notes, or settlement line detail).
 * Commas and dollar signs are stripped from the text before checking, regex metacharacters in `n` are properly escaped so `.` never acts as a wildcard,
 * and both `String(n)` and `n.toFixed(2)` are matched (e.g. `1499.5` catches `"1499.50"`, `"$2,500"` catches `2500`, while `"12.5 pallets"` does not match `1205`).
 */
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function numberInText(rawText: string, n: number): boolean {
  if (!Number.isFinite(n) || n === 0) return false;
  const abs = Math.abs(n);
  const text = rawText.replaceAll(",", "").replaceAll("$", "");
  const forms = new Set([String(abs), abs.toFixed(2)]);
  for (const form of forms) {
    const pattern = new RegExp(`(^|[^0-9.])${escapeRegExp(form)}([^0-9]|$)`);
    if (pattern.test(text)) return true;
  }
  return false;
}

const posNum = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const parsed = Number(String(v));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

/** Every positive load-money figure on a load that must never leak to a company driver's screen. */
export function loadSecrets(load: {
  quotedRevenue?: unknown;
  actualRevenue?: unknown;
  fuelSurcharge?: unknown;
  tonuRevenue?: unknown;
  layoverPay?: unknown;
  invoicedAmount?: unknown;
} | null | undefined): number[] {
  if (!load) return [];
  const q = posNum(load.quotedRevenue);
  const a = posNum(load.actualRevenue);
  const f = posNum(load.fuelSurcharge);
  const rc = q != null || f != null ? posNum(rateConTotal(q ?? 0, f ?? 0)) : null;
  const tonu = posNum(load.tonuRevenue);
  const layover = posNum(load.layoverPay);
  const invoiced = posNum(load.invoicedAmount);
  return [...new Set([q, a, f, rc, tonu, layover, invoiced].filter((x): x is number => x != null && x > 0))];
}
