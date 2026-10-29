import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { BLANK_QUOTE, readQuote, type QuoteValues } from "@/lib/quote";
import { gapsPhrase } from "@/lib/send-readiness";
import { dispatchLoad } from "@/server/tl/dispatch";
import { buildExport } from "@/server/tl/exports";
import { saveCostProfile, saveDriver, saveTruck } from "@/server/tl/fleet";
import { getLoadDetail, listBoardRows } from "@/server/tl/queries";
import { bookQuote, fitQuote, getQuote, getQuoteLike, listQuotes, passQuote, saveQuote } from "@/server/tl/quote";
import { loadSendGaps } from "@/server/tl/readiness";

/**
 * Needs a seeded database (see tl-dispatch.integration.test.ts). Makes its own trucks, driver and quotes (all named WC1) and removes them and
 * their audit events afterwards, so the demo data is left as the seed wrote it.
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const WS = "demo-workspace";

const profile: Record<string, string> = {
  monthlyInsurance: "800",
  monthlyAuthority: "100",
  monthlyPhoneSubscriptions: "60",
  monthlyLoanPayment: "0",
  estimatedMonthlyMiles: "7000",
  maintenanceReservePerMile: "0.15",
  tireReservePerMile: "0.04",
  lastFuelPricePerGallon: "3.9",
  driverHourlyTarget: "25",
  archetype: "solo_owner"
};

describe.skipIf(!run)("wave C1: what a truck can carry, passing on a quote, quoting like a load, send readiness, the Loads file", () => {
  const startedAt = new Date();
  let smallId = "";
  let bigId = "";
  let driverId = "";

  const quote = (over: Partial<QuoteValues> = {}, day = "2027-03-09"): QuoteValues => ({
    ...BLANK_QUOTE,
    stops: [
      { role: "pickup", address: "Dallas, TX", appointment: `${day}T08:00` },
      { role: "delivery", address: "Tulsa, OK", appointment: `${day}T17:00` }
    ],
    broker: "WC1 Broker",
    offer: "1500",
    loadedMiles: "260",
    emptyToPickup: "40",
    emptyHome: "240",
    marketRate: "1500",
    ...over
  });
  const input = (v: QuoteValues) => {
    const r = readQuote(v);
    if (!r) throw new Error("not priceable");
    return r;
  };
  const mine = (rows: Awaited<ReturnType<typeof fitQuote>>["rows"], id: string) => rows.filter((r) => r.truckId === id);

  beforeAll(async () => {
    // A small truck (5,000 lb, 12 ft, no liftgate) and a big one (20,000 lb, 26 ft, with a liftgate).
    const small = await saveTruck({ name: "WC1 Small", type: "box_truck", mpg: "10", fuelType: "diesel", payloadLbs: "5000", maxLengthFt: "12", maxWidthFt: "6", maxHeightIn: "70" }, null);
    if (!small.ok) throw new Error("small truck");
    smallId = small.id;
    const big = await saveTruck({ name: "WC1 Big", type: "box_truck", mpg: "10", fuelType: "diesel", payloadLbs: "20000", maxLengthFt: "26", maxWidthFt: "8", maxHeightIn: "96", hasLiftgate: "yes", hasPalletJack: "yes" }, null);
    if (!big.ok) throw new Error("big truck");
    bigId = big.id;
    for (const id of [smallId, bigId]) {
      const p = await saveCostProfile(id, profile);
      if (!p.ok) throw new Error(`profile ${JSON.stringify(p)}`);
    }
    const d = await saveDriver({ name: "WC1 Driver", cdlClass: "A", cdlExpiry: "2031-01-31", medicalCardExpiry: "2031-01-31", assignedVehicleId: bigId, payKind: "cpm", payRate: "0.60" }, null);
    if (!d.ok) throw new Error("driver");
    driverId = d.id;
  });

  afterAll(async () => {
    const loads = await prisma.load.findMany({ where: { workspaceId: WS, brokerName: "WC1 Broker" }, select: { id: true } });
    const ids = loads.map((l) => l.id);
    await prisma.auditEvent.deleteMany({ where: { OR: [{ loadId: { in: ids } }, { createdAt: { gte: startedAt }, entity: { in: ["fleet", "load"] } }] } });
    await prisma.load.deleteMany({ where: { id: { in: ids } } });
    await prisma.driver.deleteMany({ where: { workspaceId: WS, name: { startsWith: "WC1" } } });
    await prisma.vehicle.deleteMany({ where: { workspaceId: WS, name: { startsWith: "WC1" } } });
  });

  test("a truck says what it carries, and the change is audited", async () => {
    const row = await prisma.vehicle.findUniqueOrThrow({ where: { id: bigId } });
    expect([row.hasLiftgate, row.hasRamp, row.hasPalletJack]).toEqual([true, false, true]);
    const small = await prisma.vehicle.findUniqueOrThrow({ where: { id: smallId } });
    expect([small.hasLiftgate, small.hasRamp, small.hasPalletJack]).toEqual([false, false, false]);

    const out = await saveTruck({ name: "WC1 Small", type: "box_truck", mpg: "10", fuelType: "diesel", payloadLbs: "5000", maxLengthFt: "12", maxWidthFt: "6", maxHeightIn: "70", hasRamp: "yes" }, smallId);
    expect(out).toMatchObject({ ok: true, changed: true });
    const audit = await prisma.auditEvent.findFirst({ where: { action: "truck_changed", createdAt: { gte: startedAt } }, orderBy: { createdAt: "desc" } });
    expect(audit?.summary).toMatch(/ramp/i);
    // And back, so the next tests see a truck with no equipment.
    await saveTruck({ name: "WC1 Small", type: "box_truck", mpg: "10", fuelType: "diesel", payloadLbs: "5000", maxLengthFt: "12", maxWidthFt: "6", maxHeightIn: "70" }, smallId);
  });

  test("a load nothing is said about prices as before: no truck is blocked, nothing is warned", async () => {
    const fit = await fitQuote(input(quote()));
    for (const r of [...mine(fit.rows, smallId), ...mine(fit.rows, bigId)]) {
      expect(r.blocked).toBeNull();
      expect(r.warnings).toEqual([]);
    }
  });

  test("a load heavier than a truck is rated for blocks that truck, and it sorts last with its reason", async () => {
    const fit = await fitQuote(input(quote({ weightLbs: "9000" })));
    const small = mine(fit.rows, smallId)[0]!;
    const big = mine(fit.rows, bigId)[0]!;
    expect(small.blocked).toMatch(/9000.*5000/);
    expect(small.blocked).not.toMatch(/vehicle/);
    expect(big.blocked).toBeNull();
    const idx = (id: string) => fit.rows.findIndex((r) => r.truckId === id);
    expect(idx(smallId)).toBeGreaterThan(idx(bigId));
    // It still gets a price, so the dispatcher can see what it would have been.
    expect(small.allInPerMile).not.toBeNull();
  });

  test("size blocks too, and oversize freight is a warning on a truck that holds it", async () => {
    const tooLong = await fitQuote(input(quote({ lengthFt: "20" })));
    expect(mine(tooLong.rows, smallId)[0]!.blocked).toMatch(/length/i);
    expect(mine(tooLong.rows, bigId)[0]!.blocked).toBeNull();
    const wide = await fitQuote(input(quote({ widthFt: "7.5" })));
    expect(mine(wide.rows, smallId)[0]!.blocked).toMatch(/width/i);
    // Over the legal width (8.5 ft) needs permits, whichever truck: a warning, not a block, on a truck whose own limit has no number.
    await prisma.vehicle.update({ where: { id: bigId }, data: { maxWidthFt: null } });
    const over = await fitQuote(input(quote({ widthFt: "9" })));
    const big = mine(over.rows, bigId)[0]!;
    expect(big.blocked).toBeNull();
    expect(big.warnings.join(" ")).toMatch(/Oversize freight \(wide\)/);
    await prisma.vehicle.update({ where: { id: bigId }, data: { maxWidthFt: 8 } });
  });

  test("a truck is warned only for equipment it is not marked as carrying", async () => {
    const fit = await fitQuote(input(quote({ requiresLiftgate: true })));
    expect(mine(fit.rows, smallId)[0]!.warnings.join(" ")).toMatch(/liftgate/i);
    expect(mine(fit.rows, smallId)[0]!.blocked).toBeNull();
    expect(mine(fit.rows, bigId)[0]!.warnings).toEqual([]);
  });

  test("booking refuses a truck the load does not fit, and books one that does", async () => {
    const heavy = quote({ weightLbs: "9000" }, "2027-03-10");
    const refused = await bookQuote(heavy, { vehicleId: smallId, driverId: null }, null, null);
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.error).toMatch(/cannot take this load/);
    const booked = await bookQuote(heavy, { vehicleId: bigId, driverId: null }, null, null);
    expect(booked.ok).toBe(true);
    if (!booked.ok) return;
    const l = await prisma.load.findUniqueOrThrow({ where: { id: booked.loadId } });
    expect(l.weightLbs).toBe(9000);
    // And the decision it was booked on shows on the load.
    const detail = await getLoadDetail(booked.loadId);
    expect(detail?.load.decisions[0]?.decisionType).toMatch(/accepted|overridden/);
  });

  test("a saved quote keeps the size, weight and needs, and reopens with them", async () => {
    const values = quote({ weightLbs: "4200", lengthFt: "10", widthFt: "6", heightIn: "60", hazmatClass: "3", requiresPalletJack: true, trailer: "dry_van" }, "2027-03-11");
    const saved = await saveQuote(values, null, null);
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    const back = (await getQuote(saved.id))!.values;
    expect(back).toMatchObject({ weightLbs: "4200", lengthFt: "10", widthFt: "6", heightIn: "60", hazmatClass: "3", requiresPalletJack: true, requiresLiftgate: false, trailer: "dry_van" });
  });

  test("passing on a quote keeps it as passed, with the reason and an audit entry, and it stays off every list of loads", async () => {
    const saved = await saveQuote(quote({}, "2027-03-12"), null, null);
    if (!saved.ok) throw new Error("save");
    expect(await passQuote(saved.id, "Pick one", "")).toEqual({ ok: false, error: "Pick a reason." });
    expect(await passQuote(saved.id, "Other", "x")).toEqual({ ok: false, error: "Say what the reason is when you pick Other." });

    expect(await passQuote(saved.id, "Rate too low", "Broker would not move")).toEqual({ ok: true });
    expect(await passQuote(saved.id, "Rate too low", "")).toEqual({ ok: false, error: "That quote was already passed on." });

    const decision = await prisma.loadDecision.findFirstOrThrow({ where: { loadId: saved.id } });
    expect(decision).toMatchObject({ decisionType: "passed", overrideReason: "Rate too low", overrideNotes: "Broker would not move" });
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { action: "quote_passed", createdAt: { gte: startedAt } }, orderBy: { createdAt: "desc" } });
    expect(audit.loadId).toBeNull(); // a quote has no page to link to
    expect(audit.summary).toMatch(/Passed on a quote: Dallas, TX to Tulsa, OK/);
    expect(audit.reason).toBe("Rate too low: Broker would not move");

    const row = (await listQuotes()).find((q) => q.id === saved.id)!;
    expect(row.passedFor).toBe("Rate too low");
    expect((await listQuotes()).filter((q) => !q.passedFor).every((q) => q.id !== saved.id)).toBe(true);
    expect((await listBoardRows()).some((r) => r.id === saved.id)).toBe(false);
  });

  test("quote like this: a load's lane, broker, size and miles carry over, its numbers and times do not, and nothing is written", async () => {
    const booked = await bookQuote(quote({ loadNumber: "WC1-100", poNumber: "PO-7", weightLbs: "3000", trailer: "dry_van" }, "2027-03-13"), { vehicleId: bigId, driverId: null }, null, null);
    if (!booked.ok) throw new Error("book");
    const before = await prisma.load.count();
    const like = (await getQuoteLike(booked.loadId))!;
    expect(await prisma.load.count()).toBe(before);
    expect(like).toMatchObject({ broker: "WC1 Broker", weightLbs: "3000", trailer: "dry_van", loadedMiles: "260", offer: "1500", loadNumber: "", poNumber: "" });
    expect(like.stops.map((s) => s.address)).toEqual(["Dallas, TX", "Tulsa, OK"]);
    expect(like.stops.every((s) => s.appointment === "")).toBe(true);
    expect(await getQuoteLike("no-such-load")).toBeNull();
  });

  test("a load that lacks what a driver would stop on is flagged before it is sent, and going anyway says what was missing", async () => {
    const booked = await bookQuote(quote({}, "2027-03-14"), { vehicleId: bigId, driverId }, null, null);
    if (!booked.ok) throw new Error("book");
    expect(booked.assigned).toBe(true);
    const gaps = await loadSendGaps(booked.loadId);
    expect(gaps.map((g) => g.key)).toEqual(expect.arrayContaining(["weight", "pickupNumber"]));
    expect(gapsPhrase(gaps)).toMatch(/weight/);

    const missing = gapsPhrase(gaps);
    await dispatchLoad(booked.loadId, new Date(), { sentWithout: missing });
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { loadId: booked.loadId, action: "sent" } });
    expect(audit.summary).toMatch(/^Sent to WC1 Driver, without weight/);

    // Fill in what was missing and the same check passes.
    await prisma.load.update({ where: { id: booked.loadId }, data: { weightLbs: 12000, pickupNumbers: ["PU-1"] } });
    const after = await loadSendGaps(booked.loadId);
    expect(after.map((g) => g.key)).not.toContain("weight");
    expect(after.map((g) => g.key)).not.toContain("pickupNumber");
  });

  test("the Loads file is the list it was asked from, and carries what was billed, paid and spent", async () => {
    const all = await buildExport("loads", {});
    const open = await buildExport("loads", { view: "open" });
    const history = await buildExport("loads", { view: "history" });
    const lines = (r: { csv: string } | null) => r!.csv.replace(/^﻿/, "").trim().split(/\r?\n/);
    const rows = await listBoardRows();
    const isOpen = (s: string) => ["draft", "accepted", "in_progress"].includes(s);
    expect(lines(open).length - 1).toBe(rows.filter((r) => isOpen(r.status)).length);
    expect(lines(history).length - 1).toBe(rows.filter((r) => !isOpen(r.status)).length);
    expect(lines(all).length - 1).toBe(rows.length);

    // A tab on the Open board narrows the file the way it narrows the screen.
    const draft = await buildExport("loads", { view: "open", status: "draft" });
    expect(lines(draft).length - 1).toBe(rows.filter((r) => r.status === "draft").length);

    // History filters by outcome.
    const cancelled = await buildExport("loads", { view: "history", filter: "cancelled" });
    expect(lines(cancelled).length - 1).toBe(rows.filter((r) => r.status === "cancelled" || r.status === "tonu").length);

    // The first columns are the ones the file always had; the new ones follow.
    const header = lines(history)[0]!;
    expect(header.startsWith("Load,Status,Broker,Origin,Destination")).toBe(true);
    expect(header.endsWith("Delivered,Invoice number,Invoiced,Invoiced amount,Paid,Expenses,Driver pay (estimate),Cancel reason")).toBe(true);
  });
});
