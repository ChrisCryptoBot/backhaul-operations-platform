import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { paidMethodLabel } from "@/lib/pay-method";
import type { Terminals } from "@/lib/scope";
import { buildStatementPdf, ytdFromRows, type StatementPdfData, type StatementYtd } from "@/lib/statement-pdf";
import { centralMidnight, centralParts } from "@/lib/zoned";
import { ledgerBalances } from "./deductions";
import { getSettlement } from "./settlement";
import { currentWorkspaceId } from "./workspace";
import { workspaceTimezone } from "./zone";

/**
 * What goes on a statement's PDF (docs/MONEY_PLAN.md, Wave 4 step 6): the statement exactly as the page reads it (getSettlement: live for a draft, frozen for a final or void one), the driver's
 * escrow held and advances owed today (their ledger), and the year to date from the frozen rows (SettlementLine) of their finalized statements in the calendar year, by the workspace's own
 * zone. Null when the statement does not exist or is outside the person's terminals: the same answer as the page.
 */
const cents = (d: Prisma.Decimal) => new Prisma.Decimal(d).times(100).toDecimalPlaces(0).toNumber();

/** The year to date through `upTo` (a final statement's own finalize time; for a draft or a void one, now). Void and draft statements never count. */
export async function statementYtd(driverId: string, upTo: Date, workspaceId: string, zone: string): Promise<StatementYtd | null> {
  const year = centralParts(upTo.getTime(), zone).y;
  const from = new Date(centralMidnight(year, 0, 1, zone));
  const finals = await prisma.settlement.findMany({ where: { workspaceId, driverId, status: "final", finalizedAt: { gte: from, lte: upTo } }, select: { id: true } });
  if (finals.length === 0) return null;
  const rows = await prisma.settlementLine.findMany({ where: { workspaceId, settlementId: { in: finals.map((f) => f.id) } }, select: { kind: true, amount: true } });
  return ytdFromRows(year, finals.length, rows.map((r) => ({ kind: r.kind, cents: cents(r.amount) })));
}

export async function statementPdfData(id: string, workspaceId = currentWorkspaceId(), terminal: Terminals = null, now = new Date()): Promise<StatementPdfData | null> {
  const s = await getSettlement(id, workspaceId, terminal);
  if (!s) return null;
  const zone = await workspaceTimezone(workspaceId);
  const day = (iso: string | null) => (iso ? new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: zone }).format(new Date(iso)) : null);
  const [balances, ytd] = await Promise.all([ledgerBalances(prisma, workspaceId, [s.driver.id]), statementYtd(s.driver.id, s.status === "final" && s.finalizedAt ? new Date(s.finalizedAt) : now, workspaceId, zone)]);
  const b = balances.get(s.driver.id)!;
  const payoutText = s.paidAt
    ? `Paid ${day(s.paidAt)}${s.paidMethod ? ` by ${paidMethodLabel(s.paidMethod).toLowerCase()}` : ""}${s.paidMethod === "payroll" && s.payrollReference ? ` (run ${s.payrollReference})` : ""}`
    : s.payrollSentAt
      ? `Sent to payroll ${day(s.payrollSentAt)}${s.payrollReference ? ` (${s.payrollReference})` : ""}`
      : null;
  return {
    number: s.number,
    status: s.status,
    issuer: { name: s.company.name, address: s.company.address, mc: s.company.mcNumber, dot: s.company.dotNumber, phone: s.company.phone, email: s.company.email },
    driver: { name: s.driver.name, code: s.driver.code },
    periodLabel: s.periodLabel,
    finalizedOn: day(s.finalizedAt),
    payoutText,
    voidedOn: day(s.voidedAt),
    voidReason: s.voidReason,
    statement: s.statement,
    balances: { escrowHeldCents: b.escrowHeldCents, advanceOwedCents: Object.values(b.owedByAdvance).reduce((n, c) => n + c, 0), asOf: day(now.toISOString())! },
    ytd
  };
}

/** The file: bytes and a name that says when it is not a final statement. */
export async function statementPdf(id: string, workspaceId = currentWorkspaceId(), terminal: Terminals = null, now = new Date()): Promise<{ bytes: Uint8Array; filename: string; data: StatementPdfData } | null> {
  const data = await statementPdfData(id, workspaceId, terminal, now);
  if (!data) return null;
  const safe = data.number.replace(/[^A-Za-z0-9._-]/g, "_");
  return { bytes: await buildStatementPdf(data), filename: `${safe}${data.status === "draft" ? "-DRAFT" : data.status === "void" ? "-VOID" : ""}.pdf`, data };
}
