import { DEFAULT_FREE_GRACE_MINUTES } from "@/truelane/lib/domain/detention";
import type { AlertThresholds } from "./alerts";

/**
 * The numbers the desk judges by, set in Settings. Each is optional in the database (null = the default below), so a new
 * workspace works with no setup. Pure: the Settings card checks input with `validateThresholds`, and the same function
 * guards the save on the server.
 */
export type Thresholds = {
  /** Empty miles as a share of every mile driven, in percent: amber from here, red from `emptyRedPct`. */
  emptyAmberPct: number;
  emptyRedPct: number;
  /** Net days an invoice is due when the load did not say. */
  defaultPayTermsDays: number;
  /** Free time at a dock before detention starts (TrueLane's default is 2 hours). */
  detentionGraceMinutes: number;
  /** Alerts: hours before a pickup with no driver sent, hours waiting for an answer, days before a card lapses. */
  pickupAlertHours: number;
  sentNoAnswerHours: number;
  clearanceDays: number;
};

export const THRESHOLD_DEFAULTS: Thresholds = {
  emptyAmberPct: 25,
  emptyRedPct: 35,
  defaultPayTermsDays: 30,
  detentionGraceMinutes: DEFAULT_FREE_GRACE_MINUTES,
  pickupAlertHours: 24,
  sentNoAnswerHours: 4,
  clearanceDays: 30
};

/** What is stored: a number, or null meaning "use the default". */
export type ThresholdRow = { [K in keyof Thresholds]?: number | null };

export function resolveThresholds(row: ThresholdRow | null | undefined): Thresholds {
  const out = { ...THRESHOLD_DEFAULTS };
  for (const k of Object.keys(THRESHOLD_DEFAULTS) as Array<keyof Thresholds>) {
    const v = row?.[k];
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

export function alertThresholds(t: Thresholds): AlertThresholds {
  return { pickupHours: t.pickupAlertHours, sentNoAnswerHours: t.sentNoAnswerHours, clearanceDays: t.clearanceDays };
}

export type ThresholdField = { key: keyof Thresholds; label: string; unit: string; min: number; max: number; step: number; whole: boolean; hint: string };

export const THRESHOLD_FIELDS: ThresholdField[] = [
  { key: "emptyAmberPct", label: "Empty miles turn amber at", unit: "%", min: 1, max: 99, step: 0.5, whole: false, hint: "Share of every mile driven that is empty." },
  { key: "emptyRedPct", label: "Empty miles turn red at", unit: "%", min: 1, max: 100, step: 0.5, whole: false, hint: "Must be above the amber line." },
  { key: "defaultPayTermsDays", label: "Invoices are due after", unit: "days", min: 1, max: 120, step: 1, whole: true, hint: "Used when a load did not say." },
  { key: "detentionGraceMinutes", label: "Free time at a dock", unit: "minutes", min: 0, max: 480, step: 15, whole: true, hint: "Waiting beyond this is detention." },
  { key: "pickupAlertHours", label: "Warn when a pickup with no driver is within", unit: "hours", min: 1, max: 168, step: 1, whole: true, hint: "Raises a block alert." },
  { key: "sentNoAnswerHours", label: "Warn when a sent load has no answer after", unit: "hours", min: 1, max: 72, step: 1, whole: true, hint: "Raises a warn alert." },
  { key: "clearanceDays", label: "Warn when a CDL or medical card lapses within", unit: "days", min: 1, max: 180, step: 1, whole: true, hint: "Raises a warn alert." }
];

export type ThresholdCheck =
  | { ok: true; stored: Record<keyof Thresholds, number | null>; resolved: Thresholds }
  | { ok: false; errors: Partial<Record<keyof Thresholds, string>> };

/** Checks what the form sent. A blank field means "use the default" and is stored as null. */
export function validateThresholds(input: Record<string, unknown>): ThresholdCheck {
  const errors: Partial<Record<keyof Thresholds, string>> = {};
  const stored = {} as Record<keyof Thresholds, number | null>;
  for (const f of THRESHOLD_FIELDS) {
    const raw = input[f.key];
    if (raw == null || (typeof raw === "string" && raw.trim() === "")) {
      stored[f.key] = null;
      continue;
    }
    const n = typeof raw === "number" ? raw : Number(String(raw).trim());
    if (!Number.isFinite(n)) errors[f.key] = "Enter a number, or leave it blank for the default.";
    else if (f.whole && !Number.isInteger(n)) errors[f.key] = "Whole numbers only.";
    else if (n < f.min || n > f.max) errors[f.key] = `Between ${f.min} and ${f.max} ${f.unit}.`;
    else stored[f.key] = n;
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  const resolved = resolveThresholds(stored);
  if (resolved.emptyAmberPct >= resolved.emptyRedPct) return { ok: false, errors: { emptyRedPct: "The red line has to be above the amber line." } };
  return { ok: true, stored, resolved };
}

export type EmptyZone = "ok" | "amber" | "red";

/** Which zone an empty-miles share (a fraction, 0 to 1) falls in. Null without miles. */
export function emptyZone(share: number | null | undefined, t: Pick<Thresholds, "emptyAmberPct" | "emptyRedPct">): EmptyZone | null {
  if (share == null || !Number.isFinite(share)) return null;
  const pct = share * 100;
  return pct >= t.emptyRedPct ? "red" : pct >= t.emptyAmberPct ? "amber" : "ok";
}
