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
  | "rate_con_read"
  | "rate_con_read_failed"
  | "invoice_voided"
  | "payment_part"
  | "document_added"
  | "document_removed"
  | "member_added"
  | "member_role_changed"
  | "member_removed"
  | "booked"
  | "quote_saved"
  | "quote_passed"
  | "quote_discarded"
  | "load_edited"
  | "trip_started"
  | "delivered"
  | "trip_undone"
  | "trip_reopened"
  | "trip_corrected"
  | "load_reopened"
  | "expenses_changed"
  | "payment_undone"
  | "statement_started"
  | "statement_finalized"
  | "statement_voided"
  | "statement_discarded"
  | "statement_saved"
  | "invoice_chased"
  | "detention_waived"
  | "statement_paid"
  | "load_settled"
  | "load_released"
  | "thresholds_changed"
  | "company_changed"
  | "customer_added"
  | "customer_changed"
  | "driver_added"
  | "driver_changed"
  | "driver_deactivated"
  | "driver_reactivated"
  | "schedule_changed"
  | "time_off_added"
  | "time_off_removed"
  | "terminal_added"
  | "terminal_renamed"
  | "terminal_archived"
  | "driver_home_set"
  | "driver_code_changed"
  | "truck_added"
  | "truck_changed"
  | "truck_archived"
  | "truck_restored"
  | "import_completed"
  | "factoring_requested"
  | "factoring_updated"
  | "eld_linked"
  | "hos_synced"
  | "eld_fleet_imported"
  | "dwell_adjusted"
  | "dwell_waived"
  | "dwell_reset"
  | "fuel_imported"
  | "carrier_vetted"
  | "payroll_sent"
  | "partner_connected"
  | "partner_credentials_saved"
  | "partner_event"
  | "timezone_changed"
  | "driver_link_flag"
  | "trailer_added"
  | "trailer_changed"
  | "trailer_archived"
  | "trailer_restored"
  | "trailer_hooked"
  | "trailer_unhooked"
  | "trailer_assigned"
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
  rate_con_read: "Rate confirmation read",
  rate_con_read_failed: "Rate confirmation could not be read",
  invoice_voided: "Invoice taken back",
  payment_part: "Part payment received",
  document_added: "Document kept",
  document_removed: "Document removed",
  member_added: "Person added to the desk",
  member_role_changed: "Role changed",
  member_removed: "Person removed from the desk",
  booked: "Booked from a quote",
  quote_saved: "Quote saved",
  quote_passed: "Quote passed",
  quote_discarded: "Quote thrown away",
  load_edited: "Load details changed",
  trip_started: "Picked up",
  delivered: "Delivered",
  trip_undone: "Pickup taken back",
  trip_reopened: "Delivery taken back",
  trip_corrected: "Trip corrected",
  load_reopened: "Load reopened",
  expenses_changed: "Expenses changed",
  payment_undone: "Payment undone",
  statement_started: "Statement started",
  statement_finalized: "Statement finalized",
  statement_voided: "Statement voided",
  statement_discarded: "Statement discarded",
  statement_saved: "Statement saved",
  invoice_chased: "Customer chased",
  detention_waived: "Detention waived",
  statement_paid: "Statement paid",
  load_settled: "Load paid on a statement",
  load_released: "Load released from a statement",
  thresholds_changed: "Thresholds changed",
  company_changed: "Company details changed",
  customer_added: "Customer added",
  customer_changed: "Customer changed",
  driver_added: "Driver added",
  driver_changed: "Driver changed",
  driver_deactivated: "Driver deactivated",
  driver_reactivated: "Driver reactivated",
  schedule_changed: "Shift schedule changed",
  time_off_added: "Time off or shift change added",
  time_off_removed: "Time off or shift change removed",
  terminal_added: "Terminal added",
  terminal_renamed: "Terminal renamed",
  terminal_archived: "Terminal retired",
  driver_home_set: "Home terminal set",
  driver_code_changed: "Driver code changed",
  truck_added: "Truck added",
  truck_changed: "Truck changed",
  truck_archived: "Truck archived",
  truck_restored: "Truck restored",
  import_completed: "Fleet imported from a file",
  factoring_requested: "Invoice sent to a factor",
  factoring_updated: "Factoring updated",
  eld_linked: "Tractor linked to an ELD",
  hos_synced: "Hours of service synced",
  eld_fleet_imported: "Fleet imported from the ELD",
  dwell_adjusted: "Trailer dwell figure changed",
  dwell_waived: "Trailer dwell fee waived",
  dwell_reset: "Trailer dwell back to the company figure",
  fuel_imported: "Fuel imported from a card",
  carrier_vetted: "Carrier checked",
  payroll_sent: "Sent to payroll",
  partner_connected: "Company connected",
  partner_credentials_saved: "Keys saved",
  partner_event: "Company update",
  timezone_changed: "Time zone changed",
  driver_link_flag: "Out of step with the driver's phone",
  trailer_added: "Trailer added",
  trailer_changed: "Trailer changed",
  trailer_archived: "Trailer archived",
  trailer_restored: "Trailer restored",
  trailer_hooked: "Trailer hooked",
  trailer_unhooked: "Trailer unhooked",
  trailer_assigned: "Trailer put on a load",
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
  rate_con_read: "muted",
  rate_con_read_failed: "warn",
  invoice_voided: "warn",
  payment_part: "info",
  document_added: "muted",
  document_removed: "muted",
  member_added: "info",
  member_role_changed: "warn",
  member_removed: "warn",
  booked: "ok",
  quote_saved: "muted",
  quote_passed: "muted",
  quote_discarded: "muted",
  load_edited: "muted",
  trip_started: "info",
  delivered: "ok",
  trip_undone: "warn",
  trip_reopened: "warn",
  trip_corrected: "muted",
  load_reopened: "warn",
  expenses_changed: "muted",
  payment_undone: "warn",
  statement_started: "info",
  statement_finalized: "ok",
  statement_voided: "bad",
  statement_discarded: "muted",
  statement_saved: "muted",
  invoice_chased: "muted",
  detention_waived: "muted",
  statement_paid: "ok",
  load_settled: "muted",
  load_released: "warn",
  thresholds_changed: "muted",
  company_changed: "muted",
  customer_added: "info",
  customer_changed: "muted",
  driver_added: "info",
  driver_changed: "muted",
  driver_deactivated: "bad",
  driver_reactivated: "ok",
  schedule_changed: "muted",
  time_off_added: "muted",
  time_off_removed: "muted",
  terminal_added: "info",
  terminal_renamed: "muted",
  terminal_archived: "muted",
  driver_home_set: "muted",
  driver_code_changed: "muted",
  truck_added: "info",
  truck_changed: "muted",
  truck_archived: "bad",
  truck_restored: "ok",
  import_completed: "info",
  factoring_requested: "info",
  factoring_updated: "muted",
  eld_linked: "info",
  hos_synced: "muted",
  eld_fleet_imported: "info",
  dwell_adjusted: "muted",
  dwell_waived: "warn",
  dwell_reset: "muted",
  fuel_imported: "info",
  carrier_vetted: "info",
  payroll_sent: "ok",
  partner_connected: "info",
  partner_credentials_saved: "info",
  partner_event: "info",
  timezone_changed: "info",
  driver_link_flag: "warn",
  trailer_added: "info",
  trailer_changed: "muted",
  trailer_archived: "bad",
  trailer_restored: "ok",
  trailer_hooked: "info",
  trailer_unhooked: "muted",
  trailer_assigned: "info",
  cost_profile_changed: "warn"
};

/** The filter chips on the audit page: which actions belong to which group. */
export const AUDIT_GROUPS: Array<{ key: string; label: string; actions: string[] }> = [
  { key: "dispatch", label: "Dispatch", actions: ["booked", "quote_saved", "quote_passed", "quote_discarded", "load_edited", "trip_started", "trip_undone", "delivered", "trip_reopened", "trip_corrected", "load_reopened", "assigned", "reassigned", "unassigned", "sent", "accepted", "declined", "cancelled", "deleted", "restored", "tonu", "rescheduled"] },
  { key: "money", label: "Money", actions: ["expenses_changed", "invoiced", "invoice_chased", "detention_waived", "invoice_voided", "paid", "payment_part", "payment_undone", "statement_started", "statement_saved", "statement_paid", "load_settled", "load_released", "statement_finalized", "statement_voided", "statement_discarded"] },
  { key: "intake", label: "Intake", actions: ["rate_con_saved", "rate_con_read", "rate_con_read_failed", "document_added", "document_removed"] },
  { key: "team", label: "Team", actions: ["member_added", "member_role_changed", "member_removed"] },
  { key: "fleet", label: "Fleet", actions: ["driver_added", "driver_changed", "driver_deactivated", "driver_reactivated", "schedule_changed", "time_off_added", "time_off_removed", "terminal_added", "terminal_renamed", "terminal_archived", "driver_home_set", "driver_code_changed", "truck_added", "truck_changed", "truck_archived", "truck_restored", "import_completed", "cost_profile_changed", "trailer_added", "trailer_changed", "trailer_archived", "trailer_restored", "trailer_hooked", "trailer_unhooked", "trailer_assigned", "dwell_adjusted", "dwell_waived", "dwell_reset"] },
  { key: "customers", label: "Customers", actions: ["customer_added", "customer_changed"] },
  { key: "partners", label: "Partners", actions: ["factoring_requested", "factoring_updated", "eld_linked", "hos_synced", "eld_fleet_imported", "fuel_imported", "carrier_vetted", "payroll_sent", "partner_connected", "partner_credentials_saved", "partner_event", "driver_link_flag"] },
  { key: "settings", label: "Settings", actions: ["thresholds_changed", "company_changed", "timezone_changed"] }
];
