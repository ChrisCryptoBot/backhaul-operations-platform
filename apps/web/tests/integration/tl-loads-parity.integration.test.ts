import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { DispatchError } from "@/server/tl/dispatch";
import { recordTonu, reopenCancelled } from "@/server/tl/disruptions";
import { correctTrip, saveExpenses } from "@/server/tl/execution";
import { listHistory } from "@/server/tl/history";
import { listBoardRows } from "@/server/tl/queries";
import { podStopsMissing } from "@/server/tl/documents";

/**
 * Loads, the phone's minimum abilities on the desk: itemised costs and miles actually driven (the quote's miles are kept), a trip corrected after delivery, a TONU that was never hauled,
 * a cancelled load reopened, a proof of delivery tied to a stop, and the profit sorts. A workspace of its own, so the figures are exact.
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const W = "lp-parity";
const day = (d: string) => new Date(`${d}T17:00:00Z`);

describe.skipIf(!run)("loads parity on the demo database", () => {
  const id: Record<string, string> = {};
  const stopIds: Record<string, string[]> = {};
  beforeAll(async () => {
    await prisma.workspace.deleteMany({ where: { id: W } });
    await prisma.workspace.create({ data: { id: W, name: "LP parity", plan: "enterprise" } });
    const make = async (key: string, data: Record<string, unknown>, deliveries = 1) => {
      const l = await prisma.load.create({
        data: {
          workspaceId: W, loadNumber: `LP-${key}`, brokerName: "LP Customer", originAddress: "Dallas, TX", destinationAddress: "Tulsa, OK", loadedMiles: 260, pickupDeadheadMiles: 20, returnDeadheadMiles: 0, quotedRevenue: 1000,
          stops: { create: [{ stopSequence: 1, stopType: "pickup", stopRole: "pickup", addressString: "Dallas, TX" }, ...Array.from({ length: deliveries }, (_, i) => ({ stopSequence: i + 2, stopType: "delivery", stopRole: "delivery", addressString: `Drop ${i + 1}` }))] },
          ...data
        } as never,
        include: { stops: true }
      });
      id[key] = l.id;
      stopIds[key] = l.stops.sort((a, b) => a.stopSequence - b.stopSequence).map((s) => s.id);
    };
    await make("D", { status: "completed", completedAt: day("2026-10-05"), expenseFuelActual: 120, expenseMisc: 0 }, 2);
    await make("T", { status: "accepted" });
    await make("C", { status: "cancelled", cancelledAt: day("2026-10-06"), cancelReason: "broker_cancelled" });
  });
  afterAll(async () => {
    await prisma.auditEvent.deleteMany({ where: { workspaceId: W } });
    await prisma.workspace.deleteMany({ where: { id: W } });
  });

  test("itemised costs are kept as items and as their total with other, and the audit names what changed", async () => {
    const r = await saveExpenses(id.D!, { fuel: "120", tolls: "", misc: "5", items: { lumper: "75", parking: "20" } }, new Date(), W);
    expect(r).toMatchObject({ ok: true, changed: true });
    const l = await prisma.load.findUniqueOrThrow({ where: { id: id.D! } });
    expect(Number(l.expenseMisc)).toBe(100);
    expect(l.expenseItems).toEqual({ lumper: 75, parking: 20 });
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { loadId: id.D!, action: "expenses_changed" }, orderBy: { createdAt: "desc" } });
    expect(audit.after).toMatchObject({ Lumper: "$75.00", Parking: "$20.00" });
    // The same figures again change nothing.
    expect(await saveExpenses(id.D!, { fuel: "120", tolls: "", misc: "5", items: { lumper: "75", parking: "20" } }, new Date(), W)).toMatchObject({ ok: true, changed: false });
  });

  test("miles actually driven replace the quote's, which are kept once", async () => {
    await saveExpenses(id.D!, { fuel: "120", tolls: "", misc: "5", items: { lumper: "75", parking: "20" }, miles: { pickup: "20", loaded: "300", home: "" } }, new Date(), W);
    let l = await prisma.load.findUniqueOrThrow({ where: { id: id.D! } });
    expect([Number(l.loadedMiles), Number(l.quotedLoadedMiles), Number(l.quotedPickupDhMiles)]).toEqual([300, 260, 20]);
    // A second correction does not overwrite the quote's miles with the first correction's.
    await saveExpenses(id.D!, { fuel: "120", tolls: "", misc: "5", items: { lumper: "75", parking: "20" }, miles: { pickup: "20", loaded: "310", home: "" } }, new Date(), W);
    l = await prisma.load.findUniqueOrThrow({ where: { id: id.D! } });
    expect([Number(l.loadedMiles), Number(l.quotedLoadedMiles)]).toEqual([310, 260]);
  });

  test("a trip corrected after delivery recounts the dock wait, keeps the reason, and sets this load's detention terms", async () => {
    const r = await correctTrip(id.D!, { stops: [{ id: stopIds.D![0]!, arrivedAt: "", waitMinutes: "30", seal: "S-9" }, { id: stopIds.D![1]!, arrivedAt: "", waitMinutes: "200", seal: "" }, { id: stopIds.D![2]!, arrivedAt: "", waitMinutes: "", seal: "" }], detentionRate: "75", detentionGraceMinutes: "90", reason: "Driver log said 200 min" }, new Date(), W);
    expect(r).toMatchObject({ ok: true, changed: true });
    const l = await prisma.load.findUniqueOrThrow({ where: { id: id.D! } });
    expect(l.dockWaitMinutes).toBe(230);
    expect([Number(l.snapshotDetentionRate), l.snapshotFreeGraceMinutes]).toEqual([75, 90]);
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { loadId: id.D!, action: "trip_corrected" } });
    expect(audit.reason).toBe("Driver log said 200 min");
    expect(await correctTrip(id.D!, { stops: [], reason: "" }, new Date(), W)).toMatchObject({ ok: false });
  });

  test("once invoiced, waits cannot be rewritten but a seal can", async () => {
    await prisma.load.update({ where: { id: id.D! }, data: { paymentStatus: "invoiced", invoiceNumber: "LP-D", invoicedAt: day("2026-10-06"), invoicedAmount: 1000 } });
    const stops = (wait: string, seal: string) => [{ id: stopIds.D![0]!, arrivedAt: "", waitMinutes: "30", seal: "S-9" }, { id: stopIds.D![1]!, arrivedAt: "", waitMinutes: wait, seal }, { id: stopIds.D![2]!, arrivedAt: "", waitMinutes: "", seal: "" }];
    expect(await correctTrip(id.D!, { stops: stops("10", ""), reason: "wrong wait" }, new Date(), W)).toMatchObject({ ok: false, error: expect.stringMatching(/invoiced/) });
    expect(await correctTrip(id.D!, { stops: stops("200", "S-77"), reason: "seal typo" }, new Date(), W)).toMatchObject({ ok: true, changed: true });
    expect((await prisma.stop.findUniqueOrThrow({ where: { id: stopIds.D![1]! } })).sealNumber).toBe("S-77");
  });

  test("a proof of delivery with no stop named covers the load; one for a stop covers that stop only", async () => {
    expect((await podStopsMissing([id.D!], W)).get(id.D!)).toBe(2);
    const doc = (stopId: string | null) => prisma.loadDocument.create({ data: { workspaceId: W, loadId: id.D!, kind: "pod", name: "pod.pdf", mime: "application/pdf", bytes: 10, sha256: "x", storageKey: `k-${Math.random()}`, addedBy: "t", stopId } });
    const first = await doc(stopIds.D![1]!);
    expect((await podStopsMissing([id.D!], W)).get(id.D!)).toBe(1);
    await doc(stopIds.D![2]!);
    expect((await podStopsMissing([id.D!], W)).get(id.D!)).toBe(0);
    await prisma.loadDocument.deleteMany({ where: { loadId: id.D! } });
    await doc(null);
    expect((await podStopsMissing([id.D!], W)).get(id.D!)).toBe(0);
    expect(first.stopId).toBe(stopIds.D![1]);
  });

  test("a TONU is refused once the driver has reached a delivery stop, and keeps its note and miles otherwise", async () => {
    await prisma.assignment.create({ data: { loadId: id.T!, driverId: (await prisma.driver.create({ data: { workspaceId: W, name: "LP Driver" } })).id, payKind: "cpm", payRate: 0.5, status: "accepted" } });
    await prisma.stop.update({ where: { id: stopIds.T![1]! }, data: { arrivedAt: day("2026-10-07") } });
    await expect(recordTonu({ loadId: id.T!, reason: "shipper_not_ready", fee: 150 }, new Date(), W)).rejects.toThrow(/already reached a delivery stop/);
    await prisma.stop.update({ where: { id: stopIds.T![1]! }, data: { arrivedAt: null } });
    await recordTonu({ loadId: id.T!, reason: "shipper_not_ready", note: "Dock said Tuesday", fee: 150 }, new Date(), W);
    const l = await prisma.load.findUniqueOrThrow({ where: { id: id.T! } });
    expect([l.status, l.cancelNote]).toEqual(["tonu", "Dock said Tuesday"]);
    // The truck still cost something to send: its costs and miles can be entered on the TONU.
    expect(await saveExpenses(id.T!, { fuel: "40", tolls: "", misc: "", tonuMiles: "55" }, new Date(), W)).toMatchObject({ ok: true, changed: true });
    expect(Number((await prisma.load.findUniqueOrThrow({ where: { id: id.T! } })).tonuMiles)).toBe(55);
  });

  test("a cancelled load or a TONU can be reopened with a reason, and not while an invoice stands on it", async () => {
    await expect(reopenCancelled({ loadId: id.C!, reason: "" }, new Date(), W)).rejects.toBeInstanceOf(DispatchError);
    await reopenCancelled({ loadId: id.C!, reason: "Customer called back" }, new Date(), W);
    const c = await prisma.load.findUniqueOrThrow({ where: { id: id.C! } });
    expect([c.status, c.cancelReason, c.cancelledAt]).toEqual(["draft", null, null]);
    expect(await prisma.auditEvent.count({ where: { loadId: id.C!, action: "load_reopened", reason: "Customer called back" } })).toBe(1);
    await expect(reopenCancelled({ loadId: id.C!, reason: "again" }, new Date(), W)).rejects.toThrow(/Only a cancelled/);

    await prisma.load.update({ where: { id: id.T! }, data: { paymentStatus: "invoiced", invoiceNumber: "LP-T", invoicedAt: day("2026-10-08"), invoicedAmount: 150 } });
    await expect(reopenCancelled({ loadId: id.T!, reason: "wrong load" }, new Date(), W)).rejects.toThrow(/invoiced/);
    await prisma.load.update({ where: { id: id.T! }, data: { paymentStatus: null, invoiceNumber: null, invoicedAt: null, invoicedAmount: null } });
    await reopenCancelled({ loadId: id.T!, reason: "wrong load" }, new Date(), W);
    const t = await prisma.load.findUniqueOrThrow({ where: { id: id.T! }, include: { assignment: true } });
    expect([t.status, t.tonuRevenue, t.assignment]).toEqual(["draft", null, null]);
  });

  test("the board row carries net pay, profit a mile and $ an hour, and History sorts by them with unpriced loads last", async () => {
    // No truck, so nothing can be priced: the figures are null, never zero, and the sort keeps every load.
    const rows = (await listBoardRows(W, "all")).filter((r) => r.loadNumber === "LP-D");
    expect(rows[0]).toMatchObject({ netPay: null, profitPerMile: null, profitPerHour: null });
    for (const sort of ["net", "profit", "rph"]) {
      const h = await listHistory({ sort }, W);
      expect(h.sort).toBe(sort);
      expect(h.rows.map((r) => r.loadNumber)).toContain("LP-D");
      expect(h.windowed).toBe(false);
    }
  });
});
