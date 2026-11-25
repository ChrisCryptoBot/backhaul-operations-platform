import { inScope, termList, terminalFilter, type Terminals } from "@/lib/scope";
import { Prisma } from "@prisma/client";
import { usd } from "@/lib/desk-format";
import type { Company } from "@/lib/company";
import { toCompany } from "./company";
import { prisma } from "@/lib/db";
import type { AuditSnapshot } from "@/lib/audit-diff";
import { rateConTotal, type PayKind } from "@/lib/pay";
import { milesGapSummary, type PayMilesBasis } from "@/lib/pay-arrangement";
import { computeStatement, lineKey, linePay, periodBounds, periodCovering, periodText, rowsTotalCents, statementOf, statementRows, validatePeriod, type Adjustment, type AdjustmentInput, type FuelLine, type SettlementLoad, type Statement, type StatementLine } from "@/lib/settlement";
import { DEDUCTION_ROW_KINDS, deductionLines, NO_CHOICES, typedChoices, type DeductionChoices, type DeductionLine, type DeductionOption, type DeductionRowKind } from "@/lib/deductions";
import { recordAudit } from "./audit";
import { emitStatement } from "@/server/webhooks/emit";
import { draftDeductionOptions } from "./deductions";
import { openReimbursements, type Reimbursement } from "./receipts";
import { num, numOrNull } from "./convert";
import { currentWorkspaceId } from "./workspace";
import { workspaceTimezone } from "./zone";

/**
 * Driver pay statements. A draft is a driver, a period (two Dallas dates) and whatever the dispatcher has typed so far; the loads on it are
 * worked out from the loads each time it is shown, so a load delivered late or fixed since still reads true. Finalizing freezes the load
 * lines, the adjustments and the total, and ties each load to the statement (one row per load, enforced by the database), so a load cannot be
 * paid on two statements. Voiding a final statement keeps it as it was and frees its loads for another. Every step is audited. Gross pay
 * only: no taxes or payroll deductions are worked out here.
 */
/** `fuel` is the ids of the fuel card purchases picked to be deducted on this statement; none picked is the default, and a purchase that is no longer eligible is quietly left out. */
/** `deductions` is the draft's choices about its recurring deductions: which are skipped this time (with the reason) and an escrow release (with the reason). Wave 4 step 3. */
export type Draft = { hours: Record<string, string>; adjustments: AdjustmentInput[]; fuel?: string[]; deductions?: DeductionChoices };
export type SettleResult = { ok: true; id: string } | { ok: false; error?: string; errors?: Record<string, string> };

type Db = Prisma.TransactionClient | typeof prisma;
type LoadWithAssignment = Prisma.LoadGetPayload<{ include: { assignment: true } }>;

/** Dollars and cents as the desk says them everywhere: grouped, with a real minus (src/lib/desk-format.ts). */
const money = (n: number) => usd(n, 2);
const ymd = (d: Date) => d.toISOString().slice(0, 10);

function brokerStatus(l: { paymentStatus: string | null; paidAmount: unknown; invoicedAmount: unknown; writeOffAmount: unknown }): SettlementLoad["brokerStatus"] {
  if (l.paymentStatus === "paid") {
    const short = num(l.writeOffAmount as never) > 0 || (l.invoicedAmount != null && l.paidAmount != null && new Prisma.Decimal(l.paidAmount as never).lt(new Prisma.Decimal(l.invoicedAmount as never)));
    return short ? "paid_short" : "paid";
  }
  return l.paymentStatus === "invoiced" ? "invoiced" : "not_invoiced";
}

/** Hourly pay on an assignment can have been sent with an estimate of the hours; the statement starts from it and the dispatcher can type over it. */
function hoursFromEstimate(payKind: string, rate: number, estimate: unknown): number | null {
  return payKind === "hourly" && rate > 0 && estimate != null && num(estimate as never) > 0 ? new Prisma.Decimal(estimate as never).div(rate).toDecimalPlaces(2).toNumber() : null;
}

function toSettlementLoad(l: LoadWithAssignment, payMilesBasis: PayMilesBasis = "logged"): SettlementLoad {
  const a = l.assignment!;
  const rate = num(a.payRate);
  const assignedHours = hoursFromEstimate(a.payKind, rate, a.payEstimate);
  const actualLoaded = num(l.loadedMiles);
  const quotedLoaded = numOrNull(l.quotedLoadedMiles);
  return {
    loadId: l.id,
    loadNumber: l.loadNumber,
    origin: l.originAddress,
    destination: l.destinationAddress,
    deliveredAt: l.completedAt ? l.completedAt.toISOString() : null,
    loadedMiles: quotedLoaded ?? actualLoaded,
    loggedMiles: quotedLoaded != null ? actualLoaded : null,
    payMilesBasis,
    payKind: a.payKind as PayKind,
    payRate: rate,
    rateConTotal: rateConTotal(num(l.quotedRevenue), num(l.fuelSurcharge)),
    assignedHours,
    brokerStatus: brokerStatus(l)
  };
}

type LegWithLoad = Prisma.LoadLegGetPayload<{
  include: {
    load: {
      select: {
        id: true;
        loadNumber: true;
        originAddress: true;
        destinationAddress: true;
        loadedMiles: true;
        quotedRevenue: true;
        fuelSurcharge: true;
        paymentStatus: true;
        paidAmount: true;
        invoicedAmount: true;
        writeOffAmount: true;
      };
    };
  };
}>;

async function haulOrderMap(db: Db, loadIds: readonly string[]): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  if (loadIds.length === 0) return out;
  const rows = await db.loadLeg.findMany({ where: { loadId: { in: [...loadIds] }, kind: "haul" }, select: { loadId: true, seq: true }, orderBy: [{ loadId: "asc" }, { seq: "asc" }] });
  for (const r of rows) {
    const seqs = out.get(r.loadId) ?? [];
    seqs.push(r.seq);
    out.set(r.loadId, seqs);
  }
  return out;
}

function toSettlementLeg(leg: LegWithLoad, haulSeqs: readonly number[]): SettlementLoad {
  const l = leg.load;
  const rate = num(leg.payRate as never);
  const from = leg.fromName ?? l.originAddress ?? "?";
  const to = leg.toName ?? l.destinationAddress ?? "?";
  let legLabel: string;
  if (leg.kind === "positioning") {
    legLabel = `Positioning · ${leg.toName ? `to ${leg.toName}` : from}`;
  } else {
    const idx = haulSeqs.indexOf(leg.seq);
    const ordinal = idx >= 0 ? idx + 1 : leg.seq;
    const total = haulSeqs.length > ordinal ? haulSeqs.length : ordinal;
    legLabel = `Leg ${ordinal} of ${total} · ${from} → ${to}`;
  }
  return {
    loadId: l.id,
    loadLegId: leg.id,
    legLabel,
    legMiles: numOrNull(leg.milesDriven as never),
    loadNumber: l.loadNumber,
    origin: leg.fromName ?? l.originAddress,
    destination: leg.toName ?? l.destinationAddress,
    deliveredAt: leg.endedAt ? leg.endedAt.toISOString() : null,
    loadedMiles: num(l.loadedMiles),
    payKind: leg.payKind as PayKind,
    payRate: rate,
    rateConTotal: rateConTotal(num(l.quotedRevenue), num(l.fuelSurcharge)),
    assignedHours: hoursFromEstimate(leg.payKind ?? "", rate, leg.payEstimate),
    brokerStatus: brokerStatus(l)
  };
}

const legLoadSelect = {
  id: true,
  loadNumber: true,
  originAddress: true,
  destinationAddress: true,
  loadedMiles: true,
  quotedRevenue: true,
  fuelSurcharge: true,
  paymentStatus: true,
  paidAmount: true,
  invoicedAmount: true,
  writeOffAmount: true
} as const;

async function workspacePayBasis(workspaceId: string, db: Db = prisma): Promise<PayMilesBasis> {
  const ws = await db.workspace.findUnique({ where: { id: workspaceId }, select: { payMilesBasis: true } });
  return ws?.payMilesBasis === "billable" ? "billable" : "logged";
}

/** Loads and closed relay/positioning legs a driver completed between two carrier calendar dates that are not on a final statement. */
export async function eligibleLoads(driverId: string, start: string, end: string, workspaceId = currentWorkspaceId(), db: Db = prisma): Promise<SettlementLoad[]> {
  const [tz, payMilesBasis] = await Promise.all([workspaceTimezone(workspaceId), workspacePayBasis(workspaceId, db)]);
  const bounds = periodBounds(start, end, tz);
  if (!bounds) return [];
  const [loads, legs] = await Promise.all([
    db.load.findMany({
      where: {
        workspaceId,
        deletedAt: null,
        status: "completed",
        completedAt: { gte: bounds.from, lt: bounds.to },
        settlement: { is: null },
        legs: { none: { kind: "haul" } },
        assignment: { is: { driverId, status: "completed" } }
      },
      include: { assignment: true },
      orderBy: [{ completedAt: "asc" }, { loadNumber: "asc" }]
    }),
    db.loadLeg.findMany({
      where: {
        workspaceId,
        driverId,
        status: "closed",
        endedAt: { gte: bounds.from, lt: bounds.to },
        settlementLeg: { is: null },
        payKind: { not: null },
        payRate: { not: null },
        load: { deletedAt: null, status: { not: "quote" } },
        OR: [{ kind: "positioning", milesDriven: { not: null } }, { kind: "haul", load: { status: "completed" } }]
      },
      include: { load: { select: legLoadSelect } },
      orderBy: [{ endedAt: "asc" }, { seq: "asc" }]
    })
  ]);
  const haulSeqs = await haulOrderMap(
    db,
    [...new Set(legs.filter((l) => l.kind === "haul").map((l) => l.loadId))]
  );
  const items: Array<{ at: number; num: string; sl: SettlementLoad }> = [
    ...loads.map((l) => ({ at: l.completedAt?.getTime() ?? 0, num: l.loadNumber ?? "", sl: toSettlementLoad(l, payMilesBasis) })),
    ...legs.map((lg) => ({ at: lg.endedAt?.getTime() ?? 0, num: `${lg.load.loadNumber ?? ""}:${String(lg.seq).padStart(4, "0")}`, sl: toSettlementLeg(lg, haulSeqs.get(lg.loadId) ?? []) }))
  ];
  return items.sort((a, b) => a.at - b.at || a.num.localeCompare(b.num)).map((x) => x.sl);
}

/** The next statement number: a counter on the workspace, so a discarded draft's number is never given again and numbering does not read every statement. Inside the caller's transaction. */
async function nextNumber(tx: Prisma.TransactionClient, workspaceId: string): Promise<string> {
  const w = await tx.workspace.update({ where: { id: workspaceId }, data: { settlementSeq: { increment: 1 } }, select: { settlementSeq: true } });
  return `ST-${String(w.settlementSeq).padStart(4, "0")}`;
}

const isUniqueViolation = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";

const typedHours = (hours: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  if (hours && typeof hours === "object") for (const [k, v] of Object.entries(hours as Record<string, unknown>)) if (typeof v === "string") out[k] = v;
  return out;
};
const typedAdjustments = (rows: unknown): AdjustmentInput[] =>
  Array.isArray(rows) ? (rows as Array<{ label?: unknown; amount?: unknown }>).map((r) => ({ label: typeof r.label === "string" ? r.label : "", amount: typeof r.amount === "string" ? r.amount : "" })) : [];

const typedFuelIds = (v: unknown): string[] => (Array.isArray(v) ? (v as unknown[]).filter((x): x is string => typeof x === "string") : []);

const toFuelLine = (r: Prisma.FuelTransactionGetPayload<{ include: { load: { select: { loadNumber: true } } } }>): FuelLine => ({
  id: r.id,
  on: r.postedAt.toISOString().slice(0, 10),
  location: r.location,
  gallons: numOrNull(r.gallons),
  pricePerGallon: numOrNull(r.pricePerGallon),
  discount: numOrNull(r.discount),
  amount: num(r.amount),
  loadNumber: r.load?.loadNumber ?? null
});

/**
 * The fuel card purchases that could come off this driver's pay for the period: bought in it (on the workspace's calendar), on the truck the driver is assigned to or on a load the driver ran, and
 * not already deducted on another statement. Only settled purchases: a pending one may still change, and a declined or voided one was never charged. They are offered, never taken: a
 * dispatcher picks which come off.
 */
export async function eligibleFuel(driverId: string, start: string, end: string, workspaceId = currentWorkspaceId(), db: Db = prisma): Promise<FuelLine[]> {
  const bounds = periodBounds(start, end, await workspaceTimezone(workspaceId));
  if (!bounds) return [];
  const driver = await db.driver.findFirst({ where: { id: driverId, workspaceId }, select: { assignedVehicleId: true } });
  if (!driver) return [];
  const rows = await db.fuelTransaction.findMany({
    where: { workspaceId, settlementId: null, status: "settled", postedAt: { gte: bounds.from, lt: bounds.to }, OR: [...(driver.assignedVehicleId ? [{ vehicleId: driver.assignedVehicleId }] : []), { load: { assignment: { is: { driverId } } } }] },
    include: { load: { select: { loadNumber: true } } },
    orderBy: [{ postedAt: "asc" }, { id: "asc" }]
  });
  return rows.map(toFuelLine);
}

// ── Start, save, finalize, void, discard ───────────────────────────────────────────────────────

export async function startSettlement(input: { driverId: string; start: string; end: string }, now = new Date(), workspaceId = currentWorkspaceId()): Promise<SettleResult> {
  const period = validatePeriod(input.start, input.end);
  if (!period.ok) return { ok: false, errors: period.errors };
  const driver = await prisma.driver.findFirst({ where: { id: input.driverId, workspaceId } });
  if (!driver) return { ok: false, errors: { driverId: "Pick a driver." } };
  const loads = await eligibleLoads(driver.id, period.start, period.end, workspaceId);
  if (loads.length === 0) return { ok: false, error: `No delivered loads for ${driver.name} between ${periodText(period.start, period.end)} that are not already on a statement.` };

  // One draft per driver and stretch of dates: a second one over the same loads only invites paying them twice.
  const open = await prisma.settlement.findFirst({ where: { workspaceId, driverId: driver.id, status: "draft", periodStart: { lte: new Date(`${period.end}T00:00:00Z`) }, periodEnd: { gte: new Date(`${period.start}T00:00:00Z`) } }, select: { number: true } });
  if (open) return { ok: false, error: `${open.number} is already a draft for ${driver.name} over these dates. Open it, or discard it first.` };

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const made = await prisma.$transaction(async (tx) => {
        const number = await nextNumber(tx, workspaceId);
        const s = await tx.settlement.create({ data: { workspaceId, driverId: driver.id, number, periodStart: new Date(`${period.start}T00:00:00Z`), periodEnd: new Date(`${period.end}T00:00:00Z`) } });
        await recordAudit(
          { entity: "settlement", action: "statement_started", summary: `${s.number} started for ${driver.name}, ${periodText(period.start, period.end)}: ${loads.length} delivered ${loads.length === 1 ? "load" : "loads"}`, before: null, after: { Statement: s.number, Driver: driver.name, Period: periodText(period.start, period.end), Loads: loads.length }, at: now, workspaceId },
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
type DraftParts = { loads: SettlementLoad[]; fuelOptions: FuelLine[]; deductionOptions: DeductionOption[]; escrowHeldCents: number; choices: DeductionChoices; reimbursements: Reimbursement[]; statement: Statement };

/** A draft's choices kept only for the deductions it is offered: a skip of a rule that is not on offer any more means nothing. */
function cleanChoices(choices: DeductionChoices, options: readonly DeductionOption[]): DeductionChoices {
  const offered = new Set(options.map((o) => o.deductionId));
  const skips: Record<string, string> = {};
  for (const [k, v] of Object.entries(choices.skips)) if (offered.has(k)) skips[k] = v.trim();
  const release = choices.release && (choices.release.amount.trim() !== "" || choices.release.reason.trim() !== "") ? { amount: choices.release.amount.trim(), reason: choices.release.reason.trim() } : null;
  return { skips, release };
}

/** What a draft says today: its loads from the database, the deductions it is offered against the ledger as it stands, and the totals those and the typed values come to. */
async function draftStatement(s: SettlementWithDriver, draft: Draft, db: Db = prisma): Promise<DraftParts> {
  const start = ymd(s.periodStart);
  const end = ymd(s.periodEnd);
  const [loads, fuelOptions, [ded], back] = await Promise.all([
    eligibleLoads(s.driverId, start, end, s.workspaceId, db),
    eligibleFuel(s.driverId, start, end, s.workspaceId, db),
    draftDeductionOptions(db, s.workspaceId, [{ driverId: s.driverId, start, end, workerType: s.driver.payrollWorkerType }]),
    openReimbursements(db, s.workspaceId, [s.driverId])
  ]);
  const reimbursements = back.get(s.driverId)!;
  const picked = new Set(draft.fuel ?? []);
  const fuel = fuelOptions.filter((f) => picked.has(f.id));
  const choices = cleanChoices(draft.deductions ?? NO_CHOICES, ded!.options);
  const { lines: deductions, errors: deductionErrors } = deductionLines(ded!.options, choices, ded!.escrowHeldCents);
  return { loads, fuelOptions, deductionOptions: ded!.options, escrowHeldCents: ded!.escrowHeldCents, choices, reimbursements, statement: computeStatement({ loads, hours: draft.hours, adjustments: draft.adjustments, fuel, deductions, deductionErrors, reimbursements }) };
}

/** Keep what has been typed. Hours and lines can be saved unfinished; only what is plainly wrong (a bad number) is refused. */
export async function saveDraft(id: string, draft: Draft, workspaceId = currentWorkspaceId()): Promise<SettleResult> {
  const s = await prisma.settlement.findFirst({ where: { id, workspaceId }, include: { driver: true } });
  if (!s) return { ok: false, error: "That statement does not exist." };
  if (s.status !== "draft") return { ok: false, error: "A finalized statement cannot be changed." };
  const { loads, fuelOptions, statement, choices } = await draftStatement(s, draft);
  if (Object.keys(statement.errors).length > 0) return { ok: false, errors: statement.errors };
  const onStatement = new Set(loads.map((l) => lineKey(l)));
  const hours: Record<string, string> = {};
  for (const [k, v] of Object.entries(draft.hours)) if (onStatement.has(k) && v.trim() !== "") hours[k] = v.trim();
  const adjustments = draft.adjustments.filter((r) => r.label.trim() !== "" || r.amount.trim() !== "").map((r) => ({ label: r.label.trim(), amount: r.amount.trim() }));
  // Written only while it is still a draft: a statement finalized or discarded a moment ago (another tab, another person) is not overwritten with what was typed.
  const allowed = new Set(fuelOptions.map((f) => f.id));
  const fuelIds = (draft.fuel ?? []).filter((id) => allowed.has(id));
  const changed = JSON.stringify([typedHours(s.hours), typedAdjustments(s.adjustments), typedFuelIds(s.fuelIds), typedChoices(s.deductionChoices)]) !== JSON.stringify([hours, adjustments, fuelIds, choices]);
  const saved = await prisma.$transaction(async (tx) => {
    const out = await tx.settlement.updateMany({ where: { id, workspaceId, status: "draft" }, data: { hours: hours as Prisma.InputJsonObject, adjustments: adjustments as unknown as Prisma.InputJsonArray, fuelIds: fuelIds as unknown as Prisma.InputJsonArray, deductionChoices: choices as unknown as Prisma.InputJsonObject } });
    if (out.count !== 1) return false;
    if (changed) await recordAudit({ entity: "settlement", action: "statement_saved", summary: `${s.number} saved: ${Object.keys(hours).length} ${Object.keys(hours).length === 1 ? "hours entry" : "hours entries"}, ${adjustments.length} ${adjustments.length === 1 ? "adjustment" : "adjustments"}`, before: null, after: { Statement: s.number, Hours: Object.keys(hours).length, Adjustments: adjustments.length }, at: new Date(), workspaceId }, tx);
    return true;
  });
  if (!saved) return { ok: false, error: "This statement was finalized or discarded while you were editing it. Reload it." };
  return { ok: true, id };
}

/**
 * `confirmedTotal` is the total the person was looking at when they pressed Finalize. If the loads or their pay changed since (a load delivered, a rate corrected) the statement now
 * comes to something else, and it is refused with the new figure rather than frozen at a number nobody saw.
 *
 * Rule K: when its deductions or escrow take the statement below zero it is finalized only with `confirmNegative`. The deductions are worked out again inside the transaction, with the driver
 * locked, against the ledger as it then stands: if a cap or the escrow goal was reached by another statement a moment ago, it is refused rather than taking more than the rule allows. The ledger
 * rows are written in the same transaction as the statement rows.
 */
export async function finalizeSettlement(id: string, draft: Draft, now = new Date(), workspaceId = currentWorkspaceId(), confirmedTotal: number | null = null, confirmNegative = false): Promise<SettleResult> {
  const s = await prisma.settlement.findFirst({ where: { id, workspaceId }, include: { driver: true } });
  if (!s) return { ok: false, error: "That statement does not exist." };
  if (s.status !== "draft") return { ok: false, error: s.status === "final" ? "This statement is already finalized." : "A voided statement cannot be finalized. Start a new one." };
  const { statement, choices } = await draftStatement(s, draft);
  if (Object.keys(statement.errors).length > 0) return { ok: false, errors: statement.errors, error: statement.blockers[0] };
  if (statement.blockers.length > 0) return { ok: false, error: statement.blockers[0] };
  if (confirmedTotal != null && !new Prisma.Decimal(statement.total).toDecimalPlaces(2).equals(new Prisma.Decimal(confirmedTotal).toDecimalPlaces(2))) return { ok: false, error: `${s.number} now comes to ${money(statement.total)}, not the ${money(confirmedTotal)} you were looking at: a load or its pay changed. Review it, then finalize again.` };

  if (statement.needsConfirm && !confirmNegative) return { ok: false, error: `The deductions take ${s.number} below zero, to ${money(statement.total)}. Confirm that ${s.driver.name} ends up owing, or skip a deduction this time.` };

  const period = periodText(ymd(s.periodStart), ymd(s.periodEnd));
  const after: AuditSnapshot = { Statement: s.number, Driver: s.driver.name, Period: period, Loads: statement.lines.length, "Pay for loads": money(statement.loadsTotal), Adjustments: money(statement.adjustmentsTotal), ...(statement.fuel.length > 0 ? { "Fuel card": `-${money(statement.fuelTotal)}` } : {}), ...(statement.deductions.length > 0 ? { "Deductions, escrow and advances": money(statement.deductionsTotal) } : {}), ...(statement.needsConfirm ? { "Below zero": "Confirmed" } : {}), Total: money(statement.total) };
  const hours: Record<string, string> = {};
  for (const [k, v] of Object.entries(draft.hours)) if (statement.lines.some((l) => lineKey(l) === k) && v.trim() !== "") hours[k] = v.trim();
  try {
    await prisma.$transaction(async (tx) => {
      // The driver is locked first, so two statements for one driver finalize one after the other and each sees the ledger the other left.
      await tx.$queryRaw`select id from drivers where id = ${s.driverId} for update`;
      if (statement.deductions.length > 0 || Object.keys(choices.skips).length > 0) {
        const [again] = await draftDeductionOptions(tx, workspaceId, [{ driverId: s.driverId, start: ymd(s.periodStart), end: ymd(s.periodEnd), workerType: s.driver.payrollWorkerType }]);
        const fresh = deductionLines(again!.options, choices, again!.escrowHeldCents);
        if (Object.keys(fresh.errors).length > 0 || JSON.stringify(fresh.lines) !== JSON.stringify(statement.deductions)) throw new DeductionsMoved();
      }
      // Claimed from the state it was read in: a draft finalized or discarded a moment ago is not finalized again.
      const claimed = await tx.settlement.updateMany({
        where: { id, workspaceId, status: "draft" },
        data: {
          status: "final",
          lines: statement.lines as unknown as Prisma.InputJsonArray,
          adjustments: statement.adjustments as unknown as Prisma.InputJsonArray,
          fuel: statement.fuel as unknown as Prisma.InputJsonArray,
          fuelIds: statement.fuel.map((f) => f.id) as unknown as Prisma.InputJsonArray,
          hours: hours as Prisma.InputJsonObject,
          total: new Prisma.Decimal(statement.total),
          finalizedAt: now
        }
      });
      if (claimed.count !== 1) throw new LostDraft();
      const loadLines = statement.lines.filter((l) => l.loadLegId == null);
      const legLines = statement.lines.filter((l) => l.loadLegId != null);
      if (loadLines.length > 0) {
        await tx.settlementLoad.createMany({ data: loadLines.map((l) => ({ settlementId: id, loadId: l.loadId, amount: new Prisma.Decimal(l.amount ?? 0) })) });
      }
      if (legLines.length > 0) {
        await tx.settlementLeg.createMany({ data: legLines.map((l) => ({ workspaceId, settlementId: id, loadLegId: l.loadLegId!, loadId: l.loadId, amount: new Prisma.Decimal(l.amount ?? 0) })) });
      }
      // The statement as rows (rule J), from the same Statement the JSON above is written from. They must come to the total frozen with it, to the cent, or nothing is finalized.
      const rows = statementRows(statement);
      if (!new Prisma.Decimal(rowsTotalCents(rows)).equals(new Prisma.Decimal(statement.total).times(100).toDecimalPlaces(0))) throw new Error(`${s.number}: the statement rows do not add up to its total`);
      if (rows.length > 0)
        await tx.settlementLine.createMany({
          data: rows.map((r) => ({
            workspaceId,
            settlementId: id,
            sort: r.sort,
            kind: r.kind,
            label: r.label,
            basis: r.basis,
            amount: new Prisma.Decimal(r.amount),
            loadId: r.loadId,
            loadNumber: r.loadNumber,
            deliveredAt: r.deliveredAt ? new Date(r.deliveredAt) : null,
            payKind: r.payKind,
            payRate: r.payRate == null ? null : new Prisma.Decimal(r.payRate),
            hours: r.hours == null ? null : new Prisma.Decimal(r.hours),
            fuelTransactionId: r.fuelTransactionId,
            gallons: r.gallons == null ? null : new Prisma.Decimal(r.gallons),
            deductionId: r.deductionId,
            advanceId: r.advanceId
          }))
        });
      // The driver's ledger: one entry per deduction, escrow, release and advance repayment line, tied to this statement so voiding it removes exactly these.
      if (statement.deductions.length > 0)
        await tx.driverLedgerEntry.createMany({
          data: statement.deductions.map((d) => ({ workspaceId, driverId: s.driverId, deductionId: d.deductionId, advanceId: d.advanceId, settlementId: id, kind: d.kind, label: d.label, amount: new Prisma.Decimal(d.amount), reason: d.kind === "escrow_release" ? d.basis : null }))
        });
      // Each fuel purchase comes off one statement, once: taken from the state it was read in, so one a second statement took a moment ago stops this one rather than coming off twice. It
      // must still be settled: a purchase the card voided since the draft was read stops the finalize the same way.
      if (statement.fuel.length > 0) {
        const taken = await tx.fuelTransaction.updateMany({ where: { id: { in: statement.fuel.map((f) => f.id) }, workspaceId, settlementId: null, status: "settled" }, data: { settlementId: id } });
        if (taken.count !== statement.fuel.length) throw new FuelTaken();
      }
      // The receipts paid back on it: each is on one statement, once. One declined, put back or taken by another statement since the draft was read stops this one.
      const receiptIds = statement.adjustments.flatMap((a) => (a.receiptId ? [a.receiptId] : []));
      if (receiptIds.length > 0) {
        const taken = await tx.driverReceipt.updateMany({ where: { id: { in: receiptIds }, workspaceId, driverId: s.driverId, state: "approved", settlementId: null }, data: { settlementId: id } });
        if (taken.count !== receiptIds.length) throw new ReceiptsMoved();
      }
      // Each load or relay leg's own history says it was paid, and on what.
      for (const l of statement.lines) {
        await recordAudit({ entity: "settlement", action: "load_settled", loadId: l.loadId, loadNumber: l.loadNumber, summary: `Paid to ${s.driver.name} on ${s.number}: ${money(l.amount ?? 0)}${l.legLabel ? ` (${l.legLabel})` : ""}`, before: null, after: { Statement: s.number, ...(l.legLabel ? { Leg: l.legLabel } : {}), Pay: money(l.amount ?? 0) }, at: now, workspaceId }, tx);
      }
      await emitStatement(tx, workspaceId, id, "finalized", now);
      await recordAudit(
        { entity: "settlement", action: "statement_finalized", summary: `${s.number} finalized for ${s.driver.name}: ${statement.lines.length} ${statement.lines.length === 1 ? "load" : "loads"}, ${money(statement.total)}`, before: { Status: "Draft" }, after, at: now, workspaceId },
        tx
      );
    });
  } catch (e) {
    if (e instanceof LostDraft) return { ok: false, error: `${s.number} was just finalized or discarded by someone else. Reload it.` };
    if (e instanceof FuelTaken) return { ok: false, error: "A fuel purchase on this statement was just deducted on another statement, or the card voided it. Reload it and pick again." };
    if (e instanceof ReceiptsMoved) return { ok: false, error: `A receipt on ${s.number} was just changed or paid back on another statement. Reload it and review.` };
    if (e instanceof DeductionsMoved) return { ok: false, error: `${s.driver.name}'s deductions or escrow balance changed while you were looking (another statement was finalized or voided). Reload ${s.number} and review it.` };
    if (isUniqueViolation(e)) return { ok: false, error: "A load or leg on this statement was just settled on another one. Reload it and try again." };
    throw e;
  }
  return { ok: true, id };
}

class ReceiptsMoved extends Error {
  constructor() {
    super("a receipt moved");
  }
}

class DeductionsMoved extends Error {
  constructor() {
    super("the deductions or the escrow balance moved");
  }
}

class AdvanceBroken extends Error {
  constructor() {
    super("an advance balance would leave its bounds");
  }
}

class EscrowSpent extends Error {
  constructor() {
    super("escrow held by this statement was already released");
  }
}

class FuelTaken extends Error {
  constructor() {
    super("a fuel purchase was taken by another statement");
  }
}

class LostDraft extends Error {
  constructor() {
    super("statement is no longer a draft");
  }
}

/** Take a final statement back: it stays on record as void, and its loads can go on another statement. */
export async function voidSettlement(id: string, reason: string, now = new Date(), workspaceId = currentWorkspaceId()): Promise<SettleResult> {
  const why = reason.trim();
  if (why.length < 3) return { ok: false, error: "Say why the statement is being voided." };
  const s = await prisma.settlement.findFirst({ where: { id, workspaceId }, include: { driver: true } });
  if (!s) return { ok: false, error: "That statement does not exist." };
  if (s.status !== "final") return { ok: false, error: "Only a finalized statement can be voided." };
  // Voiding frees its loads to be paid on another statement. Once the statement has been sent to payroll the driver has been paid on it, so that would pay them twice.
  if (s.payrollSentAt) return { ok: false, error: `${s.number} was sent to payroll, so the driver has been paid on it. It cannot be voided; correct it on the next statement.` };
  if (s.paidAt) return { ok: false, error: `${s.number} was marked paid ${ymd(s.paidAt)}, so the driver has been paid on it. It cannot be voided; correct it on the next statement.` };
  const total = numOrNull(s.total) ?? 0;
  try {
    await prisma.$transaction(async (tx) => {
      // Checked again in the transaction that voids it: a statement sent to payroll a moment ago is not voided.
      const voided = await tx.settlement.updateMany({ where: { id, workspaceId, status: "final", payrollSentAt: null, paidAt: null }, data: { status: "void", voidedAt: now, voidReason: why } });
      if (voided.count !== 1) throw new PaidAlready();
      const [freed, freedLegs] = await Promise.all([
        tx.settlementLoad.findMany({ where: { settlementId: id }, select: { load: { select: { id: true, loadNumber: true } } } }),
        tx.settlementLeg.findMany({ where: { settlementId: id }, select: { load: { select: { id: true, loadNumber: true } }, loadLeg: { select: { seq: true, kind: true } } } })
      ]);
      await tx.settlementLoad.deleteMany({ where: { settlementId: id } });
      await tx.settlementLeg.deleteMany({ where: { settlementId: id } });
      // Its fuel purchases go back to being available: they were deducted on a statement that no longer stands.
      await tx.fuelTransaction.updateMany({ where: { settlementId: id, workspaceId }, data: { settlementId: null } });
      // So do the receipts paid back on it: still approved, for the next statement.
      await tx.driverReceipt.updateMany({ where: { settlementId: id, workspaceId }, data: { settlementId: null } });
      // The ledger entries this statement made go with it (its statement rows stay, rule J). Escrow it held that a later statement already paid back would leave less than nothing held.
      await tx.$queryRaw`select id from drivers where id = ${s.driverId} for update`;
      const mine = await tx.driverLedgerEntry.findMany({ where: { settlementId: id, workspaceId }, select: { advanceId: true } });
      const removed = await tx.driverLedgerEntry.deleteMany({ where: { settlementId: id, workspaceId } });
      if (removed.count > 0) {
        const held = await tx.driverLedgerEntry.aggregate({ where: { workspaceId, driverId: s.driverId, kind: { in: ["escrow", "escrow_release"] } }, _sum: { amount: true } });
        if (new Prisma.Decimal(held._sum.amount ?? 0).gt(0)) throw new EscrowSpent();
        // Each advance this statement repaid must still read between nothing owed and the whole advance: the repayment going back can never leave more owed than was given.
        const touched = [...new Set(mine.flatMap((e) => (e.advanceId ? [e.advanceId] : [])))];
        if (touched.length > 0) {
          const [owed, given] = await Promise.all([
            tx.driverLedgerEntry.groupBy({ by: ["advanceId"], where: { workspaceId, advanceId: { in: touched } }, _sum: { amount: true } }),
            tx.driverAdvance.findMany({ where: { id: { in: touched }, workspaceId }, select: { id: true, amount: true } })
          ]);
          for (const a of given) {
            const o = new Prisma.Decimal(owed.find((g) => g.advanceId === a.id)?._sum.amount ?? 0);
            if (o.lt(0) || o.gt(a.amount)) throw new AdvanceBroken();
          }
        }
      }
      for (const f of freed) await recordAudit({ entity: "settlement", action: "load_released", loadId: f.load.id, loadNumber: f.load.loadNumber, summary: `Released from ${s.number}: it can be paid on another statement`, reason: why, before: { Statement: s.number }, after: { Statement: null }, at: now, workspaceId }, tx);
      for (const fl of freedLegs) await recordAudit({ entity: "settlement", action: "load_released", loadId: fl.load.id, loadNumber: fl.load.loadNumber, summary: `Leg ${fl.loadLeg.seq} released from ${s.number}: it can be paid on another statement`, reason: why, before: { Statement: s.number, Leg: fl.loadLeg.seq }, after: { Statement: null }, at: now, workspaceId }, tx);
      await emitStatement(tx, workspaceId, id, "voided", now);
      await recordAudit(
        { entity: "settlement", action: "statement_voided", summary: `${s.number} voided for ${s.driver.name} (${money(total)}); its loads can be paid again`, reason: why, before: { Status: "Final", Total: money(total) }, after: { Status: "Void" }, at: now, workspaceId },
        tx
      );
    });
  } catch (e) {
    if (e instanceof PaidAlready) return { ok: false, error: `${s.number} was just paid or sent to payroll, so it cannot be voided.` };
    if (e instanceof AdvanceBroken) return { ok: false, error: `Voiding ${s.number} would leave an advance owing less than nothing or more than was given. Check ${s.driver.name}'s advances before voiding it.` };
    if (e instanceof EscrowSpent) return { ok: false, error: `Escrow held on ${s.number} was already paid back to ${s.driver.name} on a later statement. Void that one first.` };
    throw e;
  }
  return { ok: true, id };
}

export const STATEMENT_PAID_METHODS = ["check", "transfer", "cash", "other"] as const;

/**
 * Record that the driver was paid on a final statement outside payroll (a check, a transfer, cash), on a Dallas day not in the future. From then on it cannot be voided and cannot be
 * sent to payroll (that would pay the driver twice). Made from the state it was read in; audited.
 */
export async function markSettlementPaid(id: string, input: { paidOn: string; method: string }, now = new Date(), workspaceId = currentWorkspaceId()): Promise<SettleResult> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.paidOn)) return { ok: false, errors: { paidOn: "Pick the day the driver was paid." } };
  // A day a little ahead is allowed (the desk's date can be a day behind the person's), no more.
  if (input.paidOn > ymd(new Date(now.getTime() + 24 * 3_600_000))) return { ok: false, errors: { paidOn: "That day has not come yet." } };
  if (!(STATEMENT_PAID_METHODS as readonly string[]).includes(input.method)) return { ok: false, errors: { method: "Pick how the driver was paid." } };
  const s = await prisma.settlement.findFirst({ where: { id, workspaceId }, include: { driver: true } });
  if (!s) return { ok: false, error: "That statement does not exist." };
  if (s.status !== "final") return { ok: false, error: "Only a finalized statement is paid." };
  if (s.payrollSentAt) return { ok: false, error: `${s.number} was sent to payroll, so the driver is being paid on it there.` };
  if (s.paidAt) return { ok: false, error: `${s.number} was already marked paid ${ymd(s.paidAt)}.` };
  const done = await prisma.$transaction(async (tx) => {
    const out = await tx.settlement.updateMany({ where: { id, workspaceId, status: "final", payrollSentAt: null, paidAt: null }, data: { paidAt: new Date(`${input.paidOn}T17:00:00Z`), paidMethod: input.method } });
    if (out.count !== 1) return false;
    await recordAudit({ entity: "settlement", action: "statement_paid", summary: `${s.number} paid to ${s.driver.name} by ${input.method} on ${input.paidOn}: ${money(numOrNull(s.total) ?? 0)}`, before: { Paid: null }, after: { Paid: input.paidOn, How: input.method, Total: money(numOrNull(s.total) ?? 0) }, at: now, workspaceId }, tx);
    return true;
  });
  if (!done) return { ok: false, error: `${s.number} was just paid or sent to payroll by someone else. Reload it.` };
  return { ok: true, id };
}

class PaidAlready extends Error {
  constructor() {
    super("statement already sent to payroll");
  }
}

export async function discardSettlement(id: string, now = new Date(), workspaceId = currentWorkspaceId()): Promise<SettleResult> {
  const s = await prisma.settlement.findFirst({ where: { id, workspaceId }, include: { driver: true } });
  if (!s) return { ok: false, error: "That statement does not exist." };
  if (s.status !== "draft") return { ok: false, error: "Only a draft can be discarded. A finalized statement is voided." };
  const gone = await prisma.$transaction(async (tx) => {
    // Deleted only while it is still a draft: racing a finalize must never delete the statement the driver is paid on.
    const out = await tx.settlement.deleteMany({ where: { id, workspaceId, status: "draft" } });
    if (out.count !== 1) return false;
    await recordAudit({ entity: "settlement", action: "statement_discarded", summary: `Draft ${s.number} for ${s.driver.name} discarded`, before: { Statement: s.number, Status: "Draft" }, after: null, at: now, workspaceId }, tx);
    return true;
  });
  if (!gone) return { ok: false, error: `${s.number} was just finalized or discarded by someone else. Reload it.` };
  return { ok: true, id };
}

// ── Reading ────────────────────────────────────────────────────────────────────────────────────

export type SettlementView = {
  id: string;
  number: string;
  status: "draft" | "final" | "void";
  driver: { id: string; name: string; code: string | null; terminal: string | null };
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
  /** Draft only: the fuel card purchases that could come off this driver's pay, and the ids picked so far. */
  fuelOptions: FuelLine[];
  fuelPicked: string[];
  /** Draft only: the recurring deductions offered, the choices made so far, and the escrow held before this statement. */
  deductionOptions: DeductionOption[];
  deductionChoices: DeductionChoices;
  escrowHeldCents: number;
  /** Draft only: the approved receipts it pays back. */
  reimbursements: Reimbursement[];
  /** The totals: live for a draft, as frozen for a final or void statement. */
  statement: Statement;
  finalizedAt: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  paidAt: string | null;
  paidMethod: string | null;
  payrollSentAt: string | null;
  payrollReference: string | null;
};

export async function getSettlement(id: string, workspaceId = currentWorkspaceId(), terminal: Terminals = null): Promise<SettlementView | null> {
  const s = await prisma.settlement.findFirst({ where: { id, workspaceId }, include: { driver: true, workspace: true } });
  if (!s || (terminal != null && !inScope(terminal, s.driver.terminal))) return null;
  const base = {
    id: s.id,
    number: s.number,
    issuer: s.workspace.name,
    company: toCompany(s.workspace),
    driver: { id: s.driver.id, name: s.driver.name, code: s.driver.code, terminal: s.driver.terminal },
    start: ymd(s.periodStart),
    end: ymd(s.periodEnd),
    periodLabel: periodText(ymd(s.periodStart), ymd(s.periodEnd)),
    finalizedAt: s.finalizedAt?.toISOString() ?? null,
    voidedAt: s.voidedAt?.toISOString() ?? null,
    voidReason: s.voidReason,
    paidAt: s.paidAt?.toISOString() ?? null,
    paidMethod: s.paidMethod,
    payrollSentAt: s.payrollSentAt?.toISOString() ?? null,
    payrollReference: s.payrollReference
  };
  if (s.status === "draft") {
    const hours = typedHours(s.hours);
    const adjustmentRows = typedAdjustments(s.adjustments);
    const fuelPicked = typedFuelIds(s.fuelIds);
    const { loads, fuelOptions, statement, deductionOptions, escrowHeldCents, choices, reimbursements } = await draftStatement(s, { hours, adjustments: adjustmentRows, fuel: fuelPicked, deductions: typedChoices(s.deductionChoices) });
    return { ...base, status: "draft", loads, hours, adjustmentRows, fuelOptions, fuelPicked: fuelPicked.filter((id) => fuelOptions.some((f) => f.id === id)), deductionOptions, deductionChoices: choices, escrowHeldCents, reimbursements, statement };
  }
  const lines = (Array.isArray(s.lines) ? s.lines : []) as unknown as StatementLine[];
  const adjustments = (Array.isArray(s.adjustments) ? s.adjustments : []) as unknown as Adjustment[];
  const fuel = (Array.isArray(s.fuel) ? s.fuel : []) as unknown as FuelLine[];
  const deductions = (await frozenDeductions([s.id])).get(s.id) ?? [];
  return { ...base, status: s.status as "final" | "void", loads: [], hours: typedHours(s.hours), adjustmentRows: [], fuelOptions: [], fuelPicked: [], deductionOptions: [], deductionChoices: NO_CHOICES, escrowHeldCents: 0, reimbursements: [], statement: statementOf(lines, adjustments, fuel, deductions) };
}

export type SettlementRow = {
  id: string;
  number: string;
  status: string;
  driverId: string;
  driverName: string;
  periodStart: Date;
  periodEnd: Date;
  periodLabel: string;
  loads: number;
  loadsTotal: number;
  adjustmentsTotal: number;
  /** Fuel card purchases deducted (a positive amount that comes off). */
  fuelTotal: number;
  /** Recurring deductions, escrow held and escrow released, signed. */
  deductionsTotal: number;
  total: number | null;
  finalizedAt: Date | null;
  paidAt: Date | null;
  paidMethod: string | null;
  payrollSentAt: Date | null;
  payrollReference: string | null;
  voidedAt: Date | null;
  voidReason: string | null;
  createdAt: Date;
  statement: Statement;
};

export const STATEMENTS_PAGE = 50;

/** How many statements there are in each state, and what the finalized ones come to. */
export async function settlementCounts(workspaceId = currentWorkspaceId(), terminal: Terminals = null) {
  const groups = await prisma.settlement.groupBy({ by: ["status"], where: { workspaceId, ...(terminal != null ? { driver: { terminal: terminalFilter(terminal) } } : {}) }, _count: { _all: true }, _sum: { total: true } });
  const of = (status: string) => groups.find((g) => g.status === status);
  return { draft: of("draft")?._count._all ?? 0, final: of("final")?._count._all ?? 0, void: of("void")?._count._all ?? 0, finalTotal: numOrNull(of("final")?._sum.total) ?? 0 };
}

type SettlementWithDriver = Prisma.SettlementGetPayload<{ include: { driver: true } }>;

/** A final or void statement's deduction, escrow and release lines, read from its rows, not its JSON. */
async function frozenDeductions(ids: readonly string[]): Promise<Map<string, DeductionLine[]>> {
  const out = new Map<string, DeductionLine[]>();
  if (ids.length === 0) return out;
  const rows = await prisma.settlementLine.findMany({ where: { settlementId: { in: [...ids] }, kind: { in: [...DEDUCTION_ROW_KINDS] } }, orderBy: [{ settlementId: "asc" }, { sort: "asc" }] });
  for (const r of rows) {
    const list = out.get(r.settlementId) ?? [];
    list.push({ deductionId: r.deductionId, advanceId: r.advanceId, kind: r.kind as DeductionRowKind, label: r.label, basis: r.basis, amount: new Prisma.Decimal(r.amount).toNumber() });
    out.set(r.settlementId, list);
  }
  return out;
}

/**
 * Turns raw settlement rows into `SettlementRow`s, reading the eligible loads for every draft in ONE database query rather than one per draft.
 */
async function resolveSettlementRows(rows: SettlementWithDriver[], workspaceId: string): Promise<SettlementRow[]> {
  const drafts = rows.filter((s) => s.status === "draft");
  const [tz, payMilesBasis] = await Promise.all([workspaceTimezone(workspaceId), workspacePayBasis(workspaceId)]);
  const draftMap = new Map<string, { loads: SettlementLoad[]; statement: Statement }>();
  if (drafts.length > 0) {
    const boundsById = new Map<string, { from: Date; to: Date }>();
    let minFrom: Date | null = null;
    let maxTo: Date | null = null;
    for (const s of drafts) {
      const b = periodBounds(ymd(s.periodStart), ymd(s.periodEnd), tz);
      if (!b) continue;
      boundsById.set(s.id, b);
      if (!minFrom || b.from < minFrom) minFrom = b.from;
      if (!maxTo || b.to > maxTo) maxTo = b.to;
    }
    const driverIds = [...new Set(drafts.map((s) => s.driverId))];
    const [candidateLoads, candidateLegs] =
      minFrom && maxTo
        ? await Promise.all([
            prisma.load.findMany({
              where: {
                workspaceId,
                deletedAt: null,
                status: "completed",
                completedAt: { gte: minFrom, lt: maxTo },
                settlement: { is: null },
                legs: { none: { kind: "haul" } },
                assignment: { is: { driverId: { in: driverIds }, status: "completed" } }
              },
              include: { assignment: true },
              orderBy: [{ completedAt: "asc" }, { loadNumber: "asc" }]
            }),
            prisma.loadLeg.findMany({
              where: {
                workspaceId,
                driverId: { in: driverIds },
                status: "closed",
                endedAt: { gte: minFrom, lt: maxTo },
                settlementLeg: { is: null },
                payKind: { not: null },
                payRate: { not: null },
                load: { deletedAt: null, status: { not: "quote" } },
                OR: [{ kind: "positioning", milesDriven: { not: null } }, { kind: "haul", load: { status: "completed" } }]
              },
              include: { load: { select: legLoadSelect } },
              orderBy: [{ endedAt: "asc" }, { seq: "asc" }]
            })
          ])
        : [[], []];
    const haulSeqs = await haulOrderMap(
      prisma,
      [...new Set(candidateLegs.filter((l) => l.kind === "haul").map((l) => l.loadId))]
    );
    const byDriver = new Map<string, Array<{ completedAt: Date; sortNum: string; sl: SettlementLoad }>>();
    for (const l of candidateLoads) {
      if (!l.assignment || !l.completedAt) continue;
      const list = byDriver.get(l.assignment.driverId) ?? [];
      list.push({ completedAt: l.completedAt, sortNum: l.loadNumber ?? "", sl: toSettlementLoad(l, payMilesBasis) });
      byDriver.set(l.assignment.driverId, list);
    }
    for (const lg of candidateLegs) {
      if (!lg.driverId || !lg.endedAt) continue;
      const list = byDriver.get(lg.driverId) ?? [];
      list.push({ completedAt: lg.endedAt, sortNum: `${lg.load.loadNumber ?? ""}:${String(lg.seq).padStart(4, "0")}`, sl: toSettlementLeg(lg, haulSeqs.get(lg.loadId) ?? []) });
      byDriver.set(lg.driverId, list);
    }
    // The fuel purchases picked on these drafts, read together: still available (not deducted elsewhere) and picked on that draft.
    const pickedIds = [...new Set(drafts.flatMap((d) => typedFuelIds(d.fuelIds)))];
    const pickedFuel = pickedIds.length > 0 ? (await prisma.fuelTransaction.findMany({ where: { id: { in: pickedIds }, workspaceId, settlementId: null }, include: { load: { select: { loadNumber: true } } } })).map(toFuelLine) : [];
    // The deductions each draft is offered, against the ledger as it stands, read for all of them at once.
    const offered = await draftDeductionOptions(prisma, workspaceId, drafts.map((d) => ({ driverId: d.driverId, start: ymd(d.periodStart), end: ymd(d.periodEnd), workerType: d.driver.payrollWorkerType })));
    const back = await openReimbursements(prisma, workspaceId, driverIds);
    for (const [k, s] of drafts.entries()) {
      const b = boundsById.get(s.id);
      const loads = b
        ? (byDriver.get(s.driverId) ?? [])
            .filter((x) => x.completedAt >= b.from && x.completedAt < b.to)
            .sort((x, y) => x.completedAt.getTime() - y.completedAt.getTime() || x.sortNum.localeCompare(y.sortNum))
            .map((x) => x.sl)
        : [];
      const mine = new Set(typedFuelIds(s.fuelIds));
      const ded = offered[k]!;
      const { lines: deductions, errors: deductionErrors } = deductionLines(ded.options, cleanChoices(typedChoices(s.deductionChoices), ded.options), ded.escrowHeldCents);
      const statement = computeStatement({ loads, hours: typedHours(s.hours), adjustments: typedAdjustments(s.adjustments), fuel: pickedFuel.filter((f) => mine.has(f.id)), deductions, deductionErrors, reimbursements: back.get(s.driverId) ?? [] });
      draftMap.set(s.id, { loads, statement });
    }
  }
  const frozen = await frozenDeductions(rows.filter((s) => s.status !== "draft").map((s) => s.id));
  return rows.map((s) => {
    const label = periodText(ymd(s.periodStart), ymd(s.periodEnd));
    const common = {
      id: s.id,
      number: s.number,
      status: s.status,
      driverId: s.driverId,
      driverName: s.driver.name,
      periodStart: s.periodStart,
      periodEnd: s.periodEnd,
      periodLabel: label,
      finalizedAt: s.finalizedAt,
      paidAt: s.paidAt,
      paidMethod: s.paidMethod,
      payrollSentAt: s.payrollSentAt,
      payrollReference: s.payrollReference,
      voidedAt: s.voidedAt,
      voidReason: s.voidReason,
      createdAt: s.createdAt
    };
    if (s.status === "draft") {
      const got = draftMap.get(s.id) ?? { loads: [], statement: computeStatement({ loads: [], hours: {}, adjustments: [] }) };
      return { ...common, loads: got.loads.length, loadsTotal: got.statement.loadsTotal, adjustmentsTotal: got.statement.adjustmentsTotal, fuelTotal: got.statement.fuelTotal, deductionsTotal: got.statement.deductionsTotal, total: got.statement.total, statement: got.statement };
    }
    const lines = (Array.isArray(s.lines) ? s.lines : []) as unknown as StatementLine[];
    const adjustments = (Array.isArray(s.adjustments) ? s.adjustments : []) as unknown as Adjustment[];
    const fuel = (Array.isArray(s.fuel) ? s.fuel : []) as unknown as FuelLine[];
    const statement = statementOf(lines, adjustments, fuel, frozen.get(s.id) ?? []);
    return { ...common, loads: lines.length, loadsTotal: statement.loadsTotal, adjustmentsTotal: statement.adjustmentsTotal, fuelTotal: statement.fuelTotal, deductionsTotal: statement.deductionsTotal, total: numOrNull(s.total) ?? statement.total, statement };
  });
}

/** Statements, newest first, a page at a time (a big fleet settles every driver every week). */
export async function listSettlements(workspaceId = currentWorkspaceId(), opts: { skip?: number; take?: number; status?: string; driverId?: string; terminal?: Terminals } = {}): Promise<SettlementRow[]> {
  const rows = await prisma.settlement.findMany({
    where: {
      workspaceId,
      ...(opts.status ? { status: opts.status } : {}),
      ...(opts.driverId ? { driverId: opts.driverId } : {}),
      ...(opts.terminal != null ? { driver: { terminal: terminalFilter(opts.terminal) } } : {})
    },
    include: { driver: true },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    skip: opts.skip ?? 0,
    take: opts.take ?? STATEMENTS_PAGE
  });
  return resolveSettlementRows(rows, workspaceId);
}

/** One driver's pay statements, newest first, for their page under Drivers. */
export async function listDriverSettlements(driverId: string, workspaceId = currentWorkspaceId(), take = 25) {
  const [rows, total] = await Promise.all([
    listSettlements(workspaceId, { driverId, take }),
    prisma.settlement.count({ where: { workspaceId, driverId } })
  ]);
  return { rows, total };
}

export type Unsettled = {
  driverId: string;
  driverName: string;
  loads: number;
  amount: number;
  hourlyWithoutHours: number;
  /** Of these loads, how many the customer paid short (the percent is on the agreed rate, so the driver is paid on the full rate). */
  paidShort: number;
  /** Loads this driver drove that became a TONU in the last 120 days: they are on no statement, so any pay for them is typed as an adjustment. */
  tonu: number;
  oldest: Date;
  newest: Date;
  start: string;
  end: string;
};

/** A TONU is on no statement by itself; it is listed for this long so a dispatcher sees it and decides. */
export const TONU_DAYS = 120;

/** Per driver, the delivered loads and closed relay/positioning legs not on any final statement, what they come to, and a period that would cover them. */
export async function unsettledByDriver(workspaceId = currentWorkspaceId(), now = new Date(), terminal: Terminals = null): Promise<Unsettled[]> {
  // Read as plain columns (whole loads without haul legs, plus closed unsettled relay/positioning legs): a fleet has thousands of these.
  const [[loads, legRows, tonus], tz, payMilesBasis] = await Promise.all([
    Promise.all([
      prisma.$queryRaw<
        Array<{ driverId: string; driverName: string; completedAt: Date; loadedMiles: number; quotedLoadedMiles: number | null; quotedRevenue: number; fuelSurcharge: number | null; payKind: string; payRate: number; payEstimate: number | null; short: boolean }>
      >`
        select a.driver_id as "driverId", d.name as "driverName", l.completed_at as "completedAt", l.loaded_miles::float8 as "loadedMiles", l.quoted_loaded_miles::float8 as "quotedLoadedMiles",
          l.quoted_revenue::float8 as "quotedRevenue", l.fuel_surcharge::float8 as "fuelSurcharge", a.pay_kind as "payKind", a.pay_rate::float8 as "payRate", a.pay_estimate::float8 as "payEstimate",
          (l.payment_status = 'paid' and (coalesce(l.write_off_amount, 0) > 0 or (l.invoiced_amount is not null and l.paid_amount < l.invoiced_amount))) as short
        from loads l join assignments a on a.load_id = l.id and a.status = 'completed' join drivers d on d.id = a.driver_id
        where l.workspace_id = ${workspaceId} and l.deleted_at is null and l.status = 'completed'
          and not exists (select 1 from settlement_loads sl where sl.load_id = l.id)
          and not exists (select 1 from load_legs lg where lg.load_id = l.id and lg.kind = 'haul')
          ${terminal != null ? Prisma.sql`and d.terminal = any(${termList(terminal)})` : Prisma.empty}`,
      prisma.$queryRaw<
        Array<{ driverId: string; driverName: string; completedAt: Date; loadedMiles: number; legMiles: number | null; quotedRevenue: number; fuelSurcharge: number | null; payKind: string; payRate: number; payEstimate: number | null; short: boolean }>
      >`
        select lg.driver_id as "driverId", d.name as "driverName", lg.ended_at as "completedAt", l.loaded_miles::float8 as "loadedMiles", lg.miles_driven::float8 as "legMiles",
          l.quoted_revenue::float8 as "quotedRevenue", l.fuel_surcharge::float8 as "fuelSurcharge", lg.pay_kind as "payKind", lg.pay_rate::float8 as "payRate", lg.pay_estimate::float8 as "payEstimate",
          (l.payment_status = 'paid' and (coalesce(l.write_off_amount, 0) > 0 or (l.invoiced_amount is not null and l.paid_amount < l.invoiced_amount))) as short
        from load_legs lg join loads l on l.id = lg.load_id join drivers d on d.id = lg.driver_id
        where lg.workspace_id = ${workspaceId} and lg.status = 'closed' and lg.ended_at is not null
          and lg.driver_id is not null and lg.pay_kind is not null and lg.pay_rate is not null
          and ((lg.kind = 'positioning' and lg.miles_driven is not null) or (lg.kind = 'haul' and l.status = 'completed'))
          and l.deleted_at is null
          and not exists (select 1 from settlement_legs slg where slg.load_leg_id = lg.id)
          ${terminal != null ? Prisma.sql`and d.terminal = any(${termList(terminal)})` : Prisma.empty}`,
      prisma.$queryRaw<Array<{ driverId: string; driverName: string; n: number }>>`
        select a.driver_id as "driverId", d.name as "driverName", count(*)::int as n
        from loads l join assignments a on a.load_id = l.id and a.status = 'completed' join drivers d on d.id = a.driver_id
        where l.workspace_id = ${workspaceId} and l.deleted_at is null and l.status = 'tonu' and l.cancelled_at >= ${new Date(now.getTime() - TONU_DAYS * 86_400_000)}
          ${terminal != null ? Prisma.sql`and d.terminal = any(${termList(terminal)})` : Prisma.empty}
        group by a.driver_id, d.name`
    ]),
    workspaceTimezone(workspaceId),
    workspacePayBasis(workspaceId)
  ]);
  const tonuByDriver = new Map(tonus.map((t) => [t.driverId, t.n]));
  const boundsCache = new Map<string, { from: Date; to: Date } | null>();
  const getBounds = (start: string, end: string) => {
    const k = `${start}:${end}`;
    if (boundsCache.has(k)) return boundsCache.get(k)!;
    const b = periodBounds(start, end, tz);
    boundsCache.set(k, b);
    return b;
  };
  type UnsettledItem = { completedAt: Date; loadedMiles: number; legMiles: number | null; isLeg: boolean; quotedRevenue: number; fuelSurcharge: number | null; payKind: string; payRate: number; payEstimate: number | null; short: boolean };
  const byDriver = new Map<string, { name: string; loads: UnsettledItem[] }>();
  for (const l of loads) {
    const group = byDriver.get(l.driverId) ?? { name: l.driverName, loads: [] };
    const effectiveMiles = l.quotedLoadedMiles != null ? milesGapSummary(l.loadedMiles, l.quotedLoadedMiles, payMilesBasis).paidMiles : l.loadedMiles;
    group.loads.push({ ...l, loadedMiles: effectiveMiles, legMiles: null, isLeg: false });
    byDriver.set(l.driverId, group);
  }
  for (const lg of legRows) {
    const group = byDriver.get(lg.driverId) ?? { name: lg.driverName, loads: [] };
    group.loads.push({ ...lg, isLeg: true });
    byDriver.set(lg.driverId, group);
  }
  const out: Unsettled[] = [];
  for (const [driverId, g] of byDriver) {
    const period = periodCovering(g.loads.map((l) => l.completedAt), tz);
    if (!period) continue;
    // The period offered may be the latest stretch of a long backlog; the amount is for the items that stretch holds, so what the row says is what the statement will pay.
    const bounds = getBounds(period.start, period.end);
    const inPeriod = bounds ? g.loads.filter((l) => l.completedAt >= bounds.from && l.completedAt < bounds.to) : g.loads;
    const lines = inPeriod.map((l) => linePay(l.payKind as PayKind, l.payRate, l.loadedMiles, hoursFromEstimate(l.payKind, l.payRate, l.payEstimate), rateConTotal(l.quotedRevenue, l.fuelSurcharge ?? 0), l.legMiles, l.isLeg));
    const sorted = inPeriod.map((l) => l.completedAt).sort((a, b) => a.getTime() - b.getTime());
    const cents = lines.reduce((sum, amount) => sum.plus(amount ?? 0), new Prisma.Decimal(0));
    out.push({
      driverId, driverName: g.name, loads: inPeriod.length, amount: cents.toNumber(), hourlyWithoutHours: lines.filter((amount) => amount == null).length, paidShort: inPeriod.filter((l) => l.short).length,
      tonu: tonuByDriver.get(driverId) ?? 0, oldest: sorted[0]!, newest: sorted[sorted.length - 1]!, start: period.start, end: period.end
    });
  }
  // A driver whose only unsettled thing is a TONU still shows, so it is seen.
  for (const t of tonus) if (!byDriver.has(t.driverId)) out.push({ driverId: t.driverId, driverName: t.driverName, loads: 0, amount: 0, hourlyWithoutHours: 0, paidShort: 0, tonu: t.n, oldest: now, newest: now, start: "", end: "" });
  return out.sort((a, b) => a.driverName.localeCompare(b.driverName));
}

export type LoadSettlementInfo = {
  whole: { id: string; number: string; amount: number } | null;
  legs: Array<{ loadLegId: string; seq: number; kind: string; driverName: string | null; id: string; number: string; amount: number }>;
};

export const onStatement = (l: { settlement?: unknown | null; settlementLegs?: readonly unknown[] }): boolean =>
  !!l.settlement || (l.settlementLegs?.length ?? 0) > 0;

/** The final statement(s) a load or its relay/positioning legs were paid on, if any. */
export async function settlementsOfLoad(loadId: string, db: Db = prisma): Promise<LoadSettlementInfo> {
  const [wholeRow, legRows] = await Promise.all([
    db.settlementLoad.findUnique({ where: { loadId }, include: { settlement: { select: { id: true, number: true } } } }),
    db.settlementLeg.findMany({
      where: { loadId },
      include: { settlement: { select: { id: true, number: true } }, loadLeg: { select: { seq: true, kind: true, driverName: true } } },
      orderBy: { loadLeg: { seq: "asc" } }
    })
  ]);
  return {
    whole: wholeRow ? { id: wholeRow.settlement.id, number: wholeRow.settlement.number, amount: num(wholeRow.amount) } : null,
    legs: legRows.map((r) => ({ loadLegId: r.loadLegId, seq: r.loadLeg.seq, kind: r.loadLeg.kind, driverName: r.loadLeg.driverName, id: r.settlement.id, number: r.settlement.number, amount: num(r.amount) }))
  };
}

/** The final statement a load was paid on, if any. */
export async function settlementOfLoad(loadId: string): Promise<{ id: string; number: string; amount: number } | null> {
  const info = await settlementsOfLoad(loadId);
  if (info.whole) return info.whole;
  const first = info.legs[0];
  return first ? { id: first.id, number: first.number, amount: first.amount } : null;
}
