import { createHash } from "crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { advanceLabel } from "@/lib/deductions";
import { assertStatementSafe, driverSafeStatement, payPlan, toBalanceRow, toStatementRow, type DriverBalanceRow } from "@/lib/driver-pay";
import { deskFileFolder } from "@/lib/load-documents";
import { linePay } from "@/lib/settlement";
import { buildStatementPdf } from "@/lib/statement-pdf";
import { toCentralLocal } from "@/lib/zoned";
import { num } from "@/server/tl/convert";
import { draftDeductionOptions, ledgerBalances, toAdvance } from "@/server/tl/deductions";
import { eligibleLoads, getSettlement } from "@/server/tl/settlement";
import { statementPdfData, statementYtd } from "@/server/tl/statement-pdf";
import { currentWorkspaceId } from "@/server/tl/workspace";
import { workspaceTimezone } from "@/server/tl/zone";
import { BridgeTransportError, type BridgeTransport } from "./transport";

/** Statements finalized this long ago or less are on the phone; older ones stay on the desk. */
export const STATEMENT_DAYS = 400;
/** Loads delivered this long ago or less count as earned and not settled. */
const UNSETTLED_DAYS = 180;
/** Bumped when what is sent changes shape, so every row is written again once. */
const SHAPE = 1;

/**
 * A driver's pay, mirrored to their own phone (sync plan Step 5a) the way the HOS clocks and the load documents are: worked out from the desk as it stands, compared, and only the
 * difference written. A finalize, a payment, a void, an advance and a deduction all reach the phone on the next run with nothing of their own. Drafts never go. One statement that cannot be
 * sent (a check refused it, its PDF failed) never stops the others, and is tried again on the next run.
 */
export async function mirrorDriverPay(transport: BridgeTransport, opts: { workspaceId?: string; now?: Date } = {}): Promise<{ statements: number; removed: number; balances: number; failed: number }> {
  const workspaceId = opts.workspaceId ?? currentWorkspaceId();
  const now = opts.now ?? new Date();
  const out = { statements: 0, removed: 0, balances: 0, failed: 0 };
  const ws = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { bridgeOrgId: true } });
  if (!ws?.bridgeOrgId) return out;
  const orgId = ws.bridgeOrgId;
  const drivers = await prisma.driver.findMany({ where: { workspaceId, phoneUserId: { not: null } }, select: { id: true, phoneUserId: true, payrollWorkerType: true } });
  const subOf = new Map(drivers.map((d) => [d.id, d.phoneUserId!]));
  const since = new Date(now.getTime() - STATEMENT_DAYS * 86_400_000);
  const settled = await prisma.settlement.findMany({ where: { workspaceId, driverId: { in: drivers.map((d) => d.id) }, status: { in: ["final", "void"] }, finalizedAt: { gte: since } }, select: { id: true, driverId: true, updatedAt: true } });

  const plan = payPlan({
    statements: settled.map((s) => ({ driverSub: subOf.get(s.driverId)!, id: s.id, rev: `${SHAPE}:${s.updatedAt.toISOString()}` })),
    thereStatements: await transport.driverStatementRows(orgId),
    balances: await balanceRows(orgId, workspaceId, drivers, now),
    thereBalances: await transport.driverBalanceRows(orgId)
  });

  if (plan.remove.length > 0) {
    await transport.removeDriverFiles(plan.remove.flatMap((r) => (r.pdf_path ? [r.pdf_path] : [])));
    await transport.deleteDriverStatements(orgId, plan.remove.map((r) => r.id));
    out.removed = plan.remove.length;
  }
  const oldPdf = new Map((await transport.driverStatementRows(orgId)).map((r) => [`${r.driver_sub}|${r.desk_statement_id}`, r.pdf_path]));
  for (const w of plan.write) {
    try {
      const s = await getSettlement(w.id, workspaceId);
      const data = await statementPdfData(w.id, workspaceId, null, now);
      if (!s || !data || s.status === "draft") continue;
      const loads = await prisma.load.findMany({ where: { workspaceId, id: { in: s.statement.lines.map((l) => l.loadId) } }, select: { quotedRevenue: true, actualRevenue: true, fuelSurcharge: true } });
      const secrets = loads.flatMap((l) => {
        const [q, a, f] = [num(l.quotedRevenue), num(l.actualRevenue), num(l.fuelSurcharge)];
        return [q, a, q + f].filter((n) => n > 0);
      });
      const pdf = await buildStatementPdf({ ...data, voidReason: null, statement: driverSafeStatement(data.statement) });
      const path = `${deskFileFolder(orgId, w.driverSub)}st-${w.id}-${createHash("sha256").update(pdf).digest("hex").slice(0, 10)}.pdf`;
      const row = toStatementRow({ orgId, driverSub: w.driverSub, s, pdfPath: path, rev: w.rev });
      assertStatementSafe(row, secrets);
      await transport.uploadDeskFile(path, pdf, "application/pdf");
      await transport.upsertDriverStatement(row);
      const before = oldPdf.get(`${w.driverSub}|${w.id}`);
      if (before && before !== path) await transport.removeDriverFiles([before]);
      out.statements += 1;
    } catch (e) {
      out.failed += 1;
      if (e instanceof BridgeTransportError && e.code === "unreachable") return out;
    }
  }
  if (plan.balances.length > 0) await transport.upsertDriverBalances(plan.balances.map((b) => ({ ...b, as_of: now.toISOString() })));
  if (plan.removeBalances.length > 0) await transport.deleteDriverBalances(orgId, plan.removeBalances);
  out.balances = plan.balances.length;
  return out;
}

/** Each linked driver's balances as the desk has them now. */
async function balanceRows(orgId: string, workspaceId: string, drivers: readonly { id: string; phoneUserId: string | null; payrollWorkerType: string | null }[], now: Date): Promise<DriverBalanceRow[]> {
  if (drivers.length === 0) return [];
  const tz = await workspaceTimezone(workspaceId);
  const today = toCentralLocal(now.getTime(), tz).slice(0, 10);
  const from = toCentralLocal(now.getTime() - UNSETTLED_DAYS * 86_400_000, tz).slice(0, 10);
  const ids = drivers.map((d) => d.id);
  const [ledger, advances, options] = await Promise.all([
    ledgerBalances(prisma, workspaceId, ids),
    prisma.driverAdvance.findMany({ where: { workspaceId, driverId: { in: ids } }, orderBy: [{ givenOn: "asc" }, { id: "asc" }] }),
    draftDeductionOptions(prisma, workspaceId, drivers.map((d) => ({ driverId: d.id, start: today, end: today, workerType: d.payrollWorkerType })))
  ]);
  const out: DriverBalanceRow[] = [];
  for (const [i, d] of drivers.entries()) {
    const b = ledger.get(d.id)!;
    const loads = await eligibleLoads(d.id, from, today, workspaceId);
    const pays = loads.map((l) => linePay(l.payKind, l.payRate, l.loadedMiles, l.assignedHours, l.rateConTotal));
    out.push(
      toBalanceRow({
        orgId,
        driverSub: d.phoneUserId!,
        deskDriverId: d.id,
        escrowHeldCents: b.escrowHeldCents,
        advances: advances.filter((a) => a.driverId === d.id).map((a) => ({ label: advanceLabel(toAdvance(a)), owedCents: b.owedByAdvance[a.id] ?? 0 })),
        options: options[i]!.options,
        unsettled: { cents: pays.reduce((n, p) => n.plus(p ?? 0), new Prisma.Decimal(0)).times(100).toDecimalPlaces(0).toNumber(), loads: loads.length, unpriced: pays.filter((p) => p == null).length },
        ytd: await statementYtd(d.id, now, workspaceId, tz)
      })
    );
  }
  return out;
}
