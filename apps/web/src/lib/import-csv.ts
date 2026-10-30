import { toCsv } from "./csv";
import { validateDriver, validateTruck, type DriverValues, type TruckSpecs, type TruckValues } from "./fleet-forms";

/**
 * Bulk import of trucks and drivers from a spreadsheet saved as CSV. A fleet of thousands is not typed in by hand, so a file is read, each row is checked with the
 * same rules as the Add truck / Add driver forms (validateTruck, validateDriver), a copy of a name already in use or earlier in the file is refused, and the rows
 * that pass are the ones imported. Pure: the server reads and writes the database (server/tl/import.ts); this decides what a file means.
 */
export type ImportKind = "trucks" | "drivers";
/** A file is read whole in one request; this is far more than any fleet and keeps one upload bounded. */
export const IMPORT_MAX_ROWS = 20_000;
/** Problem rows sent back for the screen to page through. The count is always exact; the list stops here. */
export const IMPORT_MAX_PROBLEMS = 5_000;

// ── Reading the file ───────────────────────────────────────────────────────────────────────────

/** CSV text as rows of cells (RFC 4180): a quoted cell may hold commas, doubled quotes and line breaks; a byte order mark and CRLF or LF line ends are fine. */
export function parseCsv(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += c;
    } else if (c === '"' && cell === "") quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, "");

type Column<K extends string> = { key: K; label: string; aliases: string[]; example: string };

const TRUCK_COLUMNS: Array<Column<keyof TruckValues>> = [
  { key: "name", label: "Name", aliases: ["name", "truck", "truckname", "unit", "unitnumber", "unitno", "truckid"], example: "Unit 104" },
  { key: "type", label: "Type", aliases: ["type", "trucktype", "equipment"], example: "heavy_duty" },
  { key: "make", label: "Make", aliases: ["make"], example: "Freightliner" },
  { key: "model", label: "Model", aliases: ["model"], example: "Cascadia" },
  { key: "year", label: "Year", aliases: ["year", "modelyear"], example: "2022" },
  { key: "mpg", label: "Miles per gallon", aliases: ["mpg", "milespergallon"], example: "6.8" },
  { key: "fuelType", label: "Fuel", aliases: ["fuel", "fueltype"], example: "diesel" },
  { key: "homeBaseAddress", label: "Home base", aliases: ["homebase", "homebaseaddress", "home", "base", "domicileaddress"], example: "Dallas, TX" },
  { key: "terminal", label: "Terminal", aliases: ["terminal", "yard", "branch", "region", "domicile"], example: "Dallas" },
  { key: "payloadLbs", label: "Payload (lb)", aliases: ["payload", "payloadlb", "payloadlbs", "maxpayload"], example: "44000" },
  { key: "maxLengthFt", label: "Cargo length (ft)", aliases: ["cargolength", "cargolengthft", "lengthft", "length"], example: "53" },
  { key: "maxWidthFt", label: "Cargo width (ft)", aliases: ["cargowidth", "cargowidthft", "widthft", "width"], example: "8.5" },
  { key: "maxHeightIn", label: "Cargo height (in)", aliases: ["cargoheight", "cargoheightin", "heightin", "height"], example: "162" },
  { key: "hasLiftgate", label: "Liftgate", aliases: ["liftgate", "hasliftgate"], example: "no" },
  { key: "hasRamp", label: "Ramp", aliases: ["ramp", "hasramp"], example: "no" },
  { key: "hasPalletJack", label: "Pallet jack", aliases: ["palletjack", "haspalletjack"], example: "no" }
];

/** "Truck" in a driver file is the truck they drive, by name; every other column is a driver form field of the same name. */
type DriverColumnKey = Exclude<keyof DriverValues, "assignedVehicleId"> | "truck";
const DRIVER_COLUMNS: Array<Column<DriverColumnKey>> = [
  { key: "name", label: "Name", aliases: ["name", "driver", "drivername", "fullname"], example: "Alex Rivera" },
  { key: "phone", label: "Phone", aliases: ["phone", "mobile", "cell", "phonenumber"], example: "555-0142" },
  { key: "email", label: "Email", aliases: ["email", "emailaddress"], example: "alex@example.com" },
  { key: "cdlClass", label: "CDL class", aliases: ["cdlclass", "cdl", "class"], example: "A" },
  { key: "cdlExpiry", label: "CDL good through", aliases: ["cdlgoodthrough", "cdlexpiry", "cdlexpires", "cdlexpiration", "cdlexp"], example: "2027-03-31" },
  { key: "medicalCardExpiry", label: "Medical card good through", aliases: ["medicalcardgoodthrough", "medicalcardexpiry", "medicalexpiry", "medicalexpires", "medical", "medicalcard", "dotmedical"], example: "2027-06-30" },
  { key: "truck", label: "Truck", aliases: ["truck", "assignedtruck", "drives", "unit", "unitnumber"], example: "Unit 104" },
  { key: "payKind", label: "Usual pay", aliases: ["usualpay", "paykind", "paytype", "pay"], example: "cpm" },
  { key: "payRate", label: "Rate", aliases: ["rate", "payrate"], example: "0.55" },
  { key: "terminal", label: "Terminal", aliases: ["terminal", "yard", "branch", "region", "domicile"], example: "Dallas" }
];

const COLUMNS = { trucks: TRUCK_COLUMNS, drivers: DRIVER_COLUMNS } as const;
const REQUIRED = { trucks: ["name"], drivers: ["name"] } as const;

/** A file with a header row and one example row, for a person to fill in. */
export function importTemplate(kind: ImportKind): string {
  const cols = COLUMNS[kind];
  return toCsv(cols.map((c) => c.label), [cols.map((c) => c.example)]);
}

export type HeaderReading = {
  /** Each file column that means something, and what it is read as. */
  matched: Array<{ column: string; field: string }>;
  /** File columns nothing is read from. */
  unknown: string[];
  /** Required columns the file lacks. */
  missing: string[];
  /** Column index in the file for each field key. */
  index: Record<string, number>;
};

export function readHeader(kind: ImportKind, header: string[]): HeaderReading {
  const index: Record<string, number> = {};
  const matched: HeaderReading["matched"] = [];
  const unknown: string[] = [];
  header.forEach((h, i) => {
    const n = norm(h);
    if (n === "") return;
    const col = COLUMNS[kind].find((c) => c.aliases.includes(n) && index[c.key] === undefined);
    if (col) {
      index[col.key] = i;
      matched.push({ column: h.trim(), field: col.label });
    } else unknown.push(h.trim());
  });
  const missing = REQUIRED[kind].filter((k) => index[k] === undefined).map((k) => COLUMNS[kind].find((c) => c.key === k)!.label);
  return { matched, unknown, missing, index };
}

// ── Reading a cell ─────────────────────────────────────────────────────────────────────────────

const YES = new Set(["yes", "y", "true", "1", "x", "t"]);
const asYes = (v: string) => (YES.has(v.trim().toLowerCase()) ? "yes" : "");

/** A date as typed in a spreadsheet ("3/31/2027", "2027-03-31") as the "2027-03-31" the forms take; anything else is left for the form's own check to refuse. */
export function asYmd(v: string): string {
  const t = v.trim();
  const us = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(t);
  if (us) return `${us[3]}-${us[1]!.padStart(2, "0")}-${us[2]!.padStart(2, "0")}`;
  return t;
}

const digits = (v: string) => v.replace(/\D/g, "");

// ── Checking the rows ──────────────────────────────────────────────────────────────────────────

export type ProblemRow = { line: number; errors: string[]; cells: string[] };
export type ImportCheck<T> = {
  header: HeaderReading;
  /** Rows with something in them (blank lines are not counted). */
  total: number;
  good: Array<{ line: number; item: T }>;
  /** Up to IMPORT_MAX_PROBLEMS of them; `problemCount` is the whole number. */
  problems: ProblemRow[];
  problemCount: number;
  tooMany: boolean;
};

export type TruckImport = { values: TruckValues; mpg: number | null; specs: TruckSpecs };
export type DriverImport = { values: DriverValues; cdlExpiry: Date | null; medicalCardExpiry: Date | null; payRate: number | null };

const cellAt = (cells: string[], header: HeaderReading, key: string) => {
  const i = header.index[key];
  return i === undefined ? "" : (cells[i] ?? "").trim();
};

function emptyCheck<T>(header: HeaderReading, tooMany = false): ImportCheck<T> {
  return { header, total: 0, good: [], problems: [], problemCount: 0, tooMany };
}

function walk<T>(kind: ImportKind, table: string[][], row: (cells: string[], header: HeaderReading, line: number) => { item?: T; errors?: string[] }): ImportCheck<T> {
  const header = readHeader(kind, table[0] ?? []);
  if (header.missing.length > 0) return emptyCheck(header);
  const out = emptyCheck<T>(header);
  const body = table.slice(1);
  if (body.length > IMPORT_MAX_ROWS + 1000) return emptyCheck(header, true);
  body.forEach((cells, i) => {
    if (cells.every((c) => c.trim() === "")) return;
    out.total += 1;
    const line = i + 2; // the file's own line number, header on line 1
    const r = row(cells, header, line);
    if (r.errors && r.errors.length > 0) {
      out.problemCount += 1;
      if (out.problems.length < IMPORT_MAX_PROBLEMS) out.problems.push({ line, errors: r.errors, cells });
    } else if (r.item !== undefined) out.good.push({ line, item: r.item });
  });
  if (out.total > IMPORT_MAX_ROWS) return emptyCheck(header, true);
  return out;
}

/** "Column: what is wrong"; a message that already starts with the column's name (the form says "Miles per gallon between 2 and 40.") is not given it twice. */
const messages = (errors: Partial<Record<string, string>>, label: (k: string) => string) =>
  Object.entries(errors).map(([k, m]) => (m!.toLowerCase().startsWith(label(k).toLowerCase()) ? m! : `${label(k)}: ${m}`));
const labelOf = (kind: ImportKind) => (k: string) => COLUMNS[kind].find((c) => c.key === k)?.label ?? k;

/**
 * Trucks. `existingNames` are the names of trucks already in service (lower case): a truck with one of them, or with a name an earlier row of the file has,
 * is refused, as the Add truck form refuses it.
 */
export function checkTruckRows(table: string[][], existingNames: ReadonlySet<string>): ImportCheck<TruckImport> {
  const seen = new Map<string, number>();
  return walk<TruckImport>("trucks", table, (cells, header, line) => {
    const raw: Record<string, string> = {};
    for (const c of TRUCK_COLUMNS) raw[c.key] = cellAt(cells, header, c.key);
    for (const k of ["hasLiftgate", "hasRamp", "hasPalletJack"]) raw[k] = asYes(raw[k]!);
    const check = validateTruck(raw);
    if (!check.ok) return { errors: messages(check.errors, labelOf("trucks")) };
    const key = check.value.name.toLowerCase();
    if (existingNames.has(key)) return { errors: [`Name: A truck named ${check.value.name} is already in service.`] };
    const first = seen.get(key);
    if (first !== undefined) return { errors: [`Name: ${check.value.name} is also on line ${first} of this file.`] };
    seen.set(key, line);
    return { item: { values: check.value, mpg: check.mpg, specs: check.specs } };
  });
}

/**
 * Drivers. `truckIdByName` maps a truck's name (lower case) to its id, for the Truck column. `existingKeys` are the drivers already there as `driverKey`s: the same
 * name and phone is the same person, so a file loaded twice does not double the roster (two drivers with one name and different phones are two people).
 */
export const driverKey = (name: string, phone: string) => `${name.trim().replace(/\s+/g, " ").toLowerCase()}|${digits(phone)}`;

export function checkDriverRows(table: string[][], truckIdByName: ReadonlyMap<string, string>, existingKeys: ReadonlySet<string>): ImportCheck<DriverImport & { truckId: string }> {
  const seen = new Map<string, number>();
  return walk<DriverImport & { truckId: string }>("drivers", table, (cells, header, line) => {
    const raw: Record<string, string> = {};
    for (const c of DRIVER_COLUMNS) raw[c.key] = cellAt(cells, header, c.key);
    raw.cdlExpiry = asYmd(raw.cdlExpiry!);
    raw.medicalCardExpiry = asYmd(raw.medicalCardExpiry!);
    const truckName = raw.truck!;
    delete raw.truck;
    const truckId = truckName ? (truckIdByName.get(truckName.toLowerCase()) ?? null) : "";
    const check = validateDriver({ ...raw, assignedVehicleId: truckId ?? "" });
    const errors = check.ok ? [] : messages(check.errors, labelOf("drivers"));
    if (truckName && truckId === null) errors.push(`Truck: No truck named ${truckName} is in service. Import the trucks first.`);
    if (!check.ok || errors.length > 0) return { errors };
    const key = driverKey(check.value.name, check.value.phone);
    if (existingKeys.has(key)) return { errors: [`Name: ${check.value.name}${check.value.phone ? ` with that phone` : ""} is already a driver.`] };
    const first = seen.get(key);
    if (first !== undefined) return { errors: [`Name: ${check.value.name} is also on line ${first} of this file.`] };
    seen.set(key, line);
    return { item: { values: check.value, cdlExpiry: check.cdlExpiry, medicalCardExpiry: check.medicalCardExpiry, payRate: check.payRate, truckId: truckId ?? "" } };
  });
}

/** The problem rows as a CSV to fix and load again: the file's own cells with the reasons in front. */
export function problemsCsv(headers: string[], problems: ProblemRow[]): string {
  return toCsv(["Line", "What is wrong", ...headers], problems.map((p) => [p.line, p.errors.join(" "), ...p.cells]));
}
