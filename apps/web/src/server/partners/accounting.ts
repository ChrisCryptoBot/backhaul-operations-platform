import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { ACCOUNT_KEYS, checkAccountsForm, resolveAccounts, unmappedOf, unmappedSentence, type AccountMap, type AccountsForm } from "@/lib/accounting-map";
import { buildJournal, journalCsv, type JAdvance, type JInvoice, type JSettlement } from "@/lib/journal";
import { advanceLabel } from "@/lib/deductions";
import { recordAudit } from "@/server/tl/audit";
import { currentWorkspaceId } from "@/server/tl/workspace";
import { workspaceTimezone } from "@/server/tl/zone";

/**
 * A fleet's accounts (docs/MONEY_PLAN.md, rules D and E) and the journal built from its records. The accounts are the fleet's own names over the defaults (src/lib/accounting-map.ts); the
 * QuickBooks sync and the journal both ask `requireMapped` first and stop, naming what is missing, when a kind they need has no account.
 */
export async function accountMapOf(workspaceId = currentWorkspaceId()): Promise<AccountMap> {
  const rows = await prisma.accountingAccount.findMany({ where: { workspaceId }, select: { key: true, account: true, number: true } });
  return resolveAccounts(rows);
}

export type SaveAccountsResult = { ok: true; changed: number } | { ok: false; errors: Record<string, string> };

/** Save the accounts form. A blank account removes the fleet's own row, so the key goes back to its default (or to unmapped). Audited with what changed. */
export async function saveAccounts(form: AccountsForm, who: string | null, now = new Date(), workspaceId = currentWorkspaceId()): Promise<SaveAccountsResult> {
  const checked = checkAccountsForm(form);
  if (!checked.ok) return checked;
  const before = await prisma.accountingAccount.findMany({ where: { workspaceId } });
  const had = new Map(before.map((r) => [r.key, r]));
  const changes = checked.rows.filter((r) => {
    const h = had.get(r.key);
    return (h?.account ?? null) !== r.account || (h?.number ?? null) !== (r.account ? r.number : null);
  });
  if (changes.length === 0) return { ok: true, changed: 0 };
  const label = (key: string) => ACCOUNT_KEYS.find((k) => k.key === key)?.label ?? key;
  await prisma.$transaction(async (tx) => {
    for (const r of changes) {
      if (r.account) await tx.accountingAccount.upsert({ where: { workspaceId_key: { workspaceId, key: r.key } }, update: { account: r.account, number: r.number, updatedBy: who }, create: { workspaceId, key: r.key, account: r.account, number: r.number, updatedBy: who } });
      else await tx.accountingAccount.deleteMany({ where: { workspaceId, key: r.key } });
    }
    await recordAudit(
      {
        entity: "partner",
        action: "accounting_accounts_saved",
        summary: `Accounting accounts saved: ${changes.map((c) => label(c.key)).join(", ")}`,
        before: Object.fromEntries(changes.map((c) => [label(c.key), had.get(c.key)?.account ?? "Default"])),
        after: Object.fromEntries(changes.map((c) => [label(c.key), c.account ?? "Default"])),
        at: now,
        workspaceId
      },
      tx
    );
  });
  return { ok: true, changed: changes.length };
}

/** The guard every sync calls before it sends anything: every key it needs has an account. */
export async function requireMapped(keys: Iterable<string>, workspaceId = currentWorkspaceId()): Promise<{ ok: true; map: AccountMap } | { ok: false; error: string; unmapped: string[] }> {
  const map = await accountMapOf(workspaceId);
  const unmapped = unmappedOf(keys, map);
  return unmapped.length > 0 ? { ok: false, error: unmappedSentence(unmapped), unmapped } : { ok: true, map };
}

const cents = (d: Prisma.Decimal | null | undefined): number | null => (d == null ? null : d.times(100).toDecimalPlaces(0).toNumber());
export const centsOf = (v: unknown): number => {
  try {
    return new Prisma.Decimal(typeof v === "number" || typeof v === "string" ? v : 0).times(100).toDecimalPlaces(0).toNumber();
  } catch {
    return 0;
  }
};

export type JournalResult =
  | { ok: true; csv: string; filename: string; entries: number; rows: number; notes: string[]; check: ReturnType<typeof buildJournal>["check"] }
  | { ok: false; error: string; problems: string[]; unmapped: string[] };

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The journal for a span of days (inclusive, in the fleet's own zone), or all of it. Refused, with why, while a record cannot be booked or a kind it uses has no account. */
export async function journalFile(span: { from?: string | null; to?: string | null }, workspaceId = currentWorkspaceId()): Promise<JournalResult> {
  const from = span.from && DAY.test(span.from) ? span.from : null;
  const to = span.to && DAY.test(span.to) ? span.to : null;
  if (from && to && from > to) return { ok: false, error: "The first day is after the last.", problems: [], unmapped: [] };
  const zone = await workspaceTimezone(workspaceId);

  const [invoices, settlements, fuel, advances] = await Promise.all([
    prisma.invoice.findMany({
      where: { workspaceId, status: { not: "void" }, kind: { in: ["invoice", "credit_memo"] } },
      include: { lines: { select: { kind: true, amount: true } }, payments: { select: { id: true, amount: true, paidAt: true, source: true } } }
    }),
    prisma.settlement.findMany({ where: { workspaceId, status: "final", voidedAt: null, finalizedAt: { not: null } }, include: { driver: { select: { name: true, payrollWorkerType: true } }, lineRows: { select: { kind: true, amount: true }, orderBy: { sort: "asc" } } } }),
    prisma.fuelTransaction.findMany({ where: { workspaceId }, select: { id: true, postedAt: true, amount: true, location: true } }),
    prisma.driverAdvance.findMany({ where: { workspaceId }, include: { driver: { select: { name: true, payrollWorkerType: true } } } })
  ]);

  const jInvoices: JInvoice[] = invoices.map((i) => ({
    id: i.id,
    number: i.number,
    kind: i.kind,
    billTo: i.billToName,
    issuedAt: i.issuedAt,
    total: cents(i.total)!,
    paidAt: i.paidAt,
    writeOff: cents(i.writeOffAmount),
    lines: i.lines.map((l) => ({ kind: l.kind, amount: cents(l.amount)! })),
    payments: i.payments.map((p) => ({ id: p.id, amount: cents(p.amount)!, paidAt: p.paidAt, source: p.source })),
    factoring: { fundedAt: i.factoringFundedAt, advance: cents(i.factoringAdvance), fee: cents(i.factoringFee), reserveReleased: cents(i.factoringReserveReleased), chargeback: cents(i.factoringChargeback), updatedAt: i.factoringUpdatedAt }
  }));
  const jSettlements: JSettlement[] = settlements.map((s) => ({
    id: s.id,
    number: s.number,
    driver: s.driver.name,
    workerType: s.driver.payrollWorkerType,
    finalizedAt: s.finalizedAt!,
    total: cents(s.total) ?? 0,
    // The frozen rows (Wave 4 step 1), never the statement's JSON: every kind of line the statement carries is booked.
    rows: s.lineRows.map((r) => ({ kind: r.kind, amount: cents(r.amount)! })),
    paidAt: s.paidAt
  }));
  const jAdvances: JAdvance[] = advances.map((a) => ({ id: a.id, driver: a.driver.name, workerType: a.driver.payrollWorkerType, givenOn: a.givenOn.toISOString().slice(0, 10), method: a.method, amount: cents(a.amount)!, label: advanceLabel({ amountCents: cents(a.amount)!, givenOn: a.givenOn.toISOString().slice(0, 10), method: a.method }) }));

  const out = buildJournal({ invoices: jInvoices, settlements: jSettlements, advances: jAdvances, fuel: fuel.map((f) => ({ id: f.id, postedAt: f.postedAt, amount: cents(f.amount)!, location: f.location })) }, { zone, from, to });
  if (out.problems.length > 0) return { ok: false, error: `${out.problems.length} ${out.problems.length === 1 ? "record cannot" : "records cannot"} be booked as they stand.`, problems: out.problems, unmapped: [] };
  const map = await requireMapped(out.keys, workspaceId);
  if (!map.ok) return { ok: false, error: map.error, problems: [], unmapped: map.unmapped };
  const csv = journalCsv(out.entries, map.map);
  return { ok: true, csv, filename: `journal-${from ?? "start"}-to-${to ?? "today"}.csv`, entries: out.entries.length, rows: out.entries.reduce((s, e) => s + e.lines.length, 0), notes: out.notes, check: out.check };
}
