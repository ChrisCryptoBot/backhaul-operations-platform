import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { assignDriver, unassignLoad } from "@/server/tl/dispatch";
import { rankDrivers } from "@/server/tl/driver-rank";
import { loadInclude } from "@/server/tl/queries";
import { listOpenPickups, listQuotes, passQuote } from "@/server/tl/quote";
import { currentScope, limitOf } from "@/server/tl/scope";

/**
 * The fences behind R2: a person limited to some terminals cannot widen their view with a typed search, an "everyone" link, a driver id in a form, a load id in a form or a quote id,
 * whatever the header says. The limit comes from the member table (currentScope's `allowed`); the pick routes and the planner hold to it (source-pinned below), and the server actions
 * that change something (assign, unassign, pass) refuse anything outside it.
 *   DATABASE_URL=postgresql://demo:demo@localhost:54330/demo RUN_DB_INTEGRATION=true npx vitest run tests/integration/scope-fences.integration.test.ts
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const W = "sf-w";
const NOW = new Date();
const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

async function wipe(id: string) {
  await prisma.workspace.deleteMany({ where: { id } });
}

describe("the pick routes and the planner hold to the person's limit (source pins)", () => {
  const read = (p: string) => readFileSync(p, "utf8").split(String.fromCharCode(13)).join("");
  for (const p of ["src/app/(desk)/drivers/pick/route.ts", "src/app/(desk)/fleet/pick/route.ts", "src/app/(desk)/trailers/pick/route.ts"]) {
    test(`${p}: a typed search is held to currentAllowed, never null`, () => {
      const src = read(p);
      expect(src).toContain("q ? await currentAllowed() : await currentTerminal()");
      expect(src).not.toMatch(/q \? null/);
    });
  }
  test("the planner's everyone link is held to currentAllowed", () => {
    const src = read("src/app/(desk)/planner/page.tsx");
    expect(src).toContain("const reach = await currentAllowed()");
    expect(src).toContain("everyone ? reach : scope");
    expect(src).not.toMatch(/everyone \? null/);
  });
});

describe.skipIf(!run)("the fences on what a limited person can change", () => {
  const ids = { dallasDriver: "", memphisDriver: "", loadplaced: "", loadMemphis: "", loadOpen: "", quoteMemphis: "", quoteOpen: "" };
  beforeAll(async () => {
    await wipe(W);
    await prisma.workspace.create({ data: { id: W, name: "SF fleet", plan: "enterprise" } });
    for (const n of ["Dallas", "Memphis"]) await prisma.terminal.create({ data: { workspaceId: W, name: n } });
    const dTruck = await prisma.vehicle.create({ data: { workspaceId: W, name: "SF Dallas Truck", terminal: "Dallas" } });
    const mTruck = await prisma.vehicle.create({ data: { workspaceId: W, name: "SF Memphis Truck", terminal: "Memphis" } });
    ids.dallasDriver = (await prisma.driver.create({ data: { workspaceId: W, name: "SF Dallas Driver", terminal: "Dallas", cdlExpiry: days(300), medicalCardExpiry: days(300) } })).id;
    ids.memphisDriver = (await prisma.driver.create({ data: { workspaceId: W, name: "SF Memphis Driver", terminal: "Memphis", cdlExpiry: days(300), medicalCardExpiry: days(300) } })).id;
    await prisma.driver.create({ data: { workspaceId: W, name: "SF Unplaced Driver", cdlExpiry: days(300), medicalCardExpiry: days(300) } });
    const load = (n: string, extra: object) => prisma.load.create({ data: { workspaceId: W, loadNumber: n, status: "draft", quotedRevenue: 800, scheduledDate: days(2), ...extra } });
    ids.loadplaced = (await load("SF-DALLAS", { vehicleId: dTruck.id })).id;
    ids.loadMemphis = (await load("SF-MEMPHIS", { vehicleId: mTruck.id })).id;
    ids.loadOpen = (await load("SF-OPEN", {})).id;
    ids.quoteMemphis = (await load("SF-QM", { vehicleId: mTruck.id, status: "quote" })).id;
    ids.quoteOpen = (await load("SF-QO", { status: "quote" })).id;
    // Each draft has a pickup, so it is a backhaul candidate on the Quote page.
    for (const [id, city] of [[ids.loadplaced, "Dallas, TX"], [ids.loadMemphis, "Memphis, TN"], [ids.loadOpen, "Reno, NV"]] as const) await prisma.stop.create({ data: { loadId: id, stopSequence: 0, stopType: "pickup", stopRole: "pickup", addressString: city } });
  });
  afterAll(async () => {
    await wipe(W);
  });

  const texasOnly = ["Dallas"] as const;

  test("the limit is what currentScope reports as allowed, whatever the header chose", async () => {
    const limit = limitOf([{ regionId: null, terminal: "Dallas" }]);
    const s = await currentScope(W, { choice: { kind: "all" }, limit });
    expect(s.allowed).toEqual(["Dallas"]);
    expect((await currentScope(W, { choice: { kind: "all" }, limit: { kind: "all" } })).allowed).toBeNull();
  });

  test("assigning: a driver outside the limit is refused, one inside works, the unplaced load is everyone's, another terminal's load is not found", async () => {
    const pay = { kind: "cpm", rate: 0.5 } as const;
    await expect(assignDriver({ loadId: ids.loadOpen, driverId: ids.memphisDriver, pay, allowed: texasOnly }, NOW, W)).rejects.toMatchObject({ code: "driver_outside_limit" });
    await expect(assignDriver({ loadId: ids.loadOpen, driverId: (await prisma.driver.findFirstOrThrow({ where: { workspaceId: W, name: "SF Unplaced Driver" } })).id, pay, allowed: texasOnly }, NOW, W)).rejects.toMatchObject({ code: "driver_outside_limit" }); // no terminal: outside every limit
    await expect(assignDriver({ loadId: ids.loadMemphis, driverId: ids.dallasDriver, pay, allowed: texasOnly }, NOW, W)).rejects.toMatchObject({ code: "load_not_found" });
    await assignDriver({ loadId: ids.loadOpen, driverId: ids.dallasDriver, pay, allowed: texasOnly }, NOW, W);
    expect((await prisma.assignment.findFirstOrThrow({ where: { loadId: ids.loadOpen } })).driverId).toBe(ids.dallasDriver);
    // Not limited: any driver, any load.
    await assignDriver({ loadId: ids.loadMemphis, driverId: ids.memphisDriver, pay, allowed: null }, NOW, W);
    expect((await prisma.assignment.findFirstOrThrow({ where: { loadId: ids.loadMemphis } })).driverId).toBe(ids.memphisDriver);
  });

  test("unassigning another terminal's load is not found for a limited person", async () => {
    await expect(unassignLoad(ids.loadMemphis, null, NOW, W, texasOnly)).rejects.toMatchObject({ code: "load_not_found" });
    await unassignLoad(ids.loadMemphis, null, NOW, W, null);
    expect(await prisma.assignment.count({ where: { loadId: ids.loadMemphis } })).toBe(0);
  });

  test("ranking offers a limited person only drivers inside their limit, and everyone else all of them", async () => {
    const load = await prisma.load.findFirstOrThrow({ where: { id: ids.loadplaced }, include: loadInclude });
    const names = async (allowed: readonly string[] | null) => (await rankDrivers(load, W, null, allowed)).options.map((o) => o.name).sort();
    expect(await names(["Dallas"])).toEqual(["SF Dallas Driver"]);
    expect(await names(null)).toEqual(["SF Dallas Driver", "SF Memphis Driver", "SF Unplaced Driver"]);
  });

  test("the Quote page's reads: saved quotes and open pickups are the terminals' (a booking nobody holds yet is everyone's)", async () => {
    const quotes = async (t: readonly string[] | null) => (await listQuotes(W, { status: "open" }, t)).rows.map((r) => r.id).sort();
    expect(await quotes(["Dallas"])).toEqual([ids.quoteOpen]);
    expect(await quotes(["Memphis"])).toEqual([ids.quoteMemphis, ids.quoteOpen].sort());
    expect(await quotes(null)).toEqual([ids.quoteMemphis, ids.quoteOpen].sort());
    const pickups = async (t: readonly string[] | null) => (await listOpenPickups(W, t)).map((p) => p.loadNumber).sort();
    expect(await pickups(["Dallas"])).toEqual(["SF-DALLAS", "SF-OPEN"]);
    // (SF-OPEN went to Dallas's driver in the assigning test above, so it is Dallas's now, not everyone's.)
    expect(await pickups(["Memphis"])).toEqual(["SF-MEMPHIS"]);
    expect(await pickups(null)).toEqual(["SF-DALLAS", "SF-MEMPHIS", "SF-OPEN"]);
  });

  test("passing a quote: a quote on another terminal's truck is not theirs to pass; one with no truck yet is everyone's", async () => {
    expect(await passQuote(ids.quoteMemphis, "Rate too low", "", W, NOW, texasOnly)).toEqual({ ok: false, error: "That quote is gone." });
    expect(await passQuote(ids.quoteOpen, "Rate too low", "", W, NOW, texasOnly)).toMatchObject({ ok: true });
    expect(await passQuote(ids.quoteMemphis, "Rate too low", "", W, NOW, null)).toMatchObject({ ok: true });
  });
});
