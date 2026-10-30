import { prisma } from "@/lib/db";
import { IMPORT_MAX_ROWS, checkDriverRows, checkTruckRows, driverKey, parseCsv, type ImportCheck, type ImportKind, type ProblemRow, type TruckImport, type DriverImport } from "@/lib/import-csv";
import { saveTruckHomeCoordinates } from "@/server/geo/persist";
import { recordAudit } from "./audit";
import { currentWorkspaceId } from "./workspace";

/**
 * Bulk import of trucks and drivers. The file is read and checked here, on the server, every time: the preview a person sees and the import that follows both run
 * the same check against the database as it is then, so a preview that was true a minute ago cannot write a duplicate. Rows that pass are written 500 at a time
 * inside one transaction with ONE audit event (`import_completed`), not one per row; rows that do not are left out and reported. Nothing is geocoded here: a
 * truck's home base is located afterwards, a few at a time (`locateHomeBases`).
 */
export const IMPORT_CHUNK = 500;

type Read = { ok: false; error: string } | { ok: true; table: string[][]; trucks?: ImportCheck<TruckImport>; drivers?: ImportCheck<DriverImport & { truckId: string }> };

async function read(kind: ImportKind, text: string, workspaceId: string): Promise<Read> {
  const table = parseCsv(text);
  if (table.length === 0 || (table[0] ?? []).every((c) => c.trim() === "")) return { ok: false, error: "That file is empty. It needs a header row and one row per line." };
  if (kind === "trucks") {
    const inService = await prisma.vehicle.findMany({ where: { workspaceId, archivedAt: null }, select: { name: true } });
    return { ok: true, table, trucks: checkTruckRows(table, new Set(inService.map((v) => (v.name ?? "").toLowerCase()))) };
  }
  const [trucks, drivers] = await Promise.all([
    prisma.vehicle.findMany({ where: { workspaceId, archivedAt: null }, select: { id: true, name: true } }),
    prisma.driver.findMany({ where: { workspaceId }, select: { name: true, phone: true } })
  ]);
  const byName = new Map(trucks.filter((t) => t.name).map((t) => [t.name!.toLowerCase(), t.id]));
  return { ok: true, table, drivers: checkDriverRows(table, byName, new Set(drivers.map((d) => driverKey(d.name, d.phone ?? "")))) };
}

export type ImportPreview =
  | { ok: false; error: string }
  | {
      ok: true;
      kind: ImportKind;
      /** Rows with something in them. */
      total: number;
      /** Rows that will be imported. */
      ready: number;
      problemCount: number;
      problems: ProblemRow[];
      /** The file's own header cells, for the problem file. */
      fileHeader: string[];
      matched: Array<{ column: string; field: string }>;
      unknown: string[];
    };

const NOT_USABLE = (check: ImportCheck<unknown>): string | null =>
  check.tooMany ? `That file has more than ${IMPORT_MAX_ROWS.toLocaleString("en-US")} rows. Split it and load the parts one at a time.` : check.header.missing.length > 0 ? `The file needs a ${check.header.missing.join(" and ")} column.` : null;

export async function previewImport(kind: ImportKind, text: string, workspaceId = currentWorkspaceId()): Promise<ImportPreview> {
  const r = await read(kind, text, workspaceId);
  if (!r.ok) return r;
  const check = (r.trucks ?? r.drivers)!;
  const refused = NOT_USABLE(check);
  if (refused) return { ok: false, error: refused };
  return { ok: true, kind, total: check.total, ready: check.good.length, problemCount: check.problemCount, problems: check.problems, fileHeader: r.table[0] ?? [], matched: check.header.matched, unknown: check.header.unknown };
}

export type ImportResult = { ok: true; created: number; skipped: number; kind: ImportKind } | { ok: false; error: string };

export async function commitImport(kind: ImportKind, text: string, fileName: string, now = new Date(), workspaceId = currentWorkspaceId()): Promise<ImportResult> {
  const r = await read(kind, text, workspaceId);
  if (!r.ok) return r;
  const check = (r.trucks ?? r.drivers)!;
  const refused = NOT_USABLE(check);
  if (refused) return { ok: false, error: refused };
  if (check.good.length === 0) return { ok: false, error: "No row in that file can be imported. Fix the problems listed and load it again." };
  const skipped = check.problemCount;
  const file = fileName.trim().slice(0, 120) || (kind === "trucks" ? "trucks.csv" : "drivers.csv");
  await prisma.$transaction(
    async (tx) => {
      if (r.trucks) {
        const rows = r.trucks.good.map(({ item: { values: v, mpg, specs } }) => ({
          workspaceId,
          name: v.name,
          type: v.type || null,
          mpg,
          fuelType: v.fuelType || null,
          homeBaseAddress: v.homeBaseAddress || null,
          terminal: v.terminal || null,
          make: v.make || null,
          model: v.model || null,
          year: specs.year,
          payloadLbs: specs.payloadLbs,
          maxLengthFt: specs.maxLengthFt,
          maxWidthFt: specs.maxWidthFt,
          maxHeightIn: specs.maxHeightIn,
          hasLiftgate: v.hasLiftgate === "yes",
          hasRamp: v.hasRamp === "yes",
          hasPalletJack: v.hasPalletJack === "yes"
        }));
        for (let i = 0; i < rows.length; i += IMPORT_CHUNK) await tx.vehicle.createMany({ data: rows.slice(i, i + IMPORT_CHUNK) });
      } else if (r.drivers) {
        const rows = r.drivers.good.map(({ item: d }) => ({
          workspaceId,
          name: d.values.name,
          phone: d.values.phone || null,
          email: d.values.email || null,
          cdlClass: d.values.cdlClass || null,
          cdlExpiry: d.cdlExpiry,
          medicalCardExpiry: d.medicalCardExpiry,
          assignedVehicleId: d.truckId || null,
          defaultPayKind: d.values.payKind || null,
          defaultPayRate: d.payRate,
          terminal: d.values.terminal || null
        }));
        for (let i = 0; i < rows.length; i += IMPORT_CHUNK) await tx.driver.createMany({ data: rows.slice(i, i + IMPORT_CHUNK) });
      }
      const n = check.good.length;
      const noun = kind === "trucks" ? (n === 1 ? "truck" : "trucks") : n === 1 ? "driver" : "drivers";
      await recordAudit(
        {
          entity: "fleet",
          action: "import_completed",
          summary: `${n.toLocaleString("en-US")} ${noun} imported from ${file}${skipped > 0 ? `; ${skipped.toLocaleString("en-US")} ${skipped === 1 ? "row" : "rows"} left out` : ""}`,
          before: null,
          after: { File: file, "Rows read": String(check.total), Imported: String(n), "Left out": String(skipped) },
          at: now,
          workspaceId
        },
        tx
      );
    },
    { timeout: 120_000, maxWait: 10_000 }
  );
  return { ok: true, created: check.good.length, skipped, kind };
}

// ── Locating home bases, afterwards and a few at a time ───────────────────────────────────────

/** Trucks in service with a home base address and no point on the map yet. */
export const toLocate = (workspaceId = currentWorkspaceId()) => prisma.vehicle.count({ where: { workspaceId, archivedAt: null, homeBaseAddress: { not: null }, homeBaseLat: null } });

export const LOCATE_BATCH = 25;
const LOCATE_PARALLEL = 5;

export type LocateResult = { tried: number; located: number; remaining: number; /** Hand back as `after` for the next batch; null when there is no more to try. */ next: string | null };

/**
 * Find the next few trucks' home bases (the permanent geocoder, at most five at a time, a batch of 25) and keep them. `after` is the id the last batch ended on, so
 * a base the map cannot find is tried once and the loop moves on instead of asking for it again forever. Each call is short; a screen calls it until `next` is null.
 */
export async function locateHomeBases(after: string | null, workspaceId = currentWorkspaceId()): Promise<LocateResult> {
  const batch = await prisma.vehicle.findMany({
    where: { workspaceId, archivedAt: null, homeBaseAddress: { not: null }, homeBaseLat: null, ...(after ? { id: { gt: after } } : {}) },
    select: { id: true },
    orderBy: { id: "asc" },
    take: LOCATE_BATCH
  });
  let located = 0;
  for (let i = 0; i < batch.length; i += LOCATE_PARALLEL) {
    const found = await Promise.all(batch.slice(i, i + LOCATE_PARALLEL).map((t) => saveTruckHomeCoordinates(t.id, workspaceId)));
    located += found.filter(Boolean).length;
  }
  return { tried: batch.length, located, remaining: await toLocate(workspaceId), next: batch.length === LOCATE_BATCH ? batch[batch.length - 1]!.id : null };
}
