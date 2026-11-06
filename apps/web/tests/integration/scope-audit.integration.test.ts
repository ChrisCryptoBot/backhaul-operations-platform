import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { listAudit } from "@/server/tl/audit";
import { getRadarData } from "@/server/tl/radar";
import { searchDesk } from "@/server/tl/search";

/**
 * The audit trail and the header search for one slice of the fleet. An event has no terminal of its own: one on a load follows the load, one on a truck, driver or trailer follows that unit, and one about
 * neither (settings, the team, a customer) is for someone who can see every terminal. Search finds only the loads, drivers, customers and cities of the terminals in view.
 *   DATABASE_URL=postgresql://demo:demo@localhost:54330/demo RUN_DB_INTEGRATION=true npx vitest run tests/integration/scope-audit.integration.test.ts
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const W = "sa-w";
const NOW = new Date();

async function wipe(id: string) {
  await prisma.workspace.deleteMany({ where: { id } });
}

describe.skipIf(!run)("audit and search follow the scope", () => {
  beforeAll(async () => {
    await wipe(W);
    await prisma.workspace.create({ data: { id: W, name: "SA fleet", plan: "enterprise" } });
    const dTruck = await prisma.vehicle.create({ data: { workspaceId: W, name: "SA Dallas Truck", terminal: "Dallas", lastLat: 32.78, lastLng: -96.8, lastLocatedAt: NOW } });
    const mTruck = await prisma.vehicle.create({ data: { workspaceId: W, name: "SA Memphis Truck", terminal: "Memphis", lastLat: 35.15, lastLng: -90.05, lastLocatedAt: NOW } });
    const dDriver = await prisma.driver.create({ data: { workspaceId: W, name: "SA Dallas Driver", terminal: "Dallas", phone: "5550101" } });
    const mDriver = await prisma.driver.create({ data: { workspaceId: W, name: "SA Memphis Driver", terminal: "Memphis", phone: "5550102" } });
    const dTrailer = await prisma.trailer.create({ data: { workspaceId: W, number: "SA-DT-1", terminal: "Dallas", lastLat: 32.8, lastLng: -96.7, lastLocatedAt: NOW } });
    const mTrailer = await prisma.trailer.create({ data: { workspaceId: W, number: "SA-MT-1", terminal: "Memphis", lastLat: 35.1, lastLng: -90.0, lastLocatedAt: NOW } });
    const load = (n: string, v: { id: string } | null, from: string, to: string, broker: string) => prisma.load.create({ data: { workspaceId: W, vehicleId: v?.id ?? null, loadNumber: n, status: "accepted", quotedRevenue: 500, originAddress: from, destinationAddress: to, brokerName: broker } });
    const dLoad = await load("SA-D1", dTruck, "Dallas, TX", "Waco, TX", "SA Dallas Broker");
    const mLoad = await load("SA-M1", mTruck, "Memphis, TN", "Selma, AL", "SA Memphis Broker");
    await load("SA-OPEN", null, "Reno, NV", "Boise, ID", "SA Open Broker");
    const ev = (data: object) => prisma.auditEvent.create({ data: { workspaceId: W, entity: "load", summary: "x", actor: "t", createdAt: NOW, ...data } as never });
    await ev({ loadId: dLoad.id, loadNumber: "SA-D1", action: "booked", summary: "SA-D1 booked" });
    await ev({ loadId: mLoad.id, loadNumber: "SA-M1", action: "booked", summary: "SA-M1 booked" });
    await ev({ entity: "trailer", entityId: dTrailer.id, action: "trailer_changed", summary: "SA-DT-1 changed" });
    await ev({ entity: "trailer", entityId: mTrailer.id, action: "trailer_changed", summary: "SA-MT-1 changed" });
    await ev({ entity: "fleet", entityId: mDriver.id, action: "driver_changed", summary: "SA Memphis Driver changed" });
    await ev({ entity: "fleet", entityId: dDriver.id, action: "driver_changed", summary: "SA Dallas Driver changed" });
    await ev({ entity: "settings", action: "thresholds_changed", summary: "Rules changed" });
    await ev({ entity: "customer", action: "customer_changed", summary: "SA Dallas Broker changed" });
  });
  afterAll(async () => {
    await wipe(W);
  });

  const summaries = async (terminals: string[] | null, unlimited: boolean, f: Parameters<typeof listAudit>[0] = {}) => (await listAudit(f, W, terminals, unlimited)).rows.map((r) => r.summary).sort();

  test("a limited person sees the events on their loads and units, and nothing about settings or the team", async () => {
    expect(await summaries(["Dallas"], false)).toEqual(["SA Dallas Driver changed", "SA-D1 booked", "SA-DT-1 changed"]);
    expect(await summaries(["Memphis"], false)).toEqual(["SA Memphis Driver changed", "SA-M1 booked", "SA-MT-1 changed"]);
  });

  test("someone who can see every terminal, narrowed to one, also keeps the events about neither", async () => {
    expect(await summaries(["Dallas"], true)).toEqual(["Rules changed", "SA Dallas Broker changed", "SA Dallas Driver changed", "SA-D1 booked", "SA-DT-1 changed"]);
    expect((await summaries(null, true)).length).toBe(8);
  });

  test("the filters, the totals and the pages hold in a scope", async () => {
    expect(await summaries(["Dallas"], false, { q: "booked" })).toEqual(["SA-D1 booked"]);
    expect(await summaries(["Dallas"], false, { group: "fleet" })).toEqual(["SA Dallas Driver changed", "SA-DT-1 changed"]);
    expect(await summaries(["Dallas"], false, { q: "100%_" })).toEqual([]); // wildcards are text
    const page = await listAudit({ pageSize: 2, page: 1 }, W, ["Dallas"], false);
    expect(page).toMatchObject({ total: 3, all: 3, pageSize: 2 });
    expect(page.rows).toHaveLength(2);
    expect((await listAudit({ pageSize: 2, page: 2 }, W, ["Dallas"], false)).rows).toHaveLength(1);
    const memphis = await listAudit({}, W, ["Memphis"], false);
    expect(memphis.rows.every((r) => !r.summary.includes("Dallas"))).toBe(true);
  });

  test("the radar carries only the scope's tractors and trailers", async () => {
    const dallas = await getRadarData(W, ["Dallas"]);
    expect(dallas.tractors.map((t) => t.name)).toEqual(["SA Dallas Truck"]);
    expect(dallas.trailers.map((t) => t.number)).toEqual(["SA-DT-1"]);
    const all = await getRadarData(W, null);
    expect(all.tractors).toHaveLength(2);
    expect(all.trailers).toHaveLength(2);
  });

  test("search finds only the terminals' loads, drivers, customers and cities (an unplaced booking is everyone's)", async () => {
    const labels = async (terminals: string[] | null, q: string) => (await searchDesk(q, W, terminals)).map((h) => `${h.kind}:${h.label}`).sort();
    expect(await labels(["Dallas"], "SA")).toEqual(["broker:SA Dallas Broker", "broker:SA Open Broker", "driver:SA Dallas Driver", "load:SA-D1", "load:SA-OPEN"]);
    expect(await labels(["Memphis"], "SA")).toEqual(["broker:SA Memphis Broker", "broker:SA Open Broker", "driver:SA Memphis Driver", "load:SA-M1", "load:SA-OPEN"]);
    expect((await labels(null, "SA")).length).toBe(8);
    expect(await labels(["Dallas"], "Selma")).toEqual([]); // a city only on Memphis's load
    expect(await labels(null, "Selma")).toEqual(["city:Selma, AL", "load:SA-M1"]);
    expect(await labels(["Dallas"], "5550102")).toEqual([]); // Memphis's driver by phone
  });
});
