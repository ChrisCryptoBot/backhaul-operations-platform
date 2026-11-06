import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { clearAgingCache } from "@/server/tl/aging";
import { clearKpiCache } from "@/server/tl/kpi";
import { clearMovesCache, getMoves } from "@/server/tl/moves";

/**
 * "Why it moved" over real loads, in a workspace of its own: two trailing weeks, each lane's change split into the effects that add back to it, the billed detention read from the invoice's own lines, the
 * terminals in view narrowing what is added up, and one desk never reading another's.
 *   DATABASE_URL=postgresql://demo:demo@localhost:54330/demo RUN_DB_INTEGRATION=true npx vitest run tests/integration/moves.integration.test.ts
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const W = "mv-w";
const OTHER = "mv-other";
const NOW = new Date();
const days = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
const LANE_AB = { originAddress: "Dallas, TX", destinationAddress: "Atlanta, GA" };

async function wipe(id: string) {
  await prisma.workspace.deleteMany({ where: { id } });
}
const fresh = () => {
  clearMovesCache();
  clearKpiCache();
  clearAgingCache();
};
const by = (b: { effects: Array<{ key: string; dollars: number }> }) => Object.fromEntries(b.effects.map((e) => [e.key, e.dollars]));

describe.skipIf(!run)("why it moved", () => {
  beforeAll(async () => {
    await wipe(W);
    await wipe(OTHER);
    await prisma.workspace.create({ data: { id: W, name: "MV fleet", plan: "enterprise" } });
    await prisma.workspace.create({ data: { id: OTHER, name: "MV other", plan: "enterprise" } });
    const dallas = await prisma.vehicle.create({ data: { workspaceId: W, name: "MV Dallas Truck", terminal: "Dallas" } });
    const memphis = await prisma.vehicle.create({ data: { workspaceId: W, name: "MV Memphis Truck", terminal: "Memphis" } });
    const mk = (n: string, v: { id: string }, doneDaysAgo: number, extra: object) =>
      prisma.load.create({ data: { workspaceId: W, vehicleId: v.id, loadNumber: n, status: "completed", completedAt: days(doneDaysAgo), quotedRevenue: 0, scheduledDate: days(doneDaysAgo + 1), brokerName: "Acme", ...extra } });
    // Dallas to Atlanta: the hand case from the unit test. Before: 800 loaded and 100 empty miles, $2,000 line haul and $200 surcharge, $700 of costs.
    await mk("MV-AB-1", dallas, 10, { ...LANE_AB, actualRevenue: 2000, fuelSurcharge: 200, loadedMiles: 800, pickupDeadheadMiles: 50, returnDeadheadMiles: 50, expenseFuelActual: 600, expenseTolls: 50, expenseMisc: 50 });
    // After: 1,000 loaded and 50 empty miles, $2,800 and $260, $945 of costs, and $90 of detention on the invoice.
    await mk("MV-AB-2", dallas, 3, {
      ...LANE_AB,
      actualRevenue: 2800,
      fuelSurcharge: 260,
      loadedMiles: 1000,
      pickupDeadheadMiles: 25,
      returnDeadheadMiles: 25,
      expenseFuelActual: 800,
      expenseTolls: 70,
      expenseMisc: 75,
      paymentStatus: "invoiced",
      invoicedAt: days(2),
      invoicedAmount: 3150,
      invoiceLines: [{ label: "Line haul", amount: 2800 }, { label: "Fuel surcharge", amount: 260 }, { label: "Detention", amount: 90 }]
    });
    // A lane that ran only before, one that ran only after (Memphis), and a Memphis load with no cost recorded.
    await mk("MV-CD-1", dallas, 9, { originAddress: "Tulsa, OK", destinationAddress: "Joplin, MO", brokerName: "Zed", actualRevenue: 500, fuelSurcharge: 0, loadedMiles: 300, expenseFuelActual: 100 });
    await mk("MV-EF-1", memphis, 2, { originAddress: "Memphis, TN", destinationAddress: "Little Rock, AR", brokerName: "Zed", actualRevenue: 400, fuelSurcharge: 0, loadedMiles: 140, expenseFuelActual: 50 });
    await mk("MV-GH-1", memphis, 1, { originAddress: "Nashville, TN", destinationAddress: "Louisville, KY", brokerName: "Zed", actualRevenue: 100, fuelSurcharge: 0, loadedMiles: 60 });
    // Another desk's loads must never be read.
    const o = await prisma.vehicle.create({ data: { workspaceId: OTHER, name: "MV Other Truck", terminal: "Dallas" } });
    await prisma.load.create({ data: { workspaceId: OTHER, vehicleId: o.id, loadNumber: "MV-OTHER", status: "completed", completedAt: days(3), quotedRevenue: 0, actualRevenue: 99_999, loadedMiles: 500, ...LANE_AB } });
    fresh();
  });
  afterAll(async () => {
    await wipe(W);
    await wipe(OTHER);
  });

  test("the whole desk: two weeks, the result of each, and the change split so it adds back to the cent", async () => {
    const m = await getMoves({}, NOW, W);
    expect(m.ago).toBe(0);
    expect(m.after.end).toBe(NOW.getTime());
    expect(m.before.end).toBe(m.after.start);
    expect(m.desk.before).toMatchObject({ loads: 2, loadedMiles: 1100, drivenMiles: 1200, lineHaul: 2500, fsc: 200, expenses: 800 });
    expect(m.desk.after).toMatchObject({ loads: 3, detention: 90 });
    // Before: (2000 + 200 - 700) + (500 - 100) = 1900. After: (2800 + 260 + 90 - 945) + (400 - 50) + 100 = 2655.
    expect(m.desk.bridge).toMatchObject({ before: 1900, after: 2655, change: 755 });
    expect(Math.round(m.desk.bridge.effects.reduce((s, e) => s + e.dollars * 100, 0))).toBe(75_500);
    expect(m.noCosts).toEqual({ before: 0, after: 1 });
  });

  test("each lane's own bridge: the hand case through real loads, a lane that stopped, a lane that started", async () => {
    const m = await getMoves({}, NOW, W);
    expect(m.rows.map((r) => [r.label, r.bridge.change])).toEqual([["Dallas, TX → Atlanta, GA", 705], ["Tulsa, OK → Joplin, MO", -400], ["Memphis, TN → Little Rock, AR", 350], ["Nashville, TN → Louisville, KY", 100]]);
    const ab = m.rows[0]!.bridge;
    expect(ab).toMatchObject({ before: 1500, after: 2205, method: "split" });
    expect(by(ab)).toEqual({ rate: 300, miles: 344.44, deadhead: 38.89, costs: -128.33, fsc: 60, detention: 90 });
    expect(m.rows[1]!.bridge).toMatchObject({ method: "whole" });
    expect(by(m.rows[1]!.bridge)).toEqual({ lane: -400 });
    expect(by(m.rows[2]!.bridge)).toEqual({ lane: 350 });
    expect(m.more).toEqual({ count: 0, change: 0 });
  });

  test("by customer: Acme and Zed, and their changes add to the desk's", async () => {
    const m = await getMoves({ by: "customer" }, NOW, W);
    expect(m.rows.map((r) => [r.label, r.bridge.change])).toEqual([["Acme", 705], ["Zed", 50]]);
    expect(Math.round(m.rows.reduce((s, r) => s + r.bridge.change * 100, 0))).toBe(75_500);
  });

  test("a person limited to Dallas is added up from Dallas's loads only (and the unplaced ones), never Memphis's", async () => {
    fresh();
    const m = await getMoves({ terminals: ["Dallas"] }, NOW, W);
    expect(m.rows.map((r) => r.label)).toEqual(["Dallas, TX → Atlanta, GA", "Tulsa, OK → Joplin, MO"]);
    expect(m.desk.bridge).toMatchObject({ before: 1900, after: 2205, change: 305 });
    expect(m.noCosts.after).toBe(0);
    // Another terminal-order and the same answer are one kept answer; Memphis alone is the other side.
    const mem = await getMoves({ terminals: ["Memphis"] }, NOW, W);
    expect(mem.rows.map((r) => r.label).sort()).toEqual(["Memphis, TN → Little Rock, AR", "Nashville, TN → Louisville, KY"]);
    expect(mem.desk.bridge).toMatchObject({ before: 0, after: 450, change: 450 });
  });

  test("a week further back moves both windows; a week with nothing in it is a lane that started", async () => {
    fresh();
    const m = await getMoves({ ago: 1 }, NOW, W);
    expect(m.ago).toBe(1);
    expect(m.after.end).toBe(NOW.getTime() - 7 * 86_400_000);
    expect(m.desk.before.loads).toBe(0);
    expect(m.desk.after.loads).toBe(2); // the two loads that finished 9 and 10 days ago
    expect(m.desk.bridge).toMatchObject({ before: 0, after: 1900, change: 1900, method: "whole" });
    // Nonsense asks fall back to this week and to lanes.
    expect((await getMoves({ ago: -3 }, NOW, W)).ago).toBe(0);
    expect((await getMoves({ ago: 99 }, NOW, W)).ago).toBe(0);
    expect((await getMoves({ by: "nonsense" as never }, NOW, W)).by).toBe("lane");
  });

  test("another desk's loads are never read", async () => {
    fresh();
    const m = await getMoves({}, NOW, W);
    expect(JSON.stringify(m)).not.toContain("99999");
    expect(m.rows.every((r) => r.after.lineHaul < 99_999)).toBe(true);
    const other = await getMoves({}, NOW, OTHER);
    expect(other.desk.after).toMatchObject({ loads: 1, lineHaul: 99_999 });
  });
});
