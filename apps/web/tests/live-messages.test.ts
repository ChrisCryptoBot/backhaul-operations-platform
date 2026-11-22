import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { LIVE_POLL_MS, LIVE_PULL_MIN_MS, LIVE_REFRESH_MS, pullChanged, pullDue, refreshDue } from "@/lib/live-messages";

/** The Messages page keeps itself current: one bridge look per fleet per window, and a refresh only when something changed (or the fallback window runs out). */
describe("live Messages page", () => {
  test("a fleet is pulled at most once per window, however many tabs ask", () => {
    expect(pullDue(null, 1_000)).toBe(true);
    expect(pullDue(1_000, 1_000 + LIVE_PULL_MIN_MS - 1)).toBe(false);
    expect(pullDue(1_000, 1_000 + LIVE_PULL_MIN_MS)).toBe(true);
    // The throttle is shorter than the page's own poll, so one tab is never throttled out of its own looks.
    expect(LIVE_PULL_MIN_MS).toBeLessThan(LIVE_POLL_MS);
  });

  test("the page refreshes on a change, or when the fallback window runs out", () => {
    expect(refreshDue({ changed: true, lastRefreshAt: 0, now: 1 })).toBe(true);
    expect(refreshDue({ changed: false, lastRefreshAt: 0, now: LIVE_REFRESH_MS - 1 })).toBe(false);
    expect(refreshDue({ changed: false, lastRefreshAt: 0, now: LIVE_REFRESH_MS })).toBe(true);
  });

  test("a change is a message in, a message delivered, or a message read by the driver", () => {
    expect(pullChanged({ delivered: 0, taken: 0, readByDriver: 0 })).toBe(false);
    expect(pullChanged({ delivered: 1, taken: 0, readByDriver: 0 })).toBe(true);
    expect(pullChanged({ delivered: 0, taken: 1, readByDriver: 0 })).toBe(true);
    expect(pullChanged({ delivered: 0, taken: 0, readByDriver: 1 })).toBe(true);
  });

  test("the Messages page mounts the live loop", () => {
    const page = readFileSync(join(__dirname, "../src/app/(desk)/messages/page.tsx"), "utf8");
    expect(page).toContain("<LiveMessages />");
  });
});
