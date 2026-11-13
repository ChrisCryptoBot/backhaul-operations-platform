/**
 * Recurring deductions and escrow on a contractor's statements (docs/MONEY_PLAN.md, Wave 4 step 3, rule K). Pure, so the editor proposes the same lines the server finalizes.
 *
 * A deduction rule is an amount per statement (lease, insurance, ELD, escrow, other) that runs between two dates. A non-escrow rule may have a cap: the most it ever takes in all. An escrow rule
 * has a goal: the balance to hold for the driver; it builds to the goal, then stops. Escrow is one pool per driver: every escrow rule fills it and a release empties it.
 *
 * A draft proposes each active rule as a line. The dispatcher can skip one for this statement, with a reason. Releasing escrow is a person's act, with a reason, paid as a positive line, never more
 * than is held. Rule K: a deduction never takes a statement below zero unless a person confirms it (the server refuses the finalize otherwise), and escrow is the driver's money, never income.
 *
 * Money is whole cents here.
 */

export const DEDUCTION_KINDS = [
  { key: "lease", label: "Truck lease" },
  { key: "insurance", label: "Insurance" },
  { key: "eld", label: "ELD" },
  { key: "escrow", label: "Escrow" },
  { key: "other", label: "Other" }
] as const;
export type DeductionKind = (typeof DEDUCTION_KINDS)[number]["key"];
export const isDeductionKind = (v: unknown): v is DeductionKind => typeof v === "string" && DEDUCTION_KINDS.some((k) => k.key === v);
export const deductionKindLabel = (k: string) => DEDUCTION_KINDS.find((x) => x.key === k)?.label ?? k;

/** The statement row kinds this step adds. Money off: deduction, escrow. A release gives back the driver's own money. */
export type DeductionRowKind = "deduction" | "escrow" | "escrow_release";
export const DEDUCTION_ROW_KINDS: readonly DeductionRowKind[] = ["deduction", "escrow", "escrow_release"];
export const DEDUCTION_ROW_LABEL: Record<DeductionRowKind, string> = { deduction: "Deduction", escrow: "Escrow held", escrow_release: "Escrow released" };

export type DeductionRule = {
  id: string;
  kind: DeductionKind;
  label: string;
  /** Per statement, in cents, above zero. */
  amountCents: number;
  /** Escrow: the balance to hold. Others: the most to take in all. Null: no limit. */
  goalCents: number | null;
  /** "2026-11-01" or null (from the start / with no end). */
  startsOn: string | null;
  endsOn: string | null;
  active: boolean;
};

/** What the ledger says so far for one driver: taken per non-escrow rule (positive cents), and the escrow held (positive cents). */
export type LedgerBalances = { takenByRule: Record<string, number>; escrowHeldCents: number };

/** A rule as a draft offers it: what it would take on this statement and why it is less than the rule's amount, when it is. */
export type DeductionOption = {
  deductionId: string;
  kind: DeductionKind;
  label: string;
  perStatementCents: number;
  /** What it takes on this statement (0 when its goal or cap is met). */
  proposedCents: number;
  goalCents: number | null;
  /** Escrow: held so far. Others: taken so far. */
  soFarCents: number;
  note: string | null;
};

/** A draft's choices: rules skipped on this statement (id to reason) and an escrow release (typed amount and reason). */
export type DeductionChoices = { skips: Record<string, string>; release: { amount: string; reason: string } | null };
export const NO_CHOICES: DeductionChoices = { skips: {}, release: null };

/** One line on a statement from this step: signed (money off negative, a release positive), in dollars to the cent. */
export type DeductionLine = { deductionId: string | null; kind: DeductionRowKind; label: string; basis: string | null; amount: number };

const usd = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Whether a rule runs during the period (dates as "YYYY-MM-DD", which compare as text). */
export const runsDuring = (r: Pick<DeductionRule, "active" | "startsOn" | "endsOn">, start: string, end: string): boolean => r.active && (r.startsOn == null || r.startsOn <= end) && (r.endsOn == null || r.endsOn >= start);

/** The rules a draft offers for the period, each with what it would take. Escrow rules fill one pool in order, so two of them never overshoot the goal between them. */
export function proposeDeductions(rules: readonly DeductionRule[], balances: LedgerBalances, start: string, end: string): DeductionOption[] {
  let held = balances.escrowHeldCents;
  return rules
    .filter((r) => runsDuring(r, start, end))
    .map((r): DeductionOption => {
      if (r.kind === "escrow") {
        const room = r.goalCents == null ? r.amountCents : Math.max(0, r.goalCents - held);
        const proposed = Math.min(r.amountCents, room);
        const option = { deductionId: r.id, kind: r.kind, label: r.label, perStatementCents: r.amountCents, proposedCents: proposed, goalCents: r.goalCents, soFarCents: held, note: proposed === 0 ? `Escrow has reached its ${usd(r.goalCents ?? 0)} goal.` : proposed < r.amountCents ? `Only ${usd(proposed)} to reach the ${usd(r.goalCents ?? 0)} goal.` : null };
        held += proposed;
        return option;
      }
      const taken = balances.takenByRule[r.id] ?? 0;
      const room = r.goalCents == null ? r.amountCents : Math.max(0, r.goalCents - taken);
      const proposed = Math.min(r.amountCents, room);
      return { deductionId: r.id, kind: r.kind, label: r.label, perStatementCents: r.amountCents, proposedCents: proposed, goalCents: r.goalCents, soFarCents: taken, note: proposed === 0 ? `Its ${usd(r.goalCents ?? 0)} cap has been taken.` : proposed < r.amountCents ? `Only ${usd(proposed)} left under its ${usd(r.goalCents ?? 0)} cap.` : null };
    });
}

/** A typed release amount: positive dollars and cents. */
function parseRelease(raw: string): number | null {
  const s = raw.trim().replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [w, f = ""] = s.split(".");
  const c = Number.parseInt(w!, 10) * 100 + Number.parseInt(f.padEnd(2, "0") || "0", 10);
  return c > 0 && c <= 10_000_000 ? c : null;
}

export const MIN_REASON = 3;

/** The lines a draft's choices come to, and what is wrong with the choices. `escrowHeldCents` is what is held before this statement. */
export function deductionLines(options: readonly DeductionOption[], choices: DeductionChoices, escrowHeldCents: number): { lines: DeductionLine[]; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const lines: DeductionLine[] = [];
  for (const o of options) {
    const skip = choices.skips[o.deductionId];
    if (skip != null) {
      if (skip.trim().length < MIN_REASON) errors[`skip.${o.deductionId}`] = "Say why it is skipped this time.";
      continue;
    }
    if (o.proposedCents <= 0) continue;
    lines.push({ deductionId: o.deductionId, kind: o.kind === "escrow" ? "escrow" : "deduction", label: o.label, basis: deductionKindLabel(o.kind), amount: -o.proposedCents / 100 });
  }
  const r = choices.release;
  if (r && (r.amount.trim() !== "" || r.reason.trim() !== "")) {
    const c = parseRelease(r.amount);
    if (c == null) errors["release.amount"] = "Dollars and cents, above 0.";
    // Only what was held before this statement can be paid back on it.
    else if (c > escrowHeldCents) errors["release.amount"] = `Only ${usd(escrowHeldCents)} is held in escrow.`;
    if (r.reason.trim().length < MIN_REASON) errors["release.reason"] = "Say why the escrow is released.";
    if (c != null && c <= escrowHeldCents && r.reason.trim().length >= MIN_REASON) lines.push({ deductionId: null, kind: "escrow_release", label: "Escrow released", basis: r.reason.trim(), amount: c / 100 });
  }
  return { lines, errors };
}

/** Choices as stored, with anything malformed dropped. */
export function typedChoices(v: unknown): DeductionChoices {
  if (!v || typeof v !== "object") return { skips: {}, release: null };
  const o = v as { skips?: unknown; release?: unknown };
  const skips: Record<string, string> = {};
  if (o.skips && typeof o.skips === "object") for (const [k, r] of Object.entries(o.skips as Record<string, unknown>)) if (typeof r === "string") skips[k] = r;
  const rel = o.release as { amount?: unknown; reason?: unknown } | null | undefined;
  const release = rel && typeof rel === "object" && typeof rel.amount === "string" && typeof rel.reason === "string" ? { amount: rel.amount, reason: rel.reason } : null;
  return { skips, release };
}

/** Rule K: a statement with money-off deduction or escrow lines that comes to less than zero needs a person to confirm it. */
export const needsNegativeConfirm = (totalCents: number, lines: readonly DeductionLine[]): boolean => totalCents < 0 && lines.some((l) => l.amount < 0);

// ── Setting a rule up ─────────────────────────────────────────────────────────────────────────

export type DeductionValues = { kind: string; label: string; amount: string; goal: string; startsOn: string; endsOn: string };
export const BLANK_DEDUCTION: DeductionValues = { kind: "lease", label: "", amount: "", goal: "", startsOn: "", endsOn: "" };

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const realDay = (s: string) => {
  if (!YMD.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

export type DeductionCheck = { ok: true; value: DeductionValues; amountCents: number; goalCents: number | null } | { ok: false; errors: Partial<Record<keyof DeductionValues, string>> };

export function validateDeduction(input: Record<string, unknown>): DeductionCheck {
  const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const v: DeductionValues = { kind: s(input.kind), label: s(input.label).replace(/\s+/g, " "), amount: s(input.amount), goal: s(input.goal), startsOn: s(input.startsOn), endsOn: s(input.endsOn) };
  const errors: Partial<Record<keyof DeductionValues, string>> = {};
  if (!isDeductionKind(v.kind)) errors.kind = "Pick what it is for.";
  if (v.label.length < 2) errors.label = "Name it, for example Truck lease, unit 104.";
  else if (v.label.length > 60) errors.label = "60 characters at most.";
  const amount = parseRelease(v.amount);
  if (amount == null) errors.amount = "Dollars and cents per statement, above 0.";
  const goal = v.goal === "" ? null : parseRelease(v.goal);
  if (v.goal !== "" && goal == null) errors.goal = "Dollars and cents, above 0, or blank.";
  else if (v.kind === "escrow" && goal == null) errors.goal = "Escrow needs a goal: the balance to hold.";
  else if (goal != null && amount != null && goal < amount && v.kind !== "escrow") errors.goal = "The cap is less than one statement's amount.";
  if (v.startsOn && !realDay(v.startsOn)) errors.startsOn = "A real date.";
  if (v.endsOn && !realDay(v.endsOn)) errors.endsOn = "A real date.";
  else if (v.startsOn && v.endsOn && v.endsOn < v.startsOn) errors.endsOn = "It cannot end before it starts.";
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: v, amountCents: amount!, goalCents: goal };
}
