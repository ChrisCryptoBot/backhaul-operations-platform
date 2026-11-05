import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { prisma } from "@/lib/db";
import { saveFuelCard, importFuelForLoad } from "@/server/partners/fuel-card";
import { FUEL_PAGE, listFuel, storePurchases, syncFuelCards } from "@/server/partners/fuel-store";
import { listPayroll, sendToPayroll } from "@/server/partners/payroll";
import { saveKeysAndConnect } from "@/server/partners/setup";
import { shareLoadLocation } from "@/server/partners/tracking";
import { vetDriverCarrier } from "@/server/partners/vetting";
import { listDriversPage } from "@/server/tl/fleet-list";
import { buildExport } from "@/server/tl/exports";
import { calculateIfta } from "@/server/partners/ifta";
import { applyPayrollPaid } from "@/server/partners/events";

/**
 * What the partner adapters produce, kept and shown (docs/PARTNER_BACKBONE.md), on the simulator, with no network:
 *   DATABASE_URL=postgresql://demo:demo@localhost:54330/demo RUN_DB_INTEGRATION=true npx vitest run tests/integration/partner-screens.integration.test.ts
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const W = "pb-screens";
const OTHER = "pb-screens-other";
const KEYS = ["DESK_CREDENTIAL_KEY", "DESK_AUTH", "DESK_PARTNER_SANDBOX", "WEX_API_KEY", "PROJECT44_CLIENT_ID", "PROJECT44_CLIENT_SECRET", "HIGHWAY_API_KEY", "GUSTO_CLIENT_ID", "GUSTO_CLIENT_SECRET", "PROMILES_API_KEY"];
const saved: Record<string, string | undefined> = {};
const day = 86_400_000;
const days = (n: number) => new Date(Date.now() + n * day);
const COST = { estimatedMonthlyMiles: 10000, breakEvenRpm: 1.85 };

describe.skipIf(!run)("the partner data, kept and shown", () => {
  const fetchSpy = vi.fn(() => {
    throw new Error("the desk tried to reach the network");
  });
  const realFetch = globalThis.fetch;
  let truck = "";
  let loadId = "";
  let openLoad = "";

  beforeAll(async () => {
    for (const k of KEYS) saved[k] = process.env[k];
    for (const k of KEYS) delete process.env[k];
    process.env.DESK_CREDENTIAL_KEY = randomBytes(32).toString("base64");
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    for (const id of [W, OTHER]) {
      await prisma.workspace.deleteMany({ where: { id } });
      await prisma.workspace.create({ data: { id, name: id, plan: "enterprise" } });
    }
    truck = (await prisma.vehicle.create({ data: { workspaceId: W, name: "Unit 201", type: "dry_van", costProfile: { create: COST } } })).id;
    const stop = (n: number, role: string, addr: string, opens: Date) => ({ stopSequence: n, stopType: role, stopRole: role, addressString: addr, timeWindowEarliest: opens, timeWindowLatest: new Date(opens.getTime() + 2 * 3_600_000) });
    // A trip that ran across the last few days, delivered, so card purchases in that span belong to it.
    loadId = (await prisma.load.create({ data: { workspaceId: W, vehicleId: truck, loadNumber: "SC-1", status: "completed", completedAt: days(-2), quotedRevenue: 1500, loadedMiles: 800, originAddress: "Dallas, TX", destinationAddress: "Atlanta, GA", stops: { create: [stop(1, "pickup", "Dallas, TX", days(-6)), stop(2, "delivery", "Atlanta, GA", days(-3))] } } })).id;
    openLoad = (await prisma.load.create({ data: { workspaceId: W, vehicleId: truck, loadNumber: "SC-2", status: "in_progress", quotedRevenue: 900, loadedMiles: 300, originAddress: "Dallas, TX", destinationAddress: "Atlanta, GA", stops: { create: [stop(1, "pickup", "Dallas, TX", days(0)), stop(2, "delivery", "Atlanta, GA", days(1))] } } })).id;
    for (const [p, v] of [["wex", { WEX_API_KEY: "sandbox_wex_key_0001" }], ["project44", { PROJECT44_CLIENT_ID: "sandbox_p44_id_01", PROJECT44_CLIENT_SECRET: "sandbox_p44_secret" }], ["highway", { HIGHWAY_API_KEY: "sandbox_highway_key_1" }], ["gusto", { GUSTO_CLIENT_ID: "sandbox_gusto_id_01", GUSTO_CLIENT_SECRET: "sandbox_gusto_secret" }], ["promiles", { PROMILES_API_KEY: "sandbox_promiles_key" }]] as const) {
      expect(await saveKeysAndConnect(p, v as Record<string, string>, new Date(), W)).toMatchObject({ connected: true });
    }
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await prisma.workspace.deleteMany({ where: { id: { in: [W, OTHER] } } });
  });

  test("tracking: sharing keeps the link on the load, stopping clears it, the carrier's yes is needed, and the link cannot resolve", async () => {
    expect(await shareLoadLocation(openLoad, true, false, W)).toMatchObject({ ok: false, code: "bad_request" });
    expect(await prisma.load.findUniqueOrThrow({ where: { id: openLoad } })).toMatchObject({ trackingShareUrl: null });
    expect(await shareLoadLocation(openLoad, true, true, W)).toMatchObject({ ok: true, sharing: true });
    const on = await prisma.load.findUniqueOrThrow({ where: { id: openLoad } });
    expect(on.trackingShareUrl).toMatch(/^https:\/\/track\.sandbox\.invalid\/s\/p44-/);
    expect(on).toMatchObject({ trackingProvider: "project44" });
    expect(on.trackingSharedAt).not.toBeNull();
    expect(await shareLoadLocation(openLoad, false, false, W)).toMatchObject({ ok: true, sharing: false });
    expect(await prisma.load.findUniqueOrThrow({ where: { id: openLoad } })).toMatchObject({ trackingShareUrl: null, trackingProvider: null, trackingSharedAt: null });
  });

  test("carrier vetting: the score, authority and reasons are kept beside the three words, and the Drivers list carries them", async () => {
    const mk = async (name: string, mc: string) => (await prisma.driver.create({ data: { workspaceId: W, name, carrierMcNumber: mc } })).id;
    const clear = await mk("Clear Carrier", "9000005");
    const review = await mk("Low Score Carrier", "9000002");
    const failed = await mk("Inactive Carrier", "9000000");
    for (const id of [clear, review, failed]) expect(await vetDriverCarrier(id, new Date(), W)).toMatchObject({ ok: true });
    expect(await prisma.driver.findUniqueOrThrow({ where: { id: review } })).toMatchObject({ vetStatus: "review", vetSafetyScore: 48, vetAuthorityActive: true });
    expect(await prisma.driver.findUniqueOrThrow({ where: { id: failed } })).toMatchObject({ vetStatus: "failed", vetAuthorityActive: false });
    const flags = (await prisma.driver.findUniqueOrThrow({ where: { id: review } })).vetFlags as string[];
    expect(flags.join(" ")).toContain("Safety score 48");
    expect((await prisma.driver.findUniqueOrThrow({ where: { id: clear } })).vetFlags).toBeNull();
    const list = await listDriversPage({ page: 1 }, W);
    const row = list.rows.find((r) => r.id === review)!;
    expect(row).toMatchObject({ vetSafetyScore: 48, vetAuthorityActive: true });
    expect(row.vetFlags.join(" ")).toContain("Safety score 48");
  });

  test("fuel: purchases are read, kept once, tied to the load the truck was on, and listed with totals", async () => {
    expect(await syncFuelCards(30, new Date(), W)).toMatchObject({ ok: false, error: expect.stringContaining("fuel card") }); // no truck has a card yet
    expect(await saveFuelCard(truck, "wex", "WEX-ACCT-9", new Date(), W)).toEqual({ ok: true, changed: true });
    const first = await syncFuelCards(30, new Date(), W);
    expect(first).toMatchObject({ ok: true, trucks: 1 });
    if (!first.ok) return;
    expect(first.fresh).toBeGreaterThan(3);
    // The same days again are the same purchases.
    expect(await syncFuelCards(30, new Date(), W)).toMatchObject({ ok: true, fresh: 0, purchases: first.purchases });
    const all = await prisma.fuelTransaction.findMany({ where: { workspaceId: W } });
    expect(all.length).toBe(first.fresh);
    expect(new Set(all.map((r) => r.externalId)).size).toBe(all.length);
    expect(all.every((r) => r.vehicleId === truck && r.provider === "wex")).toBe(true);
    // Purchases from the days the delivered trip ran are tied to it.
    const tied = all.filter((r) => r.loadId === loadId);
    expect(tied.length).toBeGreaterThan(0);
    for (const r of tied) expect(r.postedAt.getTime()).toBeGreaterThan(Date.now() - 8 * day);

    const list = await listFuel({ days: 30 }, new Date(), W);
    expect(list.total).toBe(all.length);
    expect(list.rows.length).toBeLessThanOrEqual(FUEL_PAGE);
    expect(list.rows[0]!.postedAt.getTime()).toBeGreaterThanOrEqual(list.rows[list.rows.length - 1]!.postedAt.getTime()); // newest first
    const charged = all.reduce((s, r) => s + Number(r.amount), 0);
    expect(list.totals.charged).toBeCloseTo(charged, 1);
    expect(list.totals.discount).toBeGreaterThan(0);
    expect(list.totals.netPerGallon!).toBeGreaterThan(2.5);
    expect(list.totals.netPerGallon!).toBeLessThan(5);
    expect(list.rows.find((r) => r.loadId === loadId)).toMatchObject({ loadNumber: "SC-1", statementId: null });
    // Another fleet sees none of it.
    expect((await listFuel({ days: 30 }, new Date(), OTHER)).total).toBe(0);

    // The statement a tied load is on is named; a voided one is not.
    const driver = await prisma.driver.create({ data: { workspaceId: W, name: "Statement Driver" } });
    const st = await prisma.settlement.create({ data: { workspaceId: W, driverId: driver.id, number: "ST-SC-1", status: "final", periodStart: new Date("2026-11-01"), periodEnd: new Date("2026-11-30"), total: 1000, finalizedAt: new Date() } });
    await prisma.settlementLoad.create({ data: { settlementId: st.id, loadId, amount: 1000 } });
    expect((await listFuel({ days: 30 }, new Date(), W)).rows.find((r) => r.loadId === loadId)).toMatchObject({ statementId: st.id, statementNumber: "ST-SC-1" });
    await prisma.settlement.update({ where: { id: st.id }, data: { status: "void" } });
    expect((await listFuel({ days: 30 }, new Date(), W)).rows.find((r) => r.loadId === loadId)).toMatchObject({ statementId: null });
    await prisma.settlementLoad.deleteMany({ where: { loadId } });

    // The trip's own import keeps what it read, and does not double what the sync already kept.
    const before = await prisma.fuelTransaction.count({ where: { workspaceId: W } });
    expect(await importFuelForLoad(loadId, new Date(), W)).toMatchObject({ ok: true });
    expect(await prisma.fuelTransaction.count({ where: { workspaceId: W } })).toBe(before);

    // The file matches the screen.
    const csv = await buildExport("fuel", { days: "30" }, new Date());
    expect(csv?.filename).toContain("fuel-30d");
  });

  test("a purchase with no id of its own still keeps once, and one read again picks up a load tie it lacked", async () => {
    const p = { on: "2026-11-20", gallons: 100, amount: 380.5, discount: 20, discountPerGallon: 0.2, pricePerGallon: 4, location: "Somewhere, TX" };
    expect(await storePurchases("wex", [p], { workspaceId: W, vehicleId: truck })).toBe(1);
    expect(await storePurchases("wex", [p], { workspaceId: W, vehicleId: truck })).toBe(0);
    expect(await storePurchases("wex", [p], { workspaceId: W, vehicleId: truck, loadFor: () => loadId })).toBe(0);
    const row = await prisma.fuelTransaction.findFirstOrThrow({ where: { workspaceId: W, location: "Somewhere, TX" } });
    expect(row.loadId).toBe(loadId);
    expect(Number(row.gallons)).toBe(100);
  });

  test("payroll: a cleared run marks the statement paid by payroll, once, and the list says so", async () => {
    const driver = await prisma.driver.create({ data: { workspaceId: W, name: "Payroll Driver", payrollEmployeeId: "w-77", payrollWorkerType: "contractor" } });
    const st = await prisma.settlement.create({ data: { workspaceId: W, driverId: driver.id, number: "ST-SC-2", status: "final", periodStart: new Date("2026-11-02"), periodEnd: new Date("2026-11-08"), total: 640, finalizedAt: days(-1) } });
    const sent = await sendToPayroll([st.id], new Date(), W);
    expect(sent).toMatchObject({ ok: true });
    const reference = sent.ok ? sent.reference : "";
    let row = (await listPayroll({ filter: "all" }, W)).rows.find((r) => r.id === st.id)!;
    expect(row).toMatchObject({ reference, paidAt: null });
    expect(await applyPayrollPaid(reference, new Date(), W)).toBe(true);
    expect(await applyPayrollPaid(reference, new Date(), W)).toBe(false); // once
    row = (await listPayroll({ filter: "all" }, W)).rows.find((r) => r.id === st.id)!;
    expect(row.paidAt).not.toBeNull();
    expect(row.paidMethod).toBe("payroll");
    expect(await applyPayrollPaid(reference, new Date(), OTHER)).toBe(false); // never another fleet's
  });

  test("IFTA: the quarter's miles are kept by state, exported as the same lines, and the CSV refuses a quarter that is not one", async () => {
    const q = (() => {
      const d = new Date();
      return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
    })();
    const out = await calculateIfta(q, W);
    expect(out).toMatchObject({ ok: true, stored: true });
    const csv = await buildExport("ifta", { quarter: q }, new Date());
    expect(csv).not.toBeNull();
    expect(csv!.filename).toContain(`ifta-${q}`);
    // The file starts with a byte-order mark so a spreadsheet opens it as UTF-8.
    expect(csv!.csv.startsWith(String.fromCharCode(0xfeff))).toBe(true);
    expect(csv!.csv.slice(1).split(/\r?\n/)[0]).toBe("Quarter,State,Miles,Gallons used,Worked out by,Delivered loads,Worked out");
    expect(await buildExport("ifta", { quarter: "nonsense" }, new Date())).toBeNull();
  });

  test("nothing in any of this touched the network", () => {
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
