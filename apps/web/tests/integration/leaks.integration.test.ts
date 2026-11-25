import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { clearLeakCache, getLeakLedger } from "@/server/tl/leaks";
import { waiveDetention } from "@/server/tl/detention";
import { adjustTrailerDwell, waiveTrailerDwell } from "@/server/tl/dwell";
import { getLeakIntake, saveLeakIntake } from "@/server/tl/leak-intake";
import { commitLoadImport } from "@/server/tl/load-import";

/**
 * The Leak Ledger against the demo database, in two workspaces: every line is the sum of stored loads at the basis it says (empty miles at the floor frozen on the load, detention not billed and waived, TONU
 * fees not invoiced, the shortfall under the floor, trailer dwell waived or lowered from the audit trail), an unpriced load is counted and left out of the dollars, a scope of terminals never returns another
 * terminal's loads, and nothing of another fleet is read:
 *   DATABASE_URL=postgresql://demo:demo@localhost:54330/demo RUN_DB_INTEGRATION=true npx vitest run tests/integration/leaks.integration.test.ts
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const W = "lk-w";
const OTHER = "lk-other";
const NOW = new Date();
const ago = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

async function wipe(id: string) {
  await prisma.driverLedgerEntry.deleteMany({ where: { workspace: { id } } });
  await prisma.assignment.deleteMany({ where: { OR: [{ load: { workspace: { id } } }, { driver: { workspace: { id } } }] } });
  await prisma.workspace.deleteMany({ where: { id } });
}

describe.skipIf(!run)("the leak ledger", () => {
  const ids = { n5: "", n4: "", nTrailer: "", sTrailer: "" };
  beforeAll(async () => {
    await wipe(W);
    await wipe(OTHER);
    await prisma.workspace.create({ data: { id: W, name: "LK fleet", plan: "enterprise" } });
    await prisma.workspace.create({ data: { id: OTHER, name: "LK other", plan: "enterprise" } });
    const north = await prisma.vehicle.create({ data: { workspaceId: W, name: "LK North", terminal: "North" } });
    const south = await prisma.vehicle.create({ data: { workspaceId: W, name: "LK South", terminal: "South" } });
    const foreign = await prisma.vehicle.create({ data: { workspaceId: OTHER, name: "LK Foreign", terminal: "North" } });
    const done = (vehicleId: string, workspaceId: string, n: string, o: Record<string, unknown> = {}) =>
      prisma.load.create({ data: { workspaceId, vehicleId, loadNumber: n, status: "completed", quotedRevenue: 1000, actualRevenue: 1000, loadedMiles: 500, completedAt: ago(3), brokerName: "Acme", originAddress: "Dallas, TX", destinationAddress: "Atlanta, GA", ...o } });
    const wait = (minutes: number) => ({ create: [{ stopSequence: 1, stopType: "pickup", stopRole: "pickup", addressString: "Dallas, TX", waitMinutes: minutes }] });
    // North
    await done(north.id, W, "LK-N1", { snapshotBaseFloorRpm: 1.5, pickupDeadheadMiles: 100, returnDeadheadMiles: 20 }); // 120 empty miles x 1.50 = 180; cleared its floor
    await done(north.id, W, "LK-N2", { pickupDeadheadMiles: 50 }); // no frozen floor: 50 empty miles, unpriced
    await done(north.id, W, "LK-N3", { snapshotBaseFloorRpm: 2, loadedMiles: 400, actualRevenue: 600, quotedRevenue: 600, expenseFuelActual: 100 }); // needs 800, paid 500: 300 short
    await done(north.id, W, "LK-N4", { snapshotDetentionRate: 60, snapshotFreeGraceMinutes: 120, stops: wait(300) }); // 180 minutes past free at $60 an hour: $180 not billed
    ids.n4 = (await prisma.load.findFirstOrThrow({ where: { workspaceId: W, loadNumber: "LK-N4" } })).id;
    ids.n5 = (await done(north.id, W, "LK-N5", { snapshotDetentionRate: 60, snapshotFreeGraceMinutes: 120, stops: wait(300) })).id; // the same, waived below
    const tonu = (n: string, o: Record<string, unknown>) => prisma.load.create({ data: { workspaceId: W, vehicleId: north.id, loadNumber: n, status: "tonu", quotedRevenue: 0, tonuRevenue: 150, cancelledAt: ago(2), cancelReason: "no_freight", ...o } });
    await tonu("LK-T1", {}); // not invoiced
    await tonu("LK-T2", { paymentStatus: "invoiced", invoicedAt: ago(1), invoicedAmount: 150 }); // invoiced: not a leak
    // An open load with a lot of empty miles is not finished, so it is not in the ledger.
    await prisma.load.create({ data: { workspaceId: W, vehicleId: north.id, loadNumber: "LK-OPEN", status: "accepted", quotedRevenue: 1000, snapshotBaseFloorRpm: 1.5, pickupDeadheadMiles: 900, scheduledDate: ago(-2) } });
    // South
    await done(south.id, W, "LK-S1", { snapshotBaseFloorRpm: 1.5, pickupDeadheadMiles: 200 }); // 200 x 1.50 = 300
    // Another fleet's loads never appear.
    await done(foreign.id, OTHER, "LK-X1", { snapshotBaseFloorRpm: 1.5, pickupDeadheadMiles: 5000 });
    // Trailers: one in North that sat five days (72 hours past 48 free, $75 a day, lowered to $25 a day), one in South waived.
    const dropped = (number: string, terminal: string) => prisma.trailer.create({ data: { workspaceId: W, number, type: "dry_van", terminal, unhookedAt: ago(5) } });
    ids.nTrailer = (await dropped("LK-NTR", "North")).id;
    ids.sTrailer = (await dropped("LK-STR", "South")).id;
    expect(await waiveDetention(ids.n5, "Customer relationship", NOW, W)).toEqual({ ok: true });
    expect(await adjustTrailerDwell(ids.nTrailer, { ratePerDay: 25, note: "Regular customer" }, NOW, W)).toEqual({ ok: true });
    expect(await waiveTrailerDwell(ids.sTrailer, "Our mistake", NOW, W)).toEqual({ ok: true });
    clearLeakCache();
  });
  afterAll(async () => {
    await wipe(W);
    await wipe(OTHER);
  });

  const line = (l: Awaited<ReturnType<typeof getLeakLedger>>, key: string) => l.current.lines.find((x) => x.key === key)!;

  test("North: every line is the sum of its loads at the basis it says, and unpriced loads are counted apart", async () => {
    const l = await getLeakLedger({ period: "4w", compare: false, terminals: ["North"] }, NOW, W);
    expect(line(l, "empty_miles")).toMatchObject({ dollars: 180, items: 2, unpriced: 1, unpricedMiles: 50 });
    expect(line(l, "below_floor")).toMatchObject({ dollars: 300, items: 1 });
    expect(line(l, "detention_unbilled")).toMatchObject({ dollars: 180, items: 1 });
    expect(line(l, "detention_waived")).toMatchObject({ dollars: 180, items: 1 });
    expect(line(l, "tonu_uninvoiced")).toMatchObject({ dollars: 150, items: 1 });
    expect(line(l, "dwell_forgone")).toMatchObject({ dollars: 150, items: 1 }); // $225 owed at the company's terms, lowered to $75
    // The total adds the counted lines; the below-floor lens is not in it.
    expect(l.current.total).toBe(180 + 180 + 180 + 150 + 150);
    expect(l.openDwell).toMatchObject({ trailers: 1, dollars: 75 });
    expect(l.openDwell.rows[0]).toMatchObject({ number: "LK-NTR", owed: 75 });
  });

  test("the loads behind a line are named, biggest first, and the unfinished and the foreign are not among them", async () => {
    const l = await getLeakLedger({ period: "4w", compare: false, terminals: ["North"] }, NOW, W);
    expect(l.top.map((t) => `${t.label}:${t.key}:${t.dollars}`)).toEqual(expect.arrayContaining(["LK-N1:empty_miles:180", "LK-N4:detention_unbilled:180", "LK-T1:tonu_uninvoiced:150"]));
    expect(l.top.some((t) => /LK-OPEN|LK-X1|LK-T2/.test(t.label))).toBe(false);
    expect(l.byTruck[0]).toMatchObject({ name: "LK North" });
    expect(l.weeks).toHaveLength(12);
  });

  test("a scope of one terminal never returns another's rows; the two together are everything", async () => {
    const south = await getLeakLedger({ period: "4w", compare: false, terminals: ["South"] }, NOW, W);
    expect(line(south, "empty_miles")).toMatchObject({ dollars: 300, items: 1 });
    expect(line(south, "detention_unbilled").items).toBe(0);
    expect(line(south, "tonu_uninvoiced").items).toBe(0);
    expect(line(south, "dwell_forgone").dollars).toBe(225);
    expect(south.current.total).toBe(300 + 225);
    expect(south.openDwell.trailers).toBe(0);
    const both = await getLeakLedger({ period: "4w", compare: false, terminals: ["South", "North"] }, NOW, W);
    const all = await getLeakLedger({ period: "4w", compare: false, terminals: null }, NOW, W);
    expect(all.current.total).toBe(180 + 180 + 180 + 150 + 150 + 300 + 225);
    expect(both.current.total).toBe(all.current.total);
    // Nothing placed in a terminal that has no loads: no leaks at all.
    expect((await getLeakLedger({ period: "4w", compare: false, terminals: ["East"] }, NOW, W)).current.total).toBe(0);
    expect((await getLeakLedger({ period: "4w", compare: false, terminals: [] }, NOW, W)).current.total).toBe(0);
  });

  test("another fleet reads none of it, and its own loads are never in ours", async () => {
    const other = await getLeakLedger({ period: "4w", compare: false }, NOW, OTHER);
    expect(line(other, "empty_miles")).toMatchObject({ dollars: 7500, items: 1 }); // its own 5,000 empty miles at $1.50
    expect(other.current.total).toBe(7500);
    expect(other.openDwell.trailers).toBe(0);
    const ours = await getLeakLedger({ period: "4w", compare: false }, NOW, W);
    expect(ours.top.some((t) => t.label === "LK-X1")).toBe(false);
  });

  test("detention on a load whose truck has no rate is counted and left unpriced, never given a rate", async () => {
    const lone = await prisma.vehicle.create({ data: { workspaceId: W, name: "LK Norate", terminal: "West" } });
    await prisma.load.create({ data: { workspaceId: W, vehicleId: lone.id, loadNumber: "LK-W1", status: "completed", quotedRevenue: 1000, actualRevenue: 1000, loadedMiles: 500, completedAt: ago(2), stops: { create: [{ stopSequence: 1, stopType: "pickup", stopRole: "pickup", addressString: "Dallas, TX", waitMinutes: 400 }] } } });
    clearLeakCache();
    const l = await getLeakLedger({ period: "4w", compare: false, terminals: ["West"] }, NOW, W);
    expect(line(l, "detention_unbilled")).toMatchObject({ dollars: 0, items: 1, unpriced: 1 });
    expect(l.current.unpriced).toBe(1);
  });

  test("a kept answer is served until the data moves, then rebuilt", async () => {
    clearLeakCache();
    const a = await getLeakLedger({ period: "4w", compare: true, terminals: ["North"] }, NOW, W);
    const b = await getLeakLedger({ period: "4w", compare: true, terminals: ["North"] }, NOW, W);
    expect(b).toBe(a);
    const truck = await prisma.vehicle.findFirstOrThrow({ where: { workspaceId: W, name: "LK North" } });
    await prisma.load.create({ data: { workspaceId: W, vehicleId: truck.id, loadNumber: "LK-N9", status: "completed", quotedRevenue: 1000, actualRevenue: 1000, loadedMiles: 500, completedAt: ago(1), snapshotBaseFloorRpm: 1, pickupDeadheadMiles: 10 } });
    const c = await getLeakLedger({ period: "4w", compare: true, terminals: ["North"] }, NOW, W);
    expect(c).not.toBe(a);
    expect(c.current.lines.find((x) => x.key === "empty_miles")!.dollars).toBe(190);
  });
});

/**
 * The Leak Read: a 90-day-style file from a TMS export, imported with its stop times, priced from the carrier's intake. Every priced line is its own line and says where its figure came from; nothing is priced
 * without an intake figure; the truck's cost profile today is never used; a load whose file had no stop times is counted apart and never given a wait; a frozen floor on a load booked on the desk keeps its own line.
 */
describe.skipIf(!run)("the leak ledger on imported history", () => {
  const IM = "lk-imp";
  const days = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString().slice(0, 10);
  const stamp = (n: number, hhmm: string) => `${days(n)} ${hhmm}`;
  const HEADER = "Load #,Broker,Pickup City,Delivery City,Pickup Date,Delivery Date,Miles,DH Pickup,DH Return,Line Haul,FSC,Unit,Invoice Date,Invoice Amount,Paid Date,Paid Amount,Pickup Arrival,Pickup Departure,Delivery Arrival,Delivery Departure";
  const FILE = [
    HEADER,
    // 120 empty miles on Unit 104; a 300 minute wait at the pickup and 30 at the delivery.
    `IM-1,Acme,"Dallas, TX","Atlanta, GA",${days(14)},${days(12)},781,100,20,2000,,Unit 104,,,,,${stamp(14, "08:00")},${stamp(14, "13:00")},${stamp(12, "07:50")},${stamp(12, "08:20")}`,
    // 50 empty miles, no truck; paid 500 for 450 miles driven; a 180 minute wait at the pickup.
    `IM-2,Globex,"Tulsa, OK","Joplin, MO",${days(10)},${days(9)},400,50,0,500,,,,,,,${stamp(10, "08:00")},${stamp(10, "11:00")},,`,
    // Invoiced 1,090 against a 1,000 rate (so 90 of detention is already billed); a 240 minute wait at the pickup.
    `IM-3,Initech,"Waco, TX","Austin, TX",${days(8)},${days(7)},500,0,0,1000,,,${days(6)},1090,,,${stamp(8, "08:00")},${stamp(8, "12:00")},,`,
    // 40 empty miles and no stop times at all.
    `IM-4,Initech,"Waco, TX","Tulsa, OK",${days(6)},${days(5)},300,40,0,900,,,,,,,,,,`
  ].join("\n");
  const line = (l: Awaited<ReturnType<typeof getLeakLedger>>, key: string) => l.current.lines.find((x) => x.key === key)!;
  const read = () => getLeakLedger({ period: "4w", compare: false, terminals: null }, NOW, IM);
  let ids: Record<string, string> = {};

  beforeAll(async () => {
    await wipe(IM);
    await prisma.workspace.create({ data: { id: IM, name: "LK imported", plan: "enterprise" } });
    // The truck's cost profile today says $99 an hour after 30 minutes: it must never price an imported load.
    await prisma.vehicle.create({ data: { workspaceId: IM, name: "Unit 104", costProfile: { create: { estimatedMonthlyMiles: 8000, breakEvenRpm: 1.1, detentionHourlyRate: 99, freeGraceMinutes: 30 } } } });
    const out = await commitLoadImport(FILE, null, "tms-export.csv", NOW, IM);
    expect(out).toMatchObject({ ok: true, created: 4 });
    ids = Object.fromEntries((await prisma.load.findMany({ where: { workspaceId: IM }, select: { id: true, loadNumber: true } })).map((l) => [l.loadNumber!, l.id]));
    clearLeakCache();
  });
  afterAll(async () => {
    await wipe(IM);
  });

  test("with an empty intake every imported load is counted and none is priced: no floor and no rate are invented, and the truck's profile is not used", async () => {
    const l = await read();
    expect(line(l, "empty_miles_intake")).toMatchObject({ dollars: 0, items: 3, unpriced: 3, unpricedMiles: 210, intake: true });
    expect(line(l, "detention_unbilled_intake")).toMatchObject({ dollars: 0, items: 3, unpriced: 3 }); // IM-1 waited 300 minutes on a truck whose profile says $99 an hour: still unpriced
    expect(line(l, "below_floor_intake")).toMatchObject({ dollars: 0, items: 0 });
    for (const k of ["empty_miles", "below_floor", "detention_unbilled", "detention_waived"]) expect(line(l, k), k).toMatchObject({ dollars: 0, items: 0 });
    expect(l.current.total).toBe(0);
    expect(l.coverage).toMatchObject({ importedLoads: 4, noStopTimes: { loads: 1, sample: [{ loadId: ids["IM-4"], label: "IM-4" }] } });
  });

  test("the intake prices the empty miles, the lens and the detention, each at the figure it says: the truck's own, the customer's own, else the fleet's", async () => {
    const saved = await saveLeakIntake({ costPerMile: "1.50", detentionRate: "60", freeMinutes: "120", trucks: [{ name: "Unit 104", costPerMile: "2.00" }], customers: [{ name: "Acme", detentionRate: "90", freeMinutes: "60" }] }, NOW, IM);
    expect(saved).toEqual({ ok: true, changed: true });
    // No cache is cleared: the intake is part of the kept answer's key.
    const l = await read();
    expect(line(l, "empty_miles_intake")).toMatchObject({ dollars: 375, items: 3, unpriced: 0 }); // 120 x 2.00 (Unit 104's own) + 50 x 1.50 + 40 x 1.50
    expect(line(l, "detention_unbilled_intake")).toMatchObject({ dollars: 450, items: 3, unpriced: 0 }); // 360 (Acme: 240 minutes past 60 at $90) + 60 (fleet: 60 past 120 at $60) + 30 (fleet: 120 minutes = $120, less the $90 the invoice carried)
    expect(line(l, "below_floor_intake")).toMatchObject({ dollars: 175, items: 1, counted: false }); // IM-2: 1.50 x 450 miles = 675 against 500 paid
    expect(l.current.total).toBe(825); // the lens is not in it
    expect(l.current.intake).toEqual({ dollars: 825, items: 6, unpriced: 0 });
  });

  test("every item names the intake figure it was priced at, and the biggest are the loads to open", async () => {
    const l = await read();
    const by = (label: string, key: string) => l.top.find((t) => t.label === label && t.key === key)!;
    expect(by("IM-1", "detention_unbilled_intake")).toMatchObject({ dollars: 360, intake: true, basisNote: "$90.00 an hour (customer's intake terms), 60 minutes free (customer's intake terms)" });
    expect(by("IM-3", "detention_unbilled_intake")).toMatchObject({ dollars: 30, basisNote: "$60.00 an hour (fleet's intake default), 120 minutes free (fleet's intake default)" });
    expect(by("IM-1", "empty_miles_intake")).toMatchObject({ dollars: 240, basisNote: "$2.00 a mile, Unit 104's intake figure" });
    expect(by("IM-2", "empty_miles_intake")).toMatchObject({ dollars: 75, basisNote: "$1.50 a mile, the fleet's intake figure" });
    expect(l.top[0]).toMatchObject({ label: "IM-1", dollars: 360 });
    expect(l.byCustomer.find((r) => r.name === "Acme")).toMatchObject({ dollars: 600, intake: 600 });
  });

  test("a load whose file had no stop times is counted apart and was never given a wait", async () => {
    const l = await read();
    expect(l.coverage.noStopTimes).toEqual({ loads: 1, sample: [{ loadId: ids["IM-4"], label: "IM-4" }] });
    expect(l.current.lines.filter((x) => x.key.startsWith("detention")).reduce((s, x) => s + x.items, 0)).toBe(3); // IM-1, IM-2 and IM-3; IM-4 is nowhere in the detention lines
  });

  test("the intake is kept with one audit event that shows what changed; saving the same again, or something wrong, writes nothing", async () => {
    expect(await saveLeakIntake({ costPerMile: "1.50", detentionRate: "60", freeMinutes: "120", trucks: [{ name: "Unit 104", costPerMile: "2.00" }], customers: [{ name: "Acme", detentionRate: "90", freeMinutes: "60" }] }, NOW, IM)).toEqual({ ok: true, changed: false });
    expect(await saveLeakIntake({ costPerMile: "abc" }, NOW, IM)).toMatchObject({ ok: false, errors: { costPerMile: expect.any(String) } });
    expect(await getLeakIntake(IM)).toMatchObject({ costPerMile: 1.5, detentionRate: 60, freeMinutes: 120, trucks: [{ name: "Unit 104", costPerMile: 2 }], customers: [{ name: "Acme", detentionRate: 90, freeMinutes: 60 }] });
    const events = await prisma.auditEvent.findMany({ where: { workspaceId: IM, action: "leak_intake_saved" } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ entity: "settings", before: expect.objectContaining({ "Cost a mile (fleet)": "Not given" }), after: expect.objectContaining({ "Cost a mile (fleet)": "$1.50", "Trucks with their own cost a mile": "1" }) });
  });

  test("a load booked on the desk keeps its frozen floor on the frozen line; the two bases are never added into one line", async () => {
    const truck = await prisma.vehicle.findFirstOrThrow({ where: { workspaceId: IM, name: "Unit 104" } });
    await prisma.load.create({ data: { workspaceId: IM, vehicleId: truck.id, loadNumber: "NAT-1", status: "completed", quotedRevenue: 1000, actualRevenue: 1000, loadedMiles: 500, pickupDeadheadMiles: 100, completedAt: new Date(NOW.getTime() - 2 * 86_400_000), snapshotBaseFloorRpm: 1.5 } });
    // And one with no frozen floor that was booked on the desk: the intake does not speak for it.
    await prisma.load.create({ data: { workspaceId: IM, vehicleId: truck.id, loadNumber: "NAT-2", status: "completed", quotedRevenue: 1000, actualRevenue: 1000, loadedMiles: 500, pickupDeadheadMiles: 30, completedAt: new Date(NOW.getTime() - 2 * 86_400_000) } });
    const l = await read();
    expect(line(l, "empty_miles")).toMatchObject({ dollars: 150, items: 2, unpriced: 1, unpricedMiles: 30, intake: false }); // NAT-1 at its frozen 1.50; NAT-2 counted, not priced
    expect(line(l, "empty_miles_intake")).toMatchObject({ dollars: 375, items: 3 }); // unchanged
    expect(l.current.total).toBe(825 + 150);
    expect(l.current.intake.dollars).toBe(825);
    expect(l.coverage.importedLoads).toBe(4); // the desk's own loads are not "imported"
  });

  test("detention an imported load's owner marked as waived is its own line at the intake terms, and the unbilled line shrinks by the same dollars", async () => {
    await prisma.load.update({ where: { id: ids["IM-1"]! }, data: { detentionWaivedAt: NOW, detentionWaivedBy: "test", detentionWaivedReason: "Customer relationship" } });
    await prisma.auditEvent.create({ data: { workspaceId: IM, loadId: ids["IM-1"], loadNumber: "IM-1", entity: "invoice", action: "detention_waived", summary: "$360.00 of detention waived", reason: "Customer relationship", actor: "test", createdAt: NOW } });
    clearLeakCache(); // a waiver made through the desk bumps the load; this one is written straight to the audit log
    const l = await read();
    expect(line(l, "detention_waived_intake")).toMatchObject({ dollars: 360, items: 1 });
    expect(line(l, "detention_unbilled_intake")).toMatchObject({ dollars: 90, items: 2 });
    expect(line(l, "detention_waived")).toMatchObject({ dollars: 0, items: 0 });
    expect(l.current.total).toBe(975);
  });

  test("the ledger reads the same loads after the answer is rebuilt, and the intake is not part of any load", async () => {
    clearLeakCache();
    const again = await read();
    expect(again.current.total).toBe(975);
    expect((await prisma.load.findMany({ where: { workspaceId: IM, channel: { startsWith: "import:" } }, select: { snapshotBaseFloorRpm: true, snapshotDetentionRate: true, snapshotFreeGraceMinutes: true } })).every((l) => l.snapshotBaseFloorRpm == null && l.snapshotDetentionRate == null && l.snapshotFreeGraceMinutes == null)).toBe(true); // nothing was frozen onto an imported load
  });

  test("another desk's imported loads and intake never reach this one", async () => {
    await wipe("lk-imp-other");
    await prisma.workspace.create({ data: { id: "lk-imp-other", name: "LK other imported", plan: "enterprise" } });
    try {
      const other = await getLeakLedger({ period: "4w", compare: false, terminals: null }, NOW, "lk-imp-other");
      expect(other.current.total).toBe(0);
      expect(other.coverage.importedLoads).toBe(0);
      expect(await getLeakIntake("lk-imp-other")).toEqual({ costPerMile: null, detentionRate: null, freeMinutes: null, trucks: [], customers: [] });
    } finally {
      await wipe("lk-imp-other");
    }
  });
});

/**
 * The Leak Read's done-criterion at the size it is sold at: a 90-day TMS export (one load a day, three customers, a truck on the desk and trucks that are not, waits at stops on most loads, none at all on some, an
 * arrival with no departure on others, some invoiced with detention already on the bill), imported, given its intake, read. The expected figures are worked out here, row by row, from the file itself, in whole cents,
 * and must equal every line the ledger prints.
 */
describe.skipIf(!run)("the leak ledger on a 90-day export", () => {
  const NN = "lk-90";
  let seed = 90210;
  const rnd = () => {
    seed = (seed * 48_271) % 2_147_483_647; // Park-Miller: exact in a double, and the same every run
    return seed / 2_147_483_647;
  };
  const int = (n: number) => Math.floor(rnd() * n);
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const cents = (n: number) => Math.round(n * 100);
  const day = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString().slice(0, 10);
  /** "2026-09-14 08:00" plus some minutes, as wall-clock text (the file has no zone). */
  const wall = (daysAgo: number, minutes: number) => {
    const t = new Date(`${day(daysAgo)}T00:00:00.000Z`).getTime() + (8 * 60 + minutes) * 60_000;
    return new Date(t).toISOString().slice(0, 16).replace("T", " ");
  };
  const INTAKE = { costPerMile: "1.50", detentionRate: "60", freeMinutes: "120", trucks: [{ name: "Unit 104", costPerMile: "2.00" }], customers: [{ name: "Acme", detentionRate: "90", freeMinutes: "60" }, { name: "Globex", detentionRate: "", freeMinutes: "30" }] };
  const TERMS: Record<string, { rate: number; free: number }> = { Acme: { rate: 90, free: 60 }, Globex: { rate: 60, free: 30 }, Initech: { rate: 60, free: 120 } };

  type Gen = { n: string; customer: string; truck: string; ago: number; loaded: number; before: number; after: number; haul: number; billed: number | null; pu: number | null; puOut: boolean; del: number | null };
  const rows: Gen[] = [];
  for (let i = 0; i < 90; i += 1) {
    const loaded = 200 + int(600);
    rows.push({
      n: `N-${i}`,
      customer: ["Acme", "Globex", "Initech"][i % 3]!,
      truck: ["Unit 104", "Unit 105", "", "Unit 104"][i % 4]!,
      ago: i + 1,
      loaded,
      before: int(120),
      after: i % 5 === 0 ? 0 : int(60),
      haul: Math.round(loaded * (1.2 + rnd() * 1.6)),
      billed: i % 3 === 0 ? null : i % 2,
      pu: i % 5 === 4 ? null : int(400), // no stop times at all on every fifth load
      puOut: i % 7 !== 6, // an arrival with no departure on some
      del: i % 5 === 4 || i % 3 === 1 ? null : int(200)
    });
  }
  // billed: null = not invoiced; 0 or 1 = invoiced with that many times $50 of detention on the bill.
  const header = "Load #,Broker,Pickup City,Delivery City,Pickup Date,Delivery Date,Miles,DH Pickup,DH Return,Line Haul,FSC,Unit,Invoice Date,Invoice Amount,Paid Date,Paid Amount,Pickup Arrival,Pickup Departure,Delivery Arrival,Delivery Departure";
  const csv = [
    header,
    ...rows.map((r) => {
      const pickupIn = r.pu == null ? "" : wall(r.ago + 1, 0);
      const pickupOut = r.pu == null || !r.puOut ? "" : wall(r.ago + 1, r.pu);
      const dropIn = r.del == null ? "" : wall(r.ago, 0);
      const dropOut = r.del == null ? "" : wall(r.ago, r.del);
      const inv = r.billed == null ? ",," : `${day(r.ago)},${r.haul + r.billed * 50},`;
      return `${r.n},${r.customer},"Dallas, TX","Atlanta, GA",${day(r.ago + 1)},${day(r.ago)},${r.loaded},${r.before},${r.after},${r.haul},,${r.truck},${inv},,${pickupIn},${pickupOut},${dropIn},${dropOut}`;
    })
  ].join("\n");

  /** What the file says the ledger must print, worked out from the rows alone. */
  const expected = () => {
    let empty = 0, emptyItems = 0, lens = 0, lensItems = 0, detention = 0, detentionItems = 0, blind = 0;
    for (const r of rows) {
      const cpm = r.truck === "Unit 104" ? 2 : 1.5;
      const em = r.before + r.after;
      if (em > 0) {
        empty += cents(em * cpm);
        emptyItems += 1;
      }
      const short = cpm * (r.loaded + em) - r.haul;
      if (cents(short) > 0) {
        lens += cents(short);
        lensItems += 1;
      }
      const waits = [r.pu != null && r.puOut ? r.pu : null, r.del].filter((w): w is number => w != null);
      if (waits.length === 0) blind += 1;
      const t = TERMS[r.customer]!;
      const billable = round2(waits.reduce((s, w) => s + round2((Math.max(0, w - t.free) / 60) * t.rate), 0));
      const unbilled = Math.max(0, round2(billable - (r.billed == null ? 0 : r.billed * 50)));
      if (unbilled > 0) {
        detention += cents(unbilled);
        detentionItems += 1;
      }
    }
    return { empty: empty / 100, emptyItems, lens: lens / 100, lensItems, detention: detention / 100, detentionItems, blind };
  };

  beforeAll(async () => {
    await wipe(NN);
    await prisma.workspace.create({ data: { id: NN, name: "LK 90 days", plan: "enterprise" } });
    await prisma.vehicle.create({ data: { workspaceId: NN, name: "Unit 104" } });
  });
  afterAll(async () => {
    await wipe(NN);
  });

  test("90 loads imported with stop times, then the intake: every priced line is the sum of the file's own rows at the figures the intake gave", async () => {
    const out = await commitLoadImport(csv, null, "90-days.csv", NOW, NN);
    expect(out).toMatchObject({ ok: true, created: 90, skipped: 0 });
    clearLeakCache();
    const ledger = () => getLeakLedger({ period: "all", compare: false, terminals: null }, NOW, NN);
    const before = await ledger();
    expect(before.current.total).toBe(0); // nothing priced without the intake
    expect(before.current.lines.find((l) => l.key === "empty_miles_intake")!.unpriced).toBeGreaterThan(70);

    expect(await saveLeakIntake(INTAKE, NOW, NN)).toEqual({ ok: true, changed: true });
    const l = await ledger();
    const want = expected();
    const line = (k: string) => l.current.lines.find((x) => x.key === k)!;
    expect(want.emptyItems).toBeGreaterThan(80);
    expect(want.detentionItems).toBeGreaterThan(20);
    expect(want.lensItems).toBeGreaterThan(0);
    expect(line("empty_miles_intake")).toMatchObject({ dollars: want.empty, items: want.emptyItems, unpriced: 0 });
    expect(line("below_floor_intake")).toMatchObject({ dollars: want.lens, items: want.lensItems, counted: false });
    expect(line("detention_unbilled_intake")).toMatchObject({ dollars: want.detention, items: want.detentionItems, unpriced: 0 });
    expect(l.current.total).toBe(round2(want.empty + want.detention)); // the lens is not in it
    expect(l.current.intake.dollars).toBe(l.current.total); // all of it rests on the intake: nothing was booked on this desk
    for (const k of ["empty_miles", "below_floor", "detention_unbilled", "detention_waived", "detention_waived_intake", "tonu_uninvoiced"]) expect(line(k), k).toMatchObject({ dollars: 0, items: 0 });
    expect(l.coverage).toMatchObject({ importedLoads: 90, noStopTimes: { loads: want.blind } });
    expect(l.coverage.noStopTimes.sample.length).toBeLessThanOrEqual(10);
    expect(want.blind).toBeGreaterThan(15);
    // Every item the ledger shows says which intake figure priced it.
    expect(l.top.length).toBe(25);
    expect(l.top.every((t) => t.intake && t.basisNote != null && /intake/.test(t.basisNote))).toBe(true);
    // The three customers' rows add back to the total (every item has a customer).
    expect(round2(l.byCustomer.reduce((s, r) => s + r.dollars, 0))).toBe(l.current.total);
  });
});
