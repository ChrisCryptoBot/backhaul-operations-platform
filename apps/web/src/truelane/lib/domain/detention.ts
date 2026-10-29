// VENDORED from TrueLane lib/domain/detention.ts @ e7c88066. Do not edit; run scripts/vendor-truelane.mjs.
/**
 * Billable detention (10l) — pure. Brokers typically allow a free grace window (2 hours is the
 * standard) at a dock; time beyond that is billable detention at an hourly rate. This computes what
 * the driver can claim so dwell time isn't quietly eaten. Semantic only — the UI/export formats it.
 */

export const DEFAULT_FREE_GRACE_MINUTES = 120;

export type DetentionInput = {
  /**
   * Total dock wait in minutes (loads.dock_wait_minutes), counted from when FREE TIME STARTS: the driver's arrival, or the
   * appointment if they arrived before it. The arrival tap measures from arrival, so an early arrival must be counted from the
   * appointment before it reaches here (lib/domain/earlyArrival.ts shows the driver both numbers; nothing rewrites it).
   */
  dockWaitMinutes: number;
  /** Billable detention rate in $/hour (broker/contract terms; typically $50–$75). */
  detentionHourlyRate: number;
  /** Free grace window before detention accrues. Defaults to 120 min (2h). */
  freeGraceMinutes?: number;
};

export type DetentionResult = {
  /** Grace window applied (minutes). */
  freeGraceMinutes: number;
  /** Minutes beyond grace (0 when within grace). */
  billableMinutes: number;
  /** billableMinutes / 60. */
  billableHours: number;
  /** billableHours × rate, rounded to cents. */
  billableAmount: number;
};

export function computeBillableDetention(input: DetentionInput): DetentionResult {
  const freeGraceMinutes = Math.max(0, input.freeGraceMinutes ?? DEFAULT_FREE_GRACE_MINUTES);
  const wait = Math.max(0, Number.isFinite(input.dockWaitMinutes) ? input.dockWaitMinutes : 0);
  const rate = Math.max(0, Number.isFinite(input.detentionHourlyRate) ? input.detentionHourlyRate : 0);
  const billableMinutes = Math.max(0, wait - freeGraceMinutes);
  const billableHours = billableMinutes / 60;
  const billableAmount = Math.round(billableHours * rate * 100) / 100;
  return { freeGraceMinutes, billableMinutes, billableHours, billableAmount };
}

export type DetentionTerms = { detentionHourlyRate: number; freeGraceMinutes: number };

/**
 * A load's detention terms (math review round 6, #24): the rate and free time frozen on the load at
 * accept (or edited for this load on Expenses — rate cons vary), else the truck's Cost profile. A load
 * accepted before v48, or with no rate in the profile then, has none frozen and uses the profile.
 */
export function loadDetentionTerms(
  load: { snapshotDetentionRate?: number | null; snapshotFreeGraceMinutes?: number | null },
  profile: { detentionHourlyRate?: number | null; freeGraceMinutes?: number | null }
): DetentionTerms {
  const finiteOrNull = (n: number | null | undefined) => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null);
  return {
    detentionHourlyRate: finiteOrNull(load.snapshotDetentionRate) ?? finiteOrNull(profile.detentionHourlyRate) ?? 0,
    freeGraceMinutes:
      finiteOrNull(load.snapshotFreeGraceMinutes) ?? finiteOrNull(profile.freeGraceMinutes) ?? DEFAULT_FREE_GRACE_MINUTES,
  };
}

/** One stop's recorded wait (stops.wait_minutes, v46). Null = not entered. */
export type StopWait = {
  stopSequence: number;
  stopType: string;
  waitMinutes: number | null;
};

export type StopDetention = {
  stopSequence: number;
  stopType: string;
  waitMinutes: number;
  billableMinutes: number;
  billableAmount: number;
};

export type LoadDetentionResult = {
  /**
   * per_stop: every stop gets its own free time — Σ max(0, wait − grace).
   * total_only: a load saved before per-stop waits (v46) has one total; it is billed as
   * total − grace × stops (at least 2 — every load has a pickup and a delivery), which can never
   * exceed the true per-stop amount (never overbills) but can fall short of it (may underbill).
   */
  basis: 'per_stop' | 'total_only';
  freeGraceMinutes: number;
  /** Stops that got free time: every stop (per_stop), or the count taken off the total (total_only). */
  graceStopCount: number;
  totalWaitMinutes: number;
  billableMinutes: number;
  billableHours: number;
  /** Rounded to cents; for per_stop it is the sum of the per-stop amounts, so the lines add up. */
  billableAmount: number;
  /** Per-stop lines (per_stop only). */
  stops: StopDetention[];
};

/** Every load has at least a pickup and a delivery. */
const MIN_GRACE_STOPS = 2;

/**
 * True when a total-only bill may be less than the driver is owed: with one total, the free time comes
 * off the total once per stop, so a wait bunched at one dock bills short. (A total within one stop's
 * free time bills $0 either way.)
 */
export function detentionMayUnderbill(r: LoadDetentionResult): boolean {
  return r.basis === 'total_only' && r.totalWaitMinutes > r.freeGraceMinutes;
}

export type LoadDetentionInput = {
  stops: readonly StopWait[];
  /** loads.dock_wait_minutes — the total, used only when no stop has its own wait. */
  totalWaitMinutes: number | null;
  detentionHourlyRate: number;
  freeGraceMinutes?: number | null;
};

const nonNegFinite = (n: number | null | undefined) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0);

/**
 * Billable detention for a whole load (math audit H3). Brokers give the free time at EACH stop, so a
 * 2-hour grace is taken once per stop, not once per load: a 3-stop load with 150 min at each stop owes
 * 3 × 30 = 90 billable minutes, where the old single-total rule billed 450 − 120 = 330.
 */
export function computeLoadDetention(input: LoadDetentionInput): LoadDetentionResult {
  const grace = Math.max(0, input.freeGraceMinutes ?? DEFAULT_FREE_GRACE_MINUTES);
  const rate = nonNegFinite(input.detentionHourlyRate);
  const sorted = [...input.stops].sort((a, b) => a.stopSequence - b.stopSequence);
  const perStop = sorted.some((s) => s.waitMinutes != null);

  if (perStop) {
    const lines = sorted.map((s) => {
      const r = computeBillableDetention({ dockWaitMinutes: nonNegFinite(s.waitMinutes), detentionHourlyRate: rate, freeGraceMinutes: grace });
      return {
        stopSequence: s.stopSequence,
        stopType: s.stopType,
        waitMinutes: nonNegFinite(s.waitMinutes),
        billableMinutes: r.billableMinutes,
        billableAmount: r.billableAmount,
      };
    });
    const billableMinutes = lines.reduce((sum, l) => sum + l.billableMinutes, 0);
    return {
      basis: 'per_stop',
      freeGraceMinutes: grace,
      graceStopCount: lines.length,
      totalWaitMinutes: lines.reduce((sum, l) => sum + l.waitMinutes, 0),
      billableMinutes,
      billableHours: billableMinutes / 60,
      billableAmount: Math.round(lines.reduce((sum, l) => sum + l.billableAmount, 0) * 100) / 100,
      stops: lines,
    };
  }

  const total = nonNegFinite(input.totalWaitMinutes);
  // A load always has at least a pickup and a delivery, even when no stop rows were saved; one
  // grace for a two-stop wait would bill free time as detention.
  const graceCount = Math.max(MIN_GRACE_STOPS, sorted.length);
  const billableMinutes = Math.max(0, total - grace * graceCount);
  const billableHours = billableMinutes / 60;
  return {
    basis: 'total_only',
    freeGraceMinutes: grace,
    graceStopCount: graceCount,
    totalWaitMinutes: total,
    billableMinutes,
    billableHours,
    billableAmount: Math.round(billableHours * rate * 100) / 100,
    stops: [],
  };
}
