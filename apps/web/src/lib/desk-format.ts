/** Display helpers for the dispatcher desk. Pure. */
import { percentText } from "./pay";

export const usd = (n: number | null | undefined, digits = 0): string =>
  n == null || !Number.isFinite(n)
    ? "—"
    : n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits });

export const perMile = (n: number | null | undefined): string => (n == null || !Number.isFinite(n) ? "—" : `$${n.toFixed(2)}/mi`);

export const miles = (n: number | null | undefined): string => (n == null || !Number.isFinite(n) ? "—" : `${Math.round(n).toLocaleString("en-US")} mi`);

export const pct = (fraction: number | null | undefined, digits = 0): string =>
  fraction == null || !Number.isFinite(fraction) ? "—" : `${(fraction * 100).toFixed(digits)}%`;

export const signedPct = (fraction: number | null | undefined): string =>
  fraction == null || !Number.isFinite(fraction) ? "—" : `${fraction > 0 ? "+" : ""}${(fraction * 100).toFixed(1)}%`;

/** The demo fleet runs out of Dallas, so every time on the desk is shown in Central time. */
const DISPLAY_TZ = "America/Chicago";

export function shortDate(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: DISPLAY_TZ });
}

export function dateTime(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: DISPLAY_TZ }) + " CT";
}

export type Verdict = "accept" | "caution" | "reject" | "needs_fuel";
export const VERDICT: Record<Verdict, { label: string; tone: "ok" | "warn" | "bad" | "muted" }> = {
  accept: { label: "Covers your cost", tone: "ok" },
  caution: { label: "Thin margin", tone: "warn" },
  reject: { label: "Below your cost", tone: "bad" },
  needs_fuel: { label: "Needs a fuel price", tone: "muted" }
};

/** Tones: gold asks the dispatcher to act, green is settled, steel is moving, amber is waiting on someone, red is wrong, grey is closed. */
export type Tone = "ok" | "warn" | "bad" | "info" | "gold" | "muted";

export const LOAD_STATUS: Record<string, { label: string; tone: Tone }> = {
  draft: { label: "Needs a driver", tone: "gold" },
  accepted: { label: "Accepted", tone: "ok" },
  in_progress: { label: "On the road", tone: "info" },
  completed: { label: "Delivered", tone: "ok" },
  tonu: { label: "TONU", tone: "muted" },
  cancelled: { label: "Cancelled", tone: "bad" }
};

export const ASSIGNMENT_STATUS: Record<string, { label: string; tone: Tone }> = {
  draft: { label: "Assigned, not sent", tone: "gold" },
  dispatched: { label: "Sent, waiting", tone: "warn" },
  accepted: { label: "Driver accepted", tone: "ok" },
  declined: { label: "Driver declined", tone: "bad" },
  in_progress: { label: "On the road", tone: "info" },
  completed: { label: "Delivered", tone: "ok" }
};

export const PAY_KIND_LABEL: Record<string, string> = { flat: "Set amount", cpm: "Per mile", hourly: "Hourly", percent: "Percent of the rate" };

/** "$0.65 a mile", "$22 an hour", "$450 a load", "25% of the rate"; a dash when no pay is set. */
export function payLabel(kind: string | null | undefined, rate: number | null | undefined): string {
  if (!kind || rate == null) return "—";
  if (kind === "percent") return percentText(rate);
  const money = kind === "cpm" ? rate.toFixed(2) : Number.isInteger(rate) ? String(rate) : rate.toFixed(2);
  return `$${money} ${kind === "cpm" ? "a mile" : kind === "hourly" ? "an hour" : "a load"}`;
}
