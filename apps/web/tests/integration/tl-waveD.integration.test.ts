import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { prisma } from "@/lib/db";
import { LOAD_LIMITS } from "@/lib/load-limits";
import { toEditValues, validateLoadEdit, type LoadEditValues } from "@/lib/load-edit";
import { BLANK_QUOTE, validateQuote, type QuoteValues } from "@/lib/quote";

/**
 * Part D of the audit plan (the Quote, Edit details, trip rules), on the demo database in a workspace of its own: one set of limits for a load's size, a truck on one load at a
 * time, the same load number from the same customer is the same load, lane history by city AND state, a stale form that cannot overwrite, what an invoice carries that stays put,
 * a thrown-away quote that is on the record, and the same booking made twice that is made once.
 */
const W = "partd";
vi.mock("@/server/tl/workspace", async (original) => {
  const real = await original<typeof import("@/server/tl/workspace")>();
  const { prisma: db } = await import("@/lib/db");
  return { ...real, currentWorkspaceId: () => "partd", currentWorkspace: () => db.workspace.findUniqueOrThrow({ where: { id: "partd" } }) };
});

const run = process.env.RUN_DB_INTEGRATION === "true";
const profile: Record<string, string> = { monthlyInsurance: "800", monthlyAuthority: "100", monthlyPhoneSubscriptions: "60", monthlyLoanPayment: "0", estimatedMonthlyMiles: "7000", maintenanceReservePerMile: "0.15", tireReservePerMile: "0.04", lastFuelPricePerGallon: "3.9", driverHourlyTarget: "25", archetype: "solo_owner" };
const quote = (day: string, over: Partial<QuoteValues> = {}): QuoteValues => ({
  ...BLANK_QUOTE,
  stops: [
    { role: "pickup", address: "Dallas, TX", appointment: `${day}T08:00` },
    { role: "delivery", address: "Tulsa, OK", appointment: `${day}T17:00` }
  ],
  broker: "D Broker",
  offer: "1500",
  loadedMiles: "260",
  emptyToPickup: "40",
  emptyHome: "240",
  marketRate: "1500",
  ...over
});

describe.skipIf(!run)("Part D: the Quote, editing a load, and what must stay put", () => {
  let truck1 = "";
  let truck2 = "";
  const events = (loadId: string) => prisma.auditEvent.findMany({ where: { loadId }, orderBy: { createdAt: "asc" } });

  beforeAll(async () => {
    await prisma.workspace.deleteMany({ where: { id: W } });
    await prisma.workspace.create({ data: { id: W, name: "Part D desk", plan: "enterprise" } });
    const { saveTruck, saveCostProfile } = await import("@/server/tl/fleet");
    for (const [name, set] of [["D Truck 1", (id: string) => (truck1 = id)], ["D Truck 2", (id: string) => (truck2 = id)]] as const) {
      const t = await saveTruck({ name, type: "box_truck", mpg: "10", fuelType: "diesel" }, null);
      if (!t.ok) throw new Error("truck");
      set(t.id);
      const p = await saveCostProfile(t.id, profile);
      if (!p.ok) throw new Error("profile");
    }
  });
  afterAll(() => prisma.workspace.deleteMany({ where: { id: W } }));

  test("a load's weight and size have one set of limits, on the Quote and on Edit details", () => {
    expect(LOAD_LIMITS).toEqual({ weightLbs: 200000, lengthFt: 120, widthFt: 30, heightIn: 300 });
    // 150,000 lb passes the Quote, so it must pass Edit: a load booked from a quote can be corrected
    expect(validateQuote({ ...quote("2027-05-03"), weightLbs: "150000" })).toMatchObject({ ok: true });
    expect(validateQuote({ ...quote("2027-05-03"), weightLbs: "200001" })).toMatchObject({ ok: false });
    const base: LoadEditValues = { brokerName: "x", brokerMc: "", brokerPhone: "", brokerEmail: "", loadNumber: "", poNumber: "", trailer: "", weightLbs: "150000", lengthFt: "110", widthFt: "25", heightIn: "250", hazmat: "", liftgate: false, ramp: false, palletJack: false, payTermsDays: "", notes: "", stops: [] };
    const out = validateLoadEdit({ ...base, stops: [] });
    if (!out.ok) expect(Object.keys(out.errors)).not.toEqual(expect.arrayContaining(["weightLbs", "lengthFt", "widthFt", "heightIn"]));
    const over = validateLoadEdit({ ...base, weightLbs: "200001", stops: [] });
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.errors.weightLbs).toBeDefined();
  });

  test("a truck is on one load at a time; booking it again at that time is refused with the other load named, and another truck takes it", async () => {
    const { bookQuote } = await import("@/server/tl/quote");
    const first = await bookQuote(quote("2027-05-10", { loadNumber: "D-100" }), { vehicleId: truck1, driverId: null }, null, null, W);
    if (!first.ok) throw new Error(JSON.stringify(first));
    const clash = await bookQuote(quote("2027-05-10", { loadNumber: "D-101", broker: "Other Broker" }), { vehicleId: truck1, driverId: null }, null, null, W);
    expect(clash).toMatchObject({ ok: false, error: expect.stringContaining("D Truck 1 is already on D-100") });
    expect(await bookQuote(quote("2027-05-10", { loadNumber: "D-101", broker: "Other Broker" }), { vehicleId: truck2, driverId: null }, null, null, W)).toMatchObject({ ok: true });
    expect(await bookQuote(quote("2027-05-11", { loadNumber: "D-102" }), { vehicleId: truck1, driverId: null }, null, null, W)).toMatchObject({ ok: true }); // the next day is free
  });

  test("a load number typed on a quote that is already on the desk from that customer is refused; another customer's, or another number, is not", async () => {
    const { bookQuote } = await import("@/server/tl/quote");
    const dup = await bookQuote(quote("2027-05-20", { loadNumber: "d-100" }), { vehicleId: truck2, driverId: null }, null, null, W);
    expect(dup).toMatchObject({ ok: false, error: expect.stringContaining("already on the desk") });
    // the same number from a different, named customer is a different load
    expect(await bookQuote(quote("2027-05-20", { loadNumber: "D-100", broker: "A Different Customer" }), { vehicleId: truck2, driverId: null }, null, null, W)).toMatchObject({ ok: true });
  });

  test("the same booking made twice in a moment is one load", async () => {
    const { bookQuote } = await import("@/server/tl/quote");
    const a = await bookQuote(quote("2027-06-01", { broker: "Twice Co" }), { vehicleId: truck2, driverId: null }, null, null, W);
    const b = await bookQuote(quote("2027-06-01", { broker: "Twice Co" }), { vehicleId: truck2, driverId: null }, null, null, W);
    if (!a.ok || !b.ok) throw new Error(JSON.stringify([a, b]));
    expect(b.loadId).toBe(a.loadId);
    expect(b.note).toContain("a moment ago");
    expect(await prisma.load.count({ where: { workspaceId: W, brokerName: "Twice Co" } })).toBe(1);
  });

  test("two quotes saved in the same second do not share a number", async () => {
    const { saveQuote } = await import("@/server/tl/quote");
    const now = new Date();
    const nums = new Set<string | null>();
    for (let i = 0; i < 12; i++) {
      const out = await saveQuote(quote("2027-06-10"), null, null, W, now);
      if (!out.ok) throw new Error("save");
      nums.add((await prisma.load.findUniqueOrThrow({ where: { id: out.id } })).loadNumber);
    }
    expect(nums.size).toBe(12);
    for (const n of nums) expect(n).toMatch(/^QT-[0-9A-Z]+$/);
  });

  test("lane history is by city AND state (Springfield IL is not Springfield MO), averaged over a longer run than the five it lists", async () => {
    const { quoteContext } = await import("@/server/tl/quote");
    const done = (n: number, origin: string, extra: Record<string, unknown> = {}) =>
      prisma.load.create({ data: { workspaceId: W, loadNumber: `LANE-${n}`, status: "completed", completedAt: new Date(Date.UTC(2027, 0, n)), brokerName: "Lane Co", originAddress: origin, destinationAddress: "Tulsa, OK", quotedRevenue: 1000 + n, loadedMiles: 100, ...extra } });
    for (let i = 1; i <= 8; i++) await done(i, "Springfield, IL");
    await done(9, "Springfield, MO", { quotedRevenue: 5000 }); // a different lane: $50 a mile, which must not enter the Illinois average
    const il = await quoteContext(readQuoteFor("Springfield, IL", "Tulsa, OK"), W);
    expect(il.lane).toMatchObject({ count: 8, from: "Springfield, IL" });
    expect(il.lane!.recent).toHaveLength(5);
    expect(il.lane!.averagePerMile!).toBeGreaterThan(10);
    expect(il.lane!.averagePerMile!).toBeLessThan(11); // the eight Illinois loads, not the Missouri one
    const mo = await quoteContext(readQuoteFor("Springfield, MO", "Tulsa, OK"), W);
    expect(mo.lane).toMatchObject({ count: 1 });
    expect(mo.lane!.averagePerMile).toBeCloseTo(50, 0);
  });

  test("a thrown-away quote is on the record", async () => {
    const { saveQuote, discardQuote } = await import("@/server/tl/quote");
    const saved = await saveQuote(quote("2027-07-01", { broker: "Discard Co" }), null, null, W);
    if (!saved.ok) throw new Error("save");
    expect(await discardQuote(saved.id, W)).toBe(true);
    expect(await discardQuote(saved.id, W)).toBe(false);
    const log = await prisma.auditEvent.findFirstOrThrow({ where: { workspaceId: W, action: "quote_discarded" } });
    expect(log.summary).toContain("Discard Co");
  });

  test("a rate confirmation with no miles, or a truck-ordered-not-used notice, is not saved as a load", async () => {
    const { saveReviewedDraft } = await import("@/server/ratecon/save");
    const { extractionToLoadDraft } = await import("@/server/ratecon/map");
    const draft = extractionToLoadDraft({ loadNumber: "RC-D-1", brokerName: "D Broker", rate: 900, stops: [{ role: "pickup", address: "Dallas, TX", date: "2027-08-01", time: "08:00" }, { role: "delivery", address: "Tulsa, OK", date: "2027-08-02", time: "09:00" }] } as never, undefined);
    if (!draft) throw new Error("no draft");
    const base = { ...draft, confirmed: true, load: { ...draft.load, quotedRevenue: 900, loadNumber: "D-RC-1", loadedMiles: 250 } };
    await expect(saveReviewedDraft({ ...base, load: { ...base.load, loadedMiles: 0 } })).rejects.toThrow(/loaded miles/);
    await expect(saveReviewedDraft({ ...base, printed: { ...base.printed, tonuOnly: true } })).rejects.toThrow(/not a load|truck-ordered-not-used/);
    expect(await prisma.load.count({ where: { workspaceId: W, loadNumber: "D-RC-1" } })).toBe(0);
    expect((await saveReviewedDraft(base)).loadNumber).toBe("D-RC-1");
  });

  // ── Edit details ──────────────────────────────────────────────────────────────────────────────

  const valuesOf = async (id: string) => toEditValues(await prisma.load.findUniqueOrThrow({ where: { id }, include: { stops: { orderBy: { stopSequence: "asc" } } } }));
  const mk = (n: string, over: Record<string, unknown> = {}, day = 12) =>
    prisma.load.create({
      data: {
        workspaceId: W, loadNumber: n, status: "draft", brokerName: "Edit Co", brokerEmail: "ap@edit.example", quotedRevenue: 1000, loadedMiles: 200, originAddress: "Dallas, TX", destinationAddress: "Tulsa, OK", vehicleId: truck1,
        stops: { create: [{ stopSequence: 1, stopType: "pickup", stopRole: "pickup", addressString: "Dallas, TX", timeWindowEarliest: new Date(Date.UTC(2027, 8, day, 14)), timeWindowLatest: new Date(Date.UTC(2027, 8, day, 15)) }, { stopSequence: 2, stopType: "delivery", stopRole: "delivery", addressString: "Tulsa, OK", timeWindowEarliest: new Date(Date.UTC(2027, 8, day, 22)), timeWindowLatest: new Date(Date.UTC(2027, 8, day, 23)) }] },
        ...over
      }
    });

  test("a form opened on one version of a load cannot overwrite a change made since", async () => {
    const { saveLoadDetails } = await import("@/server/tl/edit");
    const l = await mk("E-1");
    const mine = await valuesOf(l.id);
    expect(mine.version).toBeDefined();
    // someone else changes the load after this form was opened
    await prisma.load.update({ where: { id: l.id }, data: { notes: "Changed by someone else" } });
    expect(await saveLoadDetails(l.id, { ...mine, notes: "My note" }, new Date(), W)).toMatchObject({ ok: false, error: expect.stringContaining("changed since you opened it") });
    expect((await prisma.load.findUniqueOrThrow({ where: { id: l.id } })).notes).toBe("Changed by someone else");
    // opened again, it saves
    expect(await saveLoadDetails(l.id, { ...(await valuesOf(l.id)), notes: "My note" }, new Date(), W)).toMatchObject({ ok: true, changed: true });
    // a form with no version (older callers) is not refused
    const { version: _v, ...bare } = await valuesOf(l.id);
    void _v;
    expect(await saveLoadDetails(l.id, { ...bare, notes: "No version" }, new Date(), W)).toMatchObject({ ok: true });
  });

  test("what an invoice carries (number, customer, PO, terms) stays as billed; another number from the same customer is refused as a twin", async () => {
    const { saveLoadDetails } = await import("@/server/tl/edit");
    const billed = await mk("E-2", { status: "completed", completedAt: new Date(), paymentStatus: "invoiced", invoiceNumber: "E-INV-2", invoicedAmount: 1000, invoicedAt: new Date(), payTermsDays: 30, poNumber: "PO-2" }, 14);
    const v = await valuesOf(billed.id);
    for (const [patch, word] of [[{ loadNumber: "E-2X" }, "load number"], [{ brokerName: "Someone Else" }, "customer"], [{ poNumber: "PO-9" }, "PO number"], [{ payTermsDays: "45" }, "pay terms"]] as const) {
      expect(await saveLoadDetails(billed.id, { ...v, ...patch }, new Date(), W), word).toMatchObject({ ok: false, error: expect.stringContaining(word) });
    }
    expect(await saveLoadDetails(billed.id, { ...v, notes: "Dock 4" }, new Date(), W)).toMatchObject({ ok: true });

    const other = await mk("E-3", {}, 16);
    expect(await saveLoadDetails(other.id, { ...(await valuesOf(other.id)), loadNumber: "e-1" }, new Date(), W)).toMatchObject({ ok: false, errors: { loadNumber: expect.stringContaining("already on the desk") } });
  });

  test("moving a load to another truck checks that the truck can carry it and is free at that time", async () => {
    const { saveLoadDetails } = await import("@/server/tl/edit");
    // truck 2 is on a load that day
    await mk("E-4", { vehicleId: truck2 }, 18);
    const l = await mk("E-5", {}, 18); // on truck 1, the same day
    const v = await valuesOf(l.id);
    expect(await saveLoadDetails(l.id, { ...v, deal: { ...v.deal!, vehicleId: truck2 } }, new Date(), W)).toMatchObject({ ok: false, error: expect.stringContaining("D Truck 2 is already on E-4") });
    // a load too heavy for the truck cannot be moved onto it either
    await prisma.vehicle.update({ where: { id: truck2 }, data: { payloadLbs: 5000 } });
    const heavy = await mk("E-6", { weightLbs: 20000 }, 20);
    const hv = await valuesOf(heavy.id);
    expect(await saveLoadDetails(heavy.id, { ...hv, deal: { ...hv.deal!, vehicleId: truck2 } }, new Date(), W)).toMatchObject({ ok: false, error: expect.stringContaining("cannot take this load") });
    // a free truck, able to carry it, takes it
    const free = await mk("E-7", {}, 22);
    const fv = await valuesOf(free.id);
    expect(await saveLoadDetails(free.id, { ...fv, deal: { ...fv.deal!, vehicleId: truck2 } }, new Date(), W)).toMatchObject({ ok: true, changed: true });
    expect((await prisma.load.findUniqueOrThrow({ where: { id: free.id } })).vehicleId).toBe(truck2);
    expect((await events(free.id)).some((e) => e.action === "load_edited")).toBe(true);
  });
});

/** The pieces of a quote the lane history reads: the first and last stop. */
function readQuoteFor(from: string, to: string) {
  const v = quote("2027-07-02");
  v.stops = [
    { role: "pickup", address: from, appointment: "2027-07-02T08:00" },
    { role: "delivery", address: to, appointment: "2027-07-02T17:00" }
  ];
  const c = validateQuote(v);
  if (!c.ok) throw new Error(JSON.stringify(c.errors));
  return c.input;
}
