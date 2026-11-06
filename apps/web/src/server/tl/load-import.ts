import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import { IMPORT_MAX_ROWS, parseCsv, type ProblemRow } from "@/lib/import-csv";
import { autoMap, checkLoadRows, cleanMap, importChannel, missingFields, paymentOf, type ColumnMap, type LoadCheck, type LoadFieldKey } from "@/lib/load-import";
import { recordAudit } from "./audit";
import { lockWorkspace } from "./plan";
import { currentWorkspaceId } from "./workspace";

/**
 * Loading a carrier's finished loads from a file. The file is read and checked here, on the server, every time: the preview a person sees and the import that follows both run the same check against the
 * desk as it is then, so a preview that was true a minute ago cannot write a duplicate. The rows that pass are written 500 at a time inside one transaction, with the workspace locked and the duplicate
 * check made again under the lock (two clicks at once write once), and ONE audit event that names the batch. Every imported load carries `channel = "import:<batch>"`, so a batch can be found, counted
 * and taken away again. lib/load-import.ts says what a row means and what an imported load is (and is not).
 */
export const LOAD_IMPORT_CHUNK = 500;

export type LoadImportMap = Partial<Record<LoadFieldKey, number | null>>;

type Context = { table: string[][]; map: ColumnMap; check: LoadCheck };

/** The loads already on the desk with these numbers, by lower-cased number and then the customers that hold it ("" is a load with no customer). A deleted load and a saved quote are not loads. */
async function existingFor(numbers: string[], workspaceId: string, db: Pick<typeof prisma, "$queryRaw"> = prisma): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  const unique = [...new Set(numbers.map((n) => n.toLowerCase()).filter((n) => n !== ""))];
  for (let i = 0; i < unique.length; i += 5_000) {
    const rows = await db.$queryRaw<Array<{ n: string; b: string }>>`
      select lower(load_number) as n, lower(coalesce(broker_name, '')) as b from loads
      where workspace_id = ${workspaceId} and deleted_at is null and status <> 'quote' and lower(load_number) = any(${unique.slice(i, i + 5_000)})`;
    for (const r of rows) out.set(r.n, (out.get(r.n) ?? new Set()).add(r.b));
  }
  return out;
}

async function read(text: string, mapping: LoadImportMap | null, workspaceId: string): Promise<{ ok: false; error: string } | ({ ok: true } & Context)> {
  const table = parseCsv(text);
  if (table.length === 0 || (table[0] ?? []).every((c) => c.trim() === "")) return { ok: false, error: "That file is empty. It needs a header row and one row per load." };
  const header = table[0]!;
  const map = mapping ? cleanMap(mapping, header.length) : autoMap(header);
  const noCheck: LoadCheck = { total: 0, good: [], problems: [], problemCount: 0, duplicates: 0, tooMany: false, summary: { revenue: 0, miles: 0, first: null, last: null, invoiced: 0, paid: 0, withTruck: 0, truckNames: 0 } };
  if (missingFields(map).length > 0) return { ok: true, table, map, check: noCheck };
  const numberAt = map.loadNumber!;
  const [existing, trucks] = await Promise.all([
    existingFor(table.slice(1).map((r) => (r[numberAt] ?? "").trim()), workspaceId),
    prisma.vehicle.findMany({ where: { workspaceId, archivedAt: null }, select: { name: true } })
  ]);
  const check = checkLoadRows(table, map, { existing, trucks: new Set(trucks.flatMap((t) => (t.name ? [t.name.toLowerCase()] : []))) });
  return { ok: true, table, map, check };
}

/** What the screen shows before anything is written. Everything is plain data (no dates as objects). */
export type LoadImportPreview =
  | { ok: false; error: string }
  | {
      ok: true;
      fileHeader: string[];
      /** The first row of the file, to show beside each match. */
      firstRow: string[];
      /** The match in force: the desk's field and the file column it reads (an index into `fileHeader`), null when none. */
      map: Record<LoadFieldKey, number | null>;
      /** Required fields with no column: nothing can be checked until each has one. */
      missing: Array<{ key: LoadFieldKey; label: string }>;
      total: number;
      ready: number;
      duplicates: number;
      problemCount: number;
      problems: ProblemRow[];
      tooMany: boolean;
      /** The first few good rows as they will land, and what the good rows add up to. */
      sample: Array<{ line: number; loadNumber: string; customer: string | null; lane: string; delivered: string; miles: number; revenue: number; truck: string | null; billing: "paid" | "invoiced" | "not billed" }>;
      summary: { revenue: number; miles: number; first: string | null; last: string | null; invoiced: number; paid: number; notBilled: number; withTruck: number; truckNames: number };
    };

const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

export async function previewLoadImport(text: string, mapping: LoadImportMap | null = null, workspaceId = currentWorkspaceId()): Promise<LoadImportPreview> {
  const r = await read(text, mapping, workspaceId);
  if (!r.ok) return r;
  const c = r.check;
  if (c.tooMany) return { ok: false, error: `That file has more than ${IMPORT_MAX_ROWS.toLocaleString("en-US")} rows. Split it and load the parts one at a time.` };
  const missing = missingFields(r.map).map((f) => ({ key: f.key, label: f.label }));
  return {
    ok: true,
    fileHeader: r.table[0] ?? [],
    firstRow: r.table[1] ?? [],
    map: r.map,
    missing,
    total: c.total,
    ready: c.good.length,
    duplicates: c.duplicates,
    problemCount: c.problemCount,
    problems: c.problems,
    tooMany: false,
    sample: c.good.slice(0, 8).map(({ line, item }) => ({ line, loadNumber: item.loadNumber, customer: item.customer, lane: `${item.origin} to ${item.destination}`, delivered: day(item.completedAt)!, miles: item.loadedMiles, revenue: item.revenue + (item.fuelSurcharge ?? 0), truck: item.truck, billing: paymentOf(item).status ?? "not billed" })),
    summary: { revenue: c.summary.revenue, miles: c.summary.miles, first: day(c.summary.first), last: day(c.summary.last), invoiced: c.summary.invoiced, paid: c.summary.paid, notBilled: c.good.length - c.summary.invoiced, withTruck: c.summary.withTruck, truckNames: c.summary.truckNames }
  };
}

export type LoadImportResult = { ok: true; created: number; duplicates: number; skipped: number; batchId: string; withoutTruck: number } | { ok: false; error: string };

export async function commitLoadImport(text: string, mapping: LoadImportMap | null, fileName: string, now = new Date(), workspaceId = currentWorkspaceId()): Promise<LoadImportResult> {
  const r = await read(text, mapping, workspaceId);
  if (!r.ok) return r;
  if (missingFields(r.map).length > 0) return { ok: false, error: `Match a column to ${missingFields(r.map).map((f) => f.label).join(", ")} first.` };
  if (r.check.tooMany) return { ok: false, error: `That file has more than ${IMPORT_MAX_ROWS.toLocaleString("en-US")} rows. Split it and load the parts one at a time.` };
  if (r.check.good.length === 0) return { ok: false, error: r.check.duplicates > 0 ? (r.check.problemCount === 0 ? "Every load in that file is already on the desk." : "Every load in that file that could be read is already on the desk. The rows with problems are listed.") : "No row in that file can be imported. Fix the problems listed and load it again." };
  const file = fileName.trim().slice(0, 120) || "loads.csv";
  const batchId = randomUUID().replace(/-/g, "").slice(0, 16);
  const mark = importChannel(batchId);
  const trucks = await prisma.vehicle.findMany({ where: { workspaceId, archivedAt: null }, select: { id: true, name: true } });
  const truckOf = new Map(trucks.flatMap((t) => (t.name ? [[t.name.toLowerCase(), t.id] as const] : [])));

  const out = await prisma.$transaction(
    async (tx) => {
      await lockWorkspace(tx, workspaceId);
      // Again under the lock: a second click (or another person's import) that landed first is seen now.
      const existing = await existingFor(r.check.good.map((g) => g.item.loadNumber), workspaceId, tx);
      const held = (n: string, customer: string | null) => {
        const h = existing.get(n.toLowerCase());
        return h != null && (h.has("") || customer == null || h.has(customer.toLowerCase()));
      };
      const rows = r.check.good.filter((g) => !held(g.item.loadNumber, g.item.customer));
      const raced = r.check.good.length - rows.length;
      // Everything in the file landed first through another click: nothing to write, and nothing to say it was written.
      if (rows.length === 0) return null;
      let withoutTruck = 0;
      const data = rows.map(({ item: d }) => {
        const pay = paymentOf(d);
        const vehicleId = d.truck ? (truckOf.get(d.truck.toLowerCase()) ?? null) : null;
        if (d.truck && !vehicleId) withoutTruck += 1;
        return {
          workspaceId,
          loadNumber: d.loadNumber,
          status: "completed",
          brokerName: d.customer,
          originAddress: d.origin,
          destinationAddress: d.destination,
          scheduledDate: d.pickupAt,
          completedAt: d.completedAt,
          // The load is as old as its pickup (or delivery), so lead time and the weeks it falls in are the real ones.
          createdAt: d.pickupAt ?? d.completedAt,
          loadedMiles: d.loadedMiles,
          pickupDeadheadMiles: d.pickupEmptyMiles,
          returnDeadheadMiles: d.returnEmptyMiles,
          quotedRevenue: d.revenue,
          actualRevenue: d.revenue,
          fuelSurcharge: d.fuelSurcharge,
          vehicleId,
          channel: mark,
          paymentStatus: pay.status,
          invoicedAt: pay.invoicedAt,
          invoicedAmount: pay.invoicedAmount,
          paidAt: pay.paidAt,
          paidAmount: pay.paidAmount
        };
      });
      for (let i = 0; i < data.length; i += LOAD_IMPORT_CHUNK) await tx.load.createMany({ data: data.slice(i, i + LOAD_IMPORT_CHUNK) });
      const n = data.length;
      const dup = r.check.duplicates + raced;
      await recordAudit(
        {
          entity: "load",
          entityId: batchId,
          action: "loads_import_completed",
          summary: `${n.toLocaleString("en-US")} finished ${n === 1 ? "load" : "loads"} imported from ${file}${dup > 0 ? `; ${dup.toLocaleString("en-US")} already on the desk` : ""}${r.check.problemCount > 0 ? `; ${r.check.problemCount.toLocaleString("en-US")} ${r.check.problemCount === 1 ? "row" : "rows"} left out` : ""}`,
          before: null,
          after: { File: file, "Rows read": String(r.check.total), Imported: String(n), "Already on the desk": String(dup), "Left out": String(r.check.problemCount), "Trucks not found": String(withoutTruck) },
          at: now,
          workspaceId
        },
        tx
      );
      return { created: n, duplicates: dup, withoutTruck };
    },
    { timeout: 120_000, maxWait: 10_000 }
  );
  if (out == null) return { ok: false, error: "Every load in that file is already on the desk." };
  return { ok: true, created: out.created, duplicates: out.duplicates, skipped: r.check.problemCount, batchId, withoutTruck: out.withoutTruck };
}

export type LoadImportBatch = { batchId: string; at: Date; summary: string; actor: string; loads: number; removed: boolean };

/** The imports done on this desk, newest first, with how many of their loads are still on it. */
export async function listLoadImports(limit = 10, workspaceId = currentWorkspaceId()): Promise<LoadImportBatch[]> {
  const events = await prisma.auditEvent.findMany({ where: { workspaceId, action: { in: ["loads_import_completed", "loads_import_removed"] } }, orderBy: { createdAt: "desc" }, take: limit * 3, select: { entityId: true, action: true, summary: true, actor: true, createdAt: true } });
  const removed = new Set(events.filter((e) => e.action === "loads_import_removed").map((e) => e.entityId));
  const done = events.filter((e) => e.action === "loads_import_completed" && e.entityId).slice(0, limit);
  if (done.length === 0) return [];
  const counts = await prisma.load.groupBy({ by: ["channel"], where: { workspaceId, deletedAt: null, channel: { in: done.map((e) => importChannel(e.entityId!)) } }, _count: { _all: true } });
  const left = new Map(counts.map((c) => [c.channel, c._count._all]));
  return done.map((e) => ({ batchId: e.entityId!, at: e.createdAt, summary: e.summary, actor: e.actor, loads: left.get(importChannel(e.entityId!)) ?? 0, removed: removed.has(e.entityId) }));
}

export type RemoveImportResult = { ok: true; removed: number } | { ok: false; error: string };

/**
 * Take a whole import away again: every load of the batch still on the desk is deleted (the way a deleted load is: it can be restored from the Deleted loads list). The batch has to be one this desk made.
 */
export async function removeLoadImport(batchId: string, now = new Date(), workspaceId = currentWorkspaceId()): Promise<RemoveImportResult> {
  if (!/^[0-9a-f]{16}$/.test(batchId)) return { ok: false, error: "That import is not on this desk." };
  const made = await prisma.auditEvent.findFirst({ where: { workspaceId, action: "loads_import_completed", entityId: batchId }, select: { id: true } });
  if (!made) return { ok: false, error: "That import is not on this desk." };
  return prisma.$transaction(async (tx) => {
    await lockWorkspace(tx, workspaceId);
    const res = await tx.load.updateMany({ where: { workspaceId, channel: importChannel(batchId), deletedAt: null }, data: { deletedAt: now } });
    if (res.count === 0) return { ok: false as const, error: "Nothing of that import is left on the desk." };
    await recordAudit({ entity: "load", entityId: batchId, action: "loads_import_removed", summary: `${res.count.toLocaleString("en-US")} imported ${res.count === 1 ? "load" : "loads"} removed`, before: null, after: { Removed: String(res.count) }, at: now, workspaceId }, tx);
    return { ok: true as const, removed: res.count };
  });
}

