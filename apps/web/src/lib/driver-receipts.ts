/** Money a driver spent on the job and asked for (sync plan Step 5b), the rules a screen and the server share. Pure. The kinds are the phone project's (20261122000600_bridge_driver_receipts.sql). */
export const RECEIPT_KINDS = ["fuel", "tolls", "lumper", "scale", "parking", "repair", "other"] as const;
export type ReceiptKind = (typeof RECEIPT_KINDS)[number];
export const RECEIPT_LABEL: Record<ReceiptKind, string> = { fuel: "Fuel", tolls: "Tolls", lumper: "Lumper", scale: "Scale", parking: "Parking", repair: "Repair", other: "Other" };
export const isReceiptKind = (v: unknown): v is ReceiptKind => typeof v === "string" && (RECEIPT_KINDS as readonly string[]).includes(v);

export type ReceiptState = "submitted" | "approved" | "declined";
/** What the phone is told. `settled`: on a final statement, not paid yet. */
export type BridgeReceiptState = ReceiptState | "settled" | "paid";

/** A row of `bridge.driver_receipts`, as the desk reads it. */
export type BridgeReceiptRow = {
  id: string;
  org_id: string;
  driver_sub: string;
  amount_cents: number;
  kind: string;
  spent_on: string;
  note: string | null;
  source_load_id: string | null;
  path: string;
  state: string;
  reason: string | null;
  statement_number: string | null;
  taken_at: string | null;
  created_at: string;
};

/** A row the desk can take: its own fleet's, with an amount and a kind it knows. */
export function takeable(r: BridgeReceiptRow, orgId: string): boolean {
  return r.org_id === orgId && Number.isSafeInteger(r.amount_cents) && r.amount_cents > 0 && r.amount_cents <= 1_000_000 && isReceiptKind(r.kind) && /^\d{4}-\d{2}-\d{2}$/.test(r.spent_on);
}

const monthDay = (ymd: string) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
/** The statement's line: "Reimbursed: Tolls, Nov 12". */
export const reimbursedLabel = (r: { kind: string; spentOn: string }): string => `Reimbursed: ${isReceiptKind(r.kind) ? RECEIPT_LABEL[r.kind] : "Receipt"}, ${monthDay(r.spentOn)}`;

/** What the phone should say now: the decision, then the statement it is on, then that it was paid. */
export function bridgeState(r: { state: string; reason: string | null; settlement: { number: string; paidAt: Date | null } | null }): { state: BridgeReceiptState; reason: string | null; statement_number: string | null } {
  if (r.state === "declined") return { state: "declined", reason: r.reason, statement_number: null };
  if (r.state !== "approved") return { state: "submitted", reason: null, statement_number: null };
  if (!r.settlement) return { state: "approved", reason: null, statement_number: null };
  return { state: r.settlement.paidAt ? "paid" : "settled", reason: null, statement_number: r.settlement.number };
}

export const MIN_REASON = 3;
export const MAX_REASON = 200;
