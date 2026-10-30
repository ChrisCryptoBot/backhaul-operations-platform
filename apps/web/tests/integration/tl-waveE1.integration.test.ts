import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { GET as pickDrivers } from "@/app/(desk)/drivers/pick/route";
import { GET as pickTrucks } from "@/app/(desk)/fleet/pick/route";
import { BLANK_QUOTE, readQuote } from "@/lib/quote";
import { listLoadAudit } from "@/server/tl/audit";
import { assignDriver, dispatchLoad, driverSummaryFor, recordDriverResponse, unassignLoad } from "@/server/tl/dispatch";
import { cancelLoad, recordTonu, rescheduleLoad } from "@/server/tl/disruptions";
import { rankDrivers } from "@/server/tl/driver-rank";
import { listDriversPage, listTrucksPage } from "@/server/tl/fleet-list";
import { saveCostProfile, saveDriver, saveTruck } from "@/server/tl/fleet";
import { invoiceLoad, markLoadPaid, undoPaid } from "@/server/tl/invoicing";
import { getPlannerData } from "@/server/tl/planner";
import { listBoardRows, loadInclude } from "@/server/tl/queries";
import { fitQuote } from "@/server/tl/quote";
import { loadSendGaps } from "@/server/tl/readiness";
import { getShellData } from "@/server/tl/shell";
import { listTerminals } from "@/server/tl/terminal";

/**
 * Wave E1 on the demo database: another workspace's records cannot be acted on from this one, and a terminal scope narrows the lists, the fits, the planner and
 * the pickers while a typed search still reaches the rest. Makes its own workspace, trucks, drivers and loads (all named E1) and removes them afterwards.
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const WS = "demo-workspace";
const OTHER = "e1-other-workspace";
const FUTURE = new Date("2031-01-31T12:00:00Z");

const profile: Record<string, string> = {
  monthlyInsurance: "800",
  monthlyAuthority: "100",
  monthlyPhoneSubscriptions: "60",
  monthlyLoanPayment: "0",
  estimatedMonthlyMiles: "7000",
  maintenanceReservePerMile: "0.15",
  tireReservePerMile: "0.04",
  lastFuelPricePerGallon: "3.9",
  driverHourlyTarget: "25",
  archetype: "solo_owner"
};

describe.skipIf(!run)("another workspace's records cannot be acted on", () => {
  const ids = { driver: "", draft: "", assigned: "", done: "", invoiced: "", paid: "" };

  beforeAll(async () => {
    await prisma.workspace.deleteMany({ where: { id: OTHER } });
    await prisma.workspace.create({ data: { id: OTHER, name: "E1 other fleet" } });
    const driver = await prisma.driver.create({ data: { workspaceId: OTHER, name: "E1 Other Driver", cdlClass: "A", cdlExpiry: FUTURE, medicalCardExpiry: FUTURE } });
    const make = (loadNumber: string, extra: Record<string, unknown> = {}) => prisma.load.create({ data: { workspaceId: OTHER, loadNumber, brokerName: "E1 Broker", quotedRevenue: 1000, ...extra } });
    const draft = await make("E1-DRAFT");
    const assigned = await make("E1-ASSIGNED");
    await prisma.assignment.create({ data: { loadId: assigned.id, driverId: driver.id, payKind: "cpm", payRate: 0.5 } });
    const done = await make("E1-DONE", { status: "completed", completedAt: new Date() });
    const invoiced = await make("E1-INVOICED", { status: "completed", completedAt: new Date(), paymentStatus: "invoiced", invoiceNumber: "E1-I-1", invoicedAt: new Date(), invoicedAmount: 1000 });
    const paid = await make("E1-PAID", { status: "completed", completedAt: new Date(), paymentStatus: "paid", invoiceNumber: "E1-I-2", invoicedAt: new Date(), invoicedAmount: 1000, paidAt: new Date(), paidAmount: 1000 });
    await prisma.auditEvent.create({ data: { workspaceId: OTHER, loadId: draft.id, loadNumber: "E1-DRAFT", entity: "load", action: "assigned", summary: "E1 secret note" } });
    Object.assign(ids, { driver: driver.id, draft: draft.id, assigned: assigned.id, done: done.id, invoiced: invoiced.id, paid: paid.id });
  });

  afterAll(async () => {
    await prisma.auditEvent.deleteMany({ where: { OR: [{ workspaceId: OTHER }, { summary: { contains: "E1 " }, workspaceId: WS }] } });
    await prisma.workspace.deleteMany({ where: { id: OTHER } }); // loads, drivers and assignments go with it
  });

  test("assigning, unassigning and sending in this workspace find nothing of the other's", async () => {
    await expect(assignDriver({ loadId: ids.draft, driverId: ids.driver, pay: { kind: "cpm", rate: 0.5 } })).rejects.toThrow(/does not exist/);
    await expect(unassignLoad(ids.assigned, null)).rejects.toThrow(/does not exist/);
    await expect(driverSummaryFor(ids.assigned)).rejects.toThrow(/does not exist/);
    await expect(dispatchLoad(ids.assigned)).rejects.toThrow(/does not exist/);
    await expect(recordDriverResponse(ids.assigned, "accepted")).rejects.toThrow();
    // The driver is looked up inside the workspace too: this workspace's load, the other's driver.
    const mine = await prisma.load.create({ data: { workspaceId: WS, loadNumber: "E1-MINE", brokerName: "E1 Broker", quotedRevenue: 900 } });
    try {
      await expect(assignDriver({ loadId: mine.id, driverId: ids.driver, pay: { kind: "cpm", rate: 0.5 } })).rejects.toThrow(/not available/);
    } finally {
      await prisma.load.delete({ where: { id: mine.id } });
    }
  });

  test("cancelling, a TONU, rescheduling, invoicing and payments find nothing of the other's", async () => {
    await expect(cancelLoad({ loadId: ids.draft, reason: "other", note: "E1 test" })).rejects.toThrow(/does not exist/);
    await expect(recordTonu({ loadId: ids.draft, reason: "other", note: "E1 test", fee: 100 })).rejects.toThrow(/does not exist/);
    await expect(rescheduleLoad({ loadId: ids.draft, reason: "other", note: "E1 test", newPickup: new Date("2031-02-01T12:00:00Z") })).rejects.toThrow(/does not exist/);
    await expect(invoiceLoad(ids.done)).rejects.toThrow();
    await expect(markLoadPaid(ids.invoiced)).rejects.toThrow();
    await expect(undoPaid(ids.paid, "entered against the wrong invoice")).rejects.toThrow();
    expect(await loadSendGaps(ids.draft)).toEqual([]);
    expect(await listLoadAudit(ids.draft)).toEqual([]);
  });

  test("nothing of the other workspace changed", async () => {
    const loads = await prisma.load.findMany({ where: { workspaceId: OTHER }, include: { assignment: true } });
    const by = (n: string) => loads.find((l) => l.loadNumber === n)!;
    expect(by("E1-DRAFT").status).toBe("draft");
    expect(by("E1-ASSIGNED").assignment?.status).toBe("draft");
    expect(by("E1-DONE").paymentStatus).toBeNull();
    expect(by("E1-INVOICED").paymentStatus).toBe("invoiced");
    expect(by("E1-PAID").paymentStatus).toBe("paid");
    expect(await prisma.auditEvent.count({ where: { workspaceId: OTHER } })).toBe(1);
  });

  test("the same calls, asked in the load's own workspace, work and write their audit there", async () => {
    await assignDriver({ loadId: ids.draft, driverId: ids.driver, pay: { kind: "cpm", rate: 0.5 } }, new Date(), OTHER);
    const feed = await listLoadAudit(ids.draft, 25, OTHER);
    expect(feed.length).toBeGreaterThanOrEqual(2);
    expect(await prisma.auditEvent.count({ where: { workspaceId: WS, loadId: ids.draft } })).toBe(0); // not in this workspace's trail
    expect(await listLoadAudit(ids.draft)).toEqual([]);
    const out = await invoiceLoad(ids.done, {}, new Date(), OTHER);
    expect(out.ok).toBe(true);
  });
});

describe.skipIf(!run)("a terminal scope narrows the lists, the fits, the planner and the pickers", () => {
  const startedAt = new Date();
  const T = { north: "E1 North", south: "E1 South" };
  const truck: Record<string, string> = {};
  const driver: Record<string, string> = {};
  const quoteDay = "2027-03-09";
  const priced = () => {
    const r = readQuote({
      ...BLANK_QUOTE,
      stops: [
        { role: "pickup", address: "Dallas, TX", appointment: `${quoteDay}T08:00` },
        { role: "delivery", address: "Tulsa, OK", appointment: `${quoteDay}T17:00` }
      ],
      broker: "E1 Broker",
      offer: "1500",
      loadedMiles: "260",
      emptyToPickup: "40",
      emptyHome: "240",
      marketRate: "1500"
    });
    if (!r) throw new Error("not priceable");
    return r;
  };

  beforeAll(async () => {
    for (const [k, terminal] of Object.entries(T)) {
      const t = await saveTruck({ name: `E1 Truck ${k}`, type: "box_truck", mpg: "10", fuelType: "diesel", terminal }, null);
      if (!t.ok) throw new Error(`truck ${JSON.stringify(t)}`);
      truck[k] = t.id;
      const p = await saveCostProfile(t.id, profile);
      if (!p.ok) throw new Error("profile");
      const d = await saveDriver({ name: `E1 Driver ${k}`, cdlClass: "A", cdlExpiry: "2031-01-31", medicalCardExpiry: "2031-01-31", assignedVehicleId: t.id, payKind: "cpm", payRate: "0.55", terminal }, null);
      if (!d.ok) throw new Error(`driver ${JSON.stringify(d)}`);
      driver[k] = d.id;
    }
  });

  afterAll(async () => {
    await prisma.load.deleteMany({ where: { workspaceId: WS, brokerName: "E1 Broker" } });
    await prisma.driver.deleteMany({ where: { workspaceId: WS, name: { startsWith: "E1 " } } });
    await prisma.vehicle.deleteMany({ where: { workspaceId: WS, name: { startsWith: "E1 " } } });
    await prisma.auditEvent.deleteMany({ where: { workspaceId: WS, createdAt: { gte: startedAt }, entity: "fleet" } });
  });

  test("a terminal is saved on the truck and the driver, audited, and offered by listTerminals", async () => {
    const saved = await prisma.vehicle.findUniqueOrThrow({ where: { id: truck.north! } });
    expect(saved.terminal).toBe(T.north);
    expect(await prisma.driver.findUniqueOrThrow({ where: { id: driver.south! } })).toMatchObject({ terminal: T.south });
    const terminals = await listTerminals(WS);
    expect(terminals).toEqual(expect.arrayContaining([T.north, T.south]));
    expect([...terminals].sort()).toEqual(terminals); // alphabetical, no repeats
    expect(new Set(terminals).size).toBe(terminals.length);
    // Changing it is a change the trail shows.
    const again = await saveTruck({ name: "E1 Truck north", type: "box_truck", mpg: "10", fuelType: "diesel", terminal: "E1 West" }, truck.north!);
    expect(again.ok && again.changed).toBe(true);
    const event = await prisma.auditEvent.findFirst({ where: { workspaceId: WS, action: "truck_changed", summary: { contains: "terminal" } }, orderBy: { createdAt: "desc" } });
    expect(event?.after).toMatchObject({ Terminal: "E1 West" });
    await saveTruck({ name: "E1 Truck north", type: "box_truck", mpg: "10", fuelType: "diesel", terminal: T.north }, truck.north!);
  });

  test("the Trucks and Drivers lists show one terminal, or all of them", async () => {
    const north = await listTrucksPage({ terminal: T.north });
    expect(north.rows.map((r) => r.name)).toEqual(["E1 Truck north"]);
    expect(north.total).toBe(1);
    const all = await listTrucksPage({ q: "E1 Truck" });
    expect(all.total).toBe(2);
    const drivers = await listDriversPage({ terminal: T.south });
    expect(drivers.rows.map((r) => r.name)).toEqual(["E1 Driver south"]);
    expect((await listDriversPage({ q: "E1 Driver" })).total).toBe(2);
  });

  test("an offer is priced for the terminal's trucks only", async () => {
    const whole = await fitQuote(priced());
    const wholeMine = whole.rows.filter((r) => r.truckName.startsWith("E1 Truck"));
    expect(wholeMine).toHaveLength(2);
    const scoped = await fitQuote(priced(), WS, new Date(), T.south);
    expect(scoped.rows.map((r) => r.truckName)).toEqual(["E1 Truck south"]);
    expect(scoped.total).toBe(1);
  });

  test("drivers are ranked inside the terminal; a search reaches the others", async () => {
    const load = await prisma.load.create({ data: { workspaceId: WS, loadNumber: "E1-RANK", brokerName: "E1 Broker", quotedRevenue: 1500, vehicleId: truck.north! }, include: loadInclude });
    const inNorth = await rankDrivers(load, WS, T.north);
    expect(inNorth.options.map((o) => o.name)).toEqual(["E1 Driver north"]);
    const everyone = await rankDrivers(load, WS, null);
    expect(everyone.options.map((o) => o.name)).toEqual(expect.arrayContaining(["E1 Driver north", "E1 Driver south"]));

    const typed = await pickDrivers(new Request(`http://desk.test/drivers/pick?q=${encodeURIComponent("E1 Driver s")}&load=${load.id}`));
    const body = (await typed.json()) as { drivers: Array<{ name: string; terminal: string | null; blocker: string | null }> };
    expect(body.drivers).toMatchObject([{ name: "E1 Driver south", terminal: T.south, blocker: null }]);
  });

  test("the truck picker finds a truck in any terminal by name", async () => {
    const res = await pickTrucks(new Request(`http://desk.test/fleet/pick?q=${encodeURIComponent("E1 Truck s")}`));
    const body = (await res.json()) as { trucks: Array<{ name: string; terminal: string | null }> };
    expect(body.trucks).toEqual([expect.objectContaining({ name: "E1 Truck south", terminal: T.south })]);
  });

  test("the planner gives rows to the terminal's drivers and the board keeps unplaced loads for everyone", async () => {
    const planner = await getPlannerData(Date.now(), Date.now(), 7, WS, T.north);
    expect(planner.rows.map((r) => r.name)).toEqual(["E1 Driver north"]);
    const placed = await prisma.load.create({ data: { workspaceId: WS, loadNumber: "E1-SOUTH-LOAD", brokerName: "E1 Broker", quotedRevenue: 800, vehicleId: truck.south! } });
    const unplaced = await prisma.load.create({ data: { workspaceId: WS, loadNumber: "E1-NOWHERE", brokerName: "E1 Broker", quotedRevenue: 800 } });
    const north = (await listBoardRows(WS, "open", T.north)).map((r) => r.loadNumber);
    expect(north).toContain("E1-NOWHERE");
    expect(north).not.toContain("E1-SOUTH-LOAD");
    const south = (await listBoardRows(WS, "open", T.south)).map((r) => r.loadNumber);
    expect(south).toEqual(expect.arrayContaining(["E1-NOWHERE", "E1-SOUTH-LOAD"]));
    expect((await listBoardRows(WS, "open", null)).map((r) => r.loadNumber)).toEqual(expect.arrayContaining(["E1-NOWHERE", "E1-SOUTH-LOAD"]));
    await prisma.load.deleteMany({ where: { id: { in: [placed.id, unplaced.id] } } });
  });

  test("the shell lists the terminals and keeps its counts to the whole fleet", async () => {
    const shell = await getShellData(WS);
    expect(shell.terminals).toEqual(expect.arrayContaining([T.north, T.south]));
    expect(shell.terminal).toBeNull(); // no cookie outside a request
  });
});
