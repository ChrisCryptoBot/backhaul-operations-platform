import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import { IMPORT_MAX_ROWS, parseCsv, type ProblemRow } from "@/lib/import-csv";
import { autoWeekMap, checkWeekRows, cleanWeekMap, lanesOf, missingWeekFields, weekKeyOf, weeksOf, type HistoryLane, type HistoryRow, type HistoryWeek, type WeekCheck, type WeekFieldKey, type WeekMap } from "@/lib/tracker-import";
import { recordAudit } from "./audit";
import { lockWorkspace } from "./plan";
import { currentWorkspaceId } from "./workspace";

/**
 * Loading a carrier's own weekly tracker (lane-per-week totals) into "imported history" (lib/tracker-import.ts says what a file means). Same safety as the load importer: the file is read and checked on the server
 * every time, the rows that pass are written 500 at a time in one transaction with the workspace locked and the duplicate check made again under the lock, and ONE audit event names the batch so an import can be
 * taken away whole. These rows are kept apart from loads for good: nothing here creates a load or touches a figure built from loads.
 */
export const HISTORY_IMPORT_CHUNK = 500;

export type HistoryImportMap = Partial<Record<WeekFieldKey, number | null>>;

/** The lane-weeks already imported, as "week|lane" in lower case. */
async function existingKeys(workspaceId: string, db: Pick<typeof prisma, "$queryRaw"> = prisma): Promise<Set<string>> {
  const rows = await db.$queryRaw<Array<{ wk: string; ln: string }>>`select to_char(week_start, 'YYYY-MM-DD') as wk, lower(lane) as ln from imported_history where workspace_id = ${workspaceId}`;
  return new Set(rows.map((r) => `${r.wk}|${r.ln}`));
}

async function read(text: string, mapping: HistoryImportMap | null, workspaceId: string): Promise<{ ok: false; error: string } | { ok: true; table: string[][]; map: WeekMap; check: WeekCheck }> {
  const table = parseCsv(text);
  if (table.length === 0 || (table[0] ?? []).every((c) => c.trim() === "")) return { ok: false, error: "That file is empty. It needs a header row and one row per lane per week." };
  const header = table[0]!;
  const map = mapping ? cleanWeekMap(mapping, header.length) : autoWeekMap(header);
  const none: WeekCheck = { total: 0, good: [], problems: [], problemCount: 0, duplicates: 0, tooMany: false, summary: { weeks: 0, lanes: 0, loads: 0, revenue: 0, first: null, last: null } };
  if (missingWeekFields(map).length > 0) return { ok: true, table, map, check: none };
  return { ok: true, table, map, check: checkWeekRows(table, map, await existingKeys(workspaceId)) };
}

export type HistoryImportPreview =
  | { ok: false; error: string }
  | {
      ok: true;
      fileHeader: string[];
      firstRow: string[];
      map: Record<WeekFieldKey, number | null>;
      missing: Array<{ key: WeekFieldKey; label: string }>;
      total: number;
      ready: number;
      duplicates: number;
      problemCount: number;
      problems: ProblemRow[];
      sample: Array<{ line: number; week: string; lane: string; loads: number; revenue: number; loadedMiles: number; emptyMiles: number }>;
      summary: { weeks: number; lanes: number; loads: number; revenue: number; first: string | null; last: string | null };
    };

export async function previewHistoryImport(text: string, mapping: HistoryImportMap | null = null, workspaceId = currentWorkspaceId()): Promise<HistoryImportPreview> {
  const r = await read(text, mapping, workspaceId);
  if (!r.ok) return r;
  if (r.check.tooMany) return { ok: false, error: `That file has more than ${IMPORT_MAX_ROWS.toLocaleString("en-US")} rows. Split it and load the parts one at a time.` };
  const c = r.check;
  return {
    ok: true,
    fileHeader: r.table[0] ?? [],
    firstRow: r.table[1] ?? [],
    map: r.map,
    missing: missingWeekFields(r.map),
    total: c.total,
    ready: c.good.length,
    duplicates: c.duplicates,
    problemCount: c.problemCount,
    problems: c.problems,
    sample: c.good.slice(0, 8).map(({ line, item }) => ({ line, week: item.weekStart.toISOString().slice(0, 10), lane: item.lane, loads: item.loads, revenue: item.lineHaul + item.fuelSurcharge, loadedMiles: item.loadedMiles, emptyMiles: item.emptyMiles })),
    summary: c.summary
  };
}

export type HistoryImportResult = { ok: true; created: number; duplicates: number; skipped: number; batchId: string } | { ok: false; error: string };

export async function commitHistoryImport(text: string, mapping: HistoryImportMap | null, fileName: string, now = new Date(), workspaceId = currentWorkspaceId()): Promise<HistoryImportResult> {
  const r = await read(text, mapping, workspaceId);
  if (!r.ok) return r;
  const missing = missingWeekFields(r.map);
  if (missing.length > 0) return { ok: false, error: `Match a column to ${missing.map((m) => m.label).join(", ")} first.` };
  if (r.check.tooMany) return { ok: false, error: `That file has more than ${IMPORT_MAX_ROWS.toLocaleString("en-US")} rows. Split it and load the parts one at a time.` };
  if (r.check.good.length === 0) return { ok: false, error: r.check.duplicates > 0 ? "Every week in that file is already in the imported history." : "No row in that file can be imported. Fix the problems listed and load it again." };
  const file = fileName.trim().slice(0, 120) || "tracker.csv";
  const batchId = randomUUID().replace(/-/g, "").slice(0, 16);
  const out = await prisma.$transaction(
    async (tx) => {
      await lockWorkspace(tx, workspaceId);
      // Again under the lock: a second click that landed first is seen now.
      const have = await existingKeys(workspaceId, tx);
      const rows = r.check.good.filter((g) => !have.has(weekKeyOf(g.item.weekStart, g.item.lane)));
      if (rows.length === 0) return null;
      const data = rows.map(({ item: d }) => ({ workspaceId, batchId, weekStart: d.weekStart, lane: d.lane, loads: d.loads, lineHaul: d.lineHaul, fuelSurcharge: d.fuelSurcharge, loadedMiles: d.loadedMiles, emptyMiles: d.emptyMiles, source: file }));
      for (let i = 0; i < data.length; i += HISTORY_IMPORT_CHUNK) await tx.importedHistory.createMany({ data: data.slice(i, i + HISTORY_IMPORT_CHUNK) });
      const dup = r.check.duplicates + (r.check.good.length - rows.length);
      const n = data.length;
      await recordAudit(
        {
          entity: "intake",
          entityId: batchId,
          action: "history_import_completed",
          summary: `${n.toLocaleString("en-US")} lane-${n === 1 ? "week" : "weeks"} of weekly history imported from ${file}${dup > 0 ? `; ${dup.toLocaleString("en-US")} already imported` : ""}${r.check.problemCount > 0 ? `; ${r.check.problemCount.toLocaleString("en-US")} ${r.check.problemCount === 1 ? "row" : "rows"} left out` : ""}`,
          before: null,
          after: { File: file, "Rows read": String(r.check.total), Imported: String(n), "Already imported": String(dup), "Left out": String(r.check.problemCount) },
          at: now,
          workspaceId
        },
        tx
      );
      return { created: n, duplicates: dup };
    },
    { timeout: 120_000, maxWait: 10_000 }
  );
  if (out == null) return { ok: false, error: "Every week in that file is already in the imported history." };
  return { ok: true, created: out.created, duplicates: out.duplicates, skipped: r.check.problemCount, batchId };
}

export type HistoryBatch = { batchId: string; at: Date; summary: string; actor: string; rows: number; removed: boolean };

/** The weekly-history imports done on this desk, newest first, with how many rows of each are still in it. */
export async function listHistoryImports(limit = 10, workspaceId = currentWorkspaceId()): Promise<HistoryBatch[]> {
  const events = await prisma.auditEvent.findMany({ where: { workspaceId, action: { in: ["history_import_completed", "history_import_removed"] } }, orderBy: { createdAt: "desc" }, take: limit * 3, select: { entityId: true, action: true, summary: true, actor: true, createdAt: true } });
  const removed = new Set(events.filter((e) => e.action === "history_import_removed").map((e) => e.entityId));
  const done = events.filter((e) => e.action === "history_import_completed" && e.entityId).slice(0, limit);
  if (done.length === 0) return [];
  const counts = await prisma.importedHistory.groupBy({ by: ["batchId"], where: { workspaceId, batchId: { in: done.map((e) => e.entityId!) } }, _count: { _all: true } });
  const left = new Map(counts.map((c) => [c.batchId, c._count._all]));
  return done.map((e) => ({ batchId: e.entityId!, at: e.createdAt, summary: e.summary, actor: e.actor, rows: left.get(e.entityId!) ?? 0, removed: removed.has(e.entityId) }));
}

export type RemoveHistoryResult = { ok: true; removed: number } | { ok: false; error: string };

/** Take a whole weekly-history import away. Its rows are deleted outright: they are copies of a spreadsheet, and the file is the original. */
export async function removeHistoryImport(batchId: string, now = new Date(), workspaceId = currentWorkspaceId()): Promise<RemoveHistoryResult> {
  if (!/^[0-9a-f]{16}$/.test(batchId)) return { ok: false, error: "That import is not on this desk." };
  const made = await prisma.auditEvent.findFirst({ where: { workspaceId, action: "history_import_completed", entityId: batchId }, select: { id: true } });
  if (!made) return { ok: false, error: "That import is not on this desk." };
  return prisma.$transaction(async (tx) => {
    await lockWorkspace(tx, workspaceId);
    const res = await tx.importedHistory.deleteMany({ where: { workspaceId, batchId } });
    if (res.count === 0) return { ok: false as const, error: "Nothing of that import is left on the desk." };
    await recordAudit({ entity: "intake", entityId: batchId, action: "history_import_removed", summary: `${res.count.toLocaleString("en-US")} lane-${res.count === 1 ? "week" : "weeks"} of imported history removed`, before: null, after: { Removed: String(res.count) }, at: now, workspaceId }, tx);
    return { ok: true as const, removed: res.count };
  });
}

export type ImportedHistory = { weeks: HistoryWeek[]; lanes: HistoryLane[]; rows: number; first: string | null; last: string | null; sources: string[] };

/** How many weeks the screens show at most. */
export const HISTORY_WEEKS_SHOWN = 156;

/** The imported history as the screens show it: weeks oldest first (the newest 156), the biggest lanes, and which files it came from. Nothing in it is a load. */
export async function getImportedHistory(workspaceId = currentWorkspaceId()): Promise<ImportedHistory> {
  const rows = await prisma.importedHistory.findMany({ where: { workspaceId }, select: { weekStart: true, lane: true, loads: true, lineHaul: true, fuelSurcharge: true, loadedMiles: true, emptyMiles: true, source: true }, orderBy: { weekStart: "asc" } });
  const all: HistoryRow[] = rows.map((r) => ({ weekStart: r.weekStart.toISOString().slice(0, 10), lane: r.lane, loads: r.loads, lineHaul: r.lineHaul.toNumber(), fuelSurcharge: r.fuelSurcharge.toNumber(), loadedMiles: r.loadedMiles.toNumber(), emptyMiles: r.emptyMiles.toNumber() }));
  const weeks = weeksOf(all);
  const shown = weeks.slice(-HISTORY_WEEKS_SHOWN);
  return { weeks: shown, lanes: lanesOf(all), rows: all.length, first: weeks[0]?.weekStart ?? null, last: weeks[weeks.length - 1]?.weekStart ?? null, sources: [...new Set(rows.map((r) => r.source))].sort() };
}
