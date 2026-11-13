import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { isIftaQuarter } from "@/lib/ifta-rates-csv";
import { returnMoney, type FiledSnapshot } from "@/lib/ifta-return";
import { recordAudit } from "@/server/tl/audit";
import { currentActor } from "@/server/tl/identity";
import { lockWorkspace } from "@/server/tl/plan";
import { currentWorkspaceId } from "@/server/tl/workspace";
import { iftaReturn } from "./ifta-return";

/**
 * Filing a quarter's IFTA return (money plan Wave 5 step 8): the return as worked out at that moment is frozen (ifta_returns + ifta_return_lines, which a database trigger keeps from being edited)
 * and the quarter is locked (server/partners/ifta-lock.ts). The screen then compares the live return with what was filed and says what changed since.
 *
 * Filing is refused while anything blocks the return (every blocker of lib/ifta-return.ts, sample rates among them), while the fuel flags were read only in part, and when there is no rate table.
 * Provisional or partly final rates file only with an explicit confirmation, kept on the return. A real correction reopens the return with a reason (the filed row stays, marked reopened, who,
 * when, why) and the next filing is an amendment of it. All of it is the billing office's (the actions check `bill`) and every step is audited.
 */
const BAD_QUARTER = "A quarter, like 2026-Q3.";

export type FileResult = { ok: true; id: string; total: string; amended: boolean } | { ok: false; error: string; code: "bad_request" | "already_filed" | "blocked" | "confirm_provisional" | "not_found" };

export async function fileIftaReturn(quarter: string, opts: { confirmProvisional?: boolean } = {}, now = new Date(), workspaceId = currentWorkspaceId()): Promise<FileResult> {
  if (!isIftaQuarter(quarter)) return { ok: false, error: BAD_QUARTER, code: "bad_request" };
  const by = currentActor();
  return prisma.$transaction(
    async (tx): Promise<FileResult> => {
      await lockWorkspace(tx, workspaceId);
      const had = await tx.iftaReturn.findFirst({ where: { workspaceId, quarter, status: "filed" }, select: { filedAt: true, filedBy: true } });
      if (had) return { ok: false, error: `${quarter} was already filed by ${had.filedBy} on ${had.filedAt.toISOString().slice(0, 10)}. Reopen it to file a correction.`, code: "already_filed" };
      // Worked out with the workspace locked: no rate, mileage or fuel-file writer can change it underneath (each takes the same lock first).
      const r = await iftaReturn(quarter, now, workspaceId);
      if (!r.ok) return { ok: false, error: r.error, code: "bad_request" };
      if (r.blockers.length > 0) return { ok: false, error: `Not filed: ${r.blockers.map((b) => b.text).join(" ")}`, code: "blocked" };
      if (r.flagsPartial) return { ok: false, error: "Not filed: the fuel flags could only be read for the newest purchases. Clear the flags on Fuel and try again.", code: "blocked" };
      if (r.rateState === "none") return { ok: false, error: `Not filed: ${quarter} has no tax rates. Import the quarter's rate table first.`, code: "blocked" };
      if (r.rateState === "sample") return { ok: false, error: "Not filed: sample rates are made up and never filed.", code: "blocked" };
      if (r.rateState !== "final" && !opts.confirmProvisional) return { ok: false, error: `${r.rateFinal} of ${r.rateCount} rates are final. Confirm you are filing on provisional rates.`, code: "confirm_provisional" };
      if (r.tax == null || r.surcharge == null || r.total == null || r.lines.some((l) => l.total == null || l.taxableGallons == null || l.netGallons == null || l.rate == null || l.surchargeRate == null || l.tax == null || l.surcharge == null)) {
        return { ok: false, error: "Not filed: the return is not fully worked out.", code: "blocked" };
      }
      const prev = await tx.iftaReturn.findFirst({ where: { workspaceId, quarter, status: "reopened" }, orderBy: { reopenedAt: "desc" }, select: { id: true } });
      const made = await tx.iftaReturn.create({
        data: {
          workspaceId,
          quarter,
          status: "filed",
          filedAt: now,
          filedBy: by,
          dueDate: r.dueDate,
          rateState: r.rateState,
          provisionalConfirmed: r.rateState !== "final",
          miles: new Prisma.Decimal(r.miles),
          gallons: new Prisma.Decimal(r.gallons),
          taxPaidGallons: new Prisma.Decimal(r.taxPaidGallons),
          bulkGallons: new Prisma.Decimal(r.bulkGallons),
          mpg: r.mpg != null ? new Prisma.Decimal(r.mpg) : null,
          tax: new Prisma.Decimal(r.tax),
          surcharge: new Prisma.Decimal(r.surcharge),
          total: new Prisma.Decimal(r.total),
          trucks: r.trucks.length,
          amendsId: prev?.id ?? null,
          lines: {
            create: r.lines.map((l) => ({
              jurisdiction: l.jurisdiction,
              miles: new Prisma.Decimal(l.miles),
              taxableGallons: new Prisma.Decimal(l.taxableGallons!),
              taxPaidGallons: new Prisma.Decimal(l.taxPaidGallons),
              netGallons: new Prisma.Decimal(l.netGallons!),
              rate: new Prisma.Decimal(l.rate!),
              surchargeRate: new Prisma.Decimal(l.surchargeRate!),
              tax: new Prisma.Decimal(l.tax!),
              surcharge: new Prisma.Decimal(l.surcharge!),
              total: new Prisma.Decimal(l.total!)
            }))
          }
        },
        select: { id: true }
      });
      const amended = prev != null;
      await recordAudit(
        {
          entity: "fleet",
          entityId: made.id,
          action: amended ? "ifta_return_amended" : "ifta_return_filed",
          summary: `${quarter} IFTA return ${amended ? "filed again (amended)" : "marked filed"}: ${returnMoney(r.total)} ${r.total.startsWith("-") ? "credit" : "due"} over ${r.lines.length} ${r.lines.length === 1 ? "jurisdiction" : "jurisdictions"}${r.rateState !== "final" ? `, on ${r.rateState === "mixed" ? "partly final" : "provisional"} rates (confirmed)` : ""}`,
          before: null,
          after: { Quarter: quarter, Total: r.total, Tax: r.tax, Surcharge: r.surcharge, Miles: r.miles, "Road diesel gallons": r.gallons, "Fleet MPG": r.mpg ?? "", Rates: r.rateState, Jurisdictions: String(r.lines.length), Due: r.dueDate },
          at: now,
          workspaceId
        },
        tx
      );
      return { ok: true, id: made.id, total: r.total, amended };
    },
    { timeout: 60_000 }
  );
}

export type ReopenResult = { ok: true } | { ok: false; error: string };
export const REOPEN_REASON_MIN = 5;
export const REOPEN_REASON_MAX = 500;

/** Reopen a filed quarter for a real correction: the filed return stays (marked reopened, with who, when and why) and the quarter is free to change and to be filed again as an amendment. */
export async function reopenIftaReturn(quarter: string, reason: string, now = new Date(), workspaceId = currentWorkspaceId()): Promise<ReopenResult> {
  if (!isIftaQuarter(quarter)) return { ok: false, error: BAD_QUARTER };
  const why = (typeof reason === "string" ? reason : "").trim().replace(/\s+/g, " ");
  if (why.length < REOPEN_REASON_MIN) return { ok: false, error: "Say why the filed return needs a correction (a few words)." };
  if (why.length > REOPEN_REASON_MAX) return { ok: false, error: `Keep the reason under ${REOPEN_REASON_MAX} characters.` };
  const by = currentActor();
  return prisma.$transaction(async (tx): Promise<ReopenResult> => {
    await lockWorkspace(tx, workspaceId);
    const filed = await tx.iftaReturn.findFirst({ where: { workspaceId, quarter, status: "filed" }, select: { id: true, total: true, filedAt: true } });
    if (!filed) return { ok: false, error: `${quarter} has no filed return to reopen.` };
    await tx.iftaReturn.update({ where: { id: filed.id }, data: { status: "reopened", reopenedAt: now, reopenedBy: by, reopenReason: why } });
    await recordAudit(
      {
        entity: "fleet",
        entityId: filed.id,
        action: "ifta_return_reopened",
        summary: `${quarter} IFTA return reopened for a correction (it was filed ${filed.filedAt.toISOString().slice(0, 10)} at ${returnMoney(filed.total.toFixed(2))})`,
        reason: why,
        before: { Status: "Filed", Total: filed.total.toFixed(2) },
        after: { Status: "Reopened", Why: why },
        at: now,
        workspaceId
      },
      tx
    );
    return { ok: true };
  });
}

export type FiledReturn = FiledSnapshot & { id: string; quarter: string; filedAt: Date; filedBy: string; dueDate: string; rateState: string; provisionalConfirmed: boolean; trucks: number; amends: boolean };
export type FilingHistory = Array<{ id: string; status: string; filedAt: Date; filedBy: string; total: string; reopenedAt: Date | null; reopenedBy: string | null; reopenReason: string | null }>;

/** The quarter's filed return (null when none holds it) and every filing of it, newest first. */
export async function iftaFiling(quarter: string, workspaceId = currentWorkspaceId()): Promise<{ filed: FiledReturn | null; history: FilingHistory }> {
  if (!isIftaQuarter(quarter)) return { filed: null, history: [] };
  const rows = await prisma.iftaReturn.findMany({ where: { workspaceId, quarter }, orderBy: [{ filedAt: "desc" }, { createdAt: "desc" }], include: { lines: { orderBy: { jurisdiction: "asc" } } } });
  const f = rows.find((r) => r.status === "filed") ?? null;
  return {
    filed: f
      ? {
          id: f.id,
          quarter: f.quarter,
          filedAt: f.filedAt,
          filedBy: f.filedBy,
          dueDate: f.dueDate,
          rateState: f.rateState,
          provisionalConfirmed: f.provisionalConfirmed,
          trucks: f.trucks,
          amends: f.amendsId != null,
          miles: f.miles.toFixed(1),
          gallons: f.gallons.toFixed(3),
          taxPaidGallons: f.taxPaidGallons.toFixed(3),
          bulkGallons: f.bulkGallons.toFixed(3),
          mpg: f.mpg?.toFixed(2) ?? null,
          tax: f.tax.toFixed(2),
          surcharge: f.surcharge.toFixed(2),
          total: f.total.toFixed(2),
          lines: f.lines.map((l) => ({
            jurisdiction: l.jurisdiction,
            miles: l.miles.toFixed(1),
            taxableGallons: l.taxableGallons.toFixed(0),
            taxPaidGallons: l.taxPaidGallons.toFixed(0),
            netGallons: l.netGallons.toFixed(0),
            rate: l.rate.toFixed(4),
            surchargeRate: l.surchargeRate.toFixed(4),
            tax: l.tax.toFixed(2),
            surcharge: l.surcharge.toFixed(2),
            total: l.total.toFixed(2)
          }))
        }
      : null,
    history: rows.map((r) => ({ id: r.id, status: r.status, filedAt: r.filedAt, filedBy: r.filedBy, total: r.total.toFixed(2), reopenedAt: r.reopenedAt, reopenedBy: r.reopenedBy, reopenReason: r.reopenReason }))
  };
}
