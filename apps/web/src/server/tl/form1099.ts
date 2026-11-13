import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { addressText, form1099Threshold, fromCents, profileGaps, tallyLines, thresholdNote, tinStatusLabel, tinTypeLabel } from "@/lib/form1099";
import { terminalFilter, type Terminals } from "@/lib/scope";
import { centralMidnight } from "@/lib/zoned";
import { toCsv, type CsvCell } from "@/lib/csv";
import { currentWorkspaceId } from "./workspace";
import { workspaceTimezone } from "./zone";

/**
 * The yearly contractor 1099 totals (docs/MONEY_PLAN.md, Wave 4 step 2). The first statement reader built on the rows: every figure comes from `SettlementLine`, never from a statement's
 * `lines` / `adjustments` / `fuel` JSON.
 *
 * Which statements count: finalized (never draft or void), for a driver set up as a contractor (W-2 employees go through payroll, rule E), paid in the tax year by the calendar day in the
 * workspace's own zone (cash basis). Paid covers both paths: a person marking it paid (check, transfer) and payroll's paid event. A statement finalized and not paid yet does not count; those
 * are listed apart so the accountant knows they exist.
 *
 * Gross and net are worked out by lib/form1099.ts (gross = pay rows; net = every row). A negative hand-typed adjustment is money off and does not lower gross.
 */
export type Form1099Row = {
  driverId: string;
  name: string;
  /** The legal name, or the driver's name when none is set (legalNameMissing says which). */
  legalName: string;
  legalNameMissing: boolean;
  tinType: string | null;
  tinLast4: string | null;
  tinStatus: string;
  address: string | null;
  statements: number;
  gross: number;
  net: number;
  overThreshold: boolean;
  /** What the 1099 is missing, in words; flagged on a contractor over the threshold. */
  gaps: string[];
  /** Line kinds the 1099 rules do not know yet: counted in net, never in gross. */
  unknownKinds: string[];
  /** The rows do not add up to the statements' totals (rule J says they always do). */
  rowsDisagree: boolean;
};

export type Form1099Unpaid = { id: string; number: string; driverId: string; driverName: string; finalizedAt: Date | null; total: number };

export type Form1099Report = {
  year: number;
  threshold: number;
  note: string;
  zone: string;
  rows: Form1099Row[];
  totals: { contractors: number; over: number; incompleteOver: number; gross: number; net: number; statements: number };
  unpaid: { count: number; total: number; rows: Form1099Unpaid[] };
  hiddenByTerminal: number;
};

const cents = (d: Prisma.Decimal | null): number => (d == null ? 0 : new Prisma.Decimal(d).times(100).toDecimalPlaces(0).toNumber());

/** The instants the tax year starts and ends at in the workspace's zone: [from, to). */
export function yearBounds(year: number, zone: string): { from: Date; to: Date } {
  return { from: new Date(centralMidnight(year, 0, 1, zone)), to: new Date(centralMidnight(year + 1, 0, 1, zone)) };
}

export async function contractor1099(year: number, opts: { terminal?: Terminals } = {}, workspaceId = currentWorkspaceId()): Promise<Form1099Report> {
  const zone = await workspaceTimezone(workspaceId);
  const { from, to } = yearBounds(year, zone);
  const threshold = form1099Threshold(year);
  const contractor = { payrollWorkerType: "contractor", ...(opts.terminal != null ? { terminal: terminalFilter(opts.terminal) } : {}) };
  const paidWhere = { workspaceId, status: "final", paidAt: { gte: from, lt: to }, driver: contractor };
  const unpaidWhere = { workspaceId, status: "final", paidAt: null, finalizedAt: { lt: to }, driver: contractor };

  const [statements, unpaid, hiddenByTerminal] = await Promise.all([
    prisma.settlement.findMany({ where: paidWhere, select: { id: true, driverId: true, total: true } }),
    prisma.settlement.findMany({ where: unpaidWhere, select: { id: true, number: true, driverId: true, total: true, finalizedAt: true, driver: { select: { name: true } } }, orderBy: [{ finalizedAt: "asc" }, { number: "asc" }] }),
    opts.terminal != null
      ? prisma.settlement.count({ where: { workspaceId, status: "final", paidAt: { gte: from, lt: to }, driver: { payrollWorkerType: "contractor" } } }).then(async (all) => all - (await prisma.settlement.count({ where: paidWhere })))
      : Promise.resolve(0)
  ]);

  const ids = statements.map((s) => s.id);
  const [lines, drivers] = await Promise.all([
    ids.length === 0 ? Promise.resolve([]) : prisma.settlementLine.findMany({ where: { workspaceId, settlementId: { in: ids } }, select: { settlementId: true, kind: true, amount: true } }),
    prisma.driver.findMany({ where: { workspaceId, id: { in: [...new Set(statements.map((s) => s.driverId))] } } })
  ]);

  const driverOf = new Map(statements.map((s) => [s.id, s.driverId]));
  const linesBy = new Map<string, { kind: string; cents: number }[]>();
  for (const l of lines) {
    const d = driverOf.get(l.settlementId)!;
    const list = linesBy.get(d) ?? [];
    list.push({ kind: l.kind, cents: cents(l.amount) });
    linesBy.set(d, list);
  }
  const totalsBy = new Map<string, { n: number; cents: number }>();
  for (const s of statements) {
    const t = totalsBy.get(s.driverId) ?? { n: 0, cents: 0 };
    totalsBy.set(s.driverId, { n: t.n + 1, cents: t.cents + cents(s.total) });
  }

  let grossCents = 0;
  let netCents = 0;
  const rows: Form1099Row[] = drivers.map((d) => {
    const tally = tallyLines(linesBy.get(d.id) ?? []);
    const t = totalsBy.get(d.id)!;
    grossCents += tally.grossCents;
    netCents += tally.netCents;
    return {
      driverId: d.id,
      name: d.name,
      legalName: d.legalName?.trim() || d.name,
      legalNameMissing: !d.legalName?.trim(),
      tinType: d.tinType,
      tinLast4: d.tinLast4,
      tinStatus: d.tinStatus,
      address: addressText(d),
      statements: t.n,
      gross: fromCents(tally.grossCents),
      net: fromCents(tally.netCents),
      // "Or more": a contractor paid exactly the threshold is reported.
      overThreshold: tally.grossCents >= threshold * 100,
      gaps: profileGaps(d),
      unknownKinds: tally.unknownKinds,
      rowsDisagree: tally.netCents !== t.cents
    };
  });
  rows.sort((a, b) => b.gross - a.gross || a.legalName.localeCompare(b.legalName));

  let unpaidCents = 0;
  const unpaidRows = unpaid.map((s) => {
    unpaidCents += cents(s.total);
    return { id: s.id, number: s.number, driverId: s.driverId, driverName: s.driver.name, finalizedAt: s.finalizedAt, total: fromCents(cents(s.total)) };
  });
  return {
    year,
    threshold,
    note: thresholdNote(year),
    zone,
    rows,
    totals: {
      contractors: rows.length,
      over: rows.filter((r) => r.overThreshold).length,
      incompleteOver: rows.filter((r) => r.overThreshold && r.gaps.length > 0).length,
      gross: fromCents(grossCents),
      net: fromCents(netCents),
      statements: statements.length
    },
    unpaid: { count: unpaidRows.length, total: fromCents(unpaidCents), rows: unpaidRows },
    hiddenByTerminal
  };
}

export const FORM_1099_HEADER = ["Legal name", "Name on the desk", "TIN type", "TIN last 4", "TIN status", "Address", "Gross compensation", "Net paid", "Statements", "Over threshold", "Threshold used (confirm with your accountant)", "Missing for the 1099"];

/** The CSV the 1099 screen offers, from the same report the screen draws. The first row after the header is the threshold note, so the file always carries it. */
export function form1099Csv(r: Form1099Report): string {
  const rows: CsvCell[][] = r.rows.map((x) => [
    x.legalName,
    x.legalNameMissing ? `${x.name} (no legal name set)` : x.name,
    tinTypeLabel(x.tinType),
    x.tinLast4,
    tinStatusLabel(x.tinStatus),
    x.address,
    x.gross,
    x.net,
    x.statements,
    x.overThreshold ? "Yes" : "No",
    r.threshold,
    x.overThreshold && x.gaps.length > 0 ? x.gaps.join("; ") : null
  ]);
  const notes: CsvCell[][] = [
    [`Tax year ${r.year}. ${r.note} Gross compensation is pay before fuel, deductions and advances (1099-NEC box 1); a negative adjustment, a deduction and escrow held are money off and do not lower it; escrow released pays back the driver's own money and is in net paid only. Net paid is every line, the statements' totals. Contractors only; paid in the year by the day in ${r.zone}.`],
    ...(r.unpaid.count > 0 ? [[`Finalized, not paid yet (not counted): ${r.unpaid.count} statements, ${r.unpaid.total.toFixed(2)}.`] as CsvCell[]] : [])
  ];
  return toCsv(FORM_1099_HEADER, [...rows, [], ...notes]);
}
