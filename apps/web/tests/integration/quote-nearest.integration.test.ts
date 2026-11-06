import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { BLANK_QUOTE, readQuote } from "@/lib/quote";
import { fitQuote } from "@/server/tl/quote";

/**
 * Quoting at the size of a fleet: the nearest trucks are priced, nearest first, each with its own empty miles; a truck with a base that was not among the nearest is never priced as if it were as near as
 * the typed figure; the chips (trailer fits, on shift, available) are in every row; a longer trailer takes a shorter load; and "show more" is another page of the nearest.
 *   DATABASE_URL=postgresql://demo:demo@localhost:54330/demo RUN_DB_INTEGRATION=true npx vitest run tests/integration/quote-nearest.integration.test.ts
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const W = "qn-w";
const NOW = new Date();
// What a cost profile needs to exist: the rest has defaults. The floor is stored as typed here.
const profile = { estimatedMonthlyMiles: "7000", breakEvenRpm: "1.5", lastFuelPricePerGallon: "3.9", driverHourlyTarget: "25" };

async function wipe(id: string) {
  await prisma.workspace.deleteMany({ where: { id } });
}

const ask = (over: Record<string, unknown> = {}) => {
  const r = readQuote({
    ...BLANK_QUOTE,
    stops: [
      { role: "pickup", address: "Dallas, TX", appointment: "" },
      { role: "delivery", address: "Tulsa, OK", appointment: "" }
    ],
    broker: "QN Broker",
    offer: "1500",
    loadedMiles: "260",
    emptyToPickup: "40",
    emptyHome: "240",
    marketRate: "1500",
    ...over
  } as never);
  if (!r) throw new Error("not priceable");
  return r;
};

describe.skipIf(!run)("the nearest trucks are priced, with chips", () => {
  const ids: string[] = [];
  const trailerOn: Record<string, string> = {};
  beforeAll(async () => {
    await wipe(W);
    await prisma.workspace.create({ data: { id: W, name: "QN fleet", plan: "enterprise" } });
    // 60 trucks with a cost profile and a base (the first 30 are Dallas, the next 30 Memphis), plus 3 with no base and 2 with no cost profile.
    for (let i = 0; i < 60; i++) {
      const v = await prisma.vehicle.create({ data: { workspaceId: W, name: `QN ${String(i + 1).padStart(2, "0")}`, terminal: i < 30 ? "Dallas" : "Memphis", type: "tractor", homeBaseLat: i < 30 ? 32.78 : 35.15, homeBaseLng: i < 30 ? -96.8 : -90.05 } });
      await prisma.costProfile.create({ data: { vehicleId: v.id, ...profile } as never });
      ids.push(v.id);
    }
    for (let i = 0; i < 3; i++) {
      const v = await prisma.vehicle.create({ data: { workspaceId: W, name: `QN nobase ${i + 1}`, terminal: "Dallas", type: "tractor" } });
      await prisma.costProfile.create({ data: { vehicleId: v.id, ...profile } as never });
    }
    for (let i = 0; i < 2; i++) await prisma.vehicle.create({ data: { workspaceId: W, name: `QN noprofile ${i + 1}`, terminal: "Dallas", type: "tractor" } });
    // A 53 ft dry van hooked to truck 01, a 40 ft one to truck 02.
    const t53 = await prisma.trailer.create({ data: { workspaceId: W, number: "QN-53", type: "dry_van", lengthFt: 53, currentVehicleId: ids[0], status: "available" } });
    const t40 = await prisma.trailer.create({ data: { workspaceId: W, number: "QN-40", type: "dry_van", lengthFt: 40, currentVehicleId: ids[1], status: "available" } });
    trailerOn[ids[0]!] = t53.id;
    trailerOn[ids[1]!] = t40.id;
  });
  afterAll(async () => {
    await wipe(W);
  });

  test("nothing measured: the first 25 by name, and it says so; the scope is counted, trucks with no profile are counted apart", async () => {
    const fit = await fitQuote(ask(), W);
    expect(fit.scope).toMatchObject({ ranked: "name", limit: 25, priced: 25, measured: 0, inScope: 65 });
    expect(fit.scope.available).toBe(63); // every truck with a profile
    expect(fit.skippedTotal).toBe(2);
    expect(fit.skipped.map((s) => s.truck)).toEqual(["QN noprofile 1", "QN noprofile 2"]);
    expect(new Set(fit.rows.map((r) => r.truckId)).size).toBe(25);
  });

  test("measured: the nearest 25 are priced and a far truck is never priced as if it were near (both ranking bugs)", async () => {
    // Trucks 1..40 have measured empty miles (the map's nearest forty); 41 is far and not measured; the rest have no figure.
    const measured = Object.fromEntries(ids.slice(0, 40).map((id, i) => [id, String(10 + i * 5)]));
    const fit = await fitQuote(ask({ emptyByTruck: measured }), W);
    expect(fit.scope).toMatchObject({ ranked: "distance", measured: 40, priced: 25, limit: 25 });
    const pricedTrucks = new Set(fit.rows.map((r) => r.truckId));
    expect(pricedTrucks.size).toBe(25);
    for (const id of ids.slice(0, 25)) expect(pricedTrucks.has(id)).toBe(true); // exactly the nearest 25
    for (const id of ids.slice(25)) expect(pricedTrucks.has(id)).toBe(false); // the 15 measured-but-farther and the unmeasured based ones are left out
    // Each row carries its own empty miles, not the typed 40.
    expect(fit.rows.find((r) => r.truckId === ids[0])!.emptyToPickup).toBe(10);
    expect(fit.rows.find((r) => r.truckId === ids[24])!.emptyToPickup).toBe(130);
    // Show more is another page of the nearest, and it stops at what is measured (the 3 trucks with no base come after the measured ones).
    const more = await fitQuote(ask({ emptyByTruck: measured }), W, NOW, null, 50);
    expect(more.scope).toMatchObject({ priced: 43, available: 43, limit: 50 });
    expect(new Set(more.rows.map((r) => r.truckId)).size).toBe(43);
  });

  test("the truck a saved quote is on is priced whatever its distance", async () => {
    const measured = Object.fromEntries(ids.slice(0, 40).map((id, i) => [id, String(10 + i * 5)]));
    const far = ids[55]!; // a Memphis truck with no measured miles
    const without = await fitQuote(ask({ emptyByTruck: measured }), W);
    expect(without.rows.some((r) => r.truckId === far)).toBe(false);
    const kept = await fitQuote(ask({ emptyByTruck: measured }), W, NOW, null, 25, [far, "not-a-truck"]);
    expect(kept.rows.some((r) => r.truckId === far)).toBe(true);
    expect(kept.scope.priced).toBe(26);
  });

  test("the best margin among the nearest comes first, not the nearest of the best", async () => {
    const measured = Object.fromEntries(ids.slice(0, 40).map((id, i) => [id, String(10 + i * 5)]));
    const fit = await fitQuote(ask({ emptyByTruck: measured }), W);
    const margins = fit.rows.filter((r) => !r.blocked).map((r) => r.marginPerMile ?? -Infinity);
    expect(margins).toEqual([...margins].sort((a, b) => b - a));
    // The nearest truck clears the most per mile here (everything else equal, fewer empty miles), so it leads.
    expect(fit.rows[0]!.truckId).toBe(ids[0]);
  });

  test("the terminals in view price their own trucks only", async () => {
    const fit = await fitQuote(ask(), W, NOW, ["Memphis"]);
    expect(fit.scope.inScope).toBe(30);
    expect(fit.rows.every((r) => r.terminal === "Memphis")).toBe(true);
  });

  test("chips: a longer trailer takes a shorter load, a shorter one does not, a truck with no trailer is unknown; every row carries its base, terminal and availability", async () => {
    const measured = Object.fromEntries(ids.slice(0, 5).map((id, i) => [id, String(10 + i)]));
    const need48 = await fitQuote(ask({ emptyByTruck: measured, trailer: "dry_van", lengthFt: "48" }), W);
    const row = (fit: Awaited<ReturnType<typeof fitQuote>>, i: number) => fit.rows.find((r) => r.truckId === ids[i])!;
    expect(row(need48, 0).trailerFits).toBe(true); // 53 ft takes a 48 ft load
    expect(row(need48, 1).trailerFits).toBe(false); // 40 ft does not
    expect(row(need48, 2).trailerFits).toBeNull(); // a tractor with no trailer hooked: cannot be told
    const need53 = await fitQuote(ask({ emptyByTruck: measured, trailer: "dry_van", lengthFt: "53" }), W);
    expect(row(need53, 0).trailerFits).toBe(true);
    expect(row(need53, 1).trailerFits).toBe(false);
    const r0 = row(need48, 0);
    expect(r0).toMatchObject({ terminal: "Dallas", available: true, onShift: null });
    expect(r0.homeBase).toBeNull();
  });
});
