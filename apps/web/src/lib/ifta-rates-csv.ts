import { toCsv } from "./csv";
import { CA_PROVINCES, stateCode, US_STATES } from "./fuel-normalize";
import { IMPORT_MAX_PROBLEMS, type ProblemRow } from "./import-csv";
import { matchHeader } from "./load-import";
import { centralParts } from "./zoned";

/**
 * Loading a quarter's IFTA tax rates from a CSV (money plan Wave 5 step 4). Pure: the server reads and writes the database (server/partners/ifta-rates.ts); this decides what a file means.
 *
 * The file shape is modelled on IFTA, Inc.'s quarterly rate table. That is an ASSUMPTION, the same way the partner adapters are shaped on documents rather than a live feed: one row per
 * jurisdiction with its diesel rate, and a state that charges a surcharge either in a Surcharge column or on a second row of its own ("Kentucky Surcharge"). Either way the surcharge is folded
 * into the base state's row and kept in its own column, never added to the rate: the return credits fuel bought against `rate` only.
 *
 * US dollars a gallon only. US jurisdictions (DC included) are kept; Canadian provinces are counted and skipped (gap 15, Canada not handled). An empty, negative, split ("0.285/0.31") or
 * over-precise cell is a row-level problem, never a silent skip. `0.0000` is a rate (a state with no diesel tax in that column); blank is not. Rates stay exact decimal strings, no floats.
 */

export const IFTA_QUARTER = /^\d{4}-Q[1-4]$/;
export const isIftaQuarter = (q: unknown): q is string => typeof q === "string" && IFTA_QUARTER.test(q);

/** The four quarters ending with the one the carrier's clock is in, newest first: "2026-Q4", "2026-Q3", ... */
export function recentQuarters(now: Date, tz: string, count = 4): string[] {
  const p = centralParts(now.getTime(), tz);
  let y = p.y;
  let q = Math.floor(p.m0 / 3) + 1;
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    out.push(`${y}-Q${q}`);
    q -= 1;
    if (q === 0) {
      q = 4;
      y -= 1;
    }
  }
  return out;
}

export const IFTA_RATE_STATUSES = ["provisional", "final"] as const;
export type IftaRateStatus = (typeof IFTA_RATE_STATUSES)[number];
export const RATE_STATUS_LABEL: Record<IftaRateStatus, string> = { provisional: "Provisional", final: "Final" };
export const isRateStatus = (s: unknown): s is IftaRateStatus => s === "provisional" || s === "final";

/** Past this a dollars-a-gallon cell is a typo (or cents, or a Canadian litre rate in the wrong column), not a fuel tax. */
export const MAX_IFTA_RATE = 2;
/** A rate table is one row per jurisdiction plus surcharge rows: a few hundred rows is already far more than any. */
export const MAX_IFTA_RATE_ROWS = 500;
export const IFTA_RATE_PLACES = 4;

export type IftaRateFieldKey = "jurisdiction" | "rate" | "surcharge" | "quarter" | "status";
export type IftaRateField = { key: IftaRateFieldKey; label: string; required: boolean; aliases: string[]; example: string; hint?: string };

export const IFTA_RATE_FIELDS: readonly IftaRateField[] = [
  { key: "jurisdiction", label: "Jurisdiction", required: true, aliases: ["jurisdiction", "juris", "state", "statename", "st", "stateprovince", "province", "member", "memberjurisdiction"], example: "Texas", hint: "A code (TX) or a name (Texas). A row named like \"Kentucky Surcharge\" is that state's surcharge." },
  { key: "rate", label: "Rate", required: true, aliases: ["rate", "diesel", "dieselrate", "dieselus", "usdiesel", "dieselusgal", "dieselpergallon", "taxrate", "usrate", "specialdiesel"], example: "0.2000", hint: "Diesel, US dollars a gallon, up to 4 decimals. On a surcharge row it may hold the surcharge." },
  { key: "surcharge", label: "Surcharge", required: false, aliases: ["surcharge", "surchargerate", "dieselsurcharge", "surchargeusgal", "surchargepergallon"], example: "0.0000", hint: "A separate surcharge rate, US dollars a gallon. Blank is none." },
  { key: "quarter", label: "Quarter", required: false, aliases: ["quarter", "qtr", "period", "taxquarter", "reportingquarter"], example: "", hint: "When the file has it, each row must be the quarter you chose (2026-Q3, 2026Q3 or Q3 2026)." },
  { key: "status", label: "Status", required: false, aliases: ["status", "ratestatus"], example: "", hint: "Provisional or final, row by row. Blank takes the status chosen for the file." }
];

export type IftaRateMap = Record<IftaRateFieldKey, number | null>;
export const emptyIftaRateMap = (): IftaRateMap => Object.fromEntries(IFTA_RATE_FIELDS.map((f) => [f.key, null])) as IftaRateMap;
export const autoIftaRateMap = (header: readonly string[]): IftaRateMap => matchHeader(header, IFTA_RATE_FIELDS);

/** A map that is safe to use against this header: indexes inside the file, no column used twice (the later field loses it). */
export function cleanIftaRateMap(map: Partial<Record<IftaRateFieldKey, number | null>>, width: number): IftaRateMap {
  const out = emptyIftaRateMap();
  const used = new Set<number>();
  for (const f of IFTA_RATE_FIELDS) {
    const v = map[f.key];
    if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v < width && !used.has(v)) {
      out[f.key] = v;
      used.add(v);
    }
  }
  return out;
}

export const missingIftaRateFields = (map: IftaRateMap): Array<{ key: IftaRateFieldKey; label: string }> => IFTA_RATE_FIELDS.filter((f) => f.required && map[f.key] == null).map((f) => ({ key: f.key, label: f.label }));

/** The template: the three columns every file needs, with placeholder numbers (not real rates). */
export function iftaRateTemplate(): string {
  return toCsv(["Jurisdiction", "Rate", "Surcharge"], [["Texas", "0.2000", "0.0000"], ["Kentucky", "0.2500", ""], ["Kentucky Surcharge", "0.1000", ""]]);
}

// ── Reading cells ────────────────────────────────────────────────────────────────────────────────

/** A rate cell as an exact decimal string with 4 places ("0.2850"), or why it is not one. Blank is null. */
export function readRate(raw: string): string | null | { error: string } {
  const t = raw.trim().replace(/^\$\s*/, "");
  if (t === "") return null;
  if (/^\(.*\)$/.test(t) || /^-/.test(t) || /^\$?\s*-/.test(raw.trim())) return { error: "is negative. A tax rate is never below 0.0000." };
  // Two numbers in one cell: "0.285/0.31", "0.285 - 0.31", "0.285; 0.31", "0.285 and 0.31".
  if (/\d\s*(\/|;|\||&|\band\b|\s-\s|-(?=\s*\$?\d)|\s+(?=\$?\d))\s*\$?\.?\d/i.test(t)) return { error: "holds two rates. A quarter has one rate a state: enter the one for this quarter, and a surcharge in its own column or row." };
  const m = /^(\d*)(?:\.(\d*))?$/.exec(t);
  if (!m || (m[1] === "" && (m[2] ?? "") === "")) return { error: "is not a number." };
  const whole = m[1] === "" ? "0" : m[1]!;
  let frac = m[2] ?? "";
  // Trailing zeros past 4 places change nothing; any other digit past 4 places would be rounded away, so it is refused rather than guessed.
  if (frac.length > IFTA_RATE_PLACES) {
    if (/[^0]/.test(frac.slice(IFTA_RATE_PLACES))) return { error: `has more than ${IFTA_RATE_PLACES} decimals.` };
    frac = frac.slice(0, IFTA_RATE_PLACES);
  }
  const intPart = whole.replace(/^0+(?=\d)/, "");
  const fixed = `${intPart}.${frac.padEnd(IFTA_RATE_PLACES, "0")}`;
  if (Number(fixed) > MAX_IFTA_RATE) return { error: `is more than $${MAX_IFTA_RATE.toFixed(2)} a gallon, which is a typo (or cents, or a litre rate), not a fuel tax.` };
  return fixed;
}

/** A quarter cell as "2026-Q3": "2026-Q3", "2026 Q3", "2026Q3", "Q3 2026", "Q3-2026", "3Q2026". Anything else is null. */
export function readQuarter(raw: string): string | null {
  const t = raw.trim().toUpperCase().replace(/\s+/g, " ");
  let m = /^(\d{4})\s?-?\s?Q([1-4])$/.exec(t);
  if (m) return `${m[1]}-Q${m[2]}`;
  m = /^Q([1-4])\s?[-/ ]?\s?(\d{4})$/.exec(t);
  if (m) return `${m[2]}-Q${m[1]}`;
  m = /^([1-4])Q\s?(\d{4})$/.exec(t);
  if (m) return `${m[2]}-Q${m[1]}`;
  return null;
}

/** The jurisdiction a cell names, and whether it is that state's surcharge row ("Kentucky Surcharge", "KY - surcharge", "Kentucky (surcharge)"). */
export function readJurisdiction(raw: string): { code: string | null; surcharge: boolean; canada: boolean } {
  const surcharge = /\bsurcharge\b/i.test(raw);
  const name = surcharge ? raw.replace(/\bsurcharge\b/gi, "").replace(/[()[\]\-–:]/g, " ").trim() : raw;
  const code = stateCode(name);
  if (code == null) return { code: null, surcharge, canada: false };
  return { code, surcharge, canada: code in CA_PROVINCES };
}

// ── Checking a file ──────────────────────────────────────────────────────────────────────────────

export type IftaRateDraft = { jurisdiction: string; rate: string; surcharge: string; status: IftaRateStatus; surchargeLine: number | null };

export type IftaRateCheck = {
  total: number;
  /** One per jurisdiction, any surcharge row folded in. Sorted by code. */
  good: Array<{ line: number; item: IftaRateDraft }>;
  problems: ProblemRow[];
  problemCount: number;
  /** The same row twice (same values): left out, counted apart from the mistakes. */
  duplicates: number;
  /** Canadian rows, counted and skipped (gap 15). */
  canada: number;
  tooMany: boolean;
  /** US jurisdictions (DC included) the kept rows do not have. */
  missing: string[];
  summary: { jurisdictions: number; withSurcharge: number; final: number; provisional: number };
};

export type IftaRateCheckContext = { quarter: string; status: IftaRateStatus };

const cell = (row: string[], at: number | null) => (at == null ? "" : (row[at] ?? "").trim());

export function checkIftaRateRows(table: string[][], map: IftaRateMap, ctx: IftaRateCheckContext): IftaRateCheck {
  const body = table.slice(1);
  const out: IftaRateCheck = { total: 0, good: [], problems: [], problemCount: 0, duplicates: 0, canada: 0, tooMany: body.length > MAX_IFTA_RATE_ROWS, missing: [], summary: { jurisdictions: 0, withSurcharge: 0, final: 0, provisional: 0 } };
  if (out.tooMany) return out;

  type Read = { line: number; cells: string[]; code: string; surcharge: boolean; rate: string | null; extra: string | null; status: IftaRateStatus | null };
  const reads: Read[] = [];
  const bad = new Map<number, { cells: string[]; errors: string[] }>();
  const fail = (line: number, cells: string[], m: string) => {
    const b = bad.get(line) ?? { cells, errors: [] };
    b.errors.push(m);
    bad.set(line, b);
  };

  body.forEach((row, i) => {
    if (row.every((c) => c.trim() === "")) return;
    out.total += 1;
    const line = i + 2;
    const errs: string[] = [];
    const rawJ = cell(row, map.jurisdiction);
    if (rawJ === "") {
      fail(line, row, "Jurisdiction is empty.");
      return;
    }
    const j = readJurisdiction(rawJ);
    if (j.canada) {
      out.canada += 1;
      return;
    }
    if (j.code == null) {
      fail(line, row, `"${rawJ.slice(0, 40)}" is not a US state or DC.`);
      return;
    }
    const rate = readRate(cell(row, map.rate));
    const extra = readRate(cell(row, map.surcharge));
    if (rate !== null && typeof rate === "object") errs.push(`Rate ${rate.error}`);
    if (extra !== null && typeof extra === "object") errs.push(`Surcharge ${extra.error}`);

    const rawQ = cell(row, map.quarter);
    if (rawQ !== "") {
      const q = readQuarter(rawQ);
      if (q == null) errs.push(`Quarter "${rawQ.slice(0, 20)}" is not a quarter (use 2026-Q3).`);
      else if (q !== ctx.quarter) errs.push(`This row is for ${q}, not ${ctx.quarter}.`);
    }
    const rawS = cell(row, map.status).toLowerCase();
    let status: IftaRateStatus | null = null;
    if (rawS !== "") {
      if (isRateStatus(rawS)) status = rawS;
      else errs.push("Status is not provisional or final.");
    }

    const r = typeof rate === "string" ? rate : null;
    const x = typeof extra === "string" ? extra : null;
    if (j.surcharge) {
      // A surcharge row: the number may sit in the Surcharge column or in the Rate column. Both with different numbers is two answers.
      if (r == null && x == null && rate === null && extra === null) errs.push("This surcharge row has no rate.");
      if (r != null && x != null && r !== x) errs.push("This surcharge row has two different numbers (Rate and Surcharge). Leave one blank.");
    } else if (rate === null) errs.push("Rate is empty. A state with no diesel tax is 0.0000, not blank.");

    if (errs.length > 0) {
      for (const e of errs) fail(line, row, e);
      return;
    }
    reads.push({ line, cells: row, code: j.code, surcharge: j.surcharge, rate: j.surcharge ? null : r, extra: j.surcharge ? (x ?? r) : x, status });
  });

  // Fold: one base row per state, plus at most one surcharge (its column or its own row).
  type Acc = { line: number; cells: string[]; rate: string; surcharge: string | null; surchargeLine: number | null; status: IftaRateStatus | null; surchargeStatus: IftaRateStatus | null };
  const byCode = new Map<string, Acc>();
  const surchargeRows: Read[] = [];
  for (const r of reads) {
    if (r.surcharge) {
      surchargeRows.push(r);
      continue;
    }
    const had = byCode.get(r.code);
    if (had) {
      if (had.rate === r.rate && had.surcharge === r.extra && had.status === r.status) out.duplicates += 1;
      else fail(r.line, r.cells, `${US_STATES[r.code]} is on line ${had.line} already, with a different rate.`);
      continue;
    }
    byCode.set(r.code, { line: r.line, cells: r.cells, rate: r.rate!, surcharge: r.extra, surchargeLine: r.extra != null ? r.line : null, status: r.status, surchargeStatus: null });
  }
  for (const s of surchargeRows) {
    const base = byCode.get(s.code);
    if (!base) {
      fail(s.line, s.cells, `A surcharge row for ${US_STATES[s.code]} with no ${US_STATES[s.code]} rate row in the file.`);
      continue;
    }
    if (base.surchargeLine != null && base.surchargeLine !== base.line) {
      // A second surcharge row for the same state.
      if (base.surcharge === s.extra) out.duplicates += 1;
      else fail(s.line, s.cells, `${US_STATES[s.code]}'s surcharge is on line ${base.surchargeLine} already, with a different number.`);
      continue;
    }
    // A Surcharge column of 0.0000 on the rate row says "none in this column"; the state's own surcharge row then gives it. Any other number there must agree with the row.
    if (base.surcharge != null && base.surcharge !== "0.0000" && base.surcharge !== s.extra) {
      fail(s.line, s.cells, `${US_STATES[s.code]}'s Surcharge column on line ${base.line} says ${base.surcharge}; this row says ${s.extra}.`);
      continue;
    }
    if (base.surcharge != null && base.surcharge === s.extra) {
      out.duplicates += 1;
      continue;
    }
    if (s.status != null && base.status != null && s.status !== base.status) {
      fail(s.line, s.cells, `This surcharge row is ${s.status}, but ${US_STATES[s.code]}'s rate row on line ${base.line} is ${base.status}.`);
      continue;
    }
    base.surcharge = s.extra;
    base.surchargeLine = s.line;
    base.surchargeStatus = s.status;
  }

  for (const [code, a] of [...byCode.entries()].sort(([x], [y]) => (x < y ? -1 : 1))) {
    const status = a.status ?? a.surchargeStatus ?? ctx.status;
    out.good.push({ line: a.line, item: { jurisdiction: code, rate: a.rate, surcharge: a.surcharge ?? "0.0000", status, surchargeLine: a.surchargeLine } });
    out.summary.jurisdictions += 1;
    if (a.surcharge != null && Number(a.surcharge) > 0) out.summary.withSurcharge += 1;
    out.summary[status] += 1;
  }

  const lines = [...bad.entries()].sort(([x], [y]) => x - y);
  out.problemCount = lines.length;
  out.problems = lines.slice(0, IMPORT_MAX_PROBLEMS).map(([line, b]) => ({ line, errors: b.errors, cells: b.cells }));
  out.missing = Object.keys(US_STATES).filter((c) => !byCode.has(c));
  return out;
}

// ── Sample rates ─────────────────────────────────────────────────────────────────────────────────

/** The contiguous 48 states: the IFTA members a demo fleet runs in (AK, HI and DC are not IFTA members). */
export const SAMPLE_JURISDICTIONS: readonly string[] = Object.keys(US_STATES).filter((c) => c !== "AK" && c !== "HI" && c !== "DC");
/** States the sample gives a surcharge, so a demo shows the surcharge column working. The NUMBERS are made up. */
export const SAMPLE_SURCHARGE_STATES: readonly string[] = ["IN", "KY", "VA"];

/**
 * Made-up rates for a demo, the same every time for the same quarter: between $0.2000 and $0.6495 a gallon, surcharges between $0.0500 and $0.1495. NOT real rates and never for filing; the
 * screen says so on every row they are on.
 */
export function sampleIftaRates(quarter: string): Array<{ jurisdiction: string; rate: string; surcharge: string }> {
  const pick = (seed: string, lo: number, span: number) => {
    let h = 2166136261;
    for (let i = 0; i < seed.length; i += 1) h = Math.imul(h ^ seed.charCodeAt(i), 16777619) >>> 0;
    const tenThousandths = lo + (h % span) * 5;
    return `${Math.floor(tenThousandths / 10_000)}.${String(tenThousandths % 10_000).padStart(4, "0")}`;
  };
  return SAMPLE_JURISDICTIONS.map((j) => ({ jurisdiction: j, rate: pick(`${quarter}:${j}`, 2000, 900), surcharge: SAMPLE_SURCHARGE_STATES.includes(j) ? pick(`${quarter}:${j}:s`, 500, 200) : "0.0000" }));
}
