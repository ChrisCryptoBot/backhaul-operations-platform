// VENDORED from TrueLane lib/domain/onTime.ts @ a3a9c0f4. Do not edit; run scripts/vendor-truelane.mjs.
/**
 * On-time scoring for a single stop arrival vs appointment window.
 * Grace constants are shipped (not user settings) — early arrival within graceEarly is on-time.
 */

export type OnTimeResult = {
  scored: boolean;
  /** null when not scored */
  onTime: boolean | null;
  /** positive = late, negative = early; null when not scored */
  deltaMinutes: number | null;
};

export const ON_TIME_GRACE_EARLY_MIN = 60;
export const ON_TIME_GRACE_LATE_MIN = 30;

export function computeOnTime(params: {
  arrivedAtMs: number | null;
  windowEarliestMs: number | null;
  windowLatestMs: number | null;
}): OnTimeResult {
  const { arrivedAtMs, windowEarliestMs, windowLatestMs } = params;
  const hasEarliest = windowEarliestMs != null && Number.isFinite(windowEarliestMs);
  const hasLatest = windowLatestMs != null && Number.isFinite(windowLatestMs);

  if (arrivedAtMs == null || !Number.isFinite(arrivedAtMs) || (!hasEarliest && !hasLatest)) {
    return { scored: false, onTime: null, deltaMinutes: null };
  }

  const graceEarlyMs = ON_TIME_GRACE_EARLY_MIN * 60_000;
  const graceLateMs = ON_TIME_GRACE_LATE_MIN * 60_000;

  let onTime: boolean;
  if (hasEarliest && hasLatest) {
    const lo = (windowEarliestMs as number) - graceEarlyMs;
    const hi = (windowLatestMs as number) + graceLateMs;
    onTime = arrivedAtMs >= lo && arrivedAtMs <= hi;
  } else if (hasLatest) {
    onTime = arrivedAtMs <= (windowLatestMs as number) + graceLateMs;
  } else {
    // only earliest
    onTime = arrivedAtMs >= (windowEarliestMs as number) - graceEarlyMs;
  }

  const deltaMinutes = hasLatest
    ? (arrivedAtMs - (windowLatestMs as number)) / 60_000
    : 0;

  return { scored: true, onTime, deltaMinutes };
}
