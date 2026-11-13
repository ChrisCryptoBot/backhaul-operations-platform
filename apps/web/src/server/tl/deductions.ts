import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { deductionKindLabel, isDeductionKind, proposeDeductions, validateDeduction, type DeductionOption, type DeductionRule, type DeductionValues, type LedgerBalances } from "@/lib/deductions";
import { usd } from "@/lib/desk-format";
import { recordAudit } from "./audit";
import { currentWorkspaceId } from "./workspace";

/**
 * Recurring deductions and escrow (docs/MONEY_PLAN.md, Wave 4 step 3, rule K): the rules on a driver, the ledger balances they are checked against, and what a draft statement is offered.
 * The pure rules are lib/deductions.ts. A W-2 employee's deductions run through payroll (rule E), so an employee is offered none and cannot be given a rule here.
 */
type Db = Prisma.TransactionClient | typeof prisma;

const cents = (d: Prisma.Decimal | null | undefined): number => (d == null ? 0 : new Prisma.Decimal(d).times(100).toDecimalPlaces(0).toNumber());
const ymd = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

type RuleRow = Prisma.DriverDeductionGetPayload<object>;
export const toRule = (r: RuleRow): DeductionRule => ({ id: r.id, kind: isDeductionKind(r.kind) ? r.kind : "other", label: r.label, amountCents: cents(r.amount), goalCents: r.goal == null ? null : cents(r.goal), startsOn: ymd(r.startsOn), endsOn: ymd(r.endsOn), active: r.active });

/** Per driver, what the ledger says: taken per non-escrow rule, and the escrow held. */
export async function ledgerBalances(db: Db, workspaceId: string, driverIds: readonly string[]): Promise<Map<string, LedgerBalances>> {
  const out = new Map<string, LedgerBalances>(driverIds.map((d) => [d, { takenByRule: {}, escrowHeldCents: 0 }]));
  if (driverIds.length === 0) return out;
  const sums = await db.driverLedgerEntry.groupBy({ by: ["driverId", "deductionId", "kind"], where: { workspaceId, driverId: { in: [...driverIds] } }, _sum: { amount: true } });
  for (const g of sums) {
    const b = out.get(g.driverId)!;
    const c = cents(g._sum.amount);
    // Signed as on the statement: escrow held and deductions are negative, a release positive.
    if (g.kind === "escrow" || g.kind === "escrow_release") b.escrowHeldCents -= c;
    else if (g.deductionId) b.takenByRule[g.deductionId] = (b.takenByRule[g.deductionId] ?? 0) - c;
  }
  return out;
}

/** What a draft for this driver and period is offered, and the escrow held before it. Employees: nothing (rule E). */
export async function draftDeductionOptions(db: Db, workspaceId: string, drafts: ReadonlyArray<{ driverId: string; start: string; end: string; workerType: string | null }>): Promise<Array<{ options: DeductionOption[]; escrowHeldCents: number }>> {
  const driverIds = [...new Set(drafts.filter((d) => d.workerType !== "employee").map((d) => d.driverId))];
  const [rules, balances] = await Promise.all([
    driverIds.length === 0 ? Promise.resolve([] as RuleRow[]) : db.driverDeduction.findMany({ where: { workspaceId, driverId: { in: driverIds }, active: true }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }),
    ledgerBalances(db, workspaceId, driverIds)
  ]);
  return drafts.map((d) => {
    if (d.workerType === "employee") return { options: [], escrowHeldCents: 0 };
    const b = balances.get(d.driverId) ?? { takenByRule: {}, escrowHeldCents: 0 };
    return { options: proposeDeductions(rules.filter((r) => r.driverId === d.driverId).map(toRule), b, d.start, d.end), escrowHeldCents: b.escrowHeldCents };
  });
}

// ── The driver page ───────────────────────────────────────────────────────────────────────────

export type DeductionSummary = { rule: DeductionRule; soFarCents: number };
export type LedgerRow = { id: string; kind: string; label: string; amount: number; reason: string | null; statementId: string | null; statementNumber: string | null; at: Date };

export async function driverDeductions(driverId: string, workspaceId = currentWorkspaceId()) {
  const [rules, balances, recent, driver] = await Promise.all([
    prisma.driverDeduction.findMany({ where: { workspaceId, driverId }, orderBy: [{ active: "desc" }, { createdAt: "asc" }] }),
    ledgerBalances(prisma, workspaceId, [driverId]),
    prisma.driverLedgerEntry.findMany({ where: { workspaceId, driverId }, include: { settlement: { select: { id: true, number: true } } }, orderBy: [{ createdAt: "desc" }, { id: "asc" }], take: 15 }),
    prisma.driver.findFirst({ where: { id: driverId, workspaceId }, select: { payrollWorkerType: true } })
  ]);
  const b = balances.get(driverId)!;
  return {
    employee: driver?.payrollWorkerType === "employee",
    escrowHeldCents: b.escrowHeldCents,
    rules: rules.map((r): DeductionSummary => ({ rule: toRule(r), soFarCents: r.kind === "escrow" ? b.escrowHeldCents : (b.takenByRule[r.id] ?? 0) })),
    ledger: recent.map((e): LedgerRow => ({ id: e.id, kind: e.kind, label: e.label, amount: new Prisma.Decimal(e.amount).toNumber(), reason: e.reason, statementId: e.settlement?.id ?? null, statementNumber: e.settlement?.number ?? null, at: e.createdAt }))
  };
}

export type DeductionSave = { ok: true; id: string; changed: boolean } | { ok: false; error?: string; errors?: Partial<Record<keyof DeductionValues, string>> };

const day = (s: string) => (s ? new Date(`${s}T00:00:00Z`) : null);
const money = (c: number | null) => (c == null ? null : usd(c / 100, 2));

/** Add a rule to a driver, or change one. A change applies to statements finalized from now on; what was taken stays in the ledger. */
export async function saveDeduction(raw: Record<string, unknown>, driverId: string, id: string | null, now = new Date(), workspaceId = currentWorkspaceId()): Promise<DeductionSave> {
  const check = validateDeduction(raw);
  if (!check.ok) return { ok: false, errors: check.errors };
  const driver = await prisma.driver.findFirst({ where: { id: driverId, workspaceId } });
  if (!driver) return { ok: false, error: "That driver does not exist." };
  if (driver.payrollWorkerType === "employee") return { ok: false, error: `${driver.name} is a W-2 employee: deductions for an employee run through payroll, not the driver statement.` };
  const v = check.value;
  const data = { kind: v.kind, label: v.label, amount: new Prisma.Decimal(check.amountCents).div(100), goal: check.goalCents == null ? null : new Prisma.Decimal(check.goalCents).div(100), startsOn: day(v.startsOn), endsOn: day(v.endsOn) };
  const snap = (x: { kind: string; label: string; amountCents: number; goalCents: number | null; startsOn: string | null; endsOn: string | null }) => ({
    What: `${deductionKindLabel(x.kind)}: ${x.label}`,
    "Per statement": money(x.amountCents),
    [x.kind === "escrow" ? "Goal" : "Cap"]: money(x.goalCents),
    From: x.startsOn,
    To: x.endsOn
  });
  const after = snap({ kind: v.kind, label: v.label, amountCents: check.amountCents, goalCents: check.goalCents, startsOn: v.startsOn || null, endsOn: v.endsOn || null });
  if (id == null) {
    const made = await prisma.$transaction(async (tx) => {
      const r = await tx.driverDeduction.create({ data: { workspaceId, driverId, ...data } });
      await recordAudit({ entity: "fleet", action: "deduction_added", summary: `${driver.name}: ${deductionKindLabel(v.kind).toLowerCase()} deduction "${v.label}" added, ${money(check.amountCents)} a statement`, before: null, after, at: now, workspaceId }, tx);
      return r;
    });
    return { ok: true, id: made.id, changed: true };
  }
  const prev = await prisma.driverDeduction.findFirst({ where: { id, workspaceId, driverId } });
  if (!prev) return { ok: false, error: "That deduction does not exist." };
  const p = toRule(prev);
  const before = snap({ kind: p.kind, label: p.label, amountCents: p.amountCents, goalCents: p.goalCents, startsOn: p.startsOn, endsOn: p.endsOn });
  if (JSON.stringify(before) === JSON.stringify(after)) return { ok: true, id, changed: false };
  // Its kind decides which ledger it fills: once something has been taken under it, it stays that kind.
  if (prev.kind !== v.kind && (await prisma.driverLedgerEntry.count({ where: { deductionId: id } })) > 0) return { ok: false, errors: { kind: "Money has been taken under this deduction, so its kind stays. Stop it and add a new one." } };
  await prisma.$transaction(async (tx) => {
    await tx.driverDeduction.update({ where: { id }, data });
    await recordAudit({ entity: "fleet", action: "deduction_changed", summary: `${driver.name}: deduction "${v.label}" changed`, before, after, at: now, workspaceId }, tx);
  });
  return { ok: true, id, changed: true };
}

/** Stop a rule (it is no longer offered) or start it again. Never deleted: the ledger names it. */
export async function setDeductionActive(id: string, active: boolean, now = new Date(), workspaceId = currentWorkspaceId()): Promise<{ ok: true } | { ok: false; error: string }> {
  const r = await prisma.driverDeduction.findFirst({ where: { id, workspaceId }, include: { driver: { select: { name: true, payrollWorkerType: true } } } });
  if (!r) return { ok: false, error: "That deduction does not exist." };
  if (r.active === active) return { ok: true };
  if (active && r.driver.payrollWorkerType === "employee") return { ok: false, error: `${r.driver.name} is a W-2 employee: deductions run through payroll.` };
  await prisma.$transaction(async (tx) => {
    await tx.driverDeduction.update({ where: { id }, data: { active } });
    await recordAudit({ entity: "fleet", action: active ? "deduction_started" : "deduction_stopped", summary: `${r.driver.name}: deduction "${r.label}" ${active ? "started again" : "stopped"}`, before: { Active: r.active ? "Yes" : "No" }, after: { Active: active ? "Yes" : "No" }, at: now, workspaceId }, tx);
  });
  return { ok: true };
}
