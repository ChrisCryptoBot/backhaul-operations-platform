/**
 * When a load falls through or moves: the reasons a dispatcher picks from, so "why did this go wrong" can be counted later.
 * Pure and dependency-free (the seed script imports it too).
 */
export type Reason = { key: string; label: string };

/** Why a load was cancelled or became a TONU (truck ordered, not used). */
export const CANCEL_REASONS: Reason[] = [
  { key: "driver_no_show", label: "Driver no-show" },
  { key: "equipment", label: "Equipment problem" },
  { key: "weather_road", label: "Weather or road closure" },
  { key: "broker_cancelled", label: "Broker cancelled" },
  { key: "shipper_not_ready", label: "Shipper not ready" },
  { key: "rate_dispute", label: "Rate dispute" },
  { key: "pulled", label: "Load pulled (covered by someone else)" },
  { key: "other", label: "Other" }
];

/** Why a pickup was moved to another time. */
export const RESCHEDULE_REASONS: Reason[] = [
  { key: "shipper_not_ready", label: "Shipper not ready" },
  { key: "weather_road", label: "Weather or road closure" },
  { key: "equipment", label: "Equipment problem" },
  { key: "broker_request", label: "Broker asked for a new time" },
  { key: "driver_unavailable", label: "Driver unavailable" },
  { key: "other", label: "Other" }
];

export function reasonLabel(key: string | null | undefined): string {
  if (!key) return "No reason given";
  return [...CANCEL_REASONS, ...RESCHEDULE_REASONS].find((r) => r.key === key)?.label ?? key;
}

export const isCancelReason = (key: string) => CANCEL_REASONS.some((r) => r.key === key);
export const isRescheduleReason = (key: string) => RESCHEDULE_REASONS.some((r) => r.key === key);

/** A load that is still open can be cancelled; a TONU needs a driver who was already on the way; only a load not yet moving can be rescheduled. */
export const CAN_CANCEL = ["draft", "accepted", "in_progress"];
export const CAN_TONU = ["accepted", "in_progress"];
export const CAN_RESCHEDULE = ["draft", "accepted"];

export type StopTimes = { timeWindowEarliest: Date | null; timeWindowLatest: Date | null };

/** Every stop moved by the same amount, so the pickup-to-delivery gaps stay as they were. */
export function shiftStops<T extends StopTimes>(stops: T[], deltaMs: number): T[] {
  const move = (d: Date | null) => (d ? new Date(d.getTime() + deltaMs) : null);
  return stops.map((s) => ({ ...s, timeWindowEarliest: move(s.timeWindowEarliest), timeWindowLatest: move(s.timeWindowLatest) }));
}
