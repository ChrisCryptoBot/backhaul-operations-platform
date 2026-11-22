/**
 * The Messages page keeps itself current (no reload to see a driver's reply). Pure rules, shared by the page's loop and the server's throttle.
 *
 * While the tab is visible the page asks the server every LIVE_POLL_MS to look on the phone link now: send what is waiting and take in what the phones wrote, the same work the minute
 * cron does. The server does that at most once per LIVE_PULL_MIN_MS per fleet however many tabs ask, so ten open desks still cost one bridge read per window. The page refreshes when
 * something changed, and at least every LIVE_REFRESH_MS anyway, so a teammate's message on a fleet without the app still shows.
 */
export const LIVE_POLL_MS = 10_000;
export const LIVE_PULL_MIN_MS = 8_000;
export const LIVE_REFRESH_MS = 30_000;

export type LivePullResult = { pulled: boolean; changed: boolean };

/** Whether a fleet may be pulled now, given when it last was (null: never). */
export function pullDue(lastAt: number | null, now: number, minMs = LIVE_PULL_MIN_MS): boolean {
  return lastAt == null || now - lastAt >= minMs;
}

/** Whether the page should re-read itself: something changed on the link, or the fallback window ran out. */
export function refreshDue(i: { changed: boolean; lastRefreshAt: number; now: number }, everyMs = LIVE_REFRESH_MS): boolean {
  return i.changed || i.now - i.lastRefreshAt >= everyMs;
}

/** Whether one pull changed anything the page shows: a message came in, a sent one was delivered, or a driver read one. */
export const pullChanged = (r: { delivered: number; taken: number; readByDriver: number }): boolean => r.delivered > 0 || r.taken > 0 || r.readByDriver > 0;
