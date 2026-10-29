/**
 * The audit trail's vocabulary and its before/after diff. Pure, so the server (which writes events) and the pages
 * (which show them) agree on the words.
 */
export type AuditSnapshot = Record<string, string | number | null>;
export type DiffRow = { field: string; from: string; to: string; changed: boolean };

const show = (v: unknown): string => (v == null || v === "" ? "—" : String(v));

/** Field-by-field comparison of two snapshots, in the order the fields first appear. */
export function diffSnapshots(before: AuditSnapshot | null | undefined, after: AuditSnapshot | null | undefined): DiffRow[] {
  const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])];
  return keys.map((field) => {
    const from = show(before?.[field]);
    const to = show(after?.[field]);
    return { field, from, to, changed: from !== to };
  });
}

export function describePay(kind: string, rate: number): string {
  const r = rate.toFixed(2);
  return kind === "flat" ? `Flat $${r}` : kind === "cpm" ? `$${r}/mi` : `$${r}/hr`;
}

export type AuditAction = "assigned" | "reassigned" | "unassigned" | "sent" | "accepted" | "declined" | "invoiced" | "paid" | "rate_con_saved";

export const ACTION_LABEL: Record<string, string> = {
  assigned: "Driver assigned",
  reassigned: "Driver or pay changed",
  unassigned: "Driver removed",
  sent: "Sent to driver",
  accepted: "Driver accepted",
  declined: "Driver declined",
  invoiced: "Invoice created",
  paid: "Marked paid",
  rate_con_saved: "Created from a rate confirmation"
};

export const ACTION_TONE: Record<string, "ok" | "warn" | "bad" | "info" | "muted"> = {
  assigned: "info",
  reassigned: "warn",
  unassigned: "bad",
  sent: "info",
  accepted: "ok",
  declined: "bad",
  invoiced: "info",
  paid: "ok",
  rate_con_saved: "muted"
};

/** The filter chips on the audit page: which actions belong to which group. */
export const AUDIT_GROUPS: Array<{ key: string; label: string; actions: string[] }> = [
  { key: "dispatch", label: "Dispatch", actions: ["assigned", "reassigned", "unassigned", "sent", "accepted", "declined"] },
  { key: "money", label: "Money", actions: ["invoiced", "paid"] },
  { key: "intake", label: "Intake", actions: ["rate_con_saved"] }
];
