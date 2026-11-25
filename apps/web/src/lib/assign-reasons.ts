/**
 * The conditions that let an assignment go ahead only with a reason, each with its own reason. A reason typed for one never covers another: a dispatcher who explained why they change the
 * driver has not explained why they double-book them. The server collects every condition that applies, refuses once with the whole list of what is still missing, and keeps each reason
 * beside its condition in the audit trail. Pure: the server, the screens and the tests read this one list.
 */
export const REASON_CODES = ["double_booked", "reason_required", "pay_changed", "truck_busy", "hos_short"] as const;
export type ReasonCode = (typeof REASON_CODES)[number];
export type Reasons = Partial<Record<ReasonCode, string>>;
/** One condition that applies to this assignment, in words that name the driver, the load or the truck. */
export type ReasonNeed = { code: ReasonCode; message: string };

/** The question each box asks. */
export const REASON_LABEL: Record<ReasonCode, string> = {
  double_booked: "Why double-book this driver?",
  reason_required: "Why change the driver?",
  pay_changed: "Why change the pay after the driver had it?",
  truck_busy: "Why use this truck while it is on another load?",
  hos_short: "Why assign with the hours they have left?"
};

/** The same, said before it is known to apply (the load page asks up front): "only if ...". */
export const REASON_IF: Record<ReasonCode, string> = {
  double_booked: "Reason, only if the driver is on another load at that time",
  reason_required: "Reason, only if you change the driver who has it",
  pay_changed: "Reason, only if you change the pay of the driver who has it",
  truck_busy: "Reason, only if the driver's truck is on another load at that time",
  hos_short: "Reason, only if the driver is short on hours"
};

/** How the audit trail names each reason it keeps. */
export const REASON_AUDIT: Record<ReasonCode, string> = {
  double_booked: "Double-booked",
  reason_required: "Driver changed",
  pay_changed: "Pay changed after sending",
  truck_busy: "Truck on another load",
  hos_short: "Short on hours"
};

export const isReasonCode = (v: unknown): v is ReasonCode => typeof v === "string" && (REASON_CODES as readonly string[]).includes(v);

/** The shortest reason that counts: a few real letters, not a space or a dot. */
export const REASON_MIN = 3;
const given = (r: Reasons, c: ReasonCode) => (r[c] ?? "").trim().length >= REASON_MIN;

/** The conditions that apply and have no reason yet. */
export const missingReasons = (needs: readonly ReasonNeed[], reasons: Reasons): ReasonNeed[] => needs.filter((n) => !given(reasons, n.code));

/** What the audit trail keeps: each reason beside its condition, "Double-booked: two short hops; Short on hours: 10 h reset first". Null when nothing needed one. */
export function reasonText(needs: readonly ReasonNeed[], reasons: Reasons): string | null {
  const parts = needs.filter((n) => given(reasons, n.code)).map((n) => `${REASON_AUDIT[n.code]}: ${reasons[n.code]!.trim().slice(0, 300)}`);
  return parts.length > 0 ? parts.join("; ") : null;
}

/** The reasons a form sent, one field per condition (`reason_double_booked`, ...). */
export function reasonsFrom(get: (name: string) => unknown): Reasons {
  const out: Reasons = {};
  for (const c of REASON_CODES) {
    const v = get(`reason_${c}`);
    if (typeof v === "string" && v.trim() !== "") out[c] = v.trim();
  }
  return out;
}

/** What the refusal says: the one condition in its own words, or how many need a reason. */
export function needsMessage(missing: readonly ReasonNeed[]): string {
  if (missing.length === 1) return `${missing[0]!.message} Add a reason to go ahead.`;
  return `${missing.length} things need a reason before this can go ahead: ${missing.map((m) => m.message).join(" ")}`;
}
