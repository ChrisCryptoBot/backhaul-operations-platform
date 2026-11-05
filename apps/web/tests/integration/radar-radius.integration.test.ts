import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { prisma } from "@/lib/db";
import { readRadarParams } from "@/lib/radar-points";
import { listTrucksPage } from "@/server/tl/fleet-list";
import { getRadarData } from "@/server/tl/radar";
import { unitsNear } from "@/server/tl/radar-near";
import { radarList, radarPoints, radarUnit } from "@/server/tl/radar-query";
import { listTrailersPage } from "@/server/tl/trailers";

/**
 * The radar's clusters, radius search and list, on the demo database in a workspace of its own: a place typed as a ZIP, a city or a state narrows the units to a radius, the list is nearest first and
 * can be grouped by place (several trailers on one spot), the lean points carry nothing a map does not need, and the Trucks and Trailers tables answer the same question. Nothing leaves the machine:
 *   DATABASE_URL=postgresql://demo:demo@localhost:54330/demo RUN_DB_INTEGRATION=true npx vitest run tests/integration/radar-radius.integration.test.ts
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const W = "rr-w";
const OTHER = "rr-other";
const q = (o: Record<string, string>) => readRadarParams((k) => o[k]);
const NOW = new Date();

async function wipe(id: string) {
  await prisma.workspace.deleteMany({ where: { id } });
}

describe.skipIf(!run)("radar radius search, clusters and list", () => {
  const ids = { dallas: "", fortworth: "", houston: "", yard: [] as string[], atlanta: "" };
  beforeAll(async () => {
    await wipe(W);
    await wipe(OTHER);
    await prisma.workspace.create({ data: { id: W, name: "RR fleet", plan: "enterprise" } });
    await prisma.workspace.create({ data: { id: OTHER, name: "RR other", plan: "enterprise" } });
    const truck = (name: string, lat: number, lng: number, terminal: string, engine = "moving") =>
      prisma.vehicle.create({ data: { workspaceId: W, name, terminal, lastLat: lat, lastLng: lng, lastLocatedAt: NOW, engineState: engine, lastSpeedMph: engine === "moving" ? 60 : 0, lastHeadingDeg: 90 } });
    ids.dallas = (await truck("RR Dallas", 32.8, -96.8, "North")).id;
    ids.fortworth = (await truck("RR Fort Worth", 32.75, -97.33, "North", "idle")).id;
    ids.houston = (await truck("RR Houston", 29.76, -95.37, "South")).id;
    // Four dropped trailers on one spot (a yard), one far away in Atlanta, one in another fleet right beside the yard.
    for (let i = 0; i < 4; i++) {
      ids.yard.push((await prisma.trailer.create({ data: { workspaceId: W, number: `RR-YARD-${i}`, type: "dry_van", lengthFt: 53, terminal: "North", lastLat: 32.82, lastLng: -96.75, lastLocatedAt: NOW, unhookedAt: new Date(NOW.getTime() - (10 + i * 30) * 3_600_000) } })).id);
    }
    ids.atlanta = (await prisma.trailer.create({ data: { workspaceId: W, number: "RR-ATL", type: "reefer", lengthFt: 48, terminal: "South", lastLat: 33.75, lastLng: -84.39, lastLocatedAt: NOW, unhookedAt: new Date(NOW.getTime() - 5 * 3_600_000) } })).id;
    await prisma.trailer.create({ data: { workspaceId: OTHER, number: "RR-FOREIGN", lastLat: 32.82, lastLng: -96.75, lastLocatedAt: NOW } });
    await prisma.trailer.create({ data: { workspaceId: W, number: "RR-NOFIX", type: "dry_van" } }); // no position: never near anywhere
  });
  afterAll(async () => {
    await wipe(W);
    await wipe(OTHER);
  });

  const fetchSpy = () => vi.spyOn(globalThis, "fetch").mockImplementation(() => Promise.reject(new Error("no network in this test")));

  test("a ZIP and a radius keep the units inside it, say how many of each, and send only lean points", async () => {
    const spy = fetchSpy();
    const data = await getRadarData(W, null, NOW);
    const out = await radarPoints(data, q({ near: "75201", r: "50" }));
    expect(out.search).toMatchObject({ ok: true, radius: 50, trucks: 2, trailers: 4, source: "census" });
    expect(out.points.map((p) => p.name).sort()).toEqual(["RR Dallas", "RR Fort Worth", "RR-YARD-0", "RR-YARD-1", "RR-YARD-2", "RR-YARD-3"]);
    // A point is only what a map needs: no sentences, no names of drivers or loads.
    expect(Object.keys(out.points[0]!).sort()).toEqual(["h", "icon", "id", "k", "lat", "lng", "name", "r", "sev", "t"]);
    expect(out.points.find((p) => p.name === "RR Fort Worth")).toMatchObject({ k: "t", t: 1, r: 0, sev: 1, icon: "t-idle" }); // idling is the amber tone
    expect(out.points.filter((p) => p.k === "r").every((p) => p.t === 0 && p.r === 1)).toBe(true);
    expect(spy).not.toHaveBeenCalled(); // a ZIP is read from the bundled data
    spy.mockRestore();
  });

  test("a city, and a state with its own wide radius; a typed radius wins; unknown text is an error, not a guess", async () => {
    const spy = fetchSpy();
    const data = await getRadarData(W, null, NOW);
    expect((await radarPoints(data, q({ near: "Dallas, TX", r: "10" }))).search).toMatchObject({ ok: true, label: "Dallas, TX", trucks: 1, trailers: 4 });
    const tx = await radarPoints(data, q({ near: "TX" }));
    expect(tx.search).toMatchObject({ ok: true, radius: 400, trucks: 3 }); // Houston is inside Texas's own radius
    expect((await radarPoints(data, q({ near: "TX", r: "30" }))).search).toMatchObject({ ok: true, radius: 30, trucks: 0 });
    const lost = await radarPoints(data, q({ near: "Nowhereville, TX" }));
    expect(lost.search).toMatchObject({ ok: false });
    expect(lost.points.length).toBe(data.tractors.length + data.trailers.length); // nothing is dropped by a search that found nothing
    spy.mockRestore();
  });

  test("the list is nearest first with distances, narrows by kind and state, and a stack picked on the map lists by id", async () => {
    const data = await getRadarData(W, null, NOW);
    const all = await radarList(data, q({ near: "75201", r: "50" }));
    expect(all.total).toBe(6);
    expect(all.rows.map((r) => r.miles).every((m) => m != null)).toBe(true);
    const miles = all.rows.map((r) => r.miles!);
    expect(miles).toEqual([...miles].sort((a, b) => a - b));
    expect(all.rows[0]!.near).toContain("Dallas");
    expect((await radarList(data, q({ near: "75201", r: "50", kind: "tractor" }))).rows.map((r) => r.name).sort()).toEqual(["RR Dallas", "RR Fort Worth"]);
    expect((await radarList(data, q({ near: "75201", r: "50", state: "idling" }))).rows.map((r) => r.name)).toEqual(["RR Fort Worth"]);
    const picked = await radarList(data, q({ ids: ids.yard.slice(0, 2).join(",") }));
    expect(picked.rows.map((r) => r.name).sort()).toEqual(["RR-YARD-0", "RR-YARD-1"]);
    const byName = await radarList(data, q({ sort: "name", kind: "trailer" }));
    expect(byName.rows.map((r) => r.name)).toEqual([...byName.rows.map((r) => r.name)].sort());
    expect(byName.rows.find((r) => r.name === "RR-YARD-0")).toMatchObject({ code: "53V", lengthFt: 53, kind: "trailer", href: expect.stringContaining("/trailers/") });
    expect(await radarList(data, q({ q: "fort worth" }))).toMatchObject({ total: 1 });
  });

  test("grouped by place, trailers on one spot read as one line with all of them in it", async () => {
    const data = await getRadarData(W, null, NOW);
    const grouped = await radarList(data, q({ group: "1" }));
    expect(grouped.rows).toEqual([]);
    const yard = grouped.groups!.find((g) => g.trailers === 4)!;
    expect(yard).toMatchObject({ trucks: 0, near: expect.stringContaining("Dallas") });
    expect(yard.rows.map((r) => r.name).sort()).toEqual(["RR-YARD-0", "RR-YARD-1", "RR-YARD-2", "RR-YARD-3"]);
    expect(grouped.groups![0]!.rows.length).toBeGreaterThanOrEqual(grouped.groups![grouped.groups!.length - 1]!.rows.length); // the fullest place first
  });

  test("one unit's card, and a unit that is not this fleet's is nobody's", async () => {
    const data = await getRadarData(W, null, NOW);
    expect(radarUnit(data, "tractor", ids.dallas).tractor).toMatchObject({ name: "RR Dallas" });
    expect(radarUnit(data, "trailer", ids.yard[0]!).trailer).toMatchObject({ number: "RR-YARD-0", lengthFt: 53 });
    expect(radarUnit(data, "trailer", "nope")).toEqual({ mode: "unit", tractor: null, trailer: null });
    expect(data.trailers.some((t) => t.number === "RR-FOREIGN")).toBe(false);
  });

  test("the Trucks and Trailers lists answer the same question: ids inside the radius, scoped to the fleet and the terminal", async () => {
    const spy = fetchSpy();
    const trucks = await unitsNear("trucks", "75201", 50, W, null);
    if ("error" in trucks) throw new Error(trucks.error);
    expect([...trucks.miles.keys()].sort()).toEqual([ids.dallas, ids.fortworth].sort());
    expect(trucks.label).toContain("Dallas");
    const page = await listTrucksPage({ onlyIds: [...trucks.miles.keys()], pageSize: 10 }, W);
    expect(page.rows.map((r) => r.name).sort()).toEqual(["RR Dallas", "RR Fort Worth"]);
    expect(page.total).toBe(2);

    const trailers = await unitsNear("trailers", "75201", 50, W, null);
    if ("error" in trailers) throw new Error(trailers.error);
    expect(trailers.miles.size).toBe(4); // the other fleet's trailer beside the yard is not here, and the one with no fix is nowhere
    const tpage = await listTrailersPage({ onlyIds: [...trailers.miles.keys()] }, NOW, W);
    expect(tpage.rows.map((r) => r.number).sort()).toEqual(["RR-YARD-0", "RR-YARD-1", "RR-YARD-2", "RR-YARD-3"]);
    expect(tpage.rows.every((r) => r.lengthFt === 53)).toBe(true);

    // A terminal scope narrows further: Houston's South terminal is not near Dallas, and North's trucks are.
    const south = await unitsNear("trucks", "TX", null, W, "South");
    if ("error" in south) throw new Error(south.error);
    expect([...south.miles.keys()]).toEqual([ids.houston]);
    expect(await unitsNear("trucks", "Nowhereville, TX", null, W, null)).toMatchObject({ error: expect.stringContaining("Could not find") });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
