import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { getDriverDetail } from "@/server/tl/driver-detail";

/**
 * Needs a seeded database (see tl-dispatch.integration.test.ts). Makes its own driver and loads (all named WC2D) and removes them afterwards.
 * Dallas is on daylight time (UTC-5) until 1 November 2026, so the times are written with that offset.
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const WS = "demo-workspace";
const at = (local: string) => new Date(`${local}:00-05:00`);

describe.skipIf(!run)("a driver's page, on the demo database", () => {
  let driverId = "";

  const delivered = (n: string, day: string, arrivals: { pickup: string | null; delivery: string | null }, over: Record<string, unknown> = {}, pay = 130) =>
    prisma.load.create({
      data: {
        workspaceId: WS,
        loadNumber: `WC2D-${n}`,
        brokerName: "WC2D Customer",
        status: "completed",
        completedAt: at(`${day}T15:30`),
        quotedRevenue: 1000,
        loadedMiles: 260,
        pickupDeadheadMiles: 20,
        returnDeadheadMiles: 20,
        originAddress: "Dallas, TX",
        destinationAddress: "Tulsa, OK",
        scheduledDate: at(`${day}T08:00`),
        paymentStatus: "paid",
        invoicedAmount: 1000,
        paidAmount: 1000,
        stops: {
          create: [
            { stopSequence: 1, stopType: "pickup", stopRole: "pickup", addressString: "Dallas, TX", timeWindowEarliest: at(`${day}T08:00`), timeWindowLatest: at(`${day}T09:00`), arrivedAt: arrivals.pickup ? at(`${day}T${arrivals.pickup}`) : null },
            { stopSequence: 2, stopType: "delivery", stopRole: "delivery", addressString: "Tulsa, OK", timeWindowEarliest: at(`${day}T15:00`), timeWindowLatest: at(`${day}T16:00`), arrivedAt: arrivals.delivery ? at(`${day}T${arrivals.delivery}`) : null }
          ]
        },
        assignment: { create: { driverId, payKind: "cpm", payRate: 0.5, payEstimate: pay, status: "completed" } },
        ...over
      }
    });

  beforeAll(async () => {
    driverId = (await prisma.driver.create({ data: { workspaceId: WS, name: "WC2D Driver", cdlClass: "A", cdlExpiry: new Date("2031-01-31"), medicalCardExpiry: new Date("2031-01-31") } })).id;
    await delivered("ONTIME", "2026-10-05", { pickup: "08:30", delivery: "15:30" }, { paidAmount: 940 }, 130); // paid $60 under the invoice
    await delivered("LATE", "2026-10-06", { pickup: "11:00", delivery: null }, {}, 120.5); // two hours past the pickup window; the delivery is taken from when it was delivered (15:30, on time)
    await delivered("TONU", "2026-10-07", { pickup: "08:30", delivery: "15:30" }, { status: "tonu" }, 99); // not a delivery
    await delivered("GONE", "2026-10-08", { pickup: "08:30", delivery: "15:30" }, { deletedAt: new Date() }, 77); // deleted
    await prisma.load.create({
      data: {
        workspaceId: WS,
        loadNumber: "WC2D-OPEN",
        brokerName: "WC2D Customer",
        status: "accepted",
        quotedRevenue: 900,
        loadedMiles: 100,
        scheduledDate: at("2027-02-02T08:00"),
        originAddress: "Dallas, TX",
        destinationAddress: "Waco, TX",
        assignment: { create: { driverId, payKind: "cpm", payRate: 0.5, payEstimate: 50, status: "accepted" } }
      }
    });
  });

  afterAll(async () => {
    const mine = await prisma.load.findMany({ where: { workspaceId: WS, brokerName: "WC2D Customer" }, select: { id: true } });
    await prisma.load.deleteMany({ where: { id: { in: mine.map((l) => l.id) } } });
    await prisma.driver.deleteMany({ where: { workspaceId: WS, name: { startsWith: "WC2D" } } });
  });

  test("scores the delivered loads only: on time by the phone's rule, empty miles, pay, and what the customer paid short", async () => {
    const d = (await getDriverDetail(driverId))!;
    expect(d.driver.name).toBe("WC2D Driver");
    const s = d.scorecard;
    expect(s.loads).toBe(2); // not the TONU, not the deleted one, not the open one
    expect(s.onTime).toEqual({ scored: 4, onTime: 3, rate: 0.75 });
    expect(s.worstLateMinutes).toBe(120); // arrived 11:00 for a window that closed at 09:00
    expect(s.empty).toMatchObject({ miles: 80, total: 600 });
    expect(s.pay).toBe(250.5);
    expect(s.shortPaid).toEqual({ loads: 1, dollars: 60 });
    expect(d.recent.map((l) => l.loadNumber)).toEqual(["WC2D-LATE", "WC2D-ONTIME"]); // newest first
  });

  test("lists what the driver is on now, and nothing for a driver who does not exist", async () => {
    const d = (await getDriverDetail(driverId))!;
    expect(d.open.map((o) => [o.loadNumber, o.status])).toEqual([["WC2D-OPEN", "accepted"]]);
    expect(await getDriverDetail("no-such-driver")).toBeNull();
  });
});
