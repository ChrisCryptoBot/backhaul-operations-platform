/**
 * When a load occupies its driver: from the first stop's earliest time to the last stop's latest time.
 * Pure. Used by the double-booking guard on assignment and by the double-booked alert.
 */
export type StopWindow = { timeWindowEarliest: Date | null; timeWindowLatest: Date | null };
export type Window = { start: Date; end: Date };

export function loadWindow(stops: StopWindow[]): Window | null {
  const starts = stops.map((s) => s.timeWindowEarliest ?? s.timeWindowLatest).filter((d): d is Date => d != null);
  const ends = stops.map((s) => s.timeWindowLatest ?? s.timeWindowEarliest).filter((d): d is Date => d != null);
  if (starts.length === 0 || ends.length === 0) return null;
  const start = new Date(Math.min(...starts.map((d) => d.getTime())));
  const end = new Date(Math.max(...ends.map((d) => d.getTime())));
  return { start, end: end.getTime() < start.getTime() ? start : end };
}

/** Two windows overlap when each starts before the other ends. Back to back (one ends as the next starts) is fine. */
export function windowsOverlap(a: Window, b: Window): boolean {
  return a.start.getTime() < b.end.getTime() && b.start.getTime() < a.end.getTime();
}
