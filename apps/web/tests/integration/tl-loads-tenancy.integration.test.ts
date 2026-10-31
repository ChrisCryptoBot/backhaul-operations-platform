import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { toCentralLocal } from "@/lib/zoned";
import { applyFactoringUpdate } from "@/server/partners/factoring";
import { cancelLoad, recordTonu, reopenCancelled, rescheduleLoad } from "@/server/tl/disruptions";
import { addLoadDocument, removeLoadDocument } from "@/server/tl/documents";
import { completeTrip, correctTrip, reopenDelivered, saveExpenses, startTrip, undoStartTrip } from "@/server/tl/execution";
import { invoiceLoad, markLoadPaid, undoPaid } from "@/server/tl/invoicing";
import { deleteLoad, restoreLoad } from "@/server/tl/remove";
import { listBoardRows } from "@/server/tl/queries";
import { listHistory } from "@/server/tl/history";
import { listDeletedLoads } from "@/server/tl/deleted";

/**
 * One workspace can never touch another's loads. Every action a dispatcher has on a load is called with a real, valid request against a load that belongs to a different workspace;
 * each has to refuse, and the load has to be exactly as it was. The lists of the second workspace must not show the first's loads either.
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const A = "lt-a";
const B = "lt-b";
const H = 3_600_000;
const day = (d: string) => new Date(`${d}T17:00:00Z`);
const past = (h: number) => toCentralLocal(Date.now() - h * H);

/** Whether a call was turned away: it threw, or it answered that it did not go through. */
async function refused(call: () => Promise<unknown>): Promise<boolean> {
  try {
    const out = (await call()) as { ok?: boolean } | boolean | undefined | null;
    if (out === false) return true;
    return typeof out === "object" && out !== null && out.ok === false;
  } catch {
    return true;
  }
}

describe.skipIf(!run)("loads cannot be reached across workspaces", () => {
  const id: Record<string, string> = {};
  let stopIds: string[] = [];
  let docId = "";

  beforeAll(async () => {
    for (const w of [A, B]) {
      await prisma.workspace.deleteMany({ where: { id: w } });
      await prisma.workspace.create({ data: { id: w, name: `LT ${w}`, plan: "enterprise" } });
    }
    const driver = await prisma.driver.create({ data: { workspaceId: A, name: "LT Driver" } });
    const make = async (key: string, data: Record<string, unknown>, assignment?: string) => {
      const l = await prisma.load.create({
        data: {
          workspaceId: A, loadNumber: `LT-${key}`, brokerName: "LT Customer", brokerEmail: "ap@lt.test", originAddress: "Dallas, TX", destinationAddress: "Tulsa, OK", loadedMiles: 260, quotedRevenue: 1000,
          stops: { create: [{ stopSequence: 1, stopType: "pickup", stopRole: "pickup", addressString: "Dallas, TX", timeWindowEarliest: day("2028-01-10"), timeWindowLatest: day("2028-01-10") }, { stopSequence: 2, stopType: "delivery", stopRole: "delivery", addressString: "Tulsa, OK", timeWindowEarliest: day("2028-01-11") }] },
          ...(assignment ? { assignment: { create: { driverId: driver.id, payKind: "cpm", payRate: 0.5, status: assignment } } } : {}),
          ...data
        } as never,
        include: { stops: true }
      });
      id[key] = l.id;
      if (key === "R") stopIds = l.stops.sort((a, b) => a.stopSequence - b.stopSequence).map((s) => s.id);
    };
    await make("S", { status: "accepted" }, "accepted");
    await make("R", { status: "in_progress" }, "in_progress");
    await make("C", { status: "completed", completedAt: day("2026-10-05") }, "completed");
    await make("X", { status: "cancelled", cancelledAt: day("2026-10-06"), cancelReason: "broker_cancelled" });
    await make("D", { status: "draft" });
    await make("T", { status: "accepted" }, "accepted");
    await make("G", { status: "draft", deletedAt: new Date() });
    await make("I", { status: "completed", completedAt: day("2026-10-05"), paymentStatus: "invoiced", invoiceNumber: "LT-I", invoicedAt: day("2026-10-06"), invoicedAmount: 1000, payTermsDays: 30, factoringStatus: "requested", factoringReferenceId: "R1" });
    const doc = await prisma.loadDocument.create({ data: { workspaceId: A, loadId: id.C!, kind: "pod", name: "pod.pdf", mime: "application/pdf", bytes: 10, sha256: "x", storageKey: "lt-key", addedBy: "t" } });
    docId = doc.id;
  });
  afterAll(async () => {
    await prisma.auditEvent.deleteMany({ where: { workspaceId: { in: [A, B] } } });
    for (const w of [A, B]) await prisma.workspace.deleteMany({ where: { id: w } });
  });

  const snapshot = async () => JSON.stringify(await prisma.load.findMany({ where: { workspaceId: A }, include: { stops: { orderBy: { stopSequence: "asc" } }, assignment: true, documents: true }, orderBy: { loadNumber: "asc" } }));

  test("every action refuses a load that is not the caller's, and changes nothing", async () => {
    const before = await snapshot();
    const now = new Date();
    const calls: Array<[string, () => Promise<unknown>]> = [
      ["startTrip", () => startTrip(id.S!, { arrivedAt: past(2), waitMinutes: "", seal: "" }, now, B)],
      ["undoStartTrip", () => undoStartTrip(id.R!, "wrong load", now, B)],
      ["completeTrip", () => completeTrip(id.R!, { stops: [], deliveredAt: past(1), pod: "received", podNote: "", fuel: "", tolls: "", misc: "" }, now, B)],
      ["saveExpenses", () => saveExpenses(id.R!, { fuel: "10", tolls: "", misc: "" }, now, B)],
      ["correctTrip", () => correctTrip(id.R!, { stops: [{ id: stopIds[0]!, arrivedAt: "", waitMinutes: "30", seal: "" }], reason: "typo" }, now, B)],
      ["reopenDelivered", () => reopenDelivered(id.C!, "wrong load", now, B)],
      ["cancelLoad", () => cancelLoad({ loadId: id.D!, reason: "broker_cancelled" }, now, B)],
      ["recordTonu", () => recordTonu({ loadId: id.T!, reason: "shipper_not_ready", fee: 100 }, now, B)],
      ["rescheduleLoad", () => rescheduleLoad({ loadId: id.D!, reason: "shipper_not_ready", newPickup: day("2028-02-01") }, now, B)],
      ["reopenCancelled", () => reopenCancelled({ loadId: id.X!, reason: "called back" }, now, B)],
      ["deleteLoad", () => deleteLoad({ loadId: id.D!, reason: "duplicate" }, now, B)],
      ["restoreLoad", () => restoreLoad(id.G!, now, B)],
      ["invoiceLoad", () => invoiceLoad(id.C!, {}, now, B)],
      ["markLoadPaid", () => markLoadPaid(id.I!, now, {}, B)],
      ["undoPaid", () => undoPaid(id.I!, "wrong invoice", now, B)],
      ["applyFactoringUpdate", () => applyFactoringUpdate(id.I!, "funded", null, now, B)],
      ["addLoadDocument", () => addLoadDocument(id.C!, "pod", { name: "x.pdf", mime: "application/pdf", data: new Uint8Array([1, 2, 3]) } as never, now, B)],
      ["removeLoadDocument", () => removeLoadDocument(docId, now, B)]
    ];
    for (const [name, call] of calls) expect(await refused(call), name).toBe(true);
    expect(await snapshot()).toBe(before);
  });

  test("the second workspace's lists never show the first's loads", async () => {
    expect((await listBoardRows(B, "all")).length).toBe(0);
    expect((await listHistory({}, B)).rows.length).toBe(0);
    expect((await listHistory({ q: "LT-" }, B)).total).toBe(0);
    expect((await listDeletedLoads(B)).length).toBe(0);
    // And the first sees its own, so the test is not passing on an empty database.
    expect((await listBoardRows(A, "all")).length).toBeGreaterThan(5);
    expect((await listDeletedLoads(A)).map((r) => r.loadNumber)).toEqual(["LT-G"]);
  });
});
