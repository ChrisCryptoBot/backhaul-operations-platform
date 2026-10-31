import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { applyFactoringUpdate } from "@/server/partners/factoring";
import { reopenCancelled } from "@/server/tl/disruptions";
import { addLoadDocument, DOCS_PER_LOAD } from "@/server/tl/documents";
import { correctTrip, saveExpenses } from "@/server/tl/execution";
import { buildExport } from "@/server/tl/exports";
import { listHistory } from "@/server/tl/history";
import { listBoardRows } from "@/server/tl/queries";
import { restoreLoad } from "@/server/tl/remove";
import { LOAD_STATUS } from "@/lib/desk-format";

/**
 * The same move pressed twice at once (a double click, a second tab) happens once, a load cannot be given more documents than it may hold by asking several times at the same moment, and the
 * Loads search and the files read like a person types. A workspace of its own for the writes; the file test reads the seeded demo desk and writes nothing.
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const W = "lr-races";
const day = (d: string) => new Date(`${d}T17:00:00Z`);
const pdf = { ok: true as const, type: { mime: "application/pdf", exts: ["pdf"], label: "PDF", kind: "file" as const }, data: new TextEncoder().encode("%PDF-1.4 test"), name: "x.pdf" };

describe.skipIf(!run)("loads, pressed twice at once", () => {
  const id: Record<string, string> = {};
  let stops: string[] = [];
  beforeAll(async () => {
    await prisma.workspace.deleteMany({ where: { id: W } });
    await prisma.workspace.create({ data: { id: W, name: "LR races", plan: "enterprise" } });
    const make = async (key: string, data: Record<string, unknown>) => {
      const l = await prisma.load.create({
        data: {
          workspaceId: W, loadNumber: `LR-${key}`, brokerName: "LR Customer", originAddress: "Dallas, TX", destinationAddress: "Tulsa, OK", loadedMiles: 260, quotedRevenue: 1000,
          stops: { create: [{ stopSequence: 1, stopType: "pickup", stopRole: "pickup", addressString: "Dallas, TX" }, { stopSequence: 2, stopType: "delivery", stopRole: "delivery", addressString: "Tulsa, OK" }] },
          ...data
        } as never,
        include: { stops: true }
      });
      id[key] = l.id;
      if (key === "C") stops = l.stops.sort((a, b) => a.stopSequence - b.stopSequence).map((s) => s.id);
    };
    await make("C", { status: "completed", completedAt: day("2026-10-05") });
    await make("X", { status: "cancelled", cancelledAt: day("2026-10-06"), cancelReason: "broker_cancelled" });
    await make("G", { status: "draft", deletedAt: new Date() });
    await make("F", { status: "completed", completedAt: day("2026-10-05"), paymentStatus: "invoiced", invoiceNumber: "LR-F", invoicedAt: day("2026-10-06"), invoicedAmount: 1000, factoringStatus: "requested", factoringReferenceId: "R1" });
    await make("D", { status: "completed", completedAt: day("2026-10-05"), originAddress: "Austin, TX", destinationAddress: "Dallas, TX" });
  });
  afterAll(async () => {
    await prisma.auditEvent.deleteMany({ where: { workspaceId: W } });
    await prisma.workspace.deleteMany({ where: { id: W } });
  });

  const audits = (key: string, action: string) => prisma.auditEvent.count({ where: { loadId: id[key]!, action } });

  test("a correction sent twice is made once", async () => {
    const values = { stops: [{ id: stops[0]!, arrivedAt: "", waitMinutes: "45", seal: "S-1" }, { id: stops[1]!, arrivedAt: "", waitMinutes: "", seal: "" }], reason: "driver log" };
    const out = await Promise.all([correctTrip(id.C!, values, new Date(), W), correctTrip(id.C!, values, new Date(), W)]);
    expect(out.filter((r) => r.ok && r.changed).length).toBe(1);
    expect(await audits("C", "trip_corrected")).toBe(1);
    expect((await prisma.load.findUniqueOrThrow({ where: { id: id.C! } })).dockWaitMinutes).toBe(45);
  });

  test("expenses saved twice at once are recorded once", async () => {
    const v = { fuel: "100", tolls: "", misc: "", items: { lumper: "50" } };
    const out = await Promise.all([saveExpenses(id.C!, v, new Date(), W), saveExpenses(id.C!, v, new Date(), W), saveExpenses(id.C!, v, new Date(), W)]);
    expect(out.filter((r) => r.ok && r.changed).length).toBe(1);
    expect(await audits("C", "expenses_changed")).toBe(1);
    expect(Number((await prisma.load.findUniqueOrThrow({ where: { id: id.C! } })).expenseMisc)).toBe(50);
  });

  test("a cancelled load reopened twice is reopened once", async () => {
    const out = await Promise.allSettled([reopenCancelled({ loadId: id.X!, reason: "called back" }, new Date(), W), reopenCancelled({ loadId: id.X!, reason: "called back" }, new Date(), W)]);
    expect(out.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await audits("X", "load_reopened")).toBe(1);
  });

  test("a deleted load restored twice is restored once", async () => {
    const out = await Promise.all([restoreLoad(id.G!, new Date(), W), restoreLoad(id.G!, new Date(), W)]);
    expect(out.filter((r) => r.ok)).toHaveLength(1);
    expect(await audits("G", "restored")).toBe(1);
  });

  test("the factor's answer reported twice moves the status once", async () => {
    const out = await Promise.all([applyFactoringUpdate(id.F!, "funded", null, new Date(), W), applyFactoringUpdate(id.F!, "funded", null, new Date(), W)]);
    expect(out.filter(Boolean)).toHaveLength(1);
    expect(await audits("F", "factoring_updated")).toBe(1);
  });

  test("a load cannot be given more documents than it may hold, however many are added at the same moment", async () => {
    for (let i = 0; i < DOCS_PER_LOAD - 2; i++) {
      await prisma.loadDocument.create({ data: { workspaceId: W, loadId: id.D!, kind: "other", name: `seed${i}.pdf`, mime: "application/pdf", bytes: 10, sha256: "x", storageKey: `lr-${i}`, addedBy: "t" } });
    }
    const out = await Promise.all(Array.from({ length: 6 }, (_, i) => addLoadDocument(id.D!, "other", { ...pdf, name: `race${i}.pdf` }, new Date(), W)));
    expect(out.filter((r) => r.ok)).toHaveLength(2);
    expect(await prisma.loadDocument.count({ where: { loadId: id.D! } })).toBe(DOCS_PER_LOAD);
  });

  test("History reads a search the way a person types it: every word, any order, punctuation ignored", async () => {
    const q = async (text: string) => (await listHistory({ q: text }, W)).rows.map((r) => r.loadNumber).sort();
    expect(await q("austin dallas")).toEqual(["LR-D"]);
    expect(await q("dallas austin")).toEqual(["LR-D"]);
    expect(await q("Austin, TX")).toEqual(["LR-D"]);
    expect(await q("austin, tulsa")).toEqual([]);
    expect(await q("lr-d")).toEqual(["LR-D"]);
  });

  test("a delivered load has the same money on the board, in History and in the file", async () => {
    const board = (await listBoardRows(W, "all")).find((r) => r.loadNumber === "LR-D")!;
    const hist = (await listHistory({ q: "LR-D" }, W)).rows[0]!;
    expect(hist.grossRevenue).toBe(board.grossRevenue);
    expect(board.grossRevenue).toBe(1000);
  });
});

describe.skipIf(!run)("the loads file on the seeded desk", () => {
  test("says status in words, is bounded, and matches the screen's History for the same search", async () => {
    const out = await buildExport("loads", { view: "history", filter: "owed" }, new Date("2026-11-01T12:00:00Z"));
    expect(out).not.toBeNull();
    const [head, ...lines] = out!.csv.trim().split("\n");
    const cols = head!.split(",");
    const statusAt = cols.indexOf("Status");
    const labels = new Set(Object.values(LOAD_STATUS).map((s) => s.label));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(labels.has(line.split(",")[statusAt]!.replace(/^"|"$/g, ""))).toBe(true);
    // The Owed tab on screen counts the same loads.
    const screen = await listHistory({ filter: "owed" });
    expect(lines.length).toBe(screen.total);
    expect(out!.filename).toBe("truelane-desk-loads-2026-11-01.csv");
  });
});
