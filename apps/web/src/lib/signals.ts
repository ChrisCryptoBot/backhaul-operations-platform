import type { AlertLevel } from "./alerts";

/**
 * Signals: the alerts the desk derives on every request, kept. An alert says what needs attention now and is stored nowhere; a signal remembers when it was first seen, how long it has stayed, whether
 * someone acknowledged it, when it cleared, and what was sent about it. `diffSignals` is the one rule for how the stored list follows the derived one; nothing here reads a clock or a database. Pure.
 */
export type SignalState = "open" | "acknowledged" | "resolved";

/** One alert as the rules derive it (src/lib/alerts.ts), reduced to what is kept. `key` is the alert's own key: the load and the rule. */
export type DerivedSignal = { key: string; code: string; level: AlertLevel; title: string; detail: string; loadId: string | null; loadNumber: string | null };

export type StoredSignal = {
  id: string;
  key: string;
  level: AlertLevel;
  status: SignalState;
  firstSeenAt: number;
  lastSeenAt: number;
  resolvedAt: number | null;
  reopenCount: number;
  /** The most severe level a notification has already gone out for, so a signal is sent once per level it reaches. */
  lastLevelSent: AlertLevel | null;
};

export type SignalChange =
  /** Derived and never stored: keep it, open, first seen now. */
  | { kind: "new"; signal: DerivedSignal }
  /** Derived and stored, not resolved: last seen moves; the level and text follow the rules; an escalation reopens an acknowledged one. */
  | { kind: "seen"; id: string; signal: DerivedSignal; levelChanged: boolean; escalated: boolean }
  /** Derived again after it had cleared: open again, first-seen history kept, the sent level forgotten so it is news again. */
  | { kind: "reopened"; id: string; signal: DerivedSignal }
  /** Stored, not resolved, and no longer derived: it has cleared. */
  | { kind: "resolved"; id: string };

/** Block is the most severe, then warn, then info. */
export const LEVEL_RANK: Record<AlertLevel, number> = { block: 0, warn: 1, info: 2 };

/** Whether `a` is more severe than `b`. */
export const moreSevere = (a: AlertLevel, b: AlertLevel): boolean => LEVEL_RANK[a] < LEVEL_RANK[b];

/** How the stored signals follow what the rules derive now. Every stored signal and every derived one appears in exactly one change (a signal already resolved and still not derived changes nothing). */
export function diffSignals(stored: readonly StoredSignal[], derived: readonly DerivedSignal[]): SignalChange[] {
  const byKey = new Map(stored.map((s) => [s.key, s]));
  const seen = new Set<string>();
  const out: SignalChange[] = [];
  for (const d of derived) {
    if (seen.has(d.key)) continue; // a key derived twice is one signal
    seen.add(d.key);
    const s = byKey.get(d.key);
    if (!s) out.push({ kind: "new", signal: d });
    else if (s.status === "resolved") out.push({ kind: "reopened", id: s.id, signal: d });
    else out.push({ kind: "seen", id: s.id, signal: d, levelChanged: s.level !== d.level, escalated: moreSevere(d.level, s.level) });
  }
  for (const s of stored) if (s.status !== "resolved" && !seen.has(s.key)) out.push({ kind: "resolved", id: s.id });
  return out;
}

/** The levels a person may ask to be told about: that level and everything more severe. */
export type MinLevel = AlertLevel;

/**
 * Whether a notification is due for a signal: it is not resolved (and not acknowledged: someone is on it), its level is at least as severe as the one asked for, and nothing has gone out for this
 * level or a worse one. A signal that escalates (info to warn, warn to block) is due again; one that only repeats is not.
 */
export function notifyDue(s: Pick<StoredSignal, "status" | "level" | "lastLevelSent">, minLevel: MinLevel): boolean {
  if (s.status !== "open") return false;
  if (LEVEL_RANK[s.level] > LEVEL_RANK[minLevel]) return false;
  return s.lastLevelSent == null || moreSevere(s.level, s.lastLevelSent);
}

/** How long a signal has stayed, in whole days, from when it was first seen to when it cleared (or to `now` while it has not). */
export function ageDays(s: Pick<StoredSignal, "firstSeenAt" | "resolvedAt">, now: number): number {
  const end = s.resolvedAt ?? now;
  return Math.max(0, Math.floor((end - s.firstSeenAt) / 86_400_000));
}

/** "just now", "3 h", "4 days": how long, in words, for the list. */
export function ageText(firstSeenAt: number, until: number): string {
  const ms = Math.max(0, until - firstSeenAt);
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return "just now";
  if (hours < 48) return `${hours} h`;
  return `${Math.floor(hours / 24)} days`;
}

/** The page to show: the one asked for, kept between the first and the last that has rows (an empty list is page 1 of 1). */
export function clampPage(asked: number | undefined, total: number, pageSize: number): { page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const want = asked != null && Number.isInteger(asked) && asked > 0 ? asked : 1;
  return { page: Math.min(want, pages), pages };
}
