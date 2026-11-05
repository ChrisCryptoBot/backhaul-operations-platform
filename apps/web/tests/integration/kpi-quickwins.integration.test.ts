import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { rememberDiesel } from "@/server/fuel/diesel-history";
import { clearKpiCache, getDeskKpi } from "@/server/tl/kpi";
import { getKpiExtras, kpiExtrasStamp } from "@/server/tl/kpi-extras";
import { getKpiNote, saveKpiNote, setLaneTarget, weekKeyOf } from "@/server/tl/kpi-inputs";
import { buildExport } from "@/server/tl/exports";

/**
 * The KPI quick wins against the demo database in a workspace of its own: a lane's target rate and the note for the weekly call (set, changed, taken away, refused when wrong, audited, one fleet's
 * never another's), what the KPI reads besides finished loads (moved loads, offers, targets, diesel), and that the kept KPI answer moves when any of them does.
 *   DATABASE_URL=postgresql://demo:demo@localhost:54330/demo RUN_DB_INTEGRATION=true npx vitest run tests/integration/kpi-quickwins.integration.test.ts
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const W = "kq-w";
const OTHER = "kq-other";
const NOW = new Date();
const days = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
const LANE = "Dallas, TX → Atlanta, GA";

async function wipe(id: string) {
  await prisma.workspace.deleteMany({ where: { id } });
}

describe.skipIf(!run)("KPI targets, notes and extras", () => {
  const ids = { a: "", b: "", quote: "", booked: "", passed: "" };
  beforeAll(async () => {
    await wipe(W);
    await wipe(OTHER);
    await prisma.dieselPrice.deleteMany({ where: { weekOf: { in: ["2026-10-26", "2026-11-02"] }, region: "NUS" } });
    await prisma.workspace.create({ data: { id: W, name: "KQ fleet", plan: "enterprise" } });
    await prisma.workspace.create({ data: { id: OTHER, name: "KQ other", plan: "enterprise" } });
    const truck = await prisma.vehicle.create({ data: { workspaceId: W, name: "KQ Truck" } });
    const load = (n: string, rev: number, status = "completed") =>
      prisma.load.create({ data: { workspaceId: W, vehicleId: truck.id, loadNumber: n, status, quotedRevenue: rev, actualRevenue: status === "completed" ? rev : null, loadedMiles: 500, completedAt: status === "completed" ? days(2) : null, scheduledDate: days(1), createdAt: days(6), originAddress: "Dallas, TX", destinationAddress: "Atlanta, GA", brokerName: "KQ Broker", trailerType: "reefer", fuelSurcharge: 80 } });
    ids.a = (await load("KQ-1", 1000)).id;
    ids.b = (await load("KQ-2", 1400)).id;
    // Offers: one booked (a load with an accepted decision), one passed, one still open.
    ids.quote = (await load("KQ-Q1", 900, "quote")).id;
    ids.passed = (await load("KQ-Q2", 800, "quote")).id;
    await prisma.loadDecision.create({ data: { loadId: ids.passed, decisionType: "passed", decidedAt: days(1) } });
    await prisma.loadDecision.create({ data: { loadId: ids.a, decisionType: "accepted", decidedAt: days(3) } });
    // A load moved to a new pickup time (what a reschedule writes).
    await prisma.auditEvent.create({ data: { workspaceId: W, loadId: ids.a, entity: "load", action: "rescheduled", summary: "KQ-1 rescheduled", reason: "Customer changed the date", createdAt: days(1) } });
  });
  afterAll(async () => {
    await wipe(W);
    await wipe(OTHER);
    await prisma.dieselPrice.deleteMany({ where: { weekOf: { in: ["2026-10-26", "2026-11-02"] }, region: "NUS" } });
  });

  test("a lane target is set, changed, taken away, refused when it is not money, and audited", async () => {
    expect(await setLaneTarget(LANE, "1,500", NOW, W)).toEqual({ ok: true, changed: true });
    expect(await setLaneTarget(LANE, "1500.00", NOW, W)).toEqual({ ok: true, changed: false });
    expect(await setLaneTarget(LANE, "$1,650.5", NOW, W)).toEqual({ ok: true, changed: true });
    expect(Number((await prisma.laneTarget.findUniqueOrThrow({ where: { workspaceId_lane: { workspaceId: W, lane: LANE } } })).targetRate)).toBe(1650.5);
    for (const bad of ["abc", "-5", "12.345", "2000000"]) expect(await setLaneTarget(LANE, bad, NOW, W), bad).toMatchObject({ ok: false });
    expect(await setLaneTarget("  ", "100", NOW, W)).toMatchObject({ ok: false });
    const audit = await prisma.auditEvent.findMany({ where: { workspaceId: W, action: "lane_target_set" }, orderBy: { createdAt: "asc" } });
    expect(audit).toHaveLength(2);
    expect(audit[1]!.after).toMatchObject({ Lane: LANE, Target: "1650.50" });
    expect(audit[1]!.before).toMatchObject({ Target: "1500.00" });
    expect(await setLaneTarget(LANE, "", NOW, W)).toEqual({ ok: true, changed: true }); // blank takes it away
    expect(await prisma.laneTarget.count({ where: { workspaceId: W } })).toBe(0);
    expect(await setLaneTarget(LANE, "0", NOW, W)).toEqual({ ok: true, changed: false });
  });

  test("a target in one fleet is not in another", async () => {
    await setLaneTarget(LANE, "1700", NOW, W);
    expect(await prisma.laneTarget.count({ where: { workspaceId: OTHER } })).toBe(0);
    expect((await getKpiExtras(OTHER, days(60))).laneTargets!.size).toBe(0);
    expect((await getKpiExtras(W, days(60))).laneTargets!.get(LANE)).toBe(1700);
  });

  test("the note for the call is kept per week, trimmed, audited, bounded, and taken away when empty", async () => {
    const key = weekKeyOf(NOW.getTime(), "America/Chicago");
    expect(key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(new Date(`${key}T12:00:00Z`).getUTCDay()).toBe(1); // a Monday
    expect(await saveKpiNote(key, "  Detention at the Atlanta dock again.  ", NOW, W)).toEqual({ ok: true, changed: true });
    expect((await getKpiNote(key, W))!.body).toBe("Detention at the Atlanta dock again.");
    expect(await saveKpiNote(key, "Detention at the Atlanta dock again.", NOW, W)).toEqual({ ok: true, changed: false });
    expect(await getKpiNote(key, OTHER)).toBeNull();
    expect(await saveKpiNote("not-a-week", "x", NOW, W)).toMatchObject({ ok: false });
    expect(await saveKpiNote(key, "x".repeat(4001), NOW, W)).toMatchObject({ ok: false });
    expect(await saveKpiNote(key, "   ", NOW, W)).toEqual({ ok: true, changed: true });
    expect(await getKpiNote(key, W)).toBeNull();
    expect(await prisma.auditEvent.count({ where: { workspaceId: W, action: "kpi_note_saved" } })).toBe(2);
  });

  test("the KPI reads moved loads, offers, targets and the diesel price, for this fleet only", async () => {
    await rememberDiesel({ fuel: "diesel", period: "2026-10-26", padd: "NUS", pricePerGallon: 3.9 });
    await rememberDiesel({ fuel: "diesel", period: "2026-11-02", padd: "NUS", pricePerGallon: 3.95 });
    await rememberDiesel({ fuel: "gasoline", period: "2026-11-02", padd: "NUS", pricePerGallon: 3.2 }); // not diesel: not kept
    const x = await getKpiExtras(W, days(60));
    expect(x.rolled).toHaveLength(1);
    expect(x.rolled![0]).toMatchObject({ loadId: ids.a, reason: "Customer changed the date" });
    expect(x.tenders!.filter((t) => t.kind === "booked")).toHaveLength(1);
    expect(x.tenders!.filter((t) => t.kind === "passed")).toHaveLength(1);
    expect(x.tenders!.filter((t) => t.kind === "open")).toHaveLength(1); // KQ-Q1 has no decision
    expect(x.diesel!.map((d) => d.weekOf)).toEqual(expect.arrayContaining(["2026-10-26", "2026-11-02"]));
    const other = await getKpiExtras(OTHER, days(60));
    expect(other.rolled).toEqual([]);
    expect(other.tenders).toEqual([]);
  });

  test("the kept KPI answer moves when a target, a moved load or an offer changes, and carries the new figures", async () => {
    clearKpiCache();
    const before = await getDeskKpi({ period: "all", compare: false }, NOW, W);
    const lane = before.lanes.find((l) => l.key === LANE)!;
    expect(lane).toMatchObject({ targetRate: 1700, score: "below", loads: 2 });
    expect(lane.vsTarget).toBeCloseTo((1080 + 1480) / 2 - 1700, 5);
    expect(before.mix.trailer[0]).toMatchObject({ label: "Reefer", loads: 2 });
    expect(before.rolled.count).toBe(1);
    expect(before.tender.current).toMatchObject({ received: 3, booked: 1, passed: 1, open: 1 });
    const stamp = await kpiExtrasStamp(W);
    await setLaneTarget(LANE, "1000", NOW, W); // now OK
    expect(await kpiExtrasStamp(W)).not.toBe(stamp);
    const after = await getDeskKpi({ period: "all", compare: false }, NOW, W);
    expect(after.lanes.find((l) => l.key === LANE)).toMatchObject({ targetRate: 1000, score: "ok" });
    await prisma.auditEvent.create({ data: { workspaceId: W, loadId: ids.b, entity: "load", action: "rescheduled", summary: "KQ-2 rescheduled", reason: "Driver not available", createdAt: days(1) } });
    expect((await getDeskKpi({ period: "all", compare: false }, NOW, W)).rolled.count).toBe(2);
  });

  test("the lane export carries the tracker's columns and the target and scorecard", async () => {
    // The export is built for the signed-in fleet; the columns are pinned in the source.
    const csv = (await buildExport("kpi-lanes", {}, NOW))!.csv;
    for (const h of ["Revenue per load", "Loaded miles", "Total empty miles", "Total trip miles", "Target per load", "Vs target", "Scorecard"]) expect(csv).toContain(h);
    expect((await buildExport("kpi-trucks", {}, NOW))!.csv).toContain("Empty miles (%)");
  });
});
