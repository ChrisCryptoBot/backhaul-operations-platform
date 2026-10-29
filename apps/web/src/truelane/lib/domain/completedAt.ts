// VENDORED from TrueLane lib/domain/completedAt.ts @ a3a9c0f4. Do not edit; run scripts/vendor-truelane.mjs.
/**
 * `loads.completed_at` (v45): when a load was finished. Node-safe, no I/O.
 *
 * Stamped in the same write that finishes the load — Finish Trip, legacy TripLogger.endTrip,
 * Skip trip (quickCompleteLoad), the finished-trip repair, and a TONU. Final once set, like the
 * completed / TONU status itself (lib/loadStatusMerge): a second write never moves it.
 *
 * Loads finished before v45 are dated by `deriveLegacyCompletedAtMs` (lib/completedAtBackfill); until
 * that runs, readers use the same estimate (loadEconomics.loadCompletedAtMs).
 */

/** The value to write: an existing stamp is kept (final); otherwise `atMs`. */
export function stampCompletedAt(current: number | null | undefined, atMs: number): number {
  return typeof current === 'number' && Number.isFinite(current) ? current : atMs;
}

export type SegmentTimes = {
  segmentType: string;
  startedAt?: number | null;
  endedAt: number | null;
};

const finite = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n);

/**
 * When the trip was finished, from its own steps: the Finish Trip step (`return_dh`, created at
 * end_trip with endedAt = the finish time), else the latest step to end. Null with no ended steps.
 */
export function finishTimeFromSegments(segments: readonly SegmentTimes[]): number | null {
  let finish: number | null = null;
  let latest: number | null = null;
  for (const s of segments) {
    if (!finite(s.endedAt)) continue;
    if (s.segmentType === 'return_dh' && (finish == null || s.endedAt > finish)) finish = s.endedAt;
    if (latest == null || s.endedAt > latest) latest = s.endedAt;
  }
  return finish ?? latest;
}

export type LegacyCompletionInput = {
  status: string;
  cancelledAt: number | null;
  invoicedAt: number | null;
  paidAt: number | null;
  /** Pickup date the driver entered (local noon of that day), if any. */
  scheduledDate: number | null;
  createdAt: number;
  updatedAt: number;
};

/**
 * Estimate for a finished load with no time of its own (no trip steps, no TONU cancel time):
 * the pickup date the driver entered, else the day the load was saved — never later than the
 * first write that could only happen after completion (updated / invoiced / paid).
 *
 * Anchored on the pickup side on purpose. The later bound drifts: updated_at moves on every edit
 * and sync, and loads from before the payment loop (2026-09-21) have no invoice / paid date, so
 * "earliest later write" is often just updated_at — the drift completed_at exists to fix. A haul
 * finishes within days of pickup; an edit can land weeks later, across a month or tax year.
 */
export function estimateCompletionMs(l: {
  scheduledDate?: number | null;
  createdAt: number;
  updatedAt: number;
  invoicedAt?: number | null;
  paidAt?: number | null;
}): number {
  const planned = finite(l.scheduledDate) ? l.scheduledDate : l.createdAt;
  const latest = Math.min(
    l.updatedAt,
    finite(l.invoicedAt) ? l.invoicedAt : Number.POSITIVE_INFINITY,
    finite(l.paidAt) ? l.paidAt : Number.POSITIVE_INFINITY
  );
  return Math.min(planned, latest);
}

/**
 * Best date for a load finished before v45 (lib/completedAtBackfill writes it; it is then final).
 *  - completed: the trip's own finish time (finishTimeFromSegments), never before it was saved.
 *    Only the backfill sees trip steps; a screen shows the estimate until the backfill has run.
 *  - TONU: its cancel time.
 *  - neither (Skip trip before v45, a trip never run in the app, or trip steps already pruned after
 *    90 days): estimateCompletionMs — pickup date, else saved date, capped by the earliest later write.
 */
export function deriveLegacyCompletedAtMs(load: LegacyCompletionInput, segments: readonly SegmentTimes[]): number {
  // Same order as loadEconomics.loadCompletedAtMs, so a screen shows what the backfill will write.
  if (load.status === 'tonu') return finite(load.cancelledAt) ? load.cancelledAt : estimateCompletionMs(load);
  const finish = finishTimeFromSegments(segments);
  if (finish != null) return Math.max(finish, load.createdAt);
  return estimateCompletionMs(load);
}
