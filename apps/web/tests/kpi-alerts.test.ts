import { describe, expect, test, vi } from "vitest";

// evaluateKpiAlerts is pure, but the module imports the prisma client at top level
// (used only by hydrateAlertAcknowledgements). Stub it so importing stays side-effect free.
vi.mock("@/lib/db", () => ({ prisma: {} }));

import { DEFAULT_EMPTY_MILE_ALERT_THRESHOLD, evaluateKpiAlerts } from "@/server/kpi-alerts";

const emptyCard = (value: string) => [{ key: "emptyPct", value }];

describe("evaluateKpiAlerts empty-mile threshold", () => {
  test("fires above the default 6.5% threshold", () => {
    const alerts = evaluateKpiAlerts({ weekIso: "2026-W20", lanes: [], cards: emptyCard("7.0") });
    const alert = alerts.find((a) => a.code === "EMPTY_MILE_THRESHOLD");
    expect(alert).toBeDefined();
    expect(alert?.message).toContain(`${DEFAULT_EMPTY_MILE_ALERT_THRESHOLD.toFixed(1)}%`);
  });

  test("does not fire at or below the default threshold", () => {
    const alerts = evaluateKpiAlerts({ weekIso: "2026-W20", lanes: [], cards: emptyCard("6.5") });
    expect(alerts.some((a) => a.code === "EMPTY_MILE_THRESHOLD")).toBe(false);
  });

  test("honors a configured threshold (lower fires earlier)", () => {
    const alerts = evaluateKpiAlerts({
      weekIso: "2026-W20",
      lanes: [],
      cards: emptyCard("5.0"),
      emptyPctAlert: 4
    });
    const alert = alerts.find((a) => a.code === "EMPTY_MILE_THRESHOLD");
    expect(alert).toBeDefined();
    expect(alert?.message).toContain("4.0%");
  });

  test("honors a configured threshold (higher suppresses)", () => {
    const alerts = evaluateKpiAlerts({
      weekIso: "2026-W20",
      lanes: [],
      cards: emptyCard("7.0"),
      emptyPctAlert: 10
    });
    expect(alerts.some((a) => a.code === "EMPTY_MILE_THRESHOLD")).toBe(false);
  });

  test("falls back to the default when the configured value is not finite", () => {
    const alerts = evaluateKpiAlerts({
      weekIso: "2026-W20",
      lanes: [],
      cards: emptyCard("7.0"),
      emptyPctAlert: Number.NaN
    });
    expect(alerts.some((a) => a.code === "EMPTY_MILE_THRESHOLD")).toBe(true);
  });
});
