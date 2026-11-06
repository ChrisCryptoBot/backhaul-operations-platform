import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { toCentralLocal } from "@/lib/zoned";
import { getTrailerHistory, getTruckHistory } from "@/server/tl/asset-history";
import { logCheckCall, removeCheckCall } from "@/server/tl/check-calls";
import { applyStays } from "@/server/tl/stays";
import { hookTrailer } from "@/server/tl/trailers";
import { workspaceTimezone } from "@/server/tl/zone";
import { purgeOldStays } from "@/server/partners/retention";

/**
 * Asset history, on the demo database in a workspace of its own: a tractor's stays are written as fixes arrive (a long stop is kept, a red light is not), a trailer's hooks and drops are kept with where
 * they happened, a check call is validated, kept with the unit and audited, and a unit's history never shows another fleet's rows:
 *   DATABASE_URL=postgresql://demo:demo@localhost:54330/demo RUN_DB_INTEGRATION=true npx vitest run tests/integration/asset-history.integration.test.ts
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const W = "ah-w";
const OTHER = "ah-other";
const NOW = new Date();
const DOCK = { lat: 32.7767, lng: -96.797 };
const ago = (m: number) => new Date(NOW.getTime() - m * 60_000);

async function wipe(id: string) {
  await prisma.workspace.deleteMany({ where: { id } });
}

describe.skipIf(!run)("asset history", () => {
  const ids = { truck: "", other: "", trailer: "", load: "", otherLoad: "" };
  beforeAll(async () => {
    await wipe(W);
    await wipe(OTHER);
    await prisma.workspace.create({ data: { id: W, name: "AH fleet", plan: "enterprise" } });
    await prisma.workspace.create({ data: { id: OTHER, name: "AH other", plan: "enterprise" } });
    ids.truck = (await prisma.vehicle.create({ data: { workspaceId: W, name: "AH Truck", lastLat: DOCK.lat, lastLng: DOCK.lng, lastLocatedAt: ago(5) } })).id;
    ids.other = (await prisma.vehicle.create({ data: { workspaceId: W, name: "AH Other Truck" } })).id;
    ids.trailer = (await prisma.trailer.create({ data: { workspaceId: W, number: "AH-TR1", type: "dry_van" } })).id;
    const stop = { create: [{ stopSequence: 1, stopType: "pickup", stopRole: "pickup", addressString: "Dallas, TX", facilityName: "Acme Foods dock", lat: DOCK.lat, lng: DOCK.lng, arrivedAt: ago(180) }] };
    ids.load = (await prisma.load.create({ data: { workspaceId: W, loadNumber: "AH-1", status: "in_progress", quotedRevenue: 900, vehicleId: ids.truck, scheduledDate: ago(200), stops: stop } })).id;
    ids.otherLoad = (await prisma.load.create({ data: { workspaceId: W, loadNumber: "AH-2", status: "accepted", quotedRevenue: 900, vehicleId: ids.other, scheduledDate: ago(100) } })).id;
  });
  afterAll(async () => {
    await wipe(W);
    await wipe(OTHER);
  });

  const fix = (vehicleId: string, minutesAgo: number, moving: boolean, at = DOCK) => ({ workspaceId: W, vehicleId, lat: at.lat, lng: at.lng, speedMph: moving ? 60 : 0, engine: moving ? "moving" : "off", at: ago(minutesAgo) });

  test("a long stop is kept as a stay, grows while it lasts and closes when the truck leaves; a short one is dropped", async () => {
    // Stood at the dock for 90 minutes, then drove off, stood at a light for 8 minutes (dropped), then stood at the dock again (still there).
    for (const f of [fix(ids.truck, 240, false), fix(ids.truck, 200, false), fix(ids.truck, 150, false), fix(ids.truck, 120, true), fix(ids.truck, 100, false, { lat: 33.1, lng: -96.9 }), fix(ids.truck, 92, true), fix(ids.truck, 60, false), fix(ids.truck, 30, false)]) await prisma.$transaction((tx) => applyStays(tx, [f]));
    const stays = await prisma.unitStay.findMany({ where: { vehicleId: ids.truck }, orderBy: { arrivedAt: "asc" } });
    expect(stays).toHaveLength(2);
    expect(stays[0]).toMatchObject({ arrivedAt: ago(240), lastSeenAt: ago(150), leftAt: ago(120) });
    expect(stays[1]).toMatchObject({ arrivedAt: ago(60), lastSeenAt: ago(30), leftAt: null });
  });

  test("a re-read of an old fix does not move a stay backwards or write a second one", async () => {
    await prisma.$transaction((tx) => applyStays(tx, [fix(ids.truck, 200, false)]));
    expect(await prisma.unitStay.count({ where: { vehicleId: ids.truck } })).toBe(2);
  });

  test("the truck's history names the stays from the stops of its own loads, with the arrival and the load", async () => {
    const h = await getTruckHistory(ids.truck, 30, W, NOW);
    const titles = h.entries.map((e) => e.title);
    expect(titles).toContain("Arrived · Acme Foods dock");
    expect(h.entries.find((e) => e.kind === "stay" && !e.ongoing)).toMatchObject({ title: expect.stringMatching(/^Stopped · Acme Foods dock/), detail: "1h 30m" });
    expect(h.entries.find((e) => e.kind === "stay" && e.ongoing)).toMatchObject({ detail: "30m so far" });
    expect(h.openLoads).toEqual([{ id: ids.load, number: "AH-1" }]);
    expect(h.entries.map((e) => e.at)).toEqual([...h.entries.map((e) => e.at)].sort((a, b) => b - a));
  });

  test("a check call is validated, kept with the unit, audited, and can be removed", async () => {
    const tz = await workspaceTimezone(W);
    const unit = { kind: "truck" as const, id: ids.truck };
    expect(await logCheckCall({ unit }, NOW, W)).toMatchObject({ ok: false, error: expect.stringMatching(/Say something/) });
    expect(await logCheckCall({ unit, place: "x", at: toCentralLocal(NOW.getTime() + 3_600_000, tz) }, NOW, W)).toMatchObject({ ok: false, error: expect.stringMatching(/future/) });
    expect(await logCheckCall({ unit, place: "x", status: "great" }, NOW, W)).toMatchObject({ ok: false });
    expect(await logCheckCall({ unit, place: "x", at: "yesterday" }, NOW, W)).toMatchObject({ ok: false, error: expect.stringMatching(/date and time/) });
    expect(await logCheckCall({ unit, place: "x", loadId: ids.otherLoad }, NOW, W)).toMatchObject({ ok: false, error: expect.stringMatching(/not on AH Truck/) });
    expect(await logCheckCall({ unit: { kind: "truck", id: ids.truck }, place: "x" }, NOW, OTHER)).toMatchObject({ ok: false, error: expect.stringMatching(/not in this fleet/) });

    const made = await logCheckCall({ unit, at: toCentralLocal(NOW.getTime() - 2 * 3_600_000, tz), place: "  I-40   past Amarillo ", etaAt: toCentralLocal(NOW.getTime() + 5 * 3_600_000, tz), status: "late", note: "Flat tire, tow on the way", spokeWith: "Ana Ruiz", loadId: ids.load }, NOW, W);
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    const row = await prisma.checkCall.findUniqueOrThrow({ where: { id: made.id } });
    expect(row).toMatchObject({ vehicleId: ids.truck, trailerId: null, loadId: ids.load, place: "I-40 past Amarillo", status: "late", spokeWith: "Ana Ruiz" });
    expect(Math.abs(row.at.getTime() - (NOW.getTime() - 2 * 3_600_000))).toBeLessThan(60_000); // the typed minute, on the carrier's clock
    expect(await prisma.auditEvent.count({ where: { workspaceId: W, action: "check_call", entityId: ids.truck } })).toBe(1);

    const h = await getTruckHistory(ids.truck, 30, W, NOW);
    const call = h.entries.find((e) => e.key === `call:${made.id}`);
    expect(call).toMatchObject({ title: "Check call · Running late", meta: expect.stringContaining("Load AH-1") });
    expect(call!.detail).toContain("Said: I-40 past Amarillo");
    expect((await getTruckHistory(ids.truck, 30, OTHER, NOW)).entries).toEqual([]); // another fleet reads nothing of it

    expect(await removeCheckCall(made.id, OTHER)).toMatchObject({ ok: false });
    expect(await removeCheckCall(made.id, W)).toEqual({ ok: true });
    expect(await prisma.checkCall.count({ where: { id: made.id } })).toBe(0);
    expect(await prisma.auditEvent.count({ where: { workspaceId: W, action: "check_call_removed" } })).toBe(1);
  });

  test("a trailer's hooks and drops are kept with where they were, and read back on both the trailer and the tractor", async () => {
    expect(await hookTrailer(ids.trailer, ids.truck, ago(120), W)).toEqual({ ok: true });
    expect(await hookTrailer(ids.trailer, null, ago(60), W)).toEqual({ ok: true });
    const moves = await prisma.trailerMove.findMany({ where: { trailerId: ids.trailer }, orderBy: { at: "asc" } });
    expect(moves.map((m) => m.kind)).toEqual(["hooked", "dropped"]);
    expect(moves[1]).toMatchObject({ vehicleId: ids.truck });
    expect(Number(moves[1]!.lat)).toBeCloseTo(DOCK.lat, 3);

    const t = await getTrailerHistory(ids.trailer, 30, W, NOW);
    expect(t.entries.find((e) => e.kind === "hooked")).toMatchObject({ title: "Hooked to AH Truck" });
    expect(t.entries.find((e) => e.kind === "dropped")).toMatchObject({ title: "Dropped by AH Truck", ongoing: true, detail: expect.stringMatching(/Acme Foods dock.*Sitting 1 hour/) });
    // The tractor's stay during the hook is where the trailer stood too.
    expect(t.entries.some((e) => e.kind === "stay" && e.title.includes("(with AH Truck)"))).toBe(true);

    const truck = await getTruckHistory(ids.truck, 30, W, NOW);
    expect(truck.entries.map((e) => e.title)).toEqual(expect.arrayContaining(["Hooked AH-TR1", "Dropped AH-TR1"]));
  });

  test("closed stays older than thirteen months are purged; an open one and recent ones are not", async () => {
    const old = await prisma.unitStay.create({ data: { workspaceId: W, vehicleId: ids.other, lat: 1, lng: 1, arrivedAt: new Date(NOW.getTime() - 500 * 86_400_000), lastSeenAt: new Date(NOW.getTime() - 499 * 86_400_000), leftAt: new Date(NOW.getTime() - 499 * 86_400_000) } });
    const openOld = await prisma.unitStay.create({ data: { workspaceId: W, vehicleId: ids.other, lat: 2, lng: 2, arrivedAt: new Date(NOW.getTime() - 500 * 86_400_000), lastSeenAt: new Date(NOW.getTime() - 499 * 86_400_000) } });
    await purgeOldStays(NOW);
    expect(await prisma.unitStay.findUnique({ where: { id: old.id } })).toBeNull();
    expect(await prisma.unitStay.findUnique({ where: { id: openOld.id } })).not.toBeNull();
    expect(await prisma.unitStay.count({ where: { vehicleId: ids.truck } })).toBe(2);
  });
});
