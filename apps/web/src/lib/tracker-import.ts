import { toCsv } from "./csv";
import { IMPORT_MAX_PROBLEMS, IMPORT_MAX_ROWS, type ProblemRow } from "./import-csv";
import { matchHeader, placeOf, readDay, readMoney, readWhole } from "./load-import";

/**
 * Loading a carrier's own weekly tracker: a spreadsheet with one row per lane per week (loads, line haul, miles), not a list of loads. A tracker is a different kind of file from a load history, and it is kept
 * as one: its rows become "imported history", a table of their own that feeds the trends and is labelled as imported wherever it is shown. It is never turned into loads and never added to a figure built from loads,
 * so an owner can see their own past weeks beside the desk's own without the two being mixed. Pure: the server reads and writes the database (server/tl/tracker-import.ts); this decides what a file means.
 */
export type WeekFieldKey = "week" | "lane" | "origin" | "destination" | "loads" | "lineHaul" | "fuelSurcharge" | "loadedMiles" | "emptyMiles" | "pickupEmptyMiles" | "returnEmptyMiles";

export type WeekField = { key: WeekFieldKey; label: string; required: boolean; aliases: string[]; example: string; hint?: string };

export const WEEK_FIELDS: readonly WeekField[] = [
  { key: "week", label: "Week", required: true, aliases: ["week", "weekof", "weekending", "weekend", "weekstart", "weekstarting", "weekbeginning", "weekdate", "date", "period", "weekof"], example: "2026-09-14", hint: "Any day in the week. Weeks are counted Monday to Sunday; if your weeks start on a Sunday, give a weekday date." },
  { key: "lane", label: "Lane", required: false, aliases: ["lane", "route", "laneid", "lanename"], example: "Dallas, TX to Atlanta, GA", hint: "Either one Lane column (Dallas, TX to Atlanta, GA) or a Pickup and a Delivery column." },
  { key: "origin", label: "Pickup city", required: false, aliases: ["pickupcity", "origin", "origincity", "pickup", "from"], example: "Dallas, TX" },
  { key: "destination", label: "Delivery city", required: false, aliases: ["deliverycity", "destination", "destinationcity", "delivery", "to"], example: "Atlanta, GA" },
  { key: "loads", label: "Loads", required: true, aliases: ["loads", "numberofloads", "loadcount", "count", "trips", "qty", "totalloads", "loadsdelivered"], example: "6" },
  { key: "lineHaul", label: "Line haul", required: true, aliases: ["linehaul", "revenue", "linehaulrevenue", "gross", "totalrevenue", "linehaulrate", "amount"], example: "12900.00", hint: "The week's agreed rates for the lane, without the fuel surcharge." },
  { key: "fuelSurcharge", label: "Fuel surcharge", required: false, aliases: ["fuelsurcharge", "fsc", "fuel", "fscdollars"], example: "1080.00", hint: "In dollars." },
  { key: "loadedMiles", label: "Loaded miles", required: true, aliases: ["loadedmiles", "miles", "totalloadedmiles", "loaded", "milesloaded"], example: "4686" },
  { key: "emptyMiles", label: "Empty miles (total)", required: false, aliases: ["emptymiles", "deadheadmiles", "deadhead", "dh", "totalemptymiles", "emptymilestotal", "totaldeadhead", "emptytotal"], example: "300", hint: "Or give the two below; the desk adds them." },
  { key: "pickupEmptyMiles", label: "Empty miles before pickup", required: false, aliases: ["emptymilesbeforepickup", "emptybeforepickup", "dhpickup", "deadheadbefore", "pickupdeadhead", "pickupempty"], example: "180" },
  { key: "returnEmptyMiles", label: "Empty miles after delivery", required: false, aliases: ["emptymilesafterdelivery", "emptyafterdelivery", "dhreturn", "deadheadafter", "returndeadhead", "returnempty"], example: "120" }
];

export const WEEK_FIELD_OF: Readonly<Record<WeekFieldKey, WeekField>> = Object.fromEntries(WEEK_FIELDS.map((f) => [f.key, f])) as Record<WeekFieldKey, WeekField>;

export type WeekMap = Record<WeekFieldKey, number | null>;
export const emptyWeekMap = (): WeekMap => Object.fromEntries(WEEK_FIELDS.map((f) => [f.key, null])) as WeekMap;
export const autoWeekMap = (header: readonly string[]): WeekMap => matchHeader(header, WEEK_FIELDS);

/** A map that is safe to use against this header: indexes inside the file, no column used twice (the later field loses it). */
export function cleanWeekMap(map: Partial<Record<WeekFieldKey, number | null>>, width: number): WeekMap {
  const out = emptyWeekMap();
  const used = new Set<number>();
  for (const f of WEEK_FIELDS) {
    const v = map[f.key];
    if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v < width && !used.has(v)) {
      out[f.key] = v;
      used.add(v);
    }
  }
  return out;
}

/** What the file still needs a column for: the required ones, and a lane (one Lane column, or both a Pickup and a Delivery). */
export function missingWeekFields(map: WeekMap): Array<{ key: WeekFieldKey; label: string }> {
  const out = WEEK_FIELDS.filter((f) => f.required && map[f.key] == null).map((f) => ({ key: f.key, label: f.label }));
  if (map.lane == null && (map.origin == null || map.destination == null)) out.push({ key: "lane", label: "Lane (or a Pickup and a Delivery city)" });
  return out;
}

export function weekImportTemplate(): string {
  const cols = WEEK_FIELDS.filter((f) => f.key !== "origin" && f.key !== "destination" && f.key !== "emptyMiles");
  return toCsv(
    cols.map((f) => f.label),
    [cols.map((f) => f.example)]
  );
}

// ── Reading a row ────────────────────────────────────────────────────────────────────────────────

export type WeekDraft = { weekStart: Date; lane: string; loads: number; lineHaul: number; fuelSurcharge: number; loadedMiles: number; emptyMiles: number };

/** The Monday of the week a day falls in, as that calendar day at midnight UTC (a date with no clock). */
export function mondayOf(day: Date): Date {
  const d = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()));
  const back = (d.getUTCDay() + 6) % 7;
  return new Date(d.getTime() - back * 86_400_000);
}

export const MAX_WEEK_LOADS = 100_000;
export const MAX_WEEK_DOLLARS = 100_000_000;
export const MAX_WEEK_MILES = 50_000_000;

/** "Dallas, TX to Atlanta, GA", "Dallas TX -> Atlanta GA", "Dallas, TX → Atlanta, GA": the two places, or null. */
export function laneParts(raw: string): [string, string] | null {
  const parts = raw.trim().split(/\s*(?:→|->|=>|–>)\s*|\s+to\s+/i);
  if (parts.length !== 2 || parts[0]!.trim() === "" || parts[1]!.trim() === "") return null;
  return [placeOf(parts[0]!), placeOf(parts[1]!)];
}

/** A lane as the desk writes it everywhere (the KPI, Lanes): "Dallas, TX → Atlanta, GA". */
export const laneKey = (origin: string, destination: string) => `${origin} → ${destination}`;

export type WeekCheck = {
  total: number;
  good: Array<{ line: number; item: WeekDraft }>;
  problems: ProblemRow[];
  problemCount: number;
  /** The same lane and week already imported, or twice in the file: left out, counted apart from the mistakes. */
  duplicates: number;
  tooMany: boolean;
  summary: { weeks: number; lanes: number; loads: number; revenue: number; first: string | null; last: string | null };
};

const cell = (row: string[], at: number | null) => (at == null ? "" : (row[at] ?? "").trim());
const dayKey = (d: Date) => d.toISOString().slice(0, 10);
export const weekKeyOf = (weekStart: Date, lane: string) => `${dayKey(weekStart)}|${lane.toLowerCase()}`;

export function checkWeekRows(table: string[][], map: WeekMap, existing: ReadonlySet<string>, nowMs = Date.now()): WeekCheck {
  const body = table.slice(1);
  const out: WeekCheck = { total: 0, good: [], problems: [], problemCount: 0, duplicates: 0, tooMany: body.length > IMPORT_MAX_ROWS + 1000, summary: { weeks: 0, lanes: 0, loads: 0, revenue: 0, first: null, last: null } };
  if (out.tooMany) return out;
  const seen = new Set<string>();
  body.forEach((row, i) => {
    if (row.every((c) => c.trim() === "")) return;
    out.total += 1;
    const line = i + 2;
    const errors: string[] = [];
    const fail = (m: string) => errors.push(m);
    const get = (k: WeekFieldKey) => cell(row, map[k]);

    const day = readDay(get("week"));
    let weekStart: Date | null = null;
    if (day === null) fail("Week is empty.");
    else if (day === "bad") fail("Week is not a date (use 2026-09-14 or 9/14/2026).");
    else {
      weekStart = mondayOf(day);
      if (weekStart.getTime() > nowMs + 7 * 86_400_000) fail("Week is in the future: this imports past weeks only.");
    }

    let lane = "";
    if (map.lane != null && get("lane") !== "") {
      const p = laneParts(get("lane"));
      if (!p) fail("Lane must name two places, like Dallas, TX to Atlanta, GA.");
      else lane = laneKey(p[0], p[1]);
    } else if (map.origin != null && map.destination != null) {
      const o = placeOf(get("origin"));
      const d = placeOf(get("destination"));
      if (o === "" || d === "") fail("Pickup and delivery cities are needed.");
      else lane = laneKey(o, d);
    } else fail("Lane is empty.");
    if (lane.length > 240) fail("A lane is longer than 240 characters.");

    const loads = readWhole(get("loads"));
    if (loads === null) fail("Loads is empty.");
    else if (loads === "bad" || !Number.isInteger(loads)) fail("Loads is not a whole number.");
    else if (!(loads > 0) || loads > MAX_WEEK_LOADS) fail(`Loads must be at least 1 and no more than ${MAX_WEEK_LOADS.toLocaleString("en-US")}.`);

    const haul = readMoney(get("lineHaul"));
    if (haul === null) fail("Line haul is empty.");
    else if (haul === "bad") fail("Line haul is not a dollar amount.");
    else if (haul < 0 || haul > MAX_WEEK_DOLLARS) fail("Line haul is out of range.");
    const fsc = readMoney(get("fuelSurcharge"));
    if (fsc === "bad") fail("Fuel surcharge is not a dollar amount.");
    else if (fsc != null && (fsc < 0 || fsc > MAX_WEEK_DOLLARS)) fail("Fuel surcharge is out of range.");

    const loaded = readWhole(get("loadedMiles"));
    if (loaded === null) fail("Loaded miles is empty.");
    else if (loaded === "bad") fail("Loaded miles is not a number.");
    else if (loaded < 0 || loaded > MAX_WEEK_MILES) fail("Loaded miles is out of range.");
    const total = readWhole(get("emptyMiles"));
    const before = readWhole(get("pickupEmptyMiles"));
    const after = readWhole(get("returnEmptyMiles"));
    for (const [v, what] of [[total, "Empty miles"], [before, "Empty miles before pickup"], [after, "Empty miles after delivery"]] as const) {
      if (v === "bad") fail(`${what} is not a number.`);
      else if (v != null && v > MAX_WEEK_MILES) fail(`${what} is out of range.`);
    }

    if (errors.length > 0 || weekStart == null) {
      out.problemCount += 1;
      if (out.problems.length < IMPORT_MAX_PROBLEMS) out.problems.push({ line, errors, cells: row });
      return;
    }
    const key = weekKeyOf(weekStart, lane);
    if (existing.has(key) || seen.has(key)) {
      out.duplicates += 1;
      return;
    }
    seen.add(key);
    const split = (typeof before === "number" ? before : 0) + (typeof after === "number" ? after : 0);
    out.good.push({ line, item: { weekStart, lane, loads: loads as number, lineHaul: haul as number, fuelSurcharge: typeof fsc === "number" ? fsc : 0, loadedMiles: loaded as number, emptyMiles: typeof total === "number" ? total : split } });
  });
  const weeks = new Set<string>();
  const lanes = new Set<string>();
  for (const g of out.good) {
    const s = out.summary;
    weeks.add(dayKey(g.item.weekStart));
    lanes.add(g.item.lane.toLowerCase());
    s.loads += g.item.loads;
    s.revenue += g.item.lineHaul + g.item.fuelSurcharge;
    const k = dayKey(g.item.weekStart);
    if (s.first == null || k < s.first) s.first = k;
    if (s.last == null || k > s.last) s.last = k;
  }
  out.summary.weeks = weeks.size;
  out.summary.lanes = lanes.size;
  return out;
}

// ── What the imported history shows ──────────────────────────────────────────────────────────────

export type HistoryRow = { weekStart: string; lane: string; loads: number; lineHaul: number; fuelSurcharge: number; loadedMiles: number; emptyMiles: number };
export type HistoryWeek = { weekStart: string; loads: number; revenue: number; loadedMiles: number; emptyMiles: number; /** Revenue per loaded mile, or null with none. */ perLoadedMile: number | null; /** Empty miles over every mile driven, 0 to 1, or null with none. */ emptyShare: number | null; lanes: number };
export type HistoryLane = { lane: string; loads: number; revenue: number; loadedMiles: number; emptyMiles: number; perLoadedMile: number | null; emptyShare: number | null; weeks: number };

const ratio = (a: number, b: number) => (b > 0 ? a / b : null);

/** The imported rows added up by week, oldest first. Revenue is the line haul and the fuel surcharge; per mile is over loaded miles (a tracker has no revenue-mile basis). */
export function weeksOf(rows: readonly HistoryRow[]): HistoryWeek[] {
  const by = new Map<string, HistoryWeek & { laneSet: Set<string> }>();
  for (const r of rows) {
    const w = by.get(r.weekStart) ?? { weekStart: r.weekStart, loads: 0, revenue: 0, loadedMiles: 0, emptyMiles: 0, perLoadedMile: null, emptyShare: null, lanes: 0, laneSet: new Set<string>() };
    w.loads += r.loads;
    w.revenue += r.lineHaul + r.fuelSurcharge;
    w.loadedMiles += r.loadedMiles;
    w.emptyMiles += r.emptyMiles;
    w.laneSet.add(r.lane);
    by.set(r.weekStart, w);
  }
  return [...by.values()]
    .sort((a, b) => a.weekStart.localeCompare(b.weekStart))
    .map(({ laneSet, ...w }) => ({ ...w, perLoadedMile: ratio(w.revenue, w.loadedMiles), emptyShare: ratio(w.emptyMiles, w.loadedMiles + w.emptyMiles), lanes: laneSet.size }));
}

/** The imported rows added up by lane, the biggest by revenue first. */
export function lanesOf(rows: readonly HistoryRow[]): HistoryLane[] {
  const by = new Map<string, HistoryLane & { weekSet: Set<string> }>();
  for (const r of rows) {
    const l = by.get(r.lane) ?? { lane: r.lane, loads: 0, revenue: 0, loadedMiles: 0, emptyMiles: 0, perLoadedMile: null, emptyShare: null, weeks: 0, weekSet: new Set<string>() };
    l.loads += r.loads;
    l.revenue += r.lineHaul + r.fuelSurcharge;
    l.loadedMiles += r.loadedMiles;
    l.emptyMiles += r.emptyMiles;
    l.weekSet.add(r.weekStart);
    by.set(r.lane, l);
  }
  return [...by.values()]
    .map(({ weekSet, ...l }) => ({ ...l, perLoadedMile: ratio(l.revenue, l.loadedMiles), emptyShare: ratio(l.emptyMiles, l.loadedMiles + l.emptyMiles), weeks: weekSet.size }))
    .sort((a, b) => b.revenue - a.revenue || a.lane.localeCompare(b.lane));
}

/** The mark every file of imported history carries in its audit entry's batch id, and the table's own label wherever it is shown. */
export const HISTORY_LABEL = "Imported history";
