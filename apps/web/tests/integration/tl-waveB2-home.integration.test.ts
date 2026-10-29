import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { prisma } from "@/lib/db";
import { measureForDesk } from "@/server/geo/desk";
import { saveTruck } from "@/server/tl/fleet";
import { num } from "@/server/tl/convert";

/**
 * Needs a seeded database (see tl-dispatch.integration.test.ts). Makes its own trucks (all named WBH) and removes them and their audit events
 * afterwards. Mapbox is never reached: fetch is replaced, so the geocoders answer from a table here.
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const WS = "demo-workspace";

const place = (text: string, state: string, lng: number, lat: number) => ({ features: [{ text, place_type: ["place"], center: [lng, lat], context: [{ id: "region.1", text: state, short_code: `US-${state}` }] }] });
const TABLE: Array<[string, unknown]> = [
  ["Dallas", place("Dallas", "TX", -96.797, 32.7767)],
  ["Tulsa", place("Tulsa", "OK", -95.9928, 36.154)],
  ["Waco", place("Waco", "TX", -97.1467, 31.5493)]
];

describe.skipIf(!run)("a truck's home coordinates on the demo database", () => {
  const startedAt = new Date();
  const original = process.env.MAPBOX_ACCESS_TOKEN;
  const urls: string[] = [];

  const stub = () => {
    process.env.MAPBOX_ACCESS_TOKEN = "pk.test-token";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url);
        if (url.includes("/directions/")) return { ok: true, json: async () => ({ routes: [{ distance: 1609.344 * 100, duration: 7200, legs: [{ distance: 1609.344 * 100 }] }] }) };
        const hit = TABLE.find(([name]) => url.includes(`/${name}`));
        return { ok: true, json: async () => (hit ? hit[1] : { features: [] }) };
      })
    );
  };
  const permanent = (name: string) => urls.filter((u) => u.includes("mapbox.places-permanent") && u.includes(`/${name}`)).length;
  const temporary = (name: string) => urls.filter((u) => /mapbox\.places\//.test(u) && u.includes(`/${name}`)).length;
  const truck = (name: string, homeBaseAddress: string) => ({ name: `WBH ${name}`, type: "box_truck", mpg: "10", fuelType: "diesel", homeBaseAddress });
  const row = (id: string) => prisma.vehicle.findUniqueOrThrow({ where: { id } });

  beforeEach(() => {
    urls.length = 0;
    stub();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    if (original === undefined) delete process.env.MAPBOX_ACCESS_TOKEN;
    else process.env.MAPBOX_ACCESS_TOKEN = original;
  });
  afterAll(async () => {
    await prisma.auditEvent.deleteMany({ where: { createdAt: { gte: startedAt }, entity: "fleet" } });
    await prisma.vehicle.deleteMany({ where: { workspaceId: WS, name: { startsWith: "WBH" } } });
  });

  test("saving a truck finds its home base on the permanent endpoint and keeps six places", async () => {
    const out = await saveTruck(truck("One", "Dallas, TX"), null);
    if (!out.ok) throw new Error("save");
    const t = await row(out.id);
    expect([num(t.homeBaseLat as never), num(t.homeBaseLng as never)]).toEqual([32.7767, -96.797]);
    expect(permanent("Dallas")).toBe(1);
    expect(temporary("Dallas")).toBe(0); // the temporary endpoint is not used for a point that is stored
  });

  test("a changed address clears the old point and finds the new one; an address nobody can find leaves it blank and still saves", async () => {
    const created = await saveTruck(truck("Two", "Dallas, TX"), null);
    if (!created.ok) throw new Error("save");
    const moved = await saveTruck(truck("Two", "Tulsa, OK"), created.id);
    expect(moved).toMatchObject({ ok: true, changed: true });
    expect(num((await row(created.id)).homeBaseLat as never)).toBe(36.154);

    const lost = await saveTruck(truck("Two", "Nowhereville, ZZ"), created.id);
    expect(lost).toMatchObject({ ok: true, changed: true });
    expect(await row(created.id)).toMatchObject({ homeBaseAddress: "Nowhereville, ZZ", homeBaseLat: null, homeBaseLng: null });

    await saveTruck({ ...truck("Two", ""), homeBaseAddress: "" }, created.id);
    expect(await row(created.id)).toMatchObject({ homeBaseAddress: null, homeBaseLat: null, homeBaseLng: null });
  });

  test("editing something else keeps the point and looks nothing up", async () => {
    const created = await saveTruck(truck("Three", "Dallas, TX"), null);
    if (!created.ok) throw new Error("save");
    urls.length = 0;
    expect(await saveTruck({ ...truck("Three", "Dallas, TX"), mpg: "9" }, created.id)).toMatchObject({ ok: true, changed: true });
    expect(urls).toHaveLength(0);
    expect(num((await row(created.id)).homeBaseLat as never)).toBe(32.7767);
  });

  test("with no key a truck still saves, with no point", async () => {
    delete process.env.MAPBOX_ACCESS_TOKEN;
    const out = await saveTruck(truck("Four", "Dallas, TX"), null);
    if (!out.ok) throw new Error("save");
    expect(await row(out.id)).toMatchObject({ homeBaseLat: null, homeBaseLng: null });
    expect(urls).toHaveLength(0);
  });

  test("measuring a quote backfills a truck that has an address but no point, then measures from the stored point without looking the address up again", async () => {
    delete process.env.MAPBOX_ACCESS_TOKEN;
    const created = await saveTruck(truck("Five", "Waco, TX"), null);
    if (!created.ok) throw new Error("save");
    expect((await row(created.id)).homeBaseLat).toBeNull();

    stub();
    const stops = [
      { address: "Dallas, TX", role: "pickup" as const },
      { address: "Tulsa, OK", role: "delivery" as const }
    ];
    const first = await measureForDesk(stops);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("measure");
    expect(first.perTruck[created.id]).toEqual({ toPickup: 100, home: 100 });
    expect(num((await row(created.id)).homeBaseLat as never)).toBe(31.5493);
    expect(permanent("Waco")).toBe(1);

    urls.length = 0;
    const second = await measureForDesk(stops);
    expect(second.ok).toBe(true);
    expect(permanent("Waco")).toBe(0); // already stored
    expect(temporary("Waco")).toBe(0); // measured from the stored point
  });
});
