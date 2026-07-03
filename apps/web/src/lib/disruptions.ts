import type { DisruptionReason } from "@prisma/client";

/**
 * The single source of truth for the shared 9-reason disruption taxonomy.
 * Used by the load-detail drawer, the ConfirmDialog cancel/reschedule callers,
 * the copilot tool schemas, and the Phase-3 reason breakdown so every surface
 * shows the same values and labels.
 *
 * Reasons cannot be backfilled — they are captured at write time.
 */
export interface DisruptionReasonOption {
  value: DisruptionReason;
  label: string;
}

export const DISRUPTION_REASON_OPTIONS: readonly DisruptionReasonOption[] = [
  { value: "CARRIER_NO_SHOW", label: "Carrier no-show" },
  { value: "CARRIER_LATE_OR_NOT_EMPTY", label: "Carrier late / not empty" },
  { value: "PARTY_RESCHEDULE", label: "Shipper/receiver reschedule" },
  { value: "NO_DOCK_TIME", label: "No dock time available" },
  { value: "WEATHER_ROAD", label: "Weather / road conditions" },
  { value: "EQUIPMENT_ISSUE", label: "Equipment issue" },
  { value: "RATE_BILLING_DISPUTE", label: "Rate / billing dispute" },
  { value: "LOAD_PULLED", label: "Load pulled" },
  { value: "OTHER", label: "Other (specify)" }
] as const;

/** The ordered list of reason values, e.g. for the copilot enum schema. */
export const DISRUPTION_REASON_VALUES: readonly DisruptionReason[] =
  DISRUPTION_REASON_OPTIONS.map((o) => o.value);

const LABEL_BY_REASON = new Map<DisruptionReason, string>(
  DISRUPTION_REASON_OPTIONS.map((o) => [o.value, o.label])
);

export function disruptionReasonLabel(reason: DisruptionReason): string {
  return LABEL_BY_REASON.get(reason) ?? reason;
}

/** OTHER requires an operator-supplied detail so the free-text carries the "why". */
export function disruptionDetailRequired(reason: DisruptionReason): boolean {
  return reason === "OTHER";
}
