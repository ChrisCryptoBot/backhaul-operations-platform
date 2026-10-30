import { Prisma } from "@prisma/client";
import type { Company } from "@/lib/company";
import { toCompany } from "./company";
import { prisma } from "@/lib/db";
import type { AuditSnapshot } from "@/lib/audit-diff";
import { rateConTotal, type PayKind } from "@/lib/pay";
import { computeStatement, linePay, periodBounds, periodCovering, periodText, statementOf, validatePeriod, type Adjustment, type AdjustmentInput, type SettlementLoad, type Statement, type StatementLine } from "@/lib/settlement";
import { recordAudit } from "./audit";
import { num, numOrNull } from "./convert";
import { currentWorkspaceId } from "./workspace";

/**
 * Driver pay statements. A draft is a driver, a period (two Dallas dates) and whatever the dispatcher has typed so far; the loads on it are
 * worked out from the loads each time it is shown, so a load delivered late or fixed since still reads true. Finalizing freezes the load
 * lines, the adjustments and the total, and ties each load to the statement (one row per load, enforced by the database), so a load cannot be
 * paid on two statements. Voiding a final statement keeps it as it was and frees its loads for another. Every step is audited. Gross pay
 * only: no taxes or payroll deductions are worked out here.
 */
export type Draft = { hours: Record<string, string>; adjustments: AdjustmentInput[] };
export type SettleResult = { ok: true; id: string } | { ok: false; error?: string; errors?: Record<string, string> };

type Db = Prisma.TransactionClient | typeof prisma;
type LoadWithAssignment = Prisma.LoadGetPayload<{ include: { assignment: true } }>;

const money = (n: number) => `$${n.toFixed(2)}`;
const ymd = (d: Date) => d.toISOString().slice(0, 10);

function brokerStatus(s: string | null): SettlementLoad["brokerStatus"] {
  return s === "paid" ? "paid" : s === "invoiced" ? "invoiced" : "not_invoiced";
}

/** Hourly pay on an assignment can have been sent with an estimate of the hours; the statement starts from it and the dispatcher can type over it. */
function hoursFromEstimate(payKind: string, rate: number, estimate: unknown): number | null {
  return payKind === "hourly" && rate > 0 && estimate != null && num(estimate as never) > 0 ? new Prisma.Decimal(estimate as never).div(rate).toDecimalPlaces(2).toNumber() : null;
}

function toSettlementLoad(l: LoadWithAssignment): SettlementLoad {
  const a = l.assignment!;
  const rate = num(a.payRate);
  const assignedHours = hoursFromEstimate(a.payKind, rate, a.payEstimate);
  return {
    loadId: l.id,
    loadNumber: l.loadNumber,
    origin: l.originAddress,
    destination: l.destinationAddress,
    deliveredAt: l.completedAt ? l.completedAt.toISOString() : null,
    loadedMiles: num(l.loadedMiles),
    payKind: a.payKind as PayKind,
    payRate: rate,
    rateConTotal: rateConTotal(num(l.quotedRevenue), num(l.fuelSurcharge)),
    assignedHours,
    brokerStatus: brokerStatus(l.paymentStatus)
  };
}

/** Loads a driver delivered between two Dallas dates that are not on a final statement. */
export async function eligibleLoads(driverId: string, start: string, end: string, workspaceId = currentWorkspaceId(), db: Db = prisma): Promise<SettlementLoad[]> {
  const bounds = periodBounds(start, end);
  if (!bounds) return [];
  const loads = await db.load.findMany({
    where: { workspaceId, deletedAt: null, status: "completed", completedAt: { gte: bounds.from, lt: bounds.to }, settlement: { is: null }, assignment: { is: { driverId, status: "completed" } } },
    include: { assignment: true },
    orderBy: [{ completedAt: "asc" }, { loadNumber: "asc" }]
  });
  return loads.map(toSettlementLoad);
}

async function nextNumber(workspaceId: string): Promise<string> {
  const rows = await prisma.settlement.findMany({ where: { workspaceId }, select: { number: true } });
  let highest = 0;
  for (const r of rows) {
    const m = /^ST-(\d+)$/.exec(r.number);
    if (m) {
      const n = new Prisma.Decimal(m[1]!).toNumber();
      if (n > highest) highest = n;
    }
  }
  return `ST-${String(highest + 1).padStart(4, "0")}`;
}

const isUniqueViolation = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";

const typedHours = (hours: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  if (hours && typeof hours === "object") for (const [k, v] of Object.entries(hours as Record<string, unknown>)) if (typeof v === "string") out[k] = v;
  return out;
};
const typedAdjustments = (rows: unknown): AdjustmentInput[] =>
  Array.isArray(rows) ? (rows as Array<{ label?: unknown; amount?: unknown }>).map((r) => ({ label: typeof r.label === "string" ? r.label : "", amount: typeof r.amount === "string" ? r.amount : "" })) : [];

// ── Start, save, finalize, void, discard ───────────────────────────────────────────────────────

export async function startSettlement(input: { driverId: string; start: string; end: string }, now = new Date(), workspaceId = currentWorkspaceId()): Promise<SettleResult> {
  const period = validatePeriod(input.start, input.end);
  if (!period.ok) return { ok: false, errors: period.errors };
  const driver = await prisma.driver.findFirst({ where: { id: input.driverId, workspaceId } });
  if (!driver) return { ok: false, errors: { driverId: "Pick a driver." } };
  const loads = await eligibleLoads(driver.id, period.start, period.end, workspaceId);
  if (loads.length === 0) return { ok: false, error: `No delivered loads for ${driver.name} between ${periodText(period.start, period.end)} that are not already on a statement.` };

  for (let attempt = 0; attempt < 3; attempt++) {
    const number = await nextNumber(workspaceId);
    try {
      const made = await prisma.$transaction(async (tx) => {
        const s = await tx.settlement.create({ data: { workspaceId, driverId: driver.id, number, periodStart: new Date(`${period.start}T00:00:00Z`), periodEnd: new Date(`${period.end}T00:00:00Z`) } });
        await recordAudit(
          { entity: "settlement", action: "statement_started", summary: `${number} started for ${driver.name}, ${periodText(period.start, period.end)}: ${loads.length} delivered ${loads.length === 1 ? "load" : "loads"}`, before: null, after: { Statement: number, Driver: driver.name, Period: periodText(period.start, period.end), Loads: loads.length }, at: now, workspaceId },
          tx
        );
        return s;
      });
      return { ok: true, id: made.id };
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
    }
  }
  return { ok: false, error: "Could not number the statement. Try again." };
}

/** What a draft says today: its loads from the database, and the totals those and the typed values come to. */
async function draftStatement(s: Prisma.SettlementGetPayload<object>, draft: Draft): Promise<{ loads: SettlementLoad[]; statement: Statement }> {
  const loads = await eligibleLoads(s.driverId, ymd(s.periodStart), ymd(s.periodEnd), s.workspaceId);
  return { loads, statement: computeStatement({ loads, hours: draft.hours, adjustments: draft.adjustments }) };
}

/** Keep what has been typed. Hours and lines can be saved unfinished; only what is plainly wrong (a bad number) is refused. */
export async function saveDraft(id: string, draft: Draft, workspaceId = currentWorkspaceId()): Promise<SettleResult> {
  const s = await prisma.settlement.findFirst({ where: { id, workspaceId } });
  if (!s) return { ok: false, error: "That statement does not exist." };
  if (s.status !== "draft") return { ok: false, error: "A finalized statement cannot be changed." };
  const { loads, statement } = await draftStatement(s, draft);
  if (Object.keys(statement.errors).length > 0) return { ok: false, errors: statement.errors };
  const onStatement = new Set(loads.map((l) => l.loadId));
  const hours: Record<string, string> = {};
  for (const [k, v] of Object.entries(draft.hours)) if (onStatement.has(k) && v.trim() !== "") hours[k] = v.trim();
  const adjustments = draft.adjustments.filter((r) => r.label.trim() !== "" || r.amount.trim() !== "").map((r) => ({ label: r.label.trim(), amount: r.amount.trim() }));
  await prisma.settlement.update({ where: { id }, data: { hours: hours as Prisma.InputJsonObject, adjustments: adjustments as unknown as Prisma.InputJsonArray } });
  return { ok: true, id };
}

export async function finalizeSettlement(id: string, draft: Draft, now = new Date(), workspaceId = currentWorkspaceId()): Promise<SettleResult> {
  const s = await prisma.settlement.findFirst({ where: { id, workspaceId }, include: { driver: true } });
  if (!s) return { ok: false, error: "That statement does not exist." };
  if (s.status !== "draft") return { ok: false, error: s.status === "final" ? "This statement is already finalized." : "A voided statement cannot be finalized. Start a new one." };
  const { statement } = await draftStatement(s, draft);
  if (Object.keys(statement.errors).length > 0) return { ok: false, errors: statement.errors, error: statement.blockers[0] };
  if (statement.blockers.length > 0) return { ok: false, error: statement.blockers[0] };

  const period = periodText(ymd(s.periodStart), ymd(s.periodEnd));
  const after: AuditSnapshot = { Statement: s.number, Driver: s.driver.name, Period: period, Loads: statement.lines.length, "Pay for loads": money(statement.loadsTotal), Adjustments: money(statement.adjustmentsTotal), Total: money(statement.total) };
  const hours: Record<string, string> = {};
  for (const [k, v] of Object.entries(draft.hours)) if (statement.lines.some((l) => l.loadId === k) && v.trim() !== "") hours[k] = v.trim();
  try {
    await prisma.$transaction(async (tx) => {
      await tx.settlementLoad.createMany({ data: statement.lines.map((l) => ({ settlementId: id, loadId: l.loadId, amount: new Prisma.Decimal(l.amount ?? 0) })) });
      await tx.settlement.update({
        where: { id },
        data: {
          status: "final",
          lines: statement.lines as unknown as Prisma.InputJsonArray,
          adjustments: statement.adjustments as unknown as Prisma.InputJsonArray,
          hours: hours as Prisma.InputJsonObject,
          total: new Prisma.Decimal(statement.total),
          finalizedAt: now
        }
      });
      await recordAudit(
        { entity: "settlement", action: "statement_finalized", summary: `${s.number} finalized for ${s.driver.name}: ${statement.lines.length} ${statement.lines.length === 1 ? "load" : "loads"}, ${money(statement.total)}`, before: { Status: "Draft" }, after, at: now, workspaceId },
        tx
      );
    });
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, error: "A load on this statement was just settled on another one. Reload it and try again." };
    throw e;
  }
  return { ok: true, id };
}

/** Take a final statement back: it stays on record as void, and its loads can go on another statement. */
export async function voidSettlement(id: string, reason: string, now = new Date(), workspaceId = currentWorkspaceId()): Promise<SettleResult> {
  const why = reason.trim();
  if (why.length < 3) return { ok: false, error: "Say why the statement is being voided." };
  const s = await prisma.settlement.findFirst({ where: { id, workspaceId }, include: { driver: true } });
  if (!s) return { ok: false, error: "That statement does not exist." };
  if (s.status !== "final") return { ok: false, error: "Only a finalized statement can be voided." };
  const total = numOrNull(s.total) ?? 0;
  await prisma.$transaction(async (tx) => {
    await tx.settlementLoad.deleteMany({ where: { settlementId: id } });
    await tx.settlement.update({ where: { id }, data: { status: "void", voidedAt: now, voidReason: why } });
    await recordAudit(
      { entity: "settlement", action: "statement_voided", summary: `${s.number} voided for ${s.driver.name} (${money(total)}); its loads can be paid again`, reason: why, before: { Status: "Final", Total: money(total) }, after: { Status: "Void" }, at: now, workspaceId },
      tx
    );
  });
  return { ok: true, id };
}

export async function discardSettlement(id: string, now = new Date(), workspaceId = currentWorkspaceId()): Promise<SettleResult> {
  const s = await prisma.settlement.findFirst({ where: { id, workspaceId }, include: { driver: true } });
  if (!s) return { ok: false, error: "That statement does not exist." };
  if (s.status !== "draft") return { ok: false, error: "Only a draft can be discarded. A finalized statement is voided." };
  await prisma.$transaction(async (tx) => {
    await tx.settlement.delete({ where: { id } });
    await recordAudit({ entity: "settlement", action: "statement_discarded", summary: `Draft ${s.number} for ${s.driver.name} discarded`, before: { Statement: s.number, Status: "Draft" }, after: null, at: now, workspaceId }, tx);
  });
  return { ok: true, id };
}

// ── Reading ────────────────────────────────────────────────────────────────────────────────────

export type SettlementView = {
  id: string;
  number: string;
  status: "draft" | "final" | "void";
  driver: { id: string; name: string };
  /** Who the statement is from: the workspace. */
  issuer: string;
  /** The company's identity for the sheet's header. */
  company: Company;
  start: string;
  end: string;
  periodLabel: string;
  /** Draft only: the loads the statement would pay today. */
  loads: SettlementLoad[];
  /** Draft only: what has been typed. */
  hours: Record<string, string>;
  adjustmentRows: AdjustmentInput[];
  /** The totals: live for a draft, as frozen for a final or void statement. */
  statement: Statement;
  finalizedAt: string | null;
  voidedAt: string | null;
  voidReason: string | null;
};

export async function getSettlement(id: string, workspaceId = currentWorkspaceId()): Promise<SettlementView | null> {
  const s = await prisma.settlement.findFirst({ where: { id, workspaceId }, include: { driver: true, workspace: true } });
  if (!s) return null;
  const base = { id: s.id, number: s.number, issuer: s.workspace.name, company: toCompany(s.workspace), driver: { id: s.driver.id, name: s.driver.name }, start: ymd(s.periodStart), end: ymd(s.periodEnd), periodLabel: periodText(ymd(s.periodStart), ymd(s.periodEnd)), finalizedAt: s.finalizedAt?.toISOString() ?? null, voidedAt: s.voidedAt?.toISOString() ?? null, voidReason: s.voidReason };
  if (s.status === "draft") {
    const hours = typedHours(s.hours);
    const adjustmentRows = typedAdjustments(s.adjustments);
    const { loads, statement } = await draftStatement(s, { hours, adjustments: adjustmentRows });
    return { ...base, status: "draft", loads, hours, adjustmentRows, statement };
  }
  const lines = (Array.isArray(s.lines) ? s.lines : []) as unknown as StatementLine[];
  const adjustments = (Array.isArray(s.adjustments) ? s.adjustments : []) as unknown as Adjustment[];
  return { ...base, status: s.status as "final" | "void", loads: [], hours: typedHours(s.hours), adjustmentRows: [], statement: statementOf(lines, adjustments) };
}

export type SettlementRow = { id: string; number: string; status: string; driverId: string; driverName: string; periodLabel: string; loads: number; total: number | null; finalizedAt: Date | null; voidedAt: Date | null; createdAt: Date };

export const STATEMENTS_PAGE = 50;

/** How many statements there are in each state, and what the finalized ones come to. */
export async function settlementCounts(workspaceId = currentWorkspaceId()) {
  const groups = await prisma.settlement.groupBy({ by: ["status"], where: { workspaceId }, _count: { _all: true }, _sum: { total: true } });
  const of = (status: string) => groups.find((g) => g.status === status);
  return { draft: of("draft")?._count._all ?? 0, final: of("final")?._count._all ?? 0, void: of("void")?._count._all ?? 0, finalTotal: numOrNull(of("final")?._sum.total) ?? 0 };
}

/** Statements, newest first, a page at a time (a big fleet settles every driver every week). */
export async function listSettlements(workspaceId = currentWorkspaceId(), opts: { skip?: number; take?: number; status?: string } = {}): Promise<SettlementRow[]> {
  const rows = await prisma.settlement.findMany({ where: { workspaceId, ...(opts.status ? { status: opts.status } : {}) }, include: { driver: true }, orderBy: [{ createdAt: "desc" }], skip: opts.skip ?? 0, take: opts.take ?? STATEMENTS_PAGE });
  return Promise.all(
    rows.map(async (s) => {
      const label = periodText(ymd(s.periodStart), ymd(s.periodEnd));
      const common = { id: s.id, number: s.number, status: s.status, driverId: s.driverId, driverName: s.driver.name, periodLabel: label, finalizedAt: s.finalizedAt, voidedAt: s.voidedAt, createdAt: s.createdAt };
      if (s.status === "draft") {
        const { loads, statement } = await draftStatement(s, { hours: typedHours(s.hours), adjustments: typedAdjustments(s.adjustments) });
        return { ...common, loads: loads.length, total: statement.total };
      }
      const lines = (Array.isArray(s.lines) ? s.lines : []) as unknown as StatementLine[];
      return { ...common, loads: lines.length, total: numOrNull(s.total) };
    })
  );
}

export type Unsettled = { driverId: string; driverName: string; loads: number; amount: number; hourlyWithoutHours: number; oldest: Date; newest: Date; start: string; end: string };

/** The unsettled list looks back this far: a statement can still be started for any date, but a year of unsettled freight is not a list a dispatcher works down. */
export const UNSETTLED_DAYS = 120;

/** Per driver, the delivered loads of the last 120 days not on any final statement, what they come to, and a period that would cover them. */
export async function unsettledByDriver(workspaceId = currentWorkspaceId(), now = new Date()): Promise<Unsettled[]> {
  // Read as the nine plain columns the pay is worked out from (a whole load, with its assignment and driver, is a hundred): a fleet has thousands of these.
  const since = new Date(now.getTime() - UNSETTLED_DAYS * 86_400_000);
  const loads = await prisma.$queryRaw<
    Array<{ driverId: string; driverName: string; completedAt: Date; loadedMiles: number; quotedRevenue: number; fuelSurcharge: number | null; payKind: string; payRate: number; payEstimate: number | null }>
  >`
    select a.driver_id as "driverId", d.name as "driverName", l.completed_at as "completedAt", l.loaded_miles::float8 as "loadedMiles", l.quoted_revenue::float8 as "quotedRevenue",
      l.fuel_surcharge::float8 as "fuelSurcharge", a.pay_kind as "payKind", a.pay_rate::float8 as "payRate", a.pay_estimate::float8 as "payEstimate"
    from loads l join assignments a on a.load_id = l.id and a.status = 'completed' join drivers d on d.id = a.driver_id
    where l.workspace_id = ${workspaceId} and l.deleted_at is null and l.status = 'completed' and l.completed_at >= ${since}
      and not exists (select 1 from settlement_loads sl where sl.load_id = l.id)`;
  const byDriver = new Map<string, { name: string; loads: typeof loads }>();
  for (const l of loads) {
    const group = byDriver.get(l.driverId) ?? { name: l.driverName, loads: [] };
    group.loads.push(l);
    byDriver.set(l.driverId, group);
  }
  const out: Unsettled[] = [];
  for (const [driverId, g] of byDriver) {
    const lines = g.loads.map((l) => linePay(l.payKind as PayKind, l.payRate, l.loadedMiles, hoursFromEstimate(l.payKind, l.payRate, l.payEstimate), rateConTotal(l.quotedRevenue, l.fuelSurcharge ?? 0)));
    const dates = g.loads.map((l) => l.completedAt);
    const sorted = [...dates].sort((a, b) => a.getTime() - b.getTime());
    const period = periodCovering(dates);
    if (!period) continue;
    const cents = lines.reduce((sum, amount) => sum.plus(new Prisma.Decimal(amount ?? 0)), new Prisma.Decimal(0));
    out.push({ driverId, driverName: g.name, loads: g.loads.length, amount: cents.toNumber(), hourlyWithoutHours: lines.filter((amount) => amount == null).length, oldest: sorted[0]!, newest: sorted[sorted.length - 1]!, start: period.start, end: period.end });
  }
  return out.sort((a, b) => a.driverName.localeCompare(b.driverName));
}

/** The final statement a load was paid on, if any. */
export async function settlementOfLoad(loadId: string): Promise<{ id: string; number: string } | null> {
  const row = await prisma.settlementLoad.findUnique({ where: { loadId }, include: { settlement: { select: { id: true, number: true } } } });
  return row ? { id: row.settlement.id, number: row.settlement.number } : null;
}

