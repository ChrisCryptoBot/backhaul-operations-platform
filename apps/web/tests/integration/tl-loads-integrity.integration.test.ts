import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { toEditValues, type LoadEditValues } from "@/lib/load-edit";
import { assignDriver, DispatchError, dispatchLoad, driverSummaryFor, recordDriverResponse, unassignLoad } from "@/server/tl/dispatch";
import { cancelLoad, MAX_TONU_FEE, recordTonu } from "@/server/tl/disruptions";
import { saveLoadDetails } from "@/server/tl/edit";
import { completeTrip, reopenDelivered, startTrip, undoStartTrip } from "@/server/tl/execution";
import { invoiceLoad, markLoadPaid, undoPaid } from "@/server/tl/invoicing";
import { deleteLoad, restoreLoad } from "@/server/tl/remove";
import { CANCEL_REASONS, DELETE_REASONS } from "@/lib/disruptions";

/**
 * Loads, the parts that keep money and state straight: a delivered load edited for something else keeps what it was paid, and a move on a load happens once however many times
 * it is pressed (a double click, a second tab). Needs the seeded demo database; makes its own driver and loads (named QL) and removes them and their audit events afterwards.
 * Every window is in 2028, so nothing seeded is on the road then.
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const WS = "demo-workspace";
const H = 3_600_000;

describe.skipIf(!run)("loads on the demo database: integrity", () => {
  const startedAt = new Date();
  const ids: string[] = [];
  let driverId = "";
  let seq = 0;

  const at = (day: number, hour: number) => new Date(Date.UTC(2028, 0, day, hour));
  /** A load on its own day, so no two of these overlap. */
  async function mk(over: Record<string, unknown> = {}, day = 3 + (seq += 3)) {
    const l = await prisma.load.create({
      data: {
        workspaceId: WS,
        loadNumber: `QL-${seq}-${day}`,
        status: "draft",
        brokerName: "QL Broker",
        originAddress: "Dallas, TX",
        destinationAddress: "Tulsa, OK",
        loadedMiles: 260,
        quotedRevenue: 1000,
        weightLbs: 9000,
        trailerType: "dry_van",
        stops: {
          create: [
            { stopSequence: 1, stopType: "pickup", stopRole: "pickup", addressString: "Dallas, TX", timeWindowEarliest: at(day, 14), timeWindowLatest: at(day, 16), referenceNumbers: ["PU-1"] },
            { stopSequence: 2, stopType: "delivery", stopRole: "delivery", addressString: "Tulsa, OK", timeWindowEarliest: at(day, 22), timeWindowLatest: at(day, 23), referenceNumbers: ["DEL-1"] }
          ]
        },
        ...over
      },
      include: { stops: true }
    });
    ids.push(l.id);
    return l;
  }
  const valuesOf = async (id: string): Promise<LoadEditValues> => toEditValues(await prisma.load.findUniqueOrThrow({ where: { id }, include: { stops: { orderBy: { stopSequence: "asc" } } } }));
  const row = (id: string) => prisma.load.findUniqueOrThrow({ where: { id } });
  const events = (id: string, action: string) => prisma.auditEvent.count({ where: { loadId: id, action } });
  /** A load that has the driver, who has said yes. */
  async function accepted(over: Record<string, unknown> = {}) {
    const l = await mk(over);
    await assignDriver({ loadId: l.id, driverId, pay: { kind: "cpm", rate: 0.6 } });
    await dispatchLoad(l.id);
    await recordDriverResponse(l.id, "accepted");
    return l;
  }
  const settle = async <T,>(a: Promise<T>) => a.then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e }));

  beforeAll(async () => {
    driverId = (await prisma.driver.create({ data: { workspaceId: WS, name: "QL Driver", cdlExpiry: new Date(Date.now() + 700 * 86_400_000), medicalCardExpiry: new Date(Date.now() + 700 * 86_400_000) } })).id;
  });

  afterAll(async () => {
    await prisma.auditEvent.deleteMany({ where: { OR: [{ loadId: { in: ids } }, { workspaceId: WS, createdAt: { gte: startedAt }, entity: "fleet" }] } });
    await prisma.loadPayment.deleteMany({ where: { loadId: { in: ids } } });
    await prisma.load.deleteMany({ where: { id: { in: ids } } });
    await prisma.driver.deleteMany({ where: { workspaceId: WS, name: { startsWith: "QL" } } });
  });

  describe("a delivered load keeps what it was paid", () => {
    test("editing its notes changes no money, however it was delivered", async () => {
      const l = await mk({ status: "completed", completedAt: at(30, 23), actualRevenue: 900 });
      const v = await valuesOf(l.id);
      v.notes = "Receiver closed at five";
      expect(await saveLoadDetails(l.id, v)).toMatchObject({ ok: true, changed: true });
      const after = await row(l.id);
      expect(Number(after.actualRevenue)).toBe(900); // the short pay is still the short pay
      expect(Number(after.quotedRevenue)).toBe(1000);
    });

    test("a rate corrected on a load delivered at the rate follows it; one delivered short keeps what was paid", async () => {
      const same = await mk({ status: "completed", completedAt: at(30, 23), actualRevenue: 1000 });
      const v = await valuesOf(same.id);
      v.deal!.rate = "1100";
      expect(await saveLoadDetails(same.id, v)).toMatchObject({ ok: true });
      expect(Number((await row(same.id)).actualRevenue)).toBe(1100);

      const short = await mk({ status: "completed", completedAt: at(30, 23), actualRevenue: 900 });
      const w = await valuesOf(short.id);
      w.deal!.rate = "1100";
      expect(await saveLoadDetails(short.id, w)).toMatchObject({ ok: true });
      const after = await row(short.id);
      expect(Number(after.quotedRevenue)).toBe(1100);
      expect(Number(after.actualRevenue)).toBe(900);
    });
  });

  describe("a driver payload is not refused for a coincidence", () => {
    test("a fuel surcharge that equals a minute in a time, or the miles, still sends; a note that repeats the rate does not", async () => {
      const l = await mk({ fuelSurcharge: 45, loadedMiles: 45 });
      // The pickup window starts on the hour and ends at :45 would be the coincidence; the times here are whole hours, so make one that is :45.
      await prisma.stop.updateMany({ where: { loadId: l.id, stopSequence: 1 }, data: { timeWindowEarliest: new Date(Date.UTC(2028, 0, 31, 13, 45)) } });
      await assignDriver({ loadId: l.id, driverId, pay: { kind: "cpm", rate: 0.6 } });
      await expect(driverSummaryFor(l.id)).resolves.toBeDefined();
      await dispatchLoad(l.id);

      const leaky = await mk({ quotedRevenue: 1234 });
      // A stop between the pickup and the delivery is what the driver is sent notes for.
      await prisma.stop.updateMany({ where: { loadId: leaky.id, stopSequence: 2 }, data: { stopSequence: 3 } });
      await prisma.stop.create({ data: { loadId: leaky.id, stopSequence: 2, stopType: "delivery", stopRole: "delivery", addressString: "Waco, TX", stopNotes: "Receiver pays 1234 on the day" } });
      await assignDriver({ loadId: leaky.id, driverId, pay: { kind: "cpm", rate: 0.6 } });
      await expect(dispatchLoad(leaky.id)).rejects.toMatchObject({ code: "not_ready", message: expect.stringMatching(/Reword the stop notes/) });
    });
  });

  describe("a move happens once, however many times it is pressed", () => {
    test("send and the driver's answer", async () => {
      const l = await mk();
      await assignDriver({ loadId: l.id, driverId, pay: { kind: "cpm", rate: 0.6 } });
      const sent = await Promise.all([settle(dispatchLoad(l.id)), settle(dispatchLoad(l.id))]);
      expect(sent.filter((r) => r.ok)).toHaveLength(1);
      expect(sent.find((r) => !r.ok)).toMatchObject({ e: expect.objectContaining({ code: "already_sent" }) });
      expect(await events(l.id, "sent")).toBe(1);

      const answered = await Promise.all([settle(recordDriverResponse(l.id, "accepted")), settle(recordDriverResponse(l.id, "declined", new Date(), "Out of hours"))]);
      expect(answered.filter((r) => r.ok)).toHaveLength(1);
      expect((await events(l.id, "accepted")) + (await events(l.id, "declined"))).toBe(1);
    });

    test("taking the driver off", async () => {
      const l = await mk();
      await assignDriver({ loadId: l.id, driverId, pay: { kind: "cpm", rate: 0.6 } });
      const off = await Promise.all([settle(unassignLoad(l.id, null)), settle(unassignLoad(l.id, null))]);
      expect(off.filter((r) => r.ok)).toHaveLength(1);
      expect(await events(l.id, "unassigned")).toBe(1);
    });

    test("pickup, delivery and taking either back", async () => {
      const l = await accepted();
      const arrived = new Date(Date.now() - 2 * H);
      const start = { arrivedAt: arrived.toISOString().slice(0, 16), waitMinutes: "", seal: "" };
      void start;
      const { toCentralLocal } = await import("@/lib/zoned");
      const pick = { arrivedAt: toCentralLocal(arrived.getTime()), waitMinutes: "", seal: "" };
      const twice = await Promise.all([startTrip(l.id, pick), startTrip(l.id, pick)]);
      expect(twice.filter((r) => r.ok)).toHaveLength(1);
      expect(twice.find((r) => !r.ok)).toMatchObject({ error: expect.stringMatching(/changed while you were working/) });
      expect(await events(l.id, "trip_started")).toBe(1);

      const done = { stops: [], deliveredAt: toCentralLocal(Date.now() - H), pod: "received" as const, podNote: "", fuel: "", tolls: "", misc: "", actualRevenue: "950" };
      const delivered = await Promise.all([completeTrip(l.id, done), completeTrip(l.id, done)]);
      expect(delivered.filter((r) => r.ok)).toHaveLength(1);
      expect(await events(l.id, "delivered")).toBe(1);
      expect(Number((await row(l.id)).actualRevenue)).toBe(950);

      const back = await Promise.all([reopenDelivered(l.id, "Wrong load"), reopenDelivered(l.id, "Wrong load")]);
      expect(back.filter((r) => r.ok)).toHaveLength(1);
      expect(await events(l.id, "trip_reopened")).toBe(1);
      // What was paid is on the record of the take-back, so it is not lost when the delivery is entered again.
      const reopened = await prisma.auditEvent.findFirstOrThrow({ where: { loadId: l.id, action: "trip_reopened" } });
      expect(JSON.stringify(reopened.before)).toContain("Linehaul paid");

      const undo = await Promise.all([undoStartTrip(l.id, "Too early"), undoStartTrip(l.id, "Too early")]);
      expect(undo.filter((r) => r.ok)).toHaveLength(1);
      expect(await events(l.id, "trip_undone")).toBe(1);
    });

    test("cancel and TONU", async () => {
      const l = await accepted();
      const gone = await Promise.all([settle(cancelLoad({ loadId: l.id, reason: CANCEL_REASONS[0]!.key })), settle(cancelLoad({ loadId: l.id, reason: CANCEL_REASONS[0]!.key }))]);
      expect(gone.filter((r) => r.ok)).toHaveLength(1);
      expect(await events(l.id, "cancelled")).toBe(1);

      const t = await accepted();
      const fee = await Promise.all([settle(recordTonu({ loadId: t.id, fee: 150, reason: CANCEL_REASONS[0]!.key })), settle(recordTonu({ loadId: t.id, fee: 150, reason: CANCEL_REASONS[0]!.key }))]);
      expect(fee.filter((r) => r.ok)).toHaveLength(1);
      expect(await events(t.id, "tonu")).toBe(1);
    });

    test("delete, restore, and taking a payment back", async () => {
      const l = await mk();
      const del = await Promise.all([deleteLoad({ loadId: l.id, reason: DELETE_REASONS[0]!.key }), deleteLoad({ loadId: l.id, reason: DELETE_REASONS[0]!.key })]);
      expect(del.filter((r) => r.ok)).toHaveLength(1);
      expect(await events(l.id, "deleted")).toBe(1);
      const back = await Promise.all([restoreLoad(l.id), restoreLoad(l.id)]);
      expect(back.filter((r) => r.ok)).toHaveLength(1);
      expect(await events(l.id, "restored")).toBe(1);

      // Two payments, one undo pressed twice: only the latest comes off, once.
      const p = await mk({ status: "completed", completedAt: at(30, 23), actualRevenue: 1000 });
      expect(await invoiceLoad(p.id, {})).toMatchObject({ ok: true });
      expect(await markLoadPaid(p.id, new Date(), { amount: 400, shortAction: "balance" })).toMatchObject({ ok: true });
      expect(await markLoadPaid(p.id, new Date(), { amount: 300, shortAction: "balance" })).toMatchObject({ ok: true });
      const undone = await Promise.all([undoPaid(p.id, "Bounced"), undoPaid(p.id, "Bounced")]);
      expect(undone.filter((r) => r.ok)).toHaveLength(1);
      expect(await prisma.loadPayment.count({ where: { loadId: p.id } })).toBe(1);
      expect(await events(p.id, "payment_undone")).toBe(1);
    });
  });

  test("a driver put on a load that has since started is refused, not set back to a draft", async () => {
    const l = await accepted();
    await prisma.load.update({ where: { id: l.id }, data: { status: "in_progress" } });
    await prisma.assignment.update({ where: { loadId: l.id }, data: { status: "in_progress" } });
    const other = await prisma.driver.create({ data: { workspaceId: WS, name: "QL Other", cdlExpiry: new Date(Date.now() + 700 * 86_400_000), medicalCardExpiry: new Date(Date.now() + 700 * 86_400_000) } });
    await expect(assignDriver({ loadId: l.id, driverId: other.id, pay: { kind: "cpm", rate: 0.6 }, overrideReason: "Swap" })).rejects.toBeInstanceOf(DispatchError);
    expect((await row(l.id)).status).toBe("in_progress");
  });

  test("a restored load has to clear the checks a new one would: its number, and a quote is not brought back", async () => {
    const l = await mk({ loadNumber: "QL-RESTORE-1" });
    expect(await deleteLoad({ loadId: l.id, reason: DELETE_REASONS[0]!.key })).toEqual({ ok: true });
    await mk({ loadNumber: "QL-RESTORE-1" }); // the same number entered again
    expect(await restoreLoad(l.id)).toMatchObject({ ok: false, error: expect.stringMatching(/already|Load QL-RESTORE-1/) });
    const quote = await mk({ status: "quote", channel: "quote", deletedAt: new Date() });
    expect(await restoreLoad(quote.id)).toMatchObject({ ok: false, error: expect.stringMatching(/quote/i) });
  });

  test("amounts are bounded: a TONU fee, and a pay rate for its kind", async () => {
    const l = await accepted();
    await expect(recordTonu({ loadId: l.id, fee: MAX_TONU_FEE + 1, reason: CANCEL_REASONS[0]!.key })).rejects.toMatchObject({ code: "bad_fee" });
    await expect(assignDriver({ loadId: (await mk()).id, driverId, pay: { kind: "cpm", rate: 25 } })).rejects.toMatchObject({ code: "bad_pay" });
    await expect(assignDriver({ loadId: (await mk()).id, driverId, pay: { kind: "hourly", rate: 5000 } })).rejects.toMatchObject({ code: "bad_pay" });
  });
});
