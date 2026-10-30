import { prisma } from "@/lib/db";
import { SPEND, decideClaim, switchedOff, windowStarts, type UsageLimits, type UsageRefusal, type UsageService } from "@/lib/spend";
import { currentWorkspaceId } from "./workspace";

/**
 * The desk's ledger of paid calls (the ServiceUsage table). `claimUsage` is asked BEFORE a paid call and answers in one step, one caller at a time per service (an advisory lock),
 * so a parallel burst cannot all pass the count before any row is written. A refusal costs nothing. `releaseUsage` gives a claim back when the call never happened.
 * Rows older than 70 days are removed as a side effect, so the table does not grow without bound.
 *
 * DESK_SPEND_METER=off turns the ledger off (unit tests, which have no database); DESK_SERVICES_OFF=mapbox_geocode,anthropic_desk (or "all") is the desk's kill switch.
 */
export type UsageClaim = { ok: true; id: string | null } | { ok: false; reason: UsageRefusal | "switched_off" };

export async function claimUsage(service: UsageService, opts: { units?: number; workspaceId?: string; now?: Date; limits?: UsageLimits } = {}): Promise<UsageClaim> {
  if (switchedOff(service, process.env.DESK_SERVICES_OFF)) return { ok: false, reason: "switched_off" };
  if (process.env.DESK_SPEND_METER === "off") return { ok: true, id: null };
  const units = Math.max(1, opts.units ?? 1);
  const now = opts.now ?? new Date();
  const workspaceId = opts.workspaceId ?? currentWorkspaceId();
  const cfg = SPEND[service];
  const limits: UsageLimits = { ...cfg.limits, ...opts.limits };
  const estCents = cfg.estCents * units;
  const { day, month } = windowStarts(now);
  try {
    return await prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`select pg_advisory_xact_lock(hashtextextended(${`usage:${service}`}, 0))::text as locked`;
        await tx.serviceUsage.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - 70 * 86_400_000) } } });
        const sum = (where: object) => tx.serviceUsage.aggregate({ _sum: { units: true, estCents: true }, where: { service, ...where } });
        const [wDay, wMonth, gDay, gMonth] = await Promise.all([
          sum({ workspaceId, createdAt: { gte: day } }),
          sum({ workspaceId, createdAt: { gte: month } }),
          sum({ createdAt: { gte: day } }),
          sum({ createdAt: { gte: month } })
        ]);
        const verdict = decideClaim(
          { workspaceDay: wDay._sum.units ?? 0, workspaceMonth: wMonth._sum.units ?? 0, globalDay: gDay._sum.units ?? 0, globalMonth: gMonth._sum.units ?? 0, globalMonthCents: gMonth._sum.estCents ?? 0 },
          limits,
          units,
          estCents
        );
        if (!verdict.ok) return verdict;
        const row = await tx.serviceUsage.create({ data: { workspaceId, service, units, estCents, createdAt: now }, select: { id: true } });
        return { ok: true as const, id: row.id };
      },
      { timeout: 5_000 }
    );
  } catch (e) {
    console.error("[usage] claim failed", service, e instanceof Error ? e.message.slice(0, 120) : "error");
    return { ok: false, reason: "error" };
  }
}

/** Give a claim back: the paid call did not happen. Never throws. */
export async function releaseUsage(claim: UsageClaim | null | undefined): Promise<void> {
  if (!claim || !claim.ok || !claim.id) return;
  try {
    await prisma.serviceUsage.deleteMany({ where: { id: claim.id } });
  } catch {
    /* a claim left in the ledger only makes the ceiling a little more careful */
  }
}
