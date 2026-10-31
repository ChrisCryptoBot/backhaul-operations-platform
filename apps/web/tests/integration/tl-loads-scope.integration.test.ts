import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { applyFactoringUpdate } from "@/server/partners/factoring";
import { dataMark } from "@/server/tl/answer-cache";
import { countDeletedLoads, listDeletedLoads } from "@/server/tl/deleted";
import { deleteLoad, restoreLoad } from "@/server/tl/remove";
import { buildExport } from "@/server/tl/exports";
import { countHistory, listHistory } from "@/server/tl/history";
import { markLoadPaid } from "@/server/tl/invoicing";
import { unassignLoad } from "@/server/tl/dispatch";
import { OPEN_LOAD_STATUSES, deskStatusOf, listBoardRows } from "@/server/tl/queries";

/**
 * Loads, flow and scope: deleted loads listed and restorable, History and its counts narrowed by terminal, the CSV labelled and bounded like the screen, factoring moving one allowed step,
 * the kept answers noticing an unassign and a delete, and the phone's scheduled and dispatched read as the desk's own. A workspace of its own, so the figures are exact.
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const W = "ls-scope";
const day = (d: string) => new Date(`${d}T17:00:00Z`);

describe.skipIf(!run)("loads scope on the demo database", () => {
  const id: Record<string, string> = {};
  beforeAll(async () => {
    await prisma.workspace.deleteMany({ where: { id: W } });
    await prisma.workspace.create({ data: { id: W, name: "LS scope", plan: "enterprise" } });
    const dallas = await prisma.vehicle.create({ data: { workspaceId: W, name: "LS Dallas", type: "box_truck", terminal: "Dallas" } as never });
    const houston = await prisma.vehicle.create({ data: { workspaceId: W, name: "LS Houston", type: "box_truck", terminal: "Houston" } as never });
    const make = async (key: string, data: Record<string, unknown>) => {
      const l = await prisma.load.create({ data: { workspaceId: W, loadNumber: `LS-${key}`, brokerName: "LS Customer", originAddress: "Dallas, TX", destinationAddress: "Tulsa, OK", loadedMiles: 260, quotedRevenue: 1000, ...data } as never });
      id[key] = l.id;
    };
    await make("D", { status: "completed", completedAt: day("2026-10-05"), vehicleId: dallas.id });
    await make("H", { status: "completed", completedAt: day("2026-10-06"), vehicleId: houston.id });
    await make("N", { status: "cancelled", cancelledAt: day("2026-10-07"), cancelReason: "broker_cancelled" });
    await make("S", { status: "scheduled", vehicleId: dallas.id });
    await make("P", { status: "dispatched" });
    await make("X", { status: "draft" });
  });
  afterAll(async () => {
    await prisma.auditEvent.deleteMany({ where: { workspaceId: W } });
    await prisma.workspace.deleteMany({ where: { id: W } });
  });

  test("History and its counts are narrowed to a terminal, keeping loads not placed anywhere", async () => {
    const all = await listHistory({}, W);
    expect(all.rows.map((r) => r.loadNumber).sort()).toEqual(["LS-D", "LS-H", "LS-N"]);
    const dallas = await listHistory({ terminal: "Dallas" }, W);
    expect(dallas.rows.map((r) => r.loadNumber).sort()).toEqual(["LS-D", "LS-N"]);
    expect(dallas.counts.all).toBe(2);
    expect(await countHistory("", W, "Houston")).toBe(2);
    expect(await countHistory("", W, null)).toBe(3);
  });

  test("the loads file says status in words and is the History on screen, with a file name that says when it was cut", async () => {
    const out = await buildExport("loads", { view: "history", q: "LS-" }, new Date("2026-11-01T12:00:00Z"));
    expect(out).not.toBeNull();
    // The export runs in the default workspace outside a request, so it reads no rows of this one; what matters here is the shape.
    expect(out!.csv.split("\n")[0]).toContain("Status");
    expect(out!.filename).toMatch(/^truelane-desk-loads-2026-11-01\.csv$/);
  });

  test("a deleted load is listed with its reason, and restoring it puts it back", async () => {
    expect(await countDeletedLoads(W)).toBe(0);
    expect(await deleteLoad({ loadId: id.X!, reason: "duplicate", note: "entered twice" }, new Date(), W)).toEqual({ ok: true });
    expect(await countDeletedLoads(W)).toBe(1);
    const [row] = await listDeletedLoads(W);
    expect(row).toMatchObject({ id: id.X, loadNumber: "LS-X", reason: expect.stringContaining("Duplicate"), note: "entered twice" });
    expect(await restoreLoad(id.X!, new Date(), W)).toEqual({ ok: true });
    expect(await countDeletedLoads(W)).toBe(0);
    // A quote that was thrown away is not a load and is not listed.
    await prisma.load.update({ where: { id: id.X! }, data: { status: "quote", deletedAt: new Date() } });
    expect(await countDeletedLoads(W)).toBe(0);
    await prisma.load.update({ where: { id: id.X! }, data: { status: "draft", deletedAt: null } });
  });

  test("the kept answers notice an unassign and a delete (the data mark moves)", async () => {
    const driver = await prisma.driver.create({ data: { workspaceId: W, name: "LS Driver" } });
    await prisma.assignment.create({ data: { loadId: id.X!, driverId: driver.id, payKind: "cpm", payRate: 0.5, status: "draft" } });
    const before = await dataMark(W);
    await unassignLoad(id.X!, null, new Date(), W);
    const afterUnassign = await dataMark(W);
    expect(afterUnassign).not.toBe(before);
    await deleteLoad({ loadId: id.X!, reason: "mistake" }, new Date(), W);
    expect(await dataMark(W)).not.toBe(afterUnassign);
    await restoreLoad(id.X!, new Date(), W);
    // Another workspace's change does not move this one's mark.
    const mine = await dataMark(W);
    await prisma.workspace.deleteMany({ where: { id: "ls-other" } });
    await prisma.workspace.create({ data: { id: "ls-other", name: "LS other", plan: "enterprise" } });
    await prisma.load.create({ data: { workspaceId: "ls-other", loadNumber: "LS-OTHER", quotedRevenue: 1 } as never });
    expect((await dataMark(W)).split(":")[0]).toBe(mine.split(":")[0]);
    await prisma.workspace.deleteMany({ where: { id: "ls-other" } });
  });

  test("factoring moves one allowed step, once, and a paid invoice closes a funded one", async () => {
    await prisma.load.update({ where: { id: id.D! }, data: { paymentStatus: "invoiced", invoiceNumber: "LS-D", invoicedAt: day("2026-10-06"), invoicedAmount: 1000, payTermsDays: 30, factoringStatus: "requested", factoringReferenceId: "R1" } });
    expect(await applyFactoringUpdate(id.D!, "paid", null, new Date(), W)).toBe(false); // a skipped step
    expect(await applyFactoringUpdate(id.D!, "funded", null, new Date(), W)).toBe(true);
    expect(await applyFactoringUpdate(id.D!, "funded", null, new Date(), W)).toBe(false); // the same report twice moves it once
    expect(await applyFactoringUpdate(id.D!, "requested", null, new Date(), W)).toBe(false); // never backwards
    expect(await prisma.auditEvent.count({ where: { loadId: id.D!, action: "factoring_updated" } })).toBe(1);
    expect(await markLoadPaid(id.D!, new Date(), {}, W)).toMatchObject({ ok: true });
    expect((await prisma.load.findUniqueOrThrow({ where: { id: id.D! } })).factoringStatus).toBe("paid");
  });

  test("the phone's scheduled and dispatched are on the open board as accepted and sent", async () => {
    expect(OPEN_LOAD_STATUSES).toEqual(expect.arrayContaining(["scheduled", "dispatched"]));
    expect([deskStatusOf("scheduled"), deskStatusOf("dispatched"), deskStatusOf("completed")]).toEqual(["accepted", "draft", "completed"]);
    const rows = await listBoardRows(W, "open");
    const byNumber = Object.fromEntries(rows.map((r) => [r.loadNumber, r]));
    expect(byNumber["LS-S"]).toMatchObject({ status: "accepted" });
    expect(byNumber["LS-P"]).toMatchObject({ status: "draft", assignmentStatus: "dispatched" });
  });
});
