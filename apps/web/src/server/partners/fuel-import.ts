import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { autoFuelMap, checkFuelRows, cleanFuelMap, missingFuelFields, type FuelCheck, type FuelFieldKey, type FuelMap } from "@/lib/fuel-csv";
import { nextStatus, type FuelProduct } from "@/lib/fuel-normalize";
import { IMPORT_MAX_ROWS, parseCsv, type ProblemRow } from "@/lib/import-csv";
import { recordAudit } from "@/server/tl/audit";
import { lockWorkspace } from "@/server/tl/plan";
import { currentWorkspaceId } from "@/server/tl/workspace";
import { workspaceTimezone } from "@/server/tl/zone";
import { loadTieFor } from "./fuel-store";

/**
 * Loading fuel purchases from a CSV file (lib/fuel-csv.ts says what a file means). The same safety as the load and tracker importers: the file is read and checked on the server every time,
 * the purchases that pass are written in one transaction with the workspace locked and the duplicate check made again under the lock, and ONE audit event names the batch so the file can be
 * taken away whole. Each purchase is kept under the provider "csv" with its batch, tied to the truck's load it was bought on as a card's purchase is, and read by every screen exactly like one.
 */
export const FUEL_IMPORT_PROVIDER = "csv";
export const FUEL_IMPORT_CHUNK = 500;
const DAY = 86_400_000;

export type FuelImportMap = Partial<Record<FuelFieldKey, number | null>>;

const squash = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/** The purchase keys already kept from files in this fleet. */
async function existingKeys(workspaceId: string, db: Pick<typeof prisma, "$queryRaw"> = prisma): Promise<Set<string>> {
  const rows = await db.$queryRaw<Array<{ k: string }>>`select external_id as k from fuel_transactions where workspace_id = ${workspaceId} and provider = ${FUEL_IMPORT_PROVIDER}`;
  return new Set(rows.map((r) => r.k));
}

async function read(text: string, mapping: FuelImportMap | null, workspaceId: string, now: Date): Promise<{ ok: false; error: string } | { ok: true; table: string[][]; map: FuelMap; check: FuelCheck }> {
  const table = parseCsv(text);
  if (table.length === 0 || (table[0] ?? []).every((c) => c.trim() === "")) return { ok: false, error: "That file is empty. It needs a header row and one row per fuel purchase." };
  const header = table[0]!;
  const map = mapping ? cleanFuelMap(mapping, header.length) : autoFuelMap(header);
  const none: FuelCheck = { total: 0, good: [], problems: [], problemCount: 0, duplicates: 0, again: [], tooMany: false, warnings: { noTruck: 0, noState: 0, noProduct: 0 }, summary: { purchases: 0, gallons: {}, charged: 0, notCounted: 0, states: 0, first: null, last: null } };
  if (missingFuelFields(map).length > 0) return { ok: true, table, map, check: none };
  const [trucks, zone, existing] = await Promise.all([
    prisma.vehicle.findMany({ where: { workspaceId, archivedAt: null }, select: { id: true, name: true, costProfile: { select: { fuelCardAccountId: true } } } }),
    workspaceTimezone(workspaceId),
    existingKeys(workspaceId)
  ]);
  const truckByName = new Map<string, string>();
  const truckByCard = new Map<string, string>();
  for (const t of trucks) {
    if (t.name) truckByName.set(squash(t.name), t.id);
    const card = t.costProfile?.fuelCardAccountId;
    if (card) truckByCard.set(squash(card), t.id);
  }
  return { ok: true, table, map, check: checkFuelRows(table, map, { truckByName, truckByCard, existing, zone, nowMs: now.getTime() }) };
}

export type FuelImportPreview =
  | { ok: false; error: string }
  | {
      ok: true;
      fileHeader: string[];
      firstRow: string[];
      map: FuelMap;
      missing: Array<{ key: FuelFieldKey; label: string }>;
      total: number;
      ready: number;
      duplicates: number;
      problemCount: number;
      problems: ProblemRow[];
      warnings: FuelCheck["warnings"];
      sample: Array<{ line: number; on: string; truck: string | null; where: string | null; state: string | null; product: FuelProduct; status: string; gallons: number | null; amount: number }>;
      summary: FuelCheck["summary"];
    };

export async function previewFuelImport(text: string, mapping: FuelImportMap | null = null, now = new Date(), workspaceId = currentWorkspaceId()): Promise<FuelImportPreview> {
  const r = await read(text, mapping, workspaceId, now);
  if (!r.ok) return r;
  if (r.check.tooMany) return { ok: false, error: `That file has more than ${IMPORT_MAX_ROWS.toLocaleString("en-US")} rows. Split it and load the parts one at a time.` };
  const c = r.check;
  const names = new Map((await prisma.vehicle.findMany({ where: { workspaceId, id: { in: [...new Set(c.good.slice(0, 8).map((g) => g.item.truckId).filter((id): id is string => id != null))] } }, select: { id: true, name: true } })).map((t) => [t.id, t.name]));
  return {
    ok: true,
    fileHeader: r.table[0] ?? [],
    firstRow: r.table[1] ?? [],
    map: r.map,
    missing: missingFuelFields(r.map),
    total: c.total,
    ready: c.good.length,
    duplicates: c.duplicates,
    problemCount: c.problemCount,
    problems: c.problems,
    warnings: c.warnings,
    sample: c.good.slice(0, 8).map(({ line, item }) => ({ line, on: item.on, truck: item.truckId ? (names.get(item.truckId) ?? "Truck") : null, where: item.location, state: item.state, product: item.product, status: item.status, gallons: item.gallons, amount: item.amount })),
    summary: c.summary
  };
}

export type FuelImportResult = { ok: true; created: number; duplicates: number; updated: number; skipped: number; batchId: string } | { ok: false; error: string };

const dec = (n: number | null) => (n == null ? null : new Prisma.Decimal(n));

export async function commitFuelImport(text: string, mapping: FuelImportMap | null, fileName: string, now = new Date(), workspaceId = currentWorkspaceId()): Promise<FuelImportResult> {
  const r = await read(text, mapping, workspaceId, now);
  if (!r.ok) return r;
  const missing = missingFuelFields(r.map);
  if (missing.length > 0) return { ok: false, error: `Match a column to ${missing.map((m) => m.label).join(", ")} first.` };
  if (r.check.tooMany) return { ok: false, error: `That file has more than ${IMPORT_MAX_ROWS.toLocaleString("en-US")} rows. Split it and load the parts one at a time.` };
  if (r.check.good.length === 0 && r.check.again.length === 0) return { ok: false, error: r.check.duplicates > 0 ? "Every purchase in that file is already on the desk." : "No row in that file can be imported. Fix the problems listed and load it again." };
  const file = fileName.trim().slice(0, 120) || "fuel.csv";
  const batchId = randomUUID().replace(/-/g, "").slice(0, 16);

  // Each truck's loads over the file's days, read once, to tie each purchase to the load it was bought on.
  const ties = new Map<string, (on: string) => string | null>();
  const first = r.check.good.reduce<string | null>((m, g) => (m == null || g.item.on < m ? g.item.on : m), null);
  for (const id of new Set(r.check.good.map((g) => g.item.truckId).filter((t): t is string => t != null))) ties.set(id, await loadTieFor(workspaceId, id, new Date(Date.parse(`${first}T00:00:00Z`) - DAY)));

  const out = await prisma.$transaction(
    async (tx) => {
      await lockWorkspace(tx, workspaceId);
      // Again under the lock: a second click that landed first is seen now.
      const have = await existingKeys(workspaceId, tx);
      const rows = r.check.good.filter((g) => !have.has(g.item.externalId));
      const data: Prisma.FuelTransactionCreateManyInput[] = rows.map(({ item: d }) => ({
        workspaceId,
        provider: FUEL_IMPORT_PROVIDER,
        externalId: d.externalId,
        importBatchId: batchId,
        vehicleId: d.truckId,
        loadId: d.truckId ? (ties.get(d.truckId)?.(d.on) ?? null) : null,
        postedAt: new Date(`${d.on}T12:00:00Z`),
        purchasedAt: d.purchasedAt,
        location: d.location,
        purchaseState: d.state,
        purchaseCity: d.city,
        product: d.product,
        status: d.status,
        taxPaid: d.taxPaid,
        gallons: dec(d.gallons),
        pricePerGallon: dec(d.pricePerGallon),
        discountPerGallon: dec(d.discountPerGallon),
        discount: dec(d.discount),
        amount: new Prisma.Decimal(d.amount)
      }));
      for (let i = 0; i < data.length; i += FUEL_IMPORT_CHUNK) await tx.fuelTransaction.createMany({ data: data.slice(i, i + FUEL_IMPORT_CHUNK) });

      // A purchase an earlier file brought in may have moved on since (pending to settled, settled to reversed): take the move the same way a card's re-read does. Nothing else changes.
      let updated = 0;
      if (r.check.again.length > 0) {
        const kept = await tx.fuelTransaction.findMany({ where: { workspaceId, provider: FUEL_IMPORT_PROVIDER, externalId: { in: r.check.again.map((a) => a.externalId) } }, select: { id: true, externalId: true, status: true } });
        const want = new Map(r.check.again.map((a) => [a.externalId, a.status]));
        for (const k of kept) {
          const moved = nextStatus(k.status, want.get(k.externalId)!);
          if (!moved) continue;
          await tx.fuelTransaction.update({ where: { id: k.id }, data: { status: moved } });
          updated += 1;
        }
      }
      if (data.length === 0 && updated === 0) return null;
      const dup = r.check.duplicates + (r.check.good.length - rows.length);
      const n = data.length;
      const unTied = rows.filter((g) => g.item.truckId == null).length;
      await recordAudit(
        {
          entity: "fleet",
          entityId: batchId,
          action: "fuel_csv_imported",
          summary: `${n.toLocaleString("en-US")} fuel ${n === 1 ? "purchase" : "purchases"} imported from ${file}${dup > 0 ? `; ${dup.toLocaleString("en-US")} already on the desk` : ""}${updated > 0 ? `; ${updated} moved on (status)` : ""}${r.check.problemCount > 0 ? `; ${r.check.problemCount.toLocaleString("en-US")} ${r.check.problemCount === 1 ? "row" : "rows"} left out` : ""}${unTied > 0 ? `; ${unTied} not tied to a truck` : ""}`,
          before: null,
          after: { File: file, "Rows read": String(r.check.total), Imported: String(n), "Already on the desk": String(dup), "Status moved": String(updated), "Left out": String(r.check.problemCount) },
          at: now,
          workspaceId
        },
        tx
      );
      return { created: n, duplicates: dup, updated };
    },
    { timeout: 120_000, maxWait: 10_000 }
  );
  if (out == null) return { ok: false, error: "Every purchase in that file is already on the desk." };
  return { ok: true, created: out.created, duplicates: out.duplicates, updated: out.updated, skipped: r.check.problemCount, batchId };
}

export type FuelBatch = { batchId: string; at: Date; summary: string; actor: string; rows: number; deducted: number; removed: boolean };

/** The fuel files imported on this desk, newest first, with how many purchases of each are still on it and how many of those are on a driver statement (which stops a removal). */
export async function listFuelImports(limit = 10, workspaceId = currentWorkspaceId()): Promise<FuelBatch[]> {
  const events = await prisma.auditEvent.findMany({ where: { workspaceId, action: { in: ["fuel_csv_imported", "fuel_csv_removed"] } }, orderBy: { createdAt: "desc" }, take: limit * 3, select: { entityId: true, action: true, summary: true, actor: true, createdAt: true } });
  const removed = new Set(events.filter((e) => e.action === "fuel_csv_removed").map((e) => e.entityId));
  const done = events.filter((e) => e.action === "fuel_csv_imported" && e.entityId).slice(0, limit);
  if (done.length === 0) return [];
  const ids = done.map((e) => e.entityId!);
  const [counts, deducted] = await Promise.all([
    prisma.fuelTransaction.groupBy({ by: ["importBatchId"], where: { workspaceId, importBatchId: { in: ids } }, _count: { _all: true }, orderBy: { importBatchId: "asc" } }),
    prisma.fuelTransaction.groupBy({ by: ["importBatchId"], where: { workspaceId, importBatchId: { in: ids }, settlementId: { not: null } }, _count: { _all: true }, orderBy: { importBatchId: "asc" } })
  ]);
  const left = new Map(counts.map((c) => [c.importBatchId, c._count._all]));
  const held = new Map(deducted.map((c) => [c.importBatchId, c._count._all]));
  return done.map((e) => ({ batchId: e.entityId!, at: e.createdAt, summary: e.summary, actor: e.actor, rows: left.get(e.entityId!) ?? 0, deducted: held.get(e.entityId!) ?? 0, removed: removed.has(e.entityId) }));
}

export type RemoveFuelImportResult = { ok: true; removed: number } | { ok: false; error: string };

/**
 * Take a whole fuel file import away. Refused while any of its purchases is deducted on a driver statement (a final statement holds it; voiding the statement gives it back first): removing
 * the file must never leave a pay deduction pointing at nothing. The purchases are locked before the check, so a statement finalized at the same moment cannot take one in between.
 * (Wave 5 step 8 adds the same refusal for a purchase on a filed fuel-tax return.)
 */
export async function removeFuelImport(batchId: string, now = new Date(), workspaceId = currentWorkspaceId()): Promise<RemoveFuelImportResult> {
  if (!/^[0-9a-f]{16}$/.test(batchId)) return { ok: false, error: "That import is not on this desk." };
  const made = await prisma.auditEvent.findFirst({ where: { workspaceId, action: "fuel_csv_imported", entityId: batchId }, select: { id: true } });
  if (!made) return { ok: false, error: "That import is not on this desk." };
  return prisma.$transaction(async (tx) => {
    await lockWorkspace(tx, workspaceId);
    const rows = await tx.$queryRaw<Array<{ id: string; settlement_id: string | null }>>`select id, settlement_id from fuel_transactions where workspace_id = ${workspaceId} and import_batch_id = ${batchId} for update`;
    if (rows.length === 0) return { ok: false as const, error: "Nothing of that import is left on the desk." };
    const held = rows.filter((r) => r.settlement_id != null);
    if (held.length > 0) {
      const numbers = await tx.settlement.findMany({ where: { id: { in: [...new Set(held.map((r) => r.settlement_id!))] } }, select: { number: true }, orderBy: { number: "asc" }, take: 3 });
      return { ok: false as const, error: `${held.length} ${held.length === 1 ? "purchase" : "purchases"} from this file ${held.length === 1 ? "is" : "are"} deducted on driver ${numbers.length === 1 ? "statement" : "statements"} ${numbers.map((s) => s.number).join(", ")}. Void ${numbers.length === 1 ? "that statement" : "those statements"} first, or keep the import.` };
    }
    const res = await tx.fuelTransaction.deleteMany({ where: { workspaceId, importBatchId: batchId, settlementId: null } });
    await recordAudit({ entity: "fleet", entityId: batchId, action: "fuel_csv_removed", summary: `${res.count.toLocaleString("en-US")} fuel ${res.count === 1 ? "purchase" : "purchases"} from a file import removed`, before: null, after: { Removed: String(res.count) }, at: now, workspaceId }, tx);
    return { ok: true as const, removed: res.count };
  });
}
