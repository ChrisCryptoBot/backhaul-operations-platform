import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { US_STATES } from "@/lib/fuel-normalize";
import {
  autoIftaRateMap,
  checkIftaRateRows,
  cleanIftaRateMap,
  isIftaQuarter,
  isRateStatus,
  MAX_IFTA_RATE_ROWS,
  missingIftaRateFields,
  sampleIftaRates,
  type IftaRateCheck,
  type IftaRateFieldKey,
  type IftaRateMap,
  type IftaRateStatus
} from "@/lib/ifta-rates-csv";
import { parseCsv, type ProblemRow } from "@/lib/import-csv";
import { recordAudit } from "@/server/tl/audit";
import { lockWorkspace } from "@/server/tl/plan";
import { currentWorkspaceId } from "@/server/tl/workspace";

/**
 * A quarter's IFTA tax rates, per workspace (money plan Wave 5 step 4): the rate table the return (step 6) multiplies by. lib/ifta-rates-csv.ts says what a file means (shaped on IFTA, Inc.'s
 * quarterly rate table, an assumption); this reads and writes the store.
 *
 * A file REPLACES its whole quarter: a rate table is one quarter's answer, so a state left out of the new file does not keep last file's number. Written with the workspace locked, in one
 * transaction, with one audit event per file. Sample rates (made up, `is_sample`, "sample, not for filing") are for a demo only and never land over real ones; a real file replaces them.
 * Only the billing office reaches any of it (the actions and /ifta/rates check `bill`).
 */
export const SAMPLE_SOURCE = "sample";
const BAD_QUARTER = "A quarter, like 2026-Q3.";

export type IftaRateImportMap = Partial<Record<IftaRateFieldKey, number | null>>;

export type IftaRateRow = { jurisdiction: string; name: string; rate: string; surcharge: string; status: IftaRateStatus; isSample: boolean; sourceFile: string | null; createdAt: Date };

/** The rates kept for a quarter, by jurisdiction code. Decimals come back as exact 4-place strings. */
export async function listIftaRates(quarter: string, workspaceId = currentWorkspaceId()): Promise<IftaRateRow[]> {
  if (!isIftaQuarter(quarter)) return [];
  const rows = await prisma.iftaRate.findMany({ where: { workspaceId, quarter }, orderBy: { jurisdiction: "asc" } });
  return rows.map((r) => ({
    jurisdiction: r.jurisdiction,
    name: US_STATES[r.jurisdiction] ?? r.jurisdiction,
    rate: r.rate.toFixed(4),
    surcharge: r.surcharge.toFixed(4),
    status: isRateStatus(r.status) ? r.status : "provisional",
    isSample: r.isSample,
    sourceFile: r.sourceFile,
    createdAt: r.createdAt
  }));
}

export type IftaRateQuarter = { quarter: string; count: number; final: number; sample: number; sourceFile: string | null; at: Date | null };

/** What each of these quarters holds: how many rates, how many final, how many sample, and the file it came from. */
export async function iftaRateQuarters(quarters: string[], workspaceId = currentWorkspaceId()): Promise<IftaRateQuarter[]> {
  const qs = quarters.filter(isIftaQuarter);
  const rows = qs.length === 0 ? [] : await prisma.iftaRate.findMany({ where: { workspaceId, quarter: { in: qs } }, select: { quarter: true, status: true, isSample: true, sourceFile: true, createdAt: true } });
  return qs.map((quarter) => {
    const mine = rows.filter((r) => r.quarter === quarter);
    const latest = mine.reduce<(typeof mine)[number] | null>((m, r) => (m == null || r.createdAt > m.createdAt ? r : m), null);
    return { quarter, count: mine.length, final: mine.filter((r) => r.status === "final").length, sample: mine.filter((r) => r.isSample).length, sourceFile: latest?.sourceFile ?? null, at: latest?.createdAt ?? null };
  });
}

function read(text: string, mapping: IftaRateImportMap | null, quarter: string, status: IftaRateStatus): { ok: false; error: string } | { ok: true; table: string[][]; map: IftaRateMap; check: IftaRateCheck } {
  if (typeof text !== "string") return { ok: false, error: "That is not a file the desk can read." };
  const table = parseCsv(text);
  if (table.length === 0 || (table[0] ?? []).every((c) => c.trim() === "")) return { ok: false, error: "That file is empty. It needs a header row and one row per jurisdiction." };
  const header = table[0]!;
  const map = mapping ? cleanIftaRateMap(mapping, header.length) : autoIftaRateMap(header);
  const none: IftaRateCheck = { total: 0, good: [], problems: [], problemCount: 0, duplicates: 0, canada: 0, tooMany: false, missing: [], summary: { jurisdictions: 0, withSurcharge: 0, final: 0, provisional: 0 } };
  if (missingIftaRateFields(map).length > 0) return { ok: true, table, map, check: none };
  return { ok: true, table, map, check: checkIftaRateRows(table, map, { quarter, status }) };
}

const tooLong = `That file has more than ${MAX_IFTA_RATE_ROWS} rows, far more than a rate table. Check it is the right file.`;

export type IftaRateKept = { count: number; final: number; sample: number; sourceFile: string | null };

async function kept(quarter: string, workspaceId: string, db: Pick<typeof prisma, "iftaRate"> = prisma): Promise<IftaRateKept> {
  const rows = await db.iftaRate.findMany({ where: { workspaceId, quarter }, select: { status: true, isSample: true, sourceFile: true, createdAt: true }, orderBy: { createdAt: "desc" } });
  return { count: rows.length, final: rows.filter((r) => r.status === "final").length, sample: rows.filter((r) => r.isSample).length, sourceFile: rows[0]?.sourceFile ?? null };
}

export type IftaRatePreview =
  | { ok: false; error: string }
  | {
      ok: true;
      fileHeader: string[];
      firstRow: string[];
      map: IftaRateMap;
      missing: Array<{ key: IftaRateFieldKey; label: string }>;
      total: number;
      ready: number;
      duplicates: number;
      canada: number;
      problemCount: number;
      problems: ProblemRow[];
      /** US jurisdictions (DC included) the file does not give a rate for. */
      notInFile: string[];
      rates: Array<{ line: number; jurisdiction: string; name: string; rate: string; surcharge: string; status: IftaRateStatus; surchargeLine: number | null }>;
      summary: IftaRateCheck["summary"];
      /** What the quarter holds now, all of which the import replaces. */
      replaces: IftaRateKept;
    };

export async function previewIftaRates(text: string, mapping: IftaRateImportMap | null, quarter: string, status: IftaRateStatus, workspaceId = currentWorkspaceId()): Promise<IftaRatePreview> {
  if (!isIftaQuarter(quarter)) return { ok: false, error: BAD_QUARTER };
  if (!isRateStatus(status)) return { ok: false, error: "Provisional or final." };
  const r = read(text, mapping, quarter, status);
  if (!r.ok) return r;
  if (r.check.tooMany) return { ok: false, error: tooLong };
  const c = r.check;
  return {
    ok: true,
    fileHeader: r.table[0] ?? [],
    firstRow: r.table[1] ?? [],
    map: r.map,
    missing: missingIftaRateFields(r.map),
    total: c.total,
    ready: c.good.length,
    duplicates: c.duplicates,
    canada: c.canada,
    problemCount: c.problemCount,
    problems: c.problems,
    notInFile: c.missing,
    rates: c.good.map(({ line, item }) => ({ line, jurisdiction: item.jurisdiction, name: US_STATES[item.jurisdiction] ?? item.jurisdiction, rate: item.rate, surcharge: item.surcharge, status: item.status, surchargeLine: item.surchargeLine })),
    summary: c.summary,
    replaces: await kept(quarter, workspaceId)
  };
}

export type IftaRateImportResult = { ok: true; created: number; replaced: number; canada: number; skipped: number; batchId: string } | { ok: false; error: string };

const n = (v: number) => v.toLocaleString("en-US");
const plural = (v: number, one: string, many: string) => `${n(v)} ${v === 1 ? one : many}`;

export async function commitIftaRates(text: string, mapping: IftaRateImportMap | null, quarter: string, status: IftaRateStatus, fileName: string, now = new Date(), workspaceId = currentWorkspaceId()): Promise<IftaRateImportResult> {
  if (!isIftaQuarter(quarter)) return { ok: false, error: BAD_QUARTER };
  if (!isRateStatus(status)) return { ok: false, error: "Provisional or final." };
  const r = read(text, mapping, quarter, status);
  if (!r.ok) return r;
  const missing = missingIftaRateFields(r.map);
  if (missing.length > 0) return { ok: false, error: `Match a column to ${missing.map((m) => m.label).join(", ")} first.` };
  if (r.check.tooMany) return { ok: false, error: tooLong };
  if (r.check.good.length === 0) return { ok: false, error: "No US rate in that file can be imported. Fix the problems listed and load it again; the rates kept for the quarter are unchanged." };
  const file = (typeof fileName === "string" ? fileName : "").trim().slice(0, 120) || "ifta-rates.csv";
  const batchId = randomUUID().replace(/-/g, "").slice(0, 16);
  const c = r.check;

  const replaced = await prisma.$transaction(async (tx) => {
    await lockWorkspace(tx, workspaceId);
    // Wave 5 step 8: once a filed return (IftaReturn) holds this quarter, refuse here, or warn and require a confirm, before the rates it was worked out with are replaced.
    const before = await kept(quarter, workspaceId, tx);
    await tx.iftaRate.deleteMany({ where: { workspaceId, quarter } });
    await tx.iftaRate.createMany({
      data: c.good.map(({ item }) => ({ workspaceId, quarter, jurisdiction: item.jurisdiction, rate: new Prisma.Decimal(item.rate), surcharge: new Prisma.Decimal(item.surcharge), status: item.status, isSample: false, sourceFile: file, importBatchId: batchId, createdAt: now }))
    });
    const parts = [
      `${plural(c.good.length, "rate", "rates")} for ${quarter} imported from ${file}`,
      c.summary.final > 0 && c.summary.provisional > 0 ? `${n(c.summary.final)} final, ${n(c.summary.provisional)} provisional` : c.summary.final > 0 ? "final" : "provisional",
      before.count > 0 ? `replacing ${plural(before.count, "rate", "rates")}${before.sample > 0 ? " (sample)" : ""}` : null,
      c.canada > 0 ? `${plural(c.canada, "Canadian row", "Canadian rows")} skipped` : null,
      c.problemCount > 0 ? `${plural(c.problemCount, "row", "rows")} left out` : null
    ].filter(Boolean);
    await recordAudit(
      {
        entity: "fleet",
        entityId: batchId,
        action: "ifta_rates_imported",
        summary: parts.join("; "),
        before: before.count > 0 ? { Rates: String(before.count), Final: String(before.final), Sample: String(before.sample), File: before.sourceFile ?? "" } : null,
        after: { Quarter: quarter, File: file, Rates: String(c.good.length), Final: String(c.summary.final), Provisional: String(c.summary.provisional), "With a surcharge": String(c.summary.withSurcharge), "Canadian rows skipped": String(c.canada), "Left out": String(c.problemCount), "Not in the file": String(c.missing.length) },
        at: now,
        workspaceId
      },
      tx
    );
    return before.count;
  });
  return { ok: true, created: c.good.length, replaced, canada: c.canada, skipped: c.problemCount, batchId };
}

export type IftaSampleResult = { ok: true; created: number } | { ok: false; error: string };

/** Made-up rates for a demo, labelled sample everywhere they show. Refused over real rates: a sample never replaces a rate file. Loading again over sample rates refreshes them. */
export async function loadSampleIftaRates(quarter: string, now = new Date(), workspaceId = currentWorkspaceId()): Promise<IftaSampleResult> {
  if (!isIftaQuarter(quarter)) return { ok: false, error: BAD_QUARTER };
  const sample = sampleIftaRates(quarter);
  return prisma.$transaction(async (tx) => {
    await lockWorkspace(tx, workspaceId);
    const real = await tx.iftaRate.count({ where: { workspaceId, quarter, isSample: false } });
    if (real > 0) return { ok: false as const, error: `${quarter} has ${plural(real, "rate", "rates")} from a rate file. Sample rates never replace real ones; clear the quarter first if you mean to.` };
    // Sample rates only ever land over nothing or over sample rates. Wave 5 step 8: a return worked out with sample rates must not be marked filed.
    await tx.iftaRate.deleteMany({ where: { workspaceId, quarter } });
    await tx.iftaRate.createMany({ data: sample.map((s) => ({ workspaceId, quarter, jurisdiction: s.jurisdiction, rate: new Prisma.Decimal(s.rate), surcharge: new Prisma.Decimal(s.surcharge), status: "provisional", isSample: true, sourceFile: SAMPLE_SOURCE, createdAt: now })) });
    await recordAudit({ entity: "fleet", entityId: quarter, action: "ifta_rates_sample_loaded", summary: `${plural(sample.length, "sample rate", "sample rates")} loaded for ${quarter} (made up, not for filing)`, before: null, after: { Quarter: quarter, Rates: String(sample.length), Sample: "yes" }, at: now, workspaceId }, tx);
    return { ok: true as const, created: sample.length };
  });
}

export type IftaClearResult = { ok: true; removed: number } | { ok: false; error: string };

/** Take every rate of a quarter away (a wrong file, or sample rates before the real table). */
export async function clearIftaRates(quarter: string, now = new Date(), workspaceId = currentWorkspaceId()): Promise<IftaClearResult> {
  if (!isIftaQuarter(quarter)) return { ok: false, error: BAD_QUARTER };
  return prisma.$transaction(async (tx) => {
    await lockWorkspace(tx, workspaceId);
    // Wave 5 step 8: once a filed return (IftaReturn) holds this quarter, refuse here (its rates are part of what was filed).
    const before = await kept(quarter, workspaceId, tx);
    if (before.count === 0) return { ok: false as const, error: `${quarter} has no rates to clear.` };
    const res = await tx.iftaRate.deleteMany({ where: { workspaceId, quarter } });
    await recordAudit(
      {
        entity: "fleet",
        entityId: quarter,
        action: "ifta_rates_cleared",
        summary: `${plural(res.count, "rate", "rates")} for ${quarter} cleared${before.sample === before.count ? " (sample)" : before.sourceFile ? ` (from ${before.sourceFile})` : ""}`,
        before: { Rates: String(before.count), Final: String(before.final), Sample: String(before.sample), File: before.sourceFile ?? "" },
        after: { Rates: "0" },
        at: now,
        workspaceId
      },
      tx
    );
    return { ok: true as const, removed: res.count };
  });
}
