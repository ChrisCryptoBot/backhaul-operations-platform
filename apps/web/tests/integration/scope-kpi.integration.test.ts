import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { getCustomerDetail, listCustomerRecordsInScope } from "@/server/tl/customers";
import { clearKpiCache, getDeskKpi } from "@/server/tl/kpi";
import { getKpiExtras } from "@/server/tl/kpi-extras";

/**
 * KPI, Lanes and Customers for one slice of the fleet: a request for Dallas never carries Memphis's loads, lanes, customers, drivers, trucks, moved loads or offers; the kept answer is one per
 * slice (asking for Dallas, then Memphis, then Dallas again never hands back the wrong one); and a customer that only hauls in another terminal is not listed for a limited person.
 *   DATABASE_URL=postgresql://demo:demo@localhost:54330/demo RUN_DB_INTEGRATION=true npx vitest run tests/integration/scope-kpi.integration.test.ts
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const W = "sk-w";
const NOW = new Date();
const days = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

async function wipe(id: string) {
  await prisma.workspace.deleteMany({ where: { id } });
}

describe.skipIf(!run)("KPI, Lanes and Customers follow the scope", () => {
  const ids = { dallasLoad: "", memphisLoad: "", memphisQuote: "", dallasQuote: "" };
  beforeAll(async () => {
    await wipe(W);
    await prisma.workspace.create({ data: { id: W, name: "SK fleet", plan: "enterprise" } });
    const truck = (name: string, terminal: string) => prisma.vehicle.create({ data: { workspaceId: W, name, terminal } });
    const dTruck = await truck("SK Dallas Truck", "Dallas");
    const mTruck = await truck("SK Memphis Truck", "Memphis");
    const driver = (name: string, terminal: string) => prisma.driver.create({ data: { workspaceId: W, name, terminal } });
    const dDriver = await driver("SK Dallas Driver", "Dallas");
    const mDriver = await driver("SK Memphis Driver", "Memphis");
    const done = async (n: string, v: { id: string }, d: { id: string }, broker: string, from: string, to: string, rev: number) => {
      const l = await prisma.load.create({ data: { workspaceId: W, vehicleId: v.id, loadNumber: n, status: "completed", quotedRevenue: rev, actualRevenue: rev, loadedMiles: 500, completedAt: days(2), scheduledDate: days(3), createdAt: days(8), originAddress: from, destinationAddress: to, brokerName: broker } });
      await prisma.assignment.create({ data: { loadId: l.id, driverId: d.id, payKind: "cpm", payRate: 0.5, status: "completed" } });
      return l;
    };
    ids.dallasLoad = (await done("SK-D1", dTruck, dDriver, "Dallas Broker", "Dallas, TX", "Atlanta, GA", 1000)).id;
    await done("SK-D2", dTruck, dDriver, "Shared Broker", "Dallas, TX", "Houston, TX", 800);
    ids.memphisLoad = (await done("SK-M1", mTruck, mDriver, "Memphis Broker", "Memphis, TN", "Chicago, IL", 1200)).id;
    await done("SK-M2", mTruck, mDriver, "Shared Broker", "Memphis, TN", "Nashville, TN", 600);
    // A customer record with no loads at all: findable by everyone.
    await prisma.customer.createMany({ data: ["Dallas Broker", "Memphis Broker", "Shared Broker", "Brand New Broker"].map((name) => ({ workspaceId: W, name })) });
    // A move and an offer on each terminal's truck.
    for (const [loadId, number] of [[ids.dallasLoad, "SK-D1"], [ids.memphisLoad, "SK-M1"]] as const) {
      await prisma.auditEvent.create({ data: { workspaceId: W, loadId, entity: "load", action: "rescheduled", summary: `${number} rescheduled`, reason: "Customer changed the date", createdAt: days(1) } });
    }
    const quote = (n: string, v: { id: string }) => prisma.load.create({ data: { workspaceId: W, vehicleId: v.id, loadNumber: n, status: "quote", quotedRevenue: 700, createdAt: days(1) } });
    ids.dallasQuote = (await quote("SK-QD", dTruck)).id;
    ids.memphisQuote = (await quote("SK-QM", mTruck)).id;
    await prisma.loadDecision.create({ data: { loadId: ids.memphisQuote, decisionType: "passed", decidedAt: days(1) } });
  });
  afterAll(async () => {
    await wipe(W);
  });

  const dallas = ["Dallas"];
  const memphis = ["Memphis"];

  test("a Dallas request carries Dallas only: lanes, customers, drivers, trucks, the filter menus", async () => {
    clearKpiCache();
    const k = await getDeskKpi({ period: "all", compare: false, terminals: dallas }, NOW, W);
    expect(k.lanes.map((l) => l.key).sort()).toEqual(["Dallas, TX → Atlanta, GA", "Dallas, TX → Houston, TX"]);
    expect(k.brokers.map((b) => b.name).sort()).toEqual(["Dallas Broker", "Shared Broker"]);
    expect(k.drivers.map((d) => d.name)).toEqual(["SK Dallas Driver"]);
    expect(k.trucks.map((t) => t.name)).toEqual(["SK Dallas Truck"]);
    expect(k.current.loads).toBe(2);
    expect(k.choices.lanes.every((l) => l.startsWith("Dallas"))).toBe(true);
    expect(k.choices.brokers).not.toContain("Memphis Broker");
    expect(k.choices.drivers).toEqual(["SK Dallas Driver"]);
    // The shared customer counts only its Dallas load.
    expect(k.brokers.find((b) => b.name === "Shared Broker")!.loads).toBe(1);
  });

  test("the kept answer is one per slice: Dallas, Memphis, Dallas again, and everything", async () => {
    const a = await getDeskKpi({ period: "all", compare: false, terminals: dallas }, NOW, W);
    const m = await getDeskKpi({ period: "all", compare: false, terminals: memphis }, NOW, W);
    const a2 = await getDeskKpi({ period: "all", compare: false, terminals: ["Dallas"] }, NOW, W);
    const all = await getDeskKpi({ period: "all", compare: false }, NOW, W);
    const both = await getDeskKpi({ period: "all", compare: false, terminals: ["Memphis", "Dallas"] }, NOW, W);
    expect(m.lanes.map((l) => l.key).sort()).toEqual(["Memphis, TN → Chicago, IL", "Memphis, TN → Nashville, TN"]);
    expect(a2.current.gross).toBe(a.current.gross);
    expect(a.current.gross).toBe(1800);
    expect(m.current.gross).toBe(1800);
    expect(all.current.loads).toBe(4);
    expect(both.current.loads).toBe(4); // the same terminals in any order are the whole fleet's four loads
  });

  test("moved loads and offers belong to the terminal of their load", async () => {
    const d = await getKpiExtras(W, days(30), dallas);
    expect(d.rolled!.map((r) => r.loadId)).toEqual([ids.dallasLoad]);
    expect(d.tenders!.filter((t) => t.kind === "passed")).toHaveLength(0); // the pass was on Memphis's truck
    expect(d.tenders!.filter((t) => t.kind === "open")).toHaveLength(1); // Dallas's open offer
    const m = await getKpiExtras(W, days(30), memphis);
    expect(m.rolled!.map((r) => r.loadId)).toEqual([ids.memphisLoad]);
    expect(m.tenders!.filter((t) => t.kind === "passed")).toHaveLength(1);
    const all = await getKpiExtras(W, days(30));
    expect(all.rolled).toHaveLength(2);
    const k = await getDeskKpi({ period: "all", compare: false, terminals: dallas }, NOW, W);
    expect(k.rolled.count).toBe(1);
  });

  test("Customers: a limited person sees the customers with loads in their terminals, and the ones with no loads yet", async () => {
    const names = async (t: readonly string[] | null) => (await listCustomerRecordsInScope(t, W)).map((r) => r.name).sort();
    expect(await names(dallas)).toEqual(["Brand New Broker", "Dallas Broker", "Shared Broker"]);
    expect(await names(memphis)).toEqual(["Brand New Broker", "Memphis Broker", "Shared Broker"]);
    expect(await names(null)).toEqual(["Brand New Broker", "Dallas Broker", "Memphis Broker", "Shared Broker"]);
  });

  test("a customer page for a limited person counts only their loads", async () => {
    const own = await getCustomerDetail({ name: "Shared Broker" }, NOW, W, dallas);
    expect(own!.loadCount).toBe(1);
    expect(own!.recent.map((r) => r.loadNumber)).toEqual(["SK-D2"]);
    expect(own!.kpi!.loads).toBe(1);
    const elsewhere = await getCustomerDetail({ name: "Memphis Broker" }, NOW, W, dallas);
    expect(elsewhere!.loadCount).toBe(0);
    expect(elsewhere!.kpi).toBeNull();
    const whole = await getCustomerDetail({ name: "Shared Broker" }, NOW, W);
    expect(whole!.loadCount).toBe(2);
  });
});
