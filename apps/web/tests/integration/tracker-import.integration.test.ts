import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { clearKpiCache, getDeskKpi } from "@/server/tl/kpi";
import { commitHistoryImport, getImportedHistory, listHistoryImports, previewHistoryImport, removeHistoryImport } from "@/server/tl/tracker-import";

/**
 * A carrier's weekly tracker into "imported history", in a workspace of its own: the file is read the same way by the preview and the import, a lane-week already imported is left out, nothing becomes a load or
 * changes a figure built from loads, a whole batch can be taken away, and one desk never reads or removes another's.
 *   DATABASE_URL=postgresql://demo:demo@localhost:54330/demo RUN_DB_INTEGRATION=true npx vitest run tests/integration/tracker-import.integration.test.ts
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const W = "ti-w";
const OTHER = "ti-other";
const NOW = new Date();

const HEADER = "Week Ending,Lane,Loads,Revenue,FSC,Miles,Deadhead";
const FILE = [
  HEADER,
  "2026-09-13,Dallas TX to Atlanta GA,6,\"$12,900.00\",1080,\"4,686\",300",
  "2026-09-20,Dallas TX to Atlanta GA,5,10750,900,3905,0",
  "2026-09-20,\"Tulsa, OK to Joplin, MO\",3,1800,,360,40",
  "2026-09-18,dallas tx to atlanta ga,1,1000,0,781,0", // the same lane and week as line 3
  "2026-09-20,Dallas,2,100,0,10,0" // a lane that is not two places
].join("\n");

async function wipe(id: string) {
  await prisma.workspace.deleteMany({ where: { id } });
}

describe.skipIf(!run)("weekly history import", () => {
  let batch = "";
  beforeAll(async () => {
    await wipe(W);
    await wipe(OTHER);
    await prisma.workspace.create({ data: { id: W, name: "TI fleet", plan: "enterprise" } });
    await prisma.workspace.create({ data: { id: OTHER, name: "TI other", plan: "enterprise" } });
  });
  afterAll(async () => {
    await wipe(W);
    await wipe(OTHER);
  });

  test("the preview reads the file: three ready, one lane-week twice, one mistake with its line", async () => {
    const p = await previewHistoryImport(FILE, null, W);
    expect(p).toMatchObject({ ok: true, total: 5, ready: 3, duplicates: 1, problemCount: 1, missing: [] });
    if (!p.ok) return;
    expect(p.problems[0]).toMatchObject({ line: 6 });
    expect(p.sample.map((s) => [s.week, s.lane, s.loads, s.revenue])).toEqual([["2026-09-07", "Dallas, TX → Atlanta, GA", 6, 13980], ["2026-09-14", "Dallas, TX → Atlanta, GA", 5, 11650], ["2026-09-14", "Tulsa, OK → Joplin, MO", 3, 1800]]);
    expect(p.summary).toMatchObject({ weeks: 2, lanes: 2, loads: 14, first: "2026-09-07", last: "2026-09-14" });
  });

  test("a column with no match is named; pointing the field at the right column fixes it; an empty file is refused", async () => {
    const odd = FILE.replace("Revenue", "Mystery");
    const p = await previewHistoryImport(odd, null, W);
    expect(p).toMatchObject({ ok: true, ready: 0 });
    if (!p.ok) return;
    expect(p.missing.map((m) => m.key)).toEqual(["lineHaul"]);
    expect(await previewHistoryImport(odd, { ...p.map, lineHaul: p.fileHeader.indexOf("Mystery") }, W)).toMatchObject({ ok: true, ready: 3 });
    expect(await commitHistoryImport(odd, null, "x.csv", NOW, W)).toMatchObject({ ok: false, error: expect.stringMatching(/Match a column to Line haul/) });
    expect(await previewHistoryImport("", null, W)).toMatchObject({ ok: false, error: expect.stringMatching(/empty/) });
  });

  test("the import writes lane-weeks of their own table and one audit event; no load is made", async () => {
    const out = await commitHistoryImport(FILE, null, "tracker.csv", NOW, W);
    expect(out).toMatchObject({ ok: true, created: 3, duplicates: 1, skipped: 1 });
    if (!out.ok) return;
    batch = out.batchId;
    const rows = await prisma.importedHistory.findMany({ where: { workspaceId: W }, orderBy: [{ weekStart: "asc" }, { lane: "asc" }] });
    expect(rows.map((r) => [r.weekStart.toISOString().slice(0, 10), r.lane, r.loads])).toEqual([["2026-09-07", "Dallas, TX → Atlanta, GA", 6], ["2026-09-14", "Dallas, TX → Atlanta, GA", 5], ["2026-09-14", "Tulsa, OK → Joplin, MO", 3]]);
    expect(Number(rows[0]!.lineHaul)).toBe(12900);
    expect(Number(rows[0]!.fuelSurcharge)).toBe(1080);
    expect(Number(rows[0]!.loadedMiles)).toBe(4686);
    expect(Number(rows[0]!.emptyMiles)).toBe(300);
    expect(rows[0]!.source).toBe("tracker.csv");
    expect(await prisma.load.count({ where: { workspaceId: W } })).toBe(0);
    const audit = await prisma.auditEvent.findMany({ where: { workspaceId: W, action: "history_import_completed" } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ entityId: batch });
    expect(audit[0]!.summary).toBe("3 lane-weeks of weekly history imported from tracker.csv; 1 already imported; 1 row left out");
  });

  test("the same file again writes nothing; two clicks at once write once", async () => {
    expect(await commitHistoryImport(FILE, null, "tracker.csv", NOW, W)).toEqual({ ok: false, error: "Every week in that file is already in the imported history." });
    const more = `${HEADER}\n2026-09-27,Waco TX to Austin TX,2,500,0,200,0`;
    const [x, y] = await Promise.all([commitHistoryImport(more, null, "more.csv", NOW, W), commitHistoryImport(more, null, "more.csv", NOW, W)]);
    expect([x, y].filter((r) => r.ok)).toHaveLength(1);
    expect(await prisma.importedHistory.count({ where: { workspaceId: W, lane: "Waco, TX → Austin, TX" } })).toBe(1);
    await removeHistoryImport(([x, y].find((r) => r.ok) as { batchId: string }).batchId, NOW, W);
  });

  test("the history is added up by week and by lane, and never touches a figure built from loads", async () => {
    clearKpiCache();
    const before = await getDeskKpi({ period: "all", compare: false }, NOW, W);
    const h = await getImportedHistory(W);
    expect(h.rows).toBe(3);
    expect(h.first).toBe("2026-09-07");
    expect(h.last).toBe("2026-09-14");
    expect(h.sources).toEqual(["tracker.csv"]);
    expect(h.weeks.map((w) => [w.weekStart, w.loads, w.revenue, w.lanes])).toEqual([["2026-09-07", 6, 13980, 1], ["2026-09-14", 8, 13450, 2]]);
    expect(h.lanes.map((l) => [l.lane, l.loads, l.weeks])).toEqual([["Dallas, TX → Atlanta, GA", 11, 2], ["Tulsa, OK → Joplin, MO", 3, 1]]);
    expect(before.current.loads).toBe(0);
    expect(before.lanes).toEqual([]);
    expect((await getImportedHistory(OTHER)).rows).toBe(0);
  });

  test("the imports are listed with their rows still there; a batch is taken away whole, and not by another desk", async () => {
    expect((await listHistoryImports(10, W)).find((b) => b.batchId === batch)).toMatchObject({ rows: 3, removed: false });
    expect(await removeHistoryImport("nope", NOW, W)).toMatchObject({ ok: false });
    expect(await removeHistoryImport(batch, NOW, OTHER)).toMatchObject({ ok: false, error: "That import is not on this desk." });
    expect(await removeHistoryImport(batch, NOW, W)).toEqual({ ok: true, removed: 3 });
    expect(await prisma.importedHistory.count({ where: { workspaceId: W } })).toBe(0);
    expect(await removeHistoryImport(batch, NOW, W)).toMatchObject({ ok: false, error: "Nothing of that import is left on the desk." });
    expect((await listHistoryImports(10, W)).find((b) => b.batchId === batch)).toMatchObject({ rows: 0, removed: true });
  });

  test("after a removal the same file can be imported again", async () => {
    expect(await commitHistoryImport(FILE, null, "again.csv", NOW, W)).toMatchObject({ ok: true, created: 3 });
  });
});
