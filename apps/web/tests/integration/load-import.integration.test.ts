import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { clearKpiCache, getDeskKpi } from "@/server/tl/kpi";
import { getLeakLedger } from "@/server/tl/leaks";
import { commitLoadImport, listLoadImports, previewLoadImport, removeLoadImport } from "@/server/tl/load-import";
import { podStopsMissing } from "@/server/tl/documents";
import { getIntakeRoster } from "@/server/tl/leak-intake";

/**
 * Loading a carrier's history from a file, against the demo database in a workspace of its own: the preview and the import read the same file the same way, a load already on the desk is left out, an
 * imported load is a finished load that says where it came from and shows in the KPI and the ledger, a whole batch can be taken away, and one desk never touches another's.
 *   DATABASE_URL=postgresql://demo:demo@localhost:54330/demo RUN_DB_INTEGRATION=true npx vitest run tests/integration/load-import.integration.test.ts
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const W = "li-w";
const OTHER = "li-other";
const NOW = new Date();
const ymd = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString().slice(0, 10);

const HEADER = "Load #,Broker,Pickup City,Delivery City,Pickup Date,Delivery Date,Miles,DH Pickup,DH Return,Line Haul,FSC,Unit,Invoice Date,Invoice Amount,Paid Date,Paid Amount";
const FILE = [
  HEADER,
  `1042,Acme,dallas tx,Atlanta GA,${ymd(20)},${ymd(18)},781,42,0,"$2,150.00",180,Unit 104,,,,`, // already on the desk
  `2001,Acme,"dallas, tx","Atlanta, GA",${ymd(30)},${ymd(28)},781,42,10,"$2,150.00",180,Unit 104,${ymd(27)},2330,${ymd(5)},2330`, // good, paid
  `2002,Globex,"Tulsa, OK","Joplin, MO",${ymd(12)},${ymd(11)},120,0,0,600,,Unit 999,,,,`, // good, unknown truck, not billed
  `2003,Globex,"Tulsa, OK","Joplin, MO",${ymd(12)},${ymd(11)},abc,0,0,600,,,,,,`, // a mistake
  `2001,Acme,"Dallas, TX","Atlanta, GA",${ymd(30)},${ymd(28)},781,0,0,2150,,,,,,` // the same load twice
].join("\n");

async function wipe(id: string) {
  await prisma.driverLedgerEntry.deleteMany({ where: { workspace: { id } } });
  await prisma.assignment.deleteMany({ where: { OR: [{ load: { workspace: { id } } }, { driver: { workspace: { id } } }] } });
  await prisma.workspace.deleteMany({ where: { id } });
}

describe.skipIf(!run)("load history import", () => {
  let batch = "";
  beforeAll(async () => {
    await wipe(W);
    await wipe(OTHER);
    await prisma.workspace.create({ data: { id: W, name: "LI fleet", plan: "enterprise" } });
    await prisma.workspace.create({ data: { id: OTHER, name: "LI other", plan: "enterprise" } });
    await prisma.vehicle.create({ data: { workspaceId: W, name: "Unit 104" } });
    await prisma.load.create({ data: { workspaceId: W, loadNumber: "1042", brokerName: "Acme", status: "completed", quotedRevenue: 100, completedAt: new Date() } });
    await prisma.load.create({ data: { workspaceId: OTHER, loadNumber: "2002", brokerName: "Globex", status: "completed", quotedRevenue: 100, completedAt: new Date() } });
  });
  afterAll(async () => {
    await wipe(W);
    await wipe(OTHER);
  });

  test("the preview reads the file: two ready, two already there, one mistake named with its line; another desk's load of the same number is not a duplicate", async () => {
    const p = await previewLoadImport(FILE, null, W);
    expect(p).toMatchObject({ ok: true, total: 5, ready: 2, duplicates: 2, problemCount: 1, missing: [] });
    if (!p.ok) return;
    expect(p.problems[0]).toMatchObject({ line: 5 });
    expect(p.problems[0]!.errors.join(" ")).toMatch(/Loaded miles is not a number/);
    expect(p.sample.map((s) => [s.loadNumber, s.lane, s.billing, s.truck])).toEqual([["2001", "Dallas, TX to Atlanta, GA", "paid", "Unit 104"], ["2002", "Tulsa, OK to Joplin, MO", "not billed", "Unit 999"]]);
    expect(p.summary).toMatchObject({ miles: 901, withTruck: 1, truckNames: 1, paid: 1, invoiced: 1, notBilled: 1 });
    expect(p.summary.revenue).toBe(2150 + 180 + 600);
    expect(p.fileHeader).toHaveLength(16);
  });

  test("a required column with no match is named, and nothing is checked until it has one", async () => {
    const lines = FILE.split("\n").map((l) => l.replace(/^([^,]*,){9}("[^"]*"|[^,]*),/, (m) => m)); // the header line is the only one that matters here
    const noRate = [lines[0]!.replace("Line Haul", "Mystery"), ...lines.slice(1)].join("\n");
    const p = await previewLoadImport(noRate, null, W);
    expect(p).toMatchObject({ ok: true, ready: 0 });
    if (!p.ok) return;
    expect(p.missing.map((m) => m.key)).toEqual(["revenue"]);
    // Pointing the field at the right column fixes it.
    const header = p.fileHeader;
    const map = { ...p.map, revenue: header.indexOf("Mystery") };
    expect(await previewLoadImport(noRate, map, W)).toMatchObject({ ok: true, ready: 2, missing: [] });
    expect(await commitLoadImport(noRate, null, "x.csv", NOW, W)).toMatchObject({ ok: false, error: expect.stringMatching(/Match a column to Line haul/) });
  });

  test("an empty file and a file past the row limit are refused", async () => {
    expect(await previewLoadImport("", null, W)).toMatchObject({ ok: false, error: expect.stringMatching(/empty/) });
    expect(await previewLoadImport(`${HEADER}\n${Array.from({ length: 21_500 }, (_, i) => `${i},A,"Dallas, TX","Waco, TX",,${ymd(3)},10,,,100,,,,,,`).join("\n")}`, null, W)).toMatchObject({ ok: false, error: expect.stringMatching(/more than 20,000/) });
  });

  test("the import writes the good rows as finished loads that say they came from a file, with their billing, truck and dates, and one audit event", async () => {
    const out = await commitLoadImport(FILE, null, "history.csv", NOW, W);
    expect(out).toMatchObject({ ok: true, created: 2, duplicates: 2, skipped: 1, withoutTruck: 1 });
    if (!out.ok) return;
    batch = out.batchId;
    const loads = await prisma.load.findMany({ where: { workspaceId: W, channel: `import:${batch}` }, orderBy: { loadNumber: "asc" } });
    expect(loads.map((l) => l.loadNumber)).toEqual(["2001", "2002"]);
    const [a, b] = loads;
    expect(a).toMatchObject({ status: "completed", brokerName: "Acme", originAddress: "Dallas, TX", destinationAddress: "Atlanta, GA", paymentStatus: "paid" });
    expect(Number(a!.quotedRevenue)).toBe(2150);
    expect(Number(a!.actualRevenue)).toBe(2150);
    expect(Number(a!.fuelSurcharge)).toBe(180);
    expect(Number(a!.loadedMiles)).toBe(781);
    expect(Number(a!.pickupDeadheadMiles)).toBe(42);
    expect(Number(a!.returnDeadheadMiles)).toBe(10);
    expect(Number(a!.paidAmount)).toBe(2330);
    expect(a!.vehicleId).not.toBeNull();
    expect(a!.completedAt!.toISOString().slice(0, 10)).toBe(ymd(28));
    expect(a!.createdAt.toISOString().slice(0, 10)).toBe(ymd(30)); // as old as its pickup
    expect(a!.snapshotBaseFloorRpm).toBeNull(); // no frozen floor: today's cost is not that day's
    expect(b).toMatchObject({ paymentStatus: null, vehicleId: null });
    expect(await prisma.assignment.count({ where: { load: { channel: `import:${batch}` } } })).toBe(0); // no driver: history never lands on a pay statement
    expect(await prisma.stop.count({ where: { load: { channel: `import:${batch}` } } })).toBe(0);
    const audit = await prisma.auditEvent.findMany({ where: { workspaceId: W, action: "loads_import_completed" } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ entityId: batch, entity: "load" });
    expect(audit[0]!.summary).toBe("2 finished loads imported from history.csv; 2 already on the desk; 1 row left out");
  });

  test("the same file again writes nothing: every load is already there", async () => {
    expect(await commitLoadImport(FILE, null, "history.csv", NOW, W)).toEqual({ ok: false, error: "Every load in that file that could be read is already on the desk. The rows with problems are listed." });
    expect(await prisma.load.count({ where: { workspaceId: W, channel: { startsWith: "import:" } } })).toBe(2);
    expect(await prisma.auditEvent.count({ where: { workspaceId: W, action: "loads_import_completed" } })).toBe(1);
  });

  test("two clicks at once write once", async () => {
    const more = [HEADER, `3001,Acme,"Waco, TX","Austin, TX",,${ymd(9)},100,0,0,500,,,,,,`].join("\n");
    const [x, y] = await Promise.all([commitLoadImport(more, null, "more.csv", NOW, W), commitLoadImport(more, null, "more.csv", NOW, W)]);
    const created = [x, y].filter((r) => r.ok);
    expect(created).toHaveLength(1);
    expect(await prisma.load.count({ where: { workspaceId: W, loadNumber: "3001", deletedAt: null } })).toBe(1);
    await removeLoadImport((created[0] as { batchId: string }).batchId, NOW, W);
  });

  test("imported loads count in the KPI and the ledger: their revenue and miles, and their empty miles counted and left unpriced until the intake gives a cost a mile", async () => {
    clearKpiCache();
    const k = await getDeskKpi({ period: "all", compare: false }, NOW, W);
    // The one load already on the desk had no miles; the imports add 2,150 + 180 + 600.
    expect(k.current.loads).toBeGreaterThanOrEqual(2);
    expect(k.lanes.map((l) => l.key)).toEqual(expect.arrayContaining(["Dallas, TX → Atlanta, GA", "Tulsa, OK → Joplin, MO"]));
    const ledger = await getLeakLedger({ period: "all", compare: false, terminals: null }, NOW, W);
    // An imported load has no frozen floor, so its empty miles are on the intake's own line (here the intake is empty: counted, none priced), never on the frozen one.
    const frozen = ledger.current.lines.find((l) => l.key === "empty_miles")!;
    expect(frozen).toMatchObject({ dollars: 0, items: 0 });
    const empty = ledger.current.lines.find((l) => l.key === "empty_miles_intake")!;
    expect(empty).toMatchObject({ dollars: 0, items: 1, unpriced: 1, unpricedMiles: 52, intake: true });
  });

  test("the imports are listed with how many loads are still on the desk, and a whole batch is taken away and can be told apart from another desk's", async () => {
    const list = await listLoadImports(10, W);
    expect(list.find((b) => b.batchId === batch)).toMatchObject({ loads: 2, removed: false, actor: expect.any(String) });
    expect(await removeLoadImport("not-a-batch", NOW, W)).toMatchObject({ ok: false });
    expect(await removeLoadImport(batch, NOW, OTHER)).toMatchObject({ ok: false, error: "That import is not on this desk." });
    expect(await removeLoadImport(batch, NOW, W)).toEqual({ ok: true, removed: 2 });
    expect(await prisma.load.count({ where: { workspaceId: W, channel: `import:${batch}`, deletedAt: null } })).toBe(0);
    expect(await prisma.load.count({ where: { workspaceId: W, loadNumber: "1042", deletedAt: null } })).toBe(1); // what was there before is untouched
    expect(await removeLoadImport(batch, NOW, W)).toMatchObject({ ok: false, error: "Nothing of that import is left on the desk." });
    expect((await listLoadImports(10, W)).find((b) => b.batchId === batch)).toMatchObject({ loads: 0, removed: true });
    // Removed loads are out of the KPI again.
    clearKpiCache();
    expect((await getDeskKpi({ period: "all", compare: false }, NOW, W)).lanes.map((l) => l.key)).not.toContain("Tulsa, OK → Joplin, MO");
  });

  test("after a removal the same file can be imported again", async () => {
    const out = await commitLoadImport(FILE, null, "again.csv", NOW, W);
    expect(out).toMatchObject({ ok: true, created: 2 });
  });
});

const S = "li-stops";
const STOP_HEADER = `${HEADER},Pickup Arrival,Pickup Departure,Delivery Arrival,Delivery Departure`;
const at = (daysAgo: number, hhmm: string) => `${ymd(daysAgo)} ${hhmm}`;
const STOP_FILE = [
  STOP_HEADER,
  `S-1,Acme,"Dallas, TX","Atlanta, GA",${ymd(14)},${ymd(12)},781,100,20,2000,,,,,,,${at(14, "08:00")},${at(14, "13:00")},${at(12, "07:50")},${at(12, "08:20")}`, // two stops, waits of 300 and 30
  `S-2,Globex,"Tulsa, OK","Joplin, MO",${ymd(10)},${ymd(9)},400,50,0,500,,,,,,,${at(10, "08:00")},${at(10, "11:00")},,`, // a pickup stop only
  `S-3,Initech,"Waco, TX","Austin, TX",${ymd(8)},${ymd(7)},200,0,0,1000,,,,,,,${at(8, "08:00")},,,`, // an arrival, no departure
  `S-4,Initech,"Waco, TX","Tulsa, OK",${ymd(6)},${ymd(5)},300,40,0,900,,,,,,,,,,`, // no times at all
  `S-5,Initech,"Waco, TX","Tulsa, OK",${ymd(6)},${ymd(5)},300,40,0,900,,,,,,,${at(6, "09:00")},${at(6, "08:00")},,` // departs before it arrives: left out
].join("\n");

describe.skipIf(!run)("load history import: stop times", () => {
  beforeAll(async () => {
    await wipe(S);
    await prisma.workspace.create({ data: { id: S, name: "LI stops", plan: "enterprise" } });
  });
  afterAll(async () => {
    await wipe(S);
  });

  test("the preview says how many loads carry a wait, which have an arrival and no departure, and names the row with a departure before its arrival", async () => {
    const p = await previewLoadImport(STOP_FILE, null, S);
    expect(p).toMatchObject({ ok: true, ready: 4, problemCount: 1, readsStopTimes: true });
    if (!p.ok) return;
    expect(p.summary).toMatchObject({ withWaits: 2, arrivalOnly: 1 });
    expect(p.problems[0]!.errors.join(" ")).toMatch(/Pickup departure is before the arrival/);
    expect(p.map.pickupArrival).toBe(16);
    // The same file with no stop-time column matched reads no times.
    const without = await previewLoadImport(STOP_FILE, { ...p.map, pickupArrival: null, pickupDeparture: null, deliveryArrival: null, deliveryDeparture: null }, S);
    expect(without).toMatchObject({ ok: true, ready: 5, readsStopTimes: false });
  });

  test("the import writes a pickup stop and a delivery stop where the file has times, with the wait, and no coordinates", async () => {
    const out = await commitLoadImport(STOP_FILE, null, "stops.csv", NOW, S);
    expect(out).toMatchObject({ ok: true, created: 4, skipped: 1 });
    if (!out.ok) return;
    const loads = await prisma.load.findMany({ where: { workspaceId: S, channel: `import:${out.batchId}` }, include: { stops: { orderBy: { stopSequence: "asc" } } }, orderBy: { loadNumber: "asc" } });
    const by = Object.fromEntries(loads.map((l) => [l.loadNumber!, l.stops]));
    expect(by["S-1"]!.map((s) => [s.stopSequence, s.stopType, s.stopRole, s.addressString, s.waitMinutes])).toEqual([[1, "pickup", "pickup", "Dallas, TX", 300], [2, "delivery", "delivery", "Atlanta, GA", 30]]);
    expect(by["S-1"]!.every((s) => s.arrivedAt != null && s.lat == null && s.lng == null && s.timeWindowLatest == null)).toBe(true);
    expect(by["S-2"]!.map((s) => [s.stopType, s.waitMinutes])).toEqual([["pickup", 180]]);
    expect(by["S-3"]!.map((s) => [s.stopType, s.waitMinutes])).toEqual([["pickup", null]]); // an arrival with no departure: no wait is made up
    expect(by["S-4"]).toEqual([]);
    expect(by["S-1"]![0]!.arrivedAt!.getTime()).toBeLessThan(by["S-1"]![1]!.arrivedAt!.getTime());
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { workspaceId: S, action: "loads_import_completed" } });
    expect(audit.after).toMatchObject({ Imported: "4", "With a wait at a stop": "2" });
  });

  test("history is not asked for a proof of delivery just because it now has a delivery stop; a load booked on the desk still is", async () => {
    const imported = await prisma.load.findFirstOrThrow({ where: { workspaceId: S, loadNumber: "S-1" } });
    const native = await prisma.load.create({ data: { workspaceId: S, loadNumber: "NAT-1", status: "completed", quotedRevenue: 500, completedAt: NOW, stops: { create: [{ stopSequence: 1, stopType: "delivery", stopRole: "delivery", addressString: "Waco, TX" }] } } });
    const missing = await podStopsMissing([imported.id, native.id], S);
    expect(missing.has(imported.id)).toBe(false);
    expect(missing.get(native.id)).toBe(1);
  });

  test("the roster offers the intake form the trucks and customers on the imported loads, and says how many carry a wait", async () => {
    const r = await getIntakeRoster(S);
    expect(r).toMatchObject({ importedLoads: 4, withStopTimes: 2 });
    expect(r.customers).toEqual([{ name: "Initech", loads: 2 }, { name: "Acme", loads: 1 }, { name: "Globex", loads: 1 }]);
  });
});
