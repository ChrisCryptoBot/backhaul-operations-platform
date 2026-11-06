import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { clearLeakCache, getLeakLedger } from "@/server/tl/leaks";
import { waiveDetention } from "@/server/tl/detention";
import { adjustTrailerDwell, waiveTrailerDwell } from "@/server/tl/dwell";

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
