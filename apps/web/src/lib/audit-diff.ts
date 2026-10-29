/**
 * The audit trail's vocabulary and its before/after diff. Pure, so the server (which writes events) and the pages
 * (which show them) agree on the words.
 */
import { percentText } from "./pay";

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
  if (kind === "percent") return percentText(rate);
  return kind === "flat" ? `Flat $${r}` : kind === "cpm" ? `$${r}/mi` : `$${r}/hr`;
}

export type AuditAction =
  | "assigned"
  | "reassigned"
  | "unassigned"
  | "sent"
  | "accepted"
  | "declined"
  | "cancelled"
  | "deleted"
  | "restored"
  | "tonu"
  | "rescheduled"
  | "invoiced"
  | "paid"
  | "rate_con_saved"
  | "booked"
  | "load_edited"
  | "trip_started"
  | "delivered"
  | "expenses_changed"
  | "payment_undone"
  | "statement_started"
  | "statement_finalized"
  | "statement_voided"
  | "statement_discarded"
  | "thresholds_changed"
  | "company_changed"
  | "driver_added"
  | "driver_changed"
  | "driver_deactivated"
  | "driver_reactivated"
  | "truck_added"
  | "truck_changed"
  | "truck_archived"
  | "truck_restored"
  | "cost_profile_changed";

export const ACTION_LABEL: Record<string, string> = {
  assigned: "Driver assigned",
  reassigned: "Driver or pay changed",
  unassigned: "Driver removed",
  sent: "Sent to driver",
  accepted: "Driver accepted",
  declined: "Driver declined",
  cancelled: "Load cancelled",
  deleted: "Load deleted",
  restored: "Load restored",
  tonu: "TONU recorded",
  rescheduled: "Pickup rescheduled",
  invoiced: "Invoice created",
  paid: "Marked paid",
  rate_con_saved: "Created from a rate confirmation",
  booked: "Booked from a quote",
  load_edited: "Load details changed",
  trip_started: "Picked up",
  delivered: "Delivered",
  expenses_changed: "Expenses changed",
  payment_undone: "Payment undone",
  statement_started: "Statement started",
  statement_finalized: "Statement finalized",
  statement_voided: "Statement voided",
  statement_discarded: "Statement discarded",
  thresholds_changed: "Thresholds changed",
  company_changed: "Company details changed",
  driver_added: "Driver added",
  driver_changed: "Driver changed",
  driver_deactivated: "Driver deactivated",
  driver_reactivated: "Driver reactivated",
  truck_added: "Truck added",
  truck_changed: "Truck changed",
  truck_archived: "Truck archived",
  truck_restored: "Truck restored",
  cost_profile_changed: "Cost profile changed"
};

export const ACTION_TONE: Record<string, "ok" | "warn" | "bad" | "info" | "muted"> = {
  assigned: "info",
  reassigned: "warn",
  unassigned: "bad",
  sent: "info",
  accepted: "ok",
  declined: "bad",
  cancelled: "bad",
  deleted: "bad",
  restored: "ok",
  tonu: "warn",
  rescheduled: "warn",
  invoiced: "info",
  paid: "ok",
  rate_con_saved: "muted",
  booked: "ok",
  load_edited: "muted",
  trip_started: "info",
  delivered: "ok",
  expenses_changed: "muted",
  payment_undone: "warn",
  statement_started: "info",
  statement_finalized: "ok",
  statement_voided: "bad",
  statement_discarded: "muted",
  thresholds_changed: "muted",
  company_changed: "muted",
  driver_added: "info",
  driver_changed: "muted",
  driver_deactivated: "bad",
  driver_reactivated: "ok",
  truck_added: "info",
  truck_changed: "muted",
  truck_archived: "bad",
  truck_restored: "ok",
  cost_profile_changed: "warn"
};

/** The filter chips on the audit page: which actions belong to which group. */
export const AUDIT_GROUPS: Array<{ key: string; label: string; actions: string[] }> = [
  { key: "dispatch", label: "Dispatch", actions: ["booked", "load_edited", "trip_started", "delivered", "assigned", "reassigned", "unassigned", "sent", "accepted", "declined", "cancelled", "deleted", "restored", "tonu", "rescheduled"] },
  { key: "money", label: "Money", actions: ["expenses_changed", "invoiced", "paid", "payment_undone", "statement_started", "statement_finalized", "statement_voided", "statement_discarded"] },
  { key: "intake", label: "Intake", actions: ["rate_con_saved"] },
  { key: "fleet", label: "Fleet", actions: ["driver_added", "driver_changed", "driver_deactivated", "driver_reactivated", "truck_added", "truck_changed", "truck_archived", "truck_restored", "cost_profile_changed"] },
  { key: "settings", label: "Settings", actions: ["thresholds_changed", "company_changed"] }
];
