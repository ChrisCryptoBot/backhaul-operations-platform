import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { assignDriver, dispatchLoad, DispatchError, recordDriverResponse, unassignLoad } from "@/server/tl/dispatch";
import { invoiceLoad, markLoadPaid } from "@/server/tl/invoicing";
import { listAudit, listLoadAudit } from "@/server/tl/audit";
import { searchDesk } from "@/server/tl/search";
import { getAlerts } from "@/server/tl/alerts";

/**
 * Needs a seeded database (see tl-dispatch.integration.test.ts). Creates its own driver and loads, and removes them
 * and their audit events afterwards, so the demo data is left as the seed wrote it.
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const WS = "demo-workspace";
const H = 3_600_000;
const D = 86_400_000;

describe.skipIf(!run)("audit trail, unassign and the double-booking guard", () => {
  const loadIds: string[] = [];
  let driverId = "";
  const base = Date.now() + 20 * D; // far enough out that no seeded load overlaps

  async function makeLoad(loadNumber: string, startMs: number, endMs: number, over: Record<string, unknown> = {}) {
    const l = await prisma.load.create({
      data: {
        workspaceId: WS,
        loadNumber,
        status: "draft",
        brokerName: "Audit Test Broker",
        originAddress: "Dallas, TX",
        destinationAddress: "Tulsa, OK",
        loadedMiles: 260,
        quotedRevenue: 700,
        stops: {
          create: [
            { stopSequence: 1, stopType: "pickup", addressString: "Dallas, TX", timeWindowEarliest: new Date(startMs), timeWindowLatest: new Date(startMs + 2 * H), referenceNumbers: ["PU-T"] },
            { stopSequence: 2, stopType: "delivery", addressString: "Tulsa, OK", timeWindowEarliest: new Date(endMs - 2 * H), timeWindowLatest: new Date(endMs), referenceNumbers: ["DEL-T"] }
          ]
        },
        ...over
      }
    });
    loadIds.push(l.id);
    return l;
  }

  beforeAll(async () => {
    driverId = (await prisma.driver.create({ data: { workspaceId: WS, name: "Audit Test Driver", cdlExpiry: new Date(Date.now() + 400 * D), medicalCardExpiry: new Date(Date.now() + 400 * D) } })).id;
  });

  afterAll(async () => {
    await prisma.auditEvent.deleteMany({ where: { loadId: { in: loadIds } } });
    await prisma.load.deleteMany({ where: { id: { in: loadIds } } }); // assignments cascade
    await prisma.driver.delete({ where: { id: driverId } });
  });

  test("assign, send, refuse a silent unassign, then unassign with a reason: each leaves one event, in order", async () => {
    const l = await makeLoad("AUD-1", base, base + D);
    await assignDriver({ loadId: l.id, driverId, pay: { kind: "cpm", rate: 0.65 } });
    await dispatchLoad(l.id);

    await expect(unassignLoad(l.id, "")).rejects.toMatchObject({ code: "reason_required" });
    expect(await prisma.assignment.count({ where: { loadId: l.id } })).toBe(1);

    await unassignLoad(l.id, "Driver called out sick");
    expect(await prisma.assignment.count({ where: { loadId: l.id } })).toBe(0);
    expect((await prisma.load.findUniqueOrThrow({ where: { id: l.id } })).status).toBe("draft");

    const feed = (await listLoadAudit(l.id)).reverse();
    expect(feed.map((e) => e.action)).toEqual(["assigned", "sent", "unassigned"]);
    expect(feed[0]!.after).toMatchObject({ Driver: "Audit Test Driver", Pay: "$0.65/mi" });
    expect(feed[2]).toMatchObject({ reason: "Driver called out sick", before: { Driver: "Audit Test Driver", Status: "Sent, waiting" }, after: { Status: "Needs a driver" } });
  });

  test("changing the driver or pay is recorded as a before and after", async () => {
    const l = await makeLoad("AUD-2", base + 5 * D, base + 6 * D);
    await assignDriver({ loadId: l.id, driverId, pay: { kind: "cpm", rate: 0.6 } });
    await assignDriver({ loadId: l.id, driverId, pay: { kind: "flat", rate: 420 } });
    const [latest] = await listLoadAudit(l.id);
    expect(latest).toMatchObject({ action: "reassigned", before: { Pay: "$0.60/mi" }, after: { Pay: "Flat $420.00" } });
  });

  test("a driver cannot be put on two loads at the same time without a reason", async () => {
    const a = await makeLoad("AUD-3A", base + 10 * D, base + 11 * D);
    const b = await makeLoad("AUD-3B", base + 10 * D + 6 * H, base + 12 * D); // starts while A is still running
    const c = await makeLoad("AUD-3C", base + 11 * D, base + 12 * D); // starts as A ends: fine
    await assignDriver({ loadId: a.id, driverId, pay: { kind: "flat", rate: 400 } });

    await expect(assignDriver({ loadId: b.id, driverId, pay: { kind: "flat", rate: 400 } })).rejects.toMatchObject({ code: "double_booked" });
    expect(await prisma.assignment.count({ where: { loadId: b.id } })).toBe(0);

    await assignDriver({ loadId: c.id, driverId, pay: { kind: "flat", rate: 400 } });

    await assignDriver({ loadId: b.id, driverId, pay: { kind: "flat", rate: 400 }, overrideReason: "Team run, second seat" });
    const [ev] = await listLoadAudit(b.id);
    expect(ev).toMatchObject({ action: "assigned", reason: "Team run, second seat" });
    expect(ev!.summary).toContain("double-booked on purpose");

    const alerts = (await getAlerts()).alerts.filter((x) => x.code === "DOUBLE_BOOKED" && [a.id, b.id].includes(x.loadId));
    expect(alerts.map((x) => x.loadId).sort()).toEqual([a.id, b.id].sort());
  });

  test("a decline is recorded with the load back on the board as assignable", async () => {
    const l = await makeLoad("AUD-4", base + 20 * D, base + 21 * D);
    await assignDriver({ loadId: l.id, driverId, pay: { kind: "flat", rate: 350 } });
    await dispatchLoad(l.id);
    await recordDriverResponse(l.id, "declined", new Date(), "Out of hours");
    const feed = await listLoadAudit(l.id);
    expect(feed[0]).toMatchObject({ action: "declined", reason: "Out of hours" });
    await unassignLoad(l.id, null); // a declined assignment needs no reason to clear
    expect(await prisma.assignment.count({ where: { loadId: l.id } })).toBe(0);
  });

  test("a load that is on the road cannot be unassigned", async () => {
    const l = await makeLoad("AUD-5", base + 30 * D, base + 31 * D);
    await assignDriver({ loadId: l.id, driverId, pay: { kind: "flat", rate: 350 } });
    await prisma.load.update({ where: { id: l.id }, data: { status: "in_progress" } });
    await expect(unassignLoad(l.id, "x".repeat(5))).rejects.toBeInstanceOf(DispatchError);
  });

  test("invoicing and payment leave events, and the audit list filters by group and text", async () => {
    const l = await makeLoad("AUD-6", base + 40 * D, base + 41 * D, { status: "completed", completedAt: new Date(), actualRevenue: 700, payTermsDays: 30 });
    expect(await invoiceLoad(l.id)).toMatchObject({ ok: true });
    expect(await invoiceLoad(l.id)).toMatchObject({ ok: false }); // already invoiced
    expect(await markLoadPaid(l.id)).toEqual({ ok: true });
    expect((await listLoadAudit(l.id)).map((e) => e.action)).toEqual(["paid", "invoiced"]);

    const money = await listAudit({ group: "money", q: "AUD-6" });
    expect(money.rows.map((e) => e.action).sort()).toEqual(["invoiced", "paid"]);
    expect(money.total).toBe(2);
    expect((await listAudit({ group: "intake", q: "AUD-6" })).total).toBe(0);
  });

  test("search finds the load by number, the driver by name, and the broker", async () => {
    const hits = await searchDesk("AUD-1");
    expect(hits.some((h) => h.kind === "load" && h.label === "AUD-1")).toBe(true);
    expect((await searchDesk("Audit Test Dri")).some((h) => h.kind === "driver")).toBe(true);
    expect((await searchDesk("Audit Test Br")).some((h) => h.kind === "broker" && h.href.startsWith("/loads?q="))).toBe(true);
    expect(await searchDesk("a")).toEqual([]);
  });
});
