import { describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { getTrailerWhere, getTruckWhere } from "@/server/tl/whereabouts";
import { getTruckHistory } from "@/server/tl/asset-history";
import { applyStays } from "@/server/tl/stays";

/**
 * Where a page of trucks and trailers are, on the scale database (1,500 trucks, 5,000 trailers, about 4,000 loads, seeded positions). The read is for the rows on screen only, so it must not
 * grow with the fleet: a page of fifty each is answered in well under a second, and the hover reads one unit.
 *
 *   DATABASE_URL=postgresql://demo:demo@localhost:54330/demo_scale RUN_SCALE=true npx vitest run tests/perf/whereabouts.perf.test.ts
 */
const run = process.env.RUN_SCALE === "true";

async function best(fn: () => Promise<unknown>, runs = 2): Promise<number> {
  let fastest = Infinity;
  for (let i = 0; i < runs; i++) {
    const t = Date.now();
    await fn();
    fastest = Math.min(fastest, Date.now() - t);
  }
  return fastest;
}

describe.skipIf(!run)("whereabouts at the size of a big fleet", () => {
  test("a page of 50 trucks and a page of 50 trailers, and one unit for the hover", async () => {
    const ws = (await prisma.vehicle.findFirst({ where: { lastLat: { not: null } }, select: { workspaceId: true } }))?.workspaceId;
    expect(ws).toBeTruthy();
    const trucks = (await prisma.vehicle.findMany({ where: { workspaceId: ws!, lastLat: { not: null } }, select: { id: true }, take: 50 })).map((t) => t.id);
    const trailers = (await prisma.trailer.findMany({ where: { workspaceId: ws!, lastLat: { not: null } }, select: { id: true }, take: 50 })).map((t) => t.id);
    expect(trucks.length).toBe(50);
    expect(trailers.length).toBe(50);
    const got = await getTruckWhere(trucks, ws!);
    expect([...got.values()].filter((u) => u.where).length).toBe(50);
    expect([...(await getTrailerWhere(trailers, ws!)).values()].filter((u) => u.where).length).toBe(50);
    expect(await best(() => getTruckWhere(trucks, ws!))).toBeLessThan(1000);
    expect(await best(() => getTrailerWhere(trailers, ws!))).toBeLessThan(1000);
    expect(await best(() => getTruckWhere([trucks[0]!], ws!))).toBeLessThan(300);
  });

  test("one truck's history is read in well under a second, and a sync's stays for 1,500 tractors are written inside a few seconds", async () => {
    const ws = (await prisma.vehicle.findFirst({ where: { lastLat: { not: null } }, select: { workspaceId: true } }))?.workspaceId!;
    const all = await prisma.vehicle.findMany({ where: { workspaceId: ws, lastLat: { not: null } }, select: { id: true, lastLat: true, lastLng: true } });
    expect(await best(() => getTruckHistory(all[0]!.id, 90, ws))).toBeLessThan(500);
    const at = new Date();
    const fixes = all.map((v) => ({ workspaceId: ws, vehicleId: v.id, lat: Number(v.lastLat), lng: Number(v.lastLng), speedMph: 0, engine: "off", at }));
    class Rollback extends Error {}
    const t = Date.now();
    await prisma
      .$transaction(
        async (tx) => {
          const out = await applyStays(tx, fixes);
          expect(out.opened).toBe(all.length);
          throw new Rollback();
        },
        { timeout: 60_000 }
      )
      .catch((e) => {
        if (!(e instanceof Rollback)) throw e;
      });
    expect(Date.now() - t).toBeLessThan(8000);
  });
});
