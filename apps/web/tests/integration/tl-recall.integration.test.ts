import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { assignDriver, dispatchLoad, DispatchError, recordDriverResponse, unassignLoad } from "@/server/tl/dispatch";
import { holderTrail, recalledLoads } from "@/server/tl/assignment-events";
import { listLoadAudit } from "@/server/tl/audit";

/**
 * Recall and the holder trail (docs/RELAY_DESIGN.md, phase 1). Needs a seeded database (see tl-dispatch.integration.test.ts). Creates its own driver and loads in the demo workspace and
 * removes them, their audit events and their holder events afterwards, so the demo data is left as the seed wrote it.
 *   DATABASE_URL=postgresql://demo:demo@localhost:54330/demo RUN_DB_INTEGRATION=true npx vitest run tests/integration/tl-recall.integration.test.ts
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const WS = "demo-workspace";
const H = 3_600_000;
const D = 86_400_000;

describe.skipIf(!run)("recall and the holder trail", () => {
  const loadIds: string[] = [];
  let driverId = "";
  const base = Date.now() + 40 * D; // far enough out that no seeded load overlaps
  let n = 0;

  async function makeLoad(label: string) {
    const startMs = base + n++ * 3 * D;
    const l = await prisma.load.create({
      data: {
        workspaceId: WS,
        loadNumber: label,
        status: "draft",
        brokerName: "Recall Test Broker",
        originAddress: "Dallas, TX",
        destinationAddress: "Tulsa, OK",
        loadedMiles: 260,
        quotedRevenue: 700,
        stops: {
          create: [
            { stopSequence: 1, stopType: "pickup", addressString: "Dallas, TX", timeWindowEarliest: new Date(startMs), timeWindowLatest: new Date(startMs + 2 * H) },
            { stopSequence: 2, stopType: "delivery", addressString: "Tulsa, OK", timeWindowEarliest: new Date(startMs + D - 2 * H), timeWindowLatest: new Date(startMs + D) }
          ]
        }
      }
    });
    loadIds.push(l.id);
    return l;
  }
  const sendIt = async (id: string) => {
    await assignDriver({ loadId: id, driverId, pay: { kind: "cpm", rate: 0.65 } });
    await dispatchLoad(id);
  };

  beforeAll(async () => {
    driverId = (await prisma.driver.create({ data: { workspaceId: WS, name: "Recall Test Driver", cdlExpiry: new Date(Date.now() + 400 * D), medicalCardExpiry: new Date(Date.now() + 400 * D) } })).id;
  });
  afterAll(async () => {
    await prisma.assignmentEvent.deleteMany({ where: { loadId: { in: loadIds } } });
    await prisma.auditEvent.deleteMany({ where: { loadId: { in: loadIds } } });
    await prisma.bridgeOutbox.deleteMany({ where: { loadId: { in: loadIds } } });
    await prisma.load.deleteMany({ where: { id: { in: loadIds } } });
    await prisma.driver.delete({ where: { id: driverId } });
  });

  test("a driver who was never sent the load comes off with no reason, and that is not a recall", async () => {
    const l = await makeLoad("RC-1");
    await assignDriver({ loadId: l.id, driverId, pay: { kind: "flat", rate: 300 } });
    await unassignLoad(l.id, null);
    expect((await holderTrail(l.id)).map((e) => e.kind)).toEqual(["assigned", "removed"]);
    expect((await recalledLoads([l.id])).has(l.id)).toBe(false);
  });

  test("a sent load is not recalled without a reason code; with one, the recall is a stored event, an audit entry, and the load is back in the bucket", async () => {
    const l = await makeLoad("RC-2");
    await sendIt(l.id);
    await expect(unassignLoad(l.id, "free words are not enough")).rejects.toMatchObject({ code: "reason_required" });
    expect(await prisma.assignment.count({ where: { loadId: l.id } })).toBe(1);

    await unassignLoad(l.id, "  sent to the wrong person  ", undefined, undefined, undefined, "ASSIGNED_IN_ERROR");
    expect(await prisma.assignment.count({ where: { loadId: l.id } })).toBe(0);
    expect((await prisma.load.findUniqueOrThrow({ where: { id: l.id } })).status).toBe("draft");

    const trail = await holderTrail(l.id);
    expect(trail.map((e) => e.kind)).toEqual(["assigned", "sent", "recalled"]);
    expect(trail[2]).toMatchObject({ driverName: "Recall Test Driver", reasonCode: "ASSIGNED_IN_ERROR", reasonNote: "sent to the wrong person", via: "dispatcher" });

    const audit = (await listLoadAudit(l.id)).find((e) => e.action === "unassigned")!;
    expect(audit.reason).toBe("Assigned in error: sent to the wrong person");
    expect(audit.summary).toMatch(/recalled/);

    const recalled = (await recalledLoads([l.id])).get(l.id)!;
    expect(recalled).toMatchObject({ code: "ASSIGNED_IN_ERROR", driverName: "Recall Test Driver", delivery: "none" }); // not on the driver link: told directly
  });

  test("an accepted load can be recalled; it goes back to a draft", async () => {
    const l = await makeLoad("RC-3");
    await sendIt(l.id);
    await recordDriverResponse(l.id, "accepted");
    expect((await prisma.load.findUniqueOrThrow({ where: { id: l.id } })).status).toBe("accepted");
    await unassignLoad(l.id, null, undefined, undefined, undefined, "MECHANICAL_BREAKDOWN");
    expect((await prisma.load.findUniqueOrThrow({ where: { id: l.id } })).status).toBe("draft");
    expect((await holderTrail(l.id)).map((e) => e.kind)).toEqual(["assigned", "sent", "accepted", "recalled"]);
  });

  test("the scheduled relay is a handoff, not a recall, and an unknown code is refused; nothing is taken off", async () => {
    const l = await makeLoad("RC-4");
    await sendIt(l.id);
    await expect(unassignLoad(l.id, null, undefined, undefined, undefined, "SCHEDULED_RELAY")).rejects.toMatchObject({ code: "bad_reason" });
    await expect(unassignLoad(l.id, null, undefined, undefined, undefined, "WHATEVER" as never)).rejects.toMatchObject({ code: "bad_reason" });
    expect(await prisma.assignment.count({ where: { loadId: l.id } })).toBe(1);
  });

  test("a load on the road is not recalled here, with or without a code", async () => {
    const l = await makeLoad("RC-5");
    await sendIt(l.id);
    await recordDriverResponse(l.id, "accepted");
    await prisma.load.update({ where: { id: l.id }, data: { status: "in_progress" } });
    await prisma.assignment.update({ where: { loadId: l.id }, data: { status: "in_progress" } });
    await expect(unassignLoad(l.id, null, undefined, undefined, undefined, "HOS_TIMEOUT")).rejects.toMatchObject({ code: "not_unassignable" });
    expect(await prisma.assignment.count({ where: { loadId: l.id } })).toBe(1);
    expect((await holderTrail(l.id)).map((e) => e.kind)).not.toContain("recalled");
  });

  test("two recalls at once: one lands, the other is told the load moved, and there is one recall event", async () => {
    const l = await makeLoad("RC-6");
    await sendIt(l.id);
    const out = await Promise.allSettled([unassignLoad(l.id, null, undefined, undefined, undefined, "DRIVER_UNRESPONSIVE"), unassignLoad(l.id, null, undefined, undefined, undefined, "DRIVER_UNRESPONSIVE")]);
    expect(out.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    const bad = out.find((o) => o.status === "rejected") as PromiseRejectedResult;
    expect(bad.reason).toBeInstanceOf(DispatchError);
    expect((await holderTrail(l.id)).filter((e) => e.kind === "recalled")).toHaveLength(1);
  });

  test("a load someone is put on again after a recall stops being 'recalled'; the trail keeps the whole story in order", async () => {
    const l = await makeLoad("RC-7");
    await sendIt(l.id);
    await unassignLoad(l.id, null, undefined, undefined, undefined, "HOS_TIMEOUT");
    expect((await recalledLoads([l.id])).has(l.id)).toBe(true);
    await assignDriver({ loadId: l.id, driverId, pay: { kind: "cpm", rate: 0.7 } });
    expect((await recalledLoads([l.id])).has(l.id)).toBe(false);
    expect((await holderTrail(l.id)).map((e) => e.kind)).toEqual(["assigned", "sent", "recalled", "assigned"]);
  });

  test("another workspace's load is 'not found', never recalled", async () => {
    const l = await makeLoad("RC-8");
    await sendIt(l.id);
    await expect(unassignLoad(l.id, null, undefined, "some-other-workspace", undefined, "HOS_TIMEOUT")).rejects.toMatchObject({ code: "load_not_found" });
    expect(await prisma.assignment.count({ where: { loadId: l.id } })).toBe(1);
  });
});
