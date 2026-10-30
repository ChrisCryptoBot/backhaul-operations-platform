import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { importTemplate } from "@/lib/import-csv";
import { rankDrivers } from "@/server/tl/driver-rank";
import { clearFinishedTotals, finishedTotals } from "@/server/tl/finished-totals";
import { countHistory, listHistory } from "@/server/tl/history";
import { IMPORT_CHUNK, commitImport, locateHomeBases, previewImport, toLocate } from "@/server/tl/import";
import { loadInclude } from "@/server/tl/queries";

/**
 * Wave E1 on the demo database, each in a workspace of its own so the counts are exact and the demo data is not touched: importing a fleet from a file,
 * the History screen's search and paging, the finished-loads totals and the ranking of drivers with one clash query.
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const day = (d: string) => new Date(`${d}T17:00:00Z`);

async function workspace(id: string) {
  await prisma.workspace.deleteMany({ where: { id } });
  await prisma.workspace.create({ data: { id, name: `E1 ${id}` } });
}
const drop = (id: string) => prisma.workspace.deleteMany({ where: { id } });

describe.skipIf(!run)("importing trucks and drivers from a file", () => {
  const W = "e1-import";
  beforeAll(() => workspace(W));
  afterAll(() => drop(W));

  const trucksFile = ["Name,Type,MPG,Home base,Terminal", "E1 Imp 1,heavy_duty,6.8,\"Dallas, TX\",Dallas", "E1 Imp 2,box_truck,9,\"Houston, TX\",Houston", "E1 Imp 3,box_truck,999,,", "e1 imp 1,heavy_duty,6.8,,"].join("\n");

  test("the preview says what would be imported and what would not, and writes nothing", async () => {
    const p = await previewImport("trucks", trucksFile, W);
    expect(p).toMatchObject({ ok: true, total: 4, ready: 2, problemCount: 2 });
    if (!p.ok) return;
    expect(p.problems.map((x) => x.line)).toEqual([4, 5]);
    expect(p.problems[1]!.errors[0]).toMatch(/also on line 2/);
    expect(await prisma.vehicle.count({ where: { workspaceId: W } })).toBe(0);
  });

  test("a file the desk cannot use says why", async () => {
    expect(await previewImport("trucks", "", W)).toMatchObject({ ok: false, error: expect.stringMatching(/empty/) });
    expect(await previewImport("trucks", "Type\nbox_truck\n", W)).toMatchObject({ ok: false, error: expect.stringMatching(/needs a Name column/) });
  });

  test("the import writes the rows that pass with their terminal, and ONE audit event", async () => {
    const out = await commitImport("trucks", trucksFile, "fleet.csv", new Date(), W);
    expect(out).toEqual({ ok: true, created: 2, skipped: 2, kind: "trucks" });
    const trucks = await prisma.vehicle.findMany({ where: { workspaceId: W }, orderBy: { name: "asc" } });
    expect(trucks.map((t) => [t.name, t.terminal, t.homeBaseAddress])).toEqual([
      ["E1 Imp 1", "Dallas", "Dallas, TX"],
      ["E1 Imp 2", "Houston", "Houston, TX"]
    ]);
    const events = await prisma.auditEvent.findMany({ where: { workspaceId: W } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ action: "import_completed", entity: "fleet" });
    expect(events[0]!.summary).toBe("2 trucks imported from fleet.csv; 2 rows left out");
    expect(events[0]!.after).toMatchObject({ File: "fleet.csv", Imported: "2" });
  });

  test("the same file loaded again adds nothing: every row is a copy", async () => {
    const again = await commitImport("trucks", trucksFile, "fleet.csv", new Date(), W);
    expect(again).toMatchObject({ ok: false, error: expect.stringMatching(/No row in that file can be imported/) });
    expect(await prisma.vehicle.count({ where: { workspaceId: W } })).toBe(2);
  });

  test("drivers are loaded with the truck they drive, found by its name; one with an unknown truck is left out", async () => {
    const file = ["Name,Phone,CDL class,CDL good through,Truck,Usual pay,Rate,Terminal", "E1 Ana,555-0101,A,12/31/2031,E1 Imp 1,cpm,0.55,Dallas", "E1 Ben,555-0102,A,2031-12-31,E1 Imp 9,,,"].join("\n");
    const p = await previewImport("drivers", file, W);
    expect(p).toMatchObject({ ok: true, ready: 1, problemCount: 1 });
    expect(await commitImport("drivers", file, "drivers.csv", new Date(), W)).toMatchObject({ ok: true, created: 1, skipped: 1 });
    const ana = await prisma.driver.findFirstOrThrow({ where: { workspaceId: W, name: "E1 Ana" }, include: { assignedVehicle: true } });
    expect(ana.assignedVehicle?.name).toBe("E1 Imp 1");
    expect(ana).toMatchObject({ terminal: "Dallas", defaultPayKind: "cpm" });
    expect(ana.cdlExpiry?.getUTCFullYear()).toBe(2032); // the end of 31 December 2031 on the Dallas calendar
    expect(await commitImport("drivers", file, "drivers.csv", new Date(), W)).toMatchObject({ ok: false }); // a copy now
  });

  test("a big file goes in 500 rows at a time, still ONE audit event", async () => {
    const n = IMPORT_CHUNK * 2 + 200;
    const rows = Array.from({ length: n }, (_, i) => `E1 Bulk ${String(i).padStart(4, "0")},heavy_duty,6.5,"Nowhere ${i}, ZZ",T${i % 7}`);
    const file = ["Name,Type,MPG,Home base,Terminal", ...rows].join("\n");
    const before = await prisma.auditEvent.count({ where: { workspaceId: W } });
    const started = Date.now();
    const out = await commitImport("trucks", file, "bulk.csv", new Date(), W);
    expect(out).toMatchObject({ ok: true, created: n, skipped: 0 });
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(await prisma.vehicle.count({ where: { workspaceId: W, name: { startsWith: "E1 Bulk" } } })).toBe(n);
    expect(await prisma.auditEvent.count({ where: { workspaceId: W } })).toBe(before + 1);
  });

  test("home bases are found a batch at a time, each truck tried once, however the map answers", async () => {
    const pending = await toLocate(W);
    expect(pending).toBeGreaterThan(1000);
    let after: string | null = null;
    let tried = 0;
    let batches = 0;
    for (;;) {
      const r = await locateHomeBases(after, W);
      tried += r.tried;
      batches += 1;
      expect(r.tried).toBeLessThanOrEqual(25);
      if (!r.next) break;
      after = r.next;
      if (batches === 3) break; // three batches show the cursor moves on; the rest would be a thousand map requests
    }
    expect(tried).toBeGreaterThanOrEqual(75);
  }, 120_000);

  test("the template is a file the preview accepts", async () => {
    const p = await previewImport("trucks", importTemplate("trucks"), W);
    expect(p).toMatchObject({ ok: true, ready: 1, problemCount: 0 });
  });
});

describe.skipIf(!run)("History: the database searches, counts, sorts and pages", () => {
  const W = "e1-history";
  beforeAll(async () => {
    await workspace(W);
    const truck = await prisma.vehicle.create({ data: { workspaceId: W, name: "E1H Truck" } });
    const driver = await prisma.driver.create({ data: { workspaceId: W, name: "E1H Driver", cdlExpiry: day("2031-01-01"), medicalCardExpiry: day("2031-01-01") } });
    const make = (loadNumber: string, extra: Record<string, unknown>) => prisma.load.create({ data: { workspaceId: W, loadNumber, brokerName: "E1H Broker", ...extra } });
    const l1 = await make("E1H-001", { status: "completed", completedAt: day("2026-09-01"), quotedRevenue: 1200, originAddress: "Dallas, TX", destinationAddress: "Houston, TX", vehicleId: truck.id, loadedMiles: 240 });
    await prisma.assignment.create({ data: { loadId: l1.id, driverId: driver.id, payKind: "cpm", payRate: 0.5, status: "completed" } });
    await make("E1H-002", { status: "completed", completedAt: day("2026-08-01"), quotedRevenue: 800, originAddress: "Dallas, TX", destinationAddress: "Atlanta, GA", paymentStatus: "paid", invoiceNumber: "E1H-INV-2", paidAt: day("2026-08-20"), paidAmount: 800, loadedMiles: 780 });
    await make("E1H-003", { status: "cancelled", cancelledAt: day("2026-07-01"), quotedRevenue: 500, originAddress: "Tulsa, OK", destinationAddress: "Memphis, TN" });
    await make("E1H-004", { status: "draft", quotedRevenue: 700, originAddress: "Dallas, TX", destinationAddress: "Austin, TX" });
  });
  afterAll(() => drop(W));

  const numbers = async (q: Parameters<typeof listHistory>[0]) => (await listHistory(q, W)).rows.map((r) => r.loadNumber);

  test("only finished loads are History, counted by tab, newest first", async () => {
    const h = await listHistory({}, W);
    expect(h.counts).toEqual({ all: 3, owed: 1, cancelled: 1 });
    expect(h.rows.map((r) => r.loadNumber)).toEqual(["E1H-001", "E1H-002", "E1H-003"]);
    expect(await numbers({ filter: "owed" })).toEqual(["E1H-001"]);
    expect(await numbers({ filter: "cancelled" })).toEqual(["E1H-003"]);
  });

  test("a search reaches the load's own text, its truck's name and its driver's name; several words must all match", async () => {
    expect(await numbers({ q: "E1H-001" })).toEqual(["E1H-001"]);
    expect(await numbers({ q: "e1h-inv-2" })).toEqual(["E1H-002"]); // the invoice number
    expect(await numbers({ q: "E1H Truck" })).toEqual(["E1H-001"]);
    expect(await numbers({ q: "E1H Driver" })).toEqual(["E1H-001"]);
    expect(await numbers({ q: "dallas" })).toEqual(["E1H-001", "E1H-002"]);
    expect(await numbers({ q: "dallas atlanta" })).toEqual(["E1H-002"]);
    expect(await numbers({ q: "no such thing" })).toEqual([]);
    expect(await numbers({ q: "100%_" })).toEqual([]); // a wildcard typed in the box is text, not a pattern
    expect((await listHistory({ q: "dallas" }, W)).counts).toEqual({ all: 2, owed: 1, cancelled: 0 });
  });

  test("the search stays inside the workspace", async () => {
    expect((await listHistory({ q: "E1H-001" })).total).toBe(0);
    expect(await countHistory("E1H-001", W)).toBe(1);
    expect(await countHistory("", W)).toBe(3);
  });

  test("the sorts, the lane and the paging", async () => {
    expect(await numbers({ sort: "oldest" })).toEqual(["E1H-003", "E1H-002", "E1H-001"]);
    expect(await numbers({ sort: "pay" })).toEqual(["E1H-001", "E1H-002", "E1H-003"]);
    expect((await numbers({ sort: "permile" })).sort()).toEqual(["E1H-001", "E1H-002", "E1H-003"]);
    expect(await numbers({ lane: "Dallas, TX → Houston, TX" })).toEqual(["E1H-001"]);
    const first = await listHistory({ pageSize: 2, page: 1 }, W);
    const second = await listHistory({ pageSize: 2, page: 2 }, W);
    expect([first.pages, first.rows.length, second.rows.length]).toEqual([2, 2, 1]);
    expect((await listHistory({ pageSize: 2, page: 99 }, W)).page).toBe(2); // past the end lands on the last page
  });

  test("the row carries what the screen shows", async () => {
    const r = (await listHistory({ q: "E1H-001" }, W)).rows[0]!;
    expect(r).toMatchObject({ vehicleName: "E1H Truck", driverName: "E1H Driver", origin: "Dallas, TX", destination: "Houston, TX", quotedRevenue: 1200, status: "completed" });
  });
});

describe.skipIf(!run)("the finished-loads totals in the header", () => {
  const W = "e1-totals";
  beforeAll(async () => {
    await workspace(W);
    clearFinishedTotals();
  });
  afterAll(() => drop(W));

  const finished = (loadNumber: string, quotedRevenue: number) =>
    prisma.load.create({ data: { workspaceId: W, loadNumber, status: "completed", completedAt: new Date(), quotedRevenue, loadedMiles: 100, originAddress: "Dallas, TX", destinationAddress: "Tulsa, OK" } });

  test("they add up the finished loads and move the moment one is added, changed or removed", async () => {
    expect((await finishedTotals(W)).gross).toBe(0);
    const a = await finished("E1T-1", 1000);
    await finished("E1T-2", 500);
    expect((await finishedTotals(W)).gross).toBe(1500);
    const c = await finished("E1T-3", 250);
    expect((await finishedTotals(W)).gross).toBe(1750);
    await prisma.load.update({ where: { id: a.id }, data: { quotedRevenue: 2000 } });
    expect((await finishedTotals(W)).gross).toBe(2750);
    await prisma.load.update({ where: { id: c.id }, data: { deletedAt: new Date() } });
    expect((await finishedTotals(W)).gross).toBe(2500);
  });

  test("an open load is not in them, and another workspace's loads are not either", async () => {
    await prisma.load.create({ data: { workspaceId: W, loadNumber: "E1T-OPEN", status: "draft", quotedRevenue: 9999 } });
    expect((await finishedTotals(W)).gross).toBe(2500);
    expect((await finishedTotals("e1-nobody")).gross).toBe(0);
  });
});

describe.skipIf(!run)("ranking drivers with one clash query", () => {
  const W = "e1-rank";
  const ids = { load: "", other: "", a: "", b: "", lapsed: "" };
  beforeAll(async () => {
    await workspace(W);
    const truck = await prisma.vehicle.create({ data: { workspaceId: W, name: "E1R Truck", costProfile: { create: { monthlyInsurance: 800, monthlyAuthority: 100, monthlyPhoneSubscriptions: 60, monthlyLoanPayment: 0, estimatedMonthlyMiles: 7000, maintenanceReservePerMile: 0.15, tireReservePerMile: 0.04, driverHourlyTarget: 25, lastFuelPricePerGallon: 3.9, breakEvenRpm: 1.5, survivalFloorRpm: 1.2, archetype: "solo_owner" } } } });
    const driver = (name: string, extra: Record<string, unknown> = {}) => prisma.driver.create({ data: { workspaceId: W, name, cdlExpiry: day("2031-01-01"), medicalCardExpiry: day("2031-01-01"), defaultPayKind: "cpm", defaultPayRate: 0.5, assignedVehicleId: truck.id, ...extra } });
    const a = await driver("E1R A busy");
    const b = await driver("E1R B free");
    const lapsed = await driver("E1R C lapsed", { cdlExpiry: day("2020-01-01") });
    const window = (start: string, end: string) => ({ create: [{ stopSequence: 0, stopType: "pickup", stopRole: "pickup", addressString: "Dallas, TX", timeWindowEarliest: new Date(start), timeWindowLatest: new Date(start) }, { stopSequence: 1, stopType: "delivery", stopRole: "delivery", addressString: "Tulsa, OK", timeWindowEarliest: new Date(end), timeWindowLatest: new Date(end) }] });
    const other = await prisma.load.create({ data: { workspaceId: W, loadNumber: "E1R-OTHER", status: "accepted", quotedRevenue: 900, stops: window("2027-05-10T08:00:00Z", "2027-05-10T18:00:00Z") } });
    await prisma.assignment.create({ data: { loadId: other.id, driverId: a.id, payKind: "cpm", payRate: 0.5, status: "accepted" } });
    const load = await prisma.load.create({ data: { workspaceId: W, loadNumber: "E1R-LOAD", status: "draft", quotedRevenue: 1500, loadedMiles: 260, vehicleId: truck.id, stops: window("2027-05-10T10:00:00Z", "2027-05-10T20:00:00Z") } });
    Object.assign(ids, { load: load.id, other: other.id, a: a.id, b: b.id, lapsed: lapsed.id });
  });
  afterAll(() => drop(W));

  test("a driver on another load at that time, and one whose card has lapsed, are marked; the free driver is ranked first", async () => {
    const load = await prisma.load.findUniqueOrThrow({ where: { id: ids.load }, include: loadInclude });
    const { options, fits } = await rankDrivers(load, W);
    const by = (id: string) => options.find((o) => o.id === id)!;
    expect(by(ids.a).busy).toBe("already on E1R-OTHER");
    expect(by(ids.b).busy).toBeNull();
    expect(by(ids.lapsed).blocker).toBe("CDL expired");
    expect(options[0]!.id).toBe(ids.b);
    expect(fits.map((f) => f.driverId)).toEqual([ids.b]); // only a driver who can take it is suggested
    expect(fits[0]!.leftOver).not.toBeNull();
  });

  test("a load on the same driver at another time is no clash", async () => {
    const later = await prisma.load.create({
      data: { workspaceId: W, loadNumber: "E1R-LATER", status: "draft", quotedRevenue: 800, vehicleId: (await prisma.vehicle.findFirstOrThrow({ where: { workspaceId: W } })).id, stops: { create: [{ stopSequence: 0, stopType: "pickup", stopRole: "pickup", addressString: "Dallas, TX", timeWindowEarliest: new Date("2027-05-12T08:00:00Z"), timeWindowLatest: new Date("2027-05-12T09:00:00Z") }] } },
      include: loadInclude
    });
    const { options } = await rankDrivers(later, W);
    expect(options.find((o) => o.id === ids.a)!.busy).toBeNull();
  });
});
