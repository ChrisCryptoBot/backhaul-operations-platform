import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { THRESHOLD_DEFAULTS } from "@/lib/thresholds";
import { getAlerts } from "@/server/tl/alerts";
import { buildExport } from "@/server/tl/exports";
import { invoiceLoad } from "@/server/tl/invoicing";
import { getDeskKpi } from "@/server/tl/kpi";
import { getStoredThresholds, getThresholds, saveThresholds } from "@/server/tl/thresholds";
import { listAudit } from "@/server/tl/audit";

/**
 * Needs a seeded database (see tl-dispatch.integration.test.ts). Changes the workspace thresholds and creates two loads, and
 * puts everything back afterwards, so the demo data is left as the seed wrote it.
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const WS = "demo-workspace";
const H = 3_600_000;

describe.skipIf(!run)("thresholds, KPI totals and exports on the demo database", () => {
  const startedAt = new Date();
  const loadIds: string[] = [];

  beforeAll(async () => {
    await saveThresholds({});
  });

  afterAll(async () => {
    await saveThresholds({});
    await prisma.auditEvent.deleteMany({ where: { createdAt: { gte: startedAt }, action: "thresholds_changed" } });
    await prisma.load.deleteMany({ where: { id: { in: loadIds } } });
    await prisma.auditEvent.deleteMany({ where: { loadId: { in: loadIds } } });
  });

  test("a bad form saves nothing and says which field; a good one is stored, applied and written to the audit log", async () => {
    const bad = await saveThresholds({ emptyAmberPct: "40", emptyRedPct: "30", defaultPayTermsDays: "abc" });
    expect(bad.ok).toBe(false);
    expect(await getThresholds()).toEqual(THRESHOLD_DEFAULTS);

    const ok = await saveThresholds({ emptyAmberPct: "20", emptyRedPct: "30", defaultPayTermsDays: "45", pickupAlertHours: "", sentNoAnswerHours: "6" });
    expect(ok).toMatchObject({ ok: true, changed: true });
    const t = await getThresholds();
    expect(t).toMatchObject({ emptyAmberPct: 20, emptyRedPct: 30, defaultPayTermsDays: 45, sentNoAnswerHours: 6, pickupAlertHours: 24 });
    expect((await getStoredThresholds()).pickupAlertHours).toBeNull();

    const [event] = (await listAudit({ group: "settings" })).rows;
    expect(event).toMatchObject({ action: "thresholds_changed", entity: "settings" });
    expect(event!.after).toMatchObject({ "Invoices are due after (days)": 45, "Empty miles turn amber at (%)": 20 });
    expect(event!.before).toMatchObject({ "Invoices are due after (days)": 30, "Empty miles turn amber at (%)": 25 });
  });

  test("saving what is already stored changes nothing and writes no event", async () => {
    const before = (await listAudit({ group: "settings" })).total;
    const again = await saveThresholds({ emptyAmberPct: "20", emptyRedPct: "30", defaultPayTermsDays: "45", sentNoAnswerHours: "6" });
    expect(again).toMatchObject({ ok: true, changed: false });
    expect((await listAudit({ group: "settings" })).total).toBe(before);
  });

  test("the alert timing really moves the alert: a pickup 10 hours out is a block at 24 hours and quiet at 2", async () => {
    const soon = Date.now() + 10 * H;
    const load = await prisma.load.create({
      data: {
        workspaceId: WS,
        loadNumber: "W3-PICKUP",
        status: "draft",
        originAddress: "Dallas, TX",
        destinationAddress: "Tulsa, OK",
        loadedMiles: 260,
        quotedRevenue: 700,
        stops: { create: [{ stopSequence: 1, stopType: "pickup", addressString: "Dallas, TX", timeWindowEarliest: new Date(soon), timeWindowLatest: new Date(soon + 2 * H), referenceNumbers: ["PU-W3"] }] }
      }
    });
    loadIds.push(load.id);
    await saveThresholds({ pickupAlertHours: "24" });
    expect((await getAlerts()).alerts.some((a) => a.loadId === load.id && a.code === "PICKUP_NO_DRIVER")).toBe(true);
    await saveThresholds({ pickupAlertHours: "2" });
    expect((await getAlerts()).alerts.some((a) => a.loadId === load.id && a.code === "PICKUP_NO_DRIVER")).toBe(false);
  });

  test("an invoice for a load with no terms takes the default from Settings", async () => {
    await saveThresholds({ defaultPayTermsDays: "45" });
    const load = await prisma.load.create({
      data: { workspaceId: WS, loadNumber: "W3-INV", status: "completed", completedAt: new Date(), actualRevenue: 800, quotedRevenue: 800, payTermsDays: null }
    });
    loadIds.push(load.id);
    expect(await invoiceLoad(load.id)).toEqual({ ok: true });
    expect((await prisma.load.findUniqueOrThrow({ where: { id: load.id } })).payTermsDays).toBe(45);
  });

  test("the KPI adds up on the real data: lanes sum to the total, a driver cannot out-earn it, the compare window exists", async () => {
    const all = await getDeskKpi({ period: "all", compare: false });
    expect(all.current.loads).toBeGreaterThanOrEqual(30);
    expect(all.lanes.reduce((s, l) => s + l.loads, 0)).toBe(all.current.loads);
    expect(all.lanes.reduce((s, l) => s + l.gross, 0)).toBeCloseTo(all.current.gross, 2);
    expect(all.drivers.reduce((s, d) => s + d.loads, 0)).toBeLessThanOrEqual(all.current.loads);
    expect(all.drivers.reduce((s, d) => s + d.gross, 0)).toBeLessThanOrEqual(all.current.gross + 0.001);
    expect(all.prior).toBeNull();
    expect(all.trend).toHaveLength(12);
    expect(all.current.paidWithinTerms).not.toBeNull();
    expect(all.current.paidWithinTerms!).toBeGreaterThanOrEqual(0);
    expect(all.current.paidWithinTerms!).toBeLessThanOrEqual(1);

    const four = await getDeskKpi({ period: "4w", compare: true });
    expect(four.prior).not.toBeNull();
    expect(four.previous!.end).toBe(four.window.start! - 1);
    expect(four.current.loads + four.prior!.loads).toBeLessThanOrEqual(all.current.loads);

    const broker = all.analytics.summary.topBrokers[0]!.broker; // a broker that has finished loads
    const one = await getDeskKpi({ period: "all", compare: false, filters: { broker } });
    expect(one.current.loads).toBeGreaterThan(0);
    expect(one.current.loads).toBeLessThan(all.current.loads);
    expect(one.choices.brokers).toEqual(all.choices.brokers); // the menus still offer every broker
  });

  test("exports: a header and one row per record, a BOM, a name with the date, and the Loads filter applied", async () => {
    const drafts = await prisma.load.count({ where: { workspaceId: WS, deletedAt: null, status: "draft" } });
    const loads = (await buildExport("loads", { status: "draft" }))!;
    expect(loads.filename).toMatch(/^truelane-desk-loads-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(loads.csv.startsWith("﻿Load,Status,Broker")).toBe(true);
    expect(loads.csv.trim().split("\r\n")).toHaveLength(1 + drafts);

    const invoices = (await buildExport("invoices", {}))!;
    expect(invoices.csv.split("\r\n")[0]).toContain("Invoice");
    expect(invoices.csv.trim().split("\r\n").length).toBeGreaterThan(20);

    const weeks = (await buildExport("kpi-weeks", { period: "all" }))!;
    expect(weeks.csv.trim().split("\r\n")).toHaveLength(13);
    expect(weeks.filename).toMatch(/kpi-weeks-all-/);

    const lanes = (await buildExport("kpi-lanes", { period: "all" }))!;
    expect(lanes.csv.trim().split("\r\n").length).toBeGreaterThan(5);
    const drivers = (await buildExport("kpi-drivers", { period: "all", broker: "Nobody Brokerage" }))!;
    expect(drivers.csv.trim().split("\r\n")).toHaveLength(1); // a filter with no matches leaves just the header

    expect(await buildExport("secrets", {})).toBeNull();
  });
});
