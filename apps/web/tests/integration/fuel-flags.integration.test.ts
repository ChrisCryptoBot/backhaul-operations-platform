import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { clearFuelFlag, reopenFuelFlag } from "@/server/partners/fuel-flags";
import { listFuel, storePurchases } from "@/server/partners/fuel-store";

/**
 * Wave 5 step 3: fuel exception flags on the Fuel screen, scoped to the terminals in view, cleared one flag at a time with why (audited), and reopened. A workspace of its own:
 *   DATABASE_URL=postgresql://demo:demo@localhost:54330/demo_test RUN_DB_INTEGRATION=true npx vitest run tests/integration/fuel-flags.integration.test.ts
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const W = "ffl-w";
const NOW = new Date();
const dayAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString().slice(0, 10);
const at = (n: number, hh: string) => `${dayAgo(n)}T${hh}:00Z`;

async function wipe() {
  await prisma.auditEvent.deleteMany({ where: { workspaceId: W } });
  await prisma.workspace.deleteMany({ where: { id: W } });
}

describe.skipIf(!run)("fuel exception flags", () => {
  let dallas = "";
  let tulsa = "";
  const P = (id: string, over: Record<string, unknown> = {}) => ({ id, on: dayAgo(3), purchasedAt: at(3, "14:00"), gallons: 100, amount: 365, pricePerGallon: 3.9, discountPerGallon: 0.25, discount: 25, state: "TX", product: "road_diesel" as const, status: "settled" as const, location: "Pilot, Dallas, TX", ...over });
  const idOf = async (externalId: string) => (await prisma.fuelTransaction.findFirstOrThrow({ where: { workspaceId: W, externalId } })).id;
  const rowOf = async (externalId: string, opts: Parameters<typeof listFuel>[0] = {}) => {
    const id = await idOf(externalId);
    return (await listFuel({ days: 30, ...opts }, NOW, W)).rows.find((r) => r.id === id);
  };

  beforeAll(async () => {
    await wipe();
    await prisma.workspace.create({ data: { id: W, name: "FFL desk", plan: "enterprise" } });
    dallas = (await prisma.vehicle.create({ data: { workspaceId: W, name: "Unit 21", type: "heavy_duty", terminal: "Dallas", tankCapacityGallons: 150 } })).id;
    tulsa = (await prisma.vehicle.create({ data: { workspaceId: W, name: "Unit 22", type: "heavy_duty", terminal: "Tulsa" } })).id;
    await storePurchases(
      "wex",
      [
        P("declined", { status: "declined" }),
        P("retry", { purchasedAt: at(3, "14:02") }),
        P("twice", { purchasedAt: at(3, "14:12"), amount: 365.4 }),
        P("big", { purchasedAt: at(2, "09:00"), gallons: 180, amount: 657, discount: 45, state: null, location: "Somewhere" }),
        P("gas", { purchasedAt: at(1, "09:00"), product: "gasoline", gallons: 10, amount: 36.5, discount: 2.5 })
      ],
      { workspaceId: W, vehicleId: dallas }
    );
    await storePurchases("wex", [P("tulsa-big", { purchasedAt: at(2, "10:00"), gallons: 260, amount: 949, discount: 65, state: "OK" })], { workspaceId: W, vehicleId: tulsa });
    await storePurchases("wex", [P("loose", { purchasedAt: at(1, "11:00"), gallons: 50, amount: 182.5, discount: 12.5 })], { workspaceId: W, vehicleId: null });
  });
  afterAll(wipe);

  test("each purchase carries its own flags; a declined swipe and its retry are not a duplicate", async () => {
    const open = async (x: string) => (await rowOf(x))!.flags.open.map((f) => f.code);
    expect(await open("declined")).toEqual([]);
    expect(await open("retry")).toEqual(["duplicate"]); // with "twice", ten minutes later
    expect(await open("twice")).toEqual(["duplicate"]);
    expect(await open("big")).toEqual(["over_capacity", "no_state"]);
    expect(await open("gas")).toEqual(["non_diesel"]);
    expect(await open("tulsa-big")).toEqual([]); // no tank size typed: not checked
    expect(await open("loose")).toEqual(["no_truck"]);
  });

  test("the counts and the Flagged list follow the terminals in view", async () => {
    const all = await listFuel({ days: 30 }, NOW, W);
    expect(all.flags).toMatchObject({ purchases: 5, open: 6, tankUnknown: 1, byCode: { duplicate: 2, over_capacity: 1, no_state: 1, non_diesel: 1, no_truck: 1 } });
    const dallasOnly = await listFuel({ days: 30, terminal: "Dallas" }, NOW, W);
    expect(dallasOnly.flags).toMatchObject({ purchases: 4, open: 5, tankUnknown: 0 });
    const tulsaOnly = await listFuel({ days: 30, terminal: "Tulsa" }, NOW, W);
    expect(tulsaOnly.flags).toMatchObject({ purchases: 0, open: 0, tankUnknown: 1 });
    // The same purchase has the same flags whatever is in view.
    expect((await rowOf("retry", { terminal: "Dallas" }))!.flags.open.map((f) => f.code)).toEqual(["duplicate"]);

    const flagged = await listFuel({ days: 30, flagged: true }, NOW, W);
    expect(flagged.total).toBe(5);
    expect(flagged.rows.every((r) => r.flags.open.length > 0)).toBe(true);
    expect((await listFuel({ days: 30, flagged: true, terminal: "Tulsa" }, NOW, W)).total).toBe(0);
  });

  test("clearing one flag leaves the other open, is audited, and can be undone", async () => {
    const big = await idOf("big");
    expect(await clearFuelFlag(big, "over_capacity", "  ", NOW, W)).toEqual({ ok: false, error: "Say why it is all right (a few words)." });
    expect(await clearFuelFlag(big, "duplicate", "Not a duplicate", NOW, W)).toEqual({ ok: false, error: "That purchase does not have that flag now." });
    expect(await clearFuelFlag(big, "nonsense", "x y z", NOW, W)).toEqual({ ok: false, error: "That is not a fuel flag." });
    expect(await clearFuelFlag(big, "over_capacity", "Two tanks and the auxiliary, receipt checked", NOW, W)).toEqual({ ok: true });
    expect(await clearFuelFlag(big, "over_capacity", "again", NOW, W)).toEqual({ ok: false, error: "That flag is already cleared." });

    const row = (await rowOf("big"))!;
    expect(row.flags.open.map((f) => f.code)).toEqual(["no_state"]);
    expect(row.flags.cleared).toMatchObject([{ code: "over_capacity", note: "Two tanks and the auxiliary, receipt checked" }]);
    expect((await listFuel({ days: 30 }, NOW, W)).flags).toMatchObject({ purchases: 5, open: 5, cleared: 1 });

    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { workspaceId: W, action: "fuel_flag_cleared", entityId: big } });
    expect(audit.reason).toBe("Two tanks and the auxiliary, receipt checked");
    expect(audit.summary).toContain('Fuel flag "Over tank size" cleared on Unit 21');

    // Clearing the last open flag takes the purchase off the Flagged list.
    expect(await clearFuelFlag(await idOf("gas"), "non_diesel", "Reefer genset runs on gas", NOW, W)).toEqual({ ok: true });
    expect((await listFuel({ days: 30, flagged: true }, NOW, W)).total).toBe(4);

    expect(await reopenFuelFlag(big, "over_capacity", NOW, W)).toEqual({ ok: true });
    expect((await rowOf("big"))!.flags.open.map((f) => f.code)).toEqual(["over_capacity", "no_state"]);
    expect(await prisma.auditEvent.count({ where: { workspaceId: W, action: "fuel_flag_reopened", entityId: big } })).toBe(1);
    expect(await reopenFuelFlag(big, "over_capacity", NOW, W)).toEqual({ ok: false, error: "That flag is not cleared." });
  });

  test("a flag cleared on one fleet's purchase cannot be reached from another fleet", async () => {
    expect(await clearFuelFlag(await idOf("loose"), "no_truck", "Belongs to the yard", NOW, "some-other-workspace")).toEqual({ ok: false, error: "That purchase is not on this desk." });
  });
});
