import { prisma } from "@/lib/db";
import { OVERAGE_CEILING_DEFAULT_CENTS, RATE_CON_FAILED_READS_PER_DAY, burstReadsPerDay, hardMonthlyReads, includedReads, overageCents } from "@/lib/plans";
import { windowStarts } from "@/lib/spend";
import { claimUsage, type UsageClaim } from "@/server/tl/usage";
import { trucksInService } from "@/server/tl/plan";
import { recordAudit } from "@/server/tl/audit";
import { currentWorkspaceId } from "@/server/tl/workspace";

/**
 * The meter on rate confirmation reads. A read sends a file to a paid reading service. A desk includes so many reads a truck a month (pooled), may go past that up to its overage ceiling
 * (billed on its own line at the month's end), and has a daily burst limit and a daily limit on failures (lib/plans.ts holds the numbers). It counts what the desk wrote down: each live
 * read (a sample's own name reads without the service and is not counted) leaves one audit event, "read" or "could not be read", and the day is the last 24 hours. A read that could not be
 * read is never counted toward the allowance or billed; it only counts against the daily failure limit.
 */
const DAY_MS = 86_400_000;

export type Meter = { ok: true } | { ok: false; reason: "daily_limit" | "month_limit" };

export async function readMeter(now = new Date(), workspaceId = currentWorkspaceId()): Promise<Meter> {
  const since = new Date(now.getTime() - DAY_MS);
  const { month } = windowStarts(now);
  const trucks = await trucksInService(workspaceId);
  const [read, failed, readMonth] = await Promise.all([
    prisma.auditEvent.count({ where: { workspaceId, action: "rate_con_read", createdAt: { gte: since } } }),
    prisma.auditEvent.count({ where: { workspaceId, action: "rate_con_read_failed", createdAt: { gte: since } } }),
    prisma.auditEvent.count({ where: { workspaceId, action: "rate_con_read", createdAt: { gte: month } } })
  ]);
  if (readMonth >= hardMonthlyReads(trucks)) return { ok: false, reason: "month_limit" };
  return read + failed >= burstReadsPerDay(trucks) || failed >= RATE_CON_FAILED_READS_PER_DAY ? { ok: false, reason: "daily_limit" } : { ok: true };
}

/**
 * The claim on paid spend, made BEFORE the read (the audit-event count above is written after the call, so a parallel burst all passed it): this desk's daily burst limit, its month's
 * hard limit (the allowance plus what its overage ceiling pays for) and everyone's ceiling, in one step (server/tl/usage.ts). A refusal costs nothing. `busy` is the shared ceiling or the
 * kill switch; `daily_limit` and `month_limit` are this desk's own.
 */
export async function claimRead(now = new Date(), workspaceId = currentWorkspaceId()): Promise<{ ok: true; claim: UsageClaim } | { ok: false; reason: "daily_limit" | "month_limit" | "busy" }> {
  const trucks = await trucksInService(workspaceId);
  const claim = await claimUsage("anthropic_desk", { workspaceId, now, limits: { workspaceDay: burstReadsPerDay(trucks), workspaceMonth: hardMonthlyReads(trucks) } });
  if (claim.ok) return { ok: true, claim };
  if (claim.reason === "workspace_day") return { ok: false, reason: "daily_limit" };
  if (claim.reason === "workspace_month") return { ok: false, reason: "month_limit" };
  return { ok: false, reason: "busy" };
}

/** Write down that a live read happened, and whether it worked. */
export async function noteRead(worked: boolean, fileName: string, now = new Date(), workspaceId = currentWorkspaceId()): Promise<void> {
  await recordAudit({ entity: "intake", action: worked ? "rate_con_read" : "rate_con_read_failed", summary: `${fileName.slice(0, 80)} ${worked ? "read" : "could not be read"}`, at: now, workspaceId });
}

/**
 * The month's reads for one desk, for the separate usage line (invoiced by hand until desk billing is on): what is included, what worked, what went over and what that comes to in cents, and
 * whether the overage ceiling has been reached. Reads that failed are not in it.
 */
export async function readUsageSummary(now = new Date(), workspaceId = currentWorkspaceId(), ceilingCents = OVERAGE_CEILING_DEFAULT_CENTS) {
  const { month } = windowStarts(now);
  const [trucks, worked] = await Promise.all([trucksInService(workspaceId), prisma.auditEvent.count({ where: { workspaceId, action: "rate_con_read", createdAt: { gte: month } } })]);
  const included = includedReads(trucks);
  const overCents = overageCents(worked, trucks);
  return { trucks, included, worked, over: Math.max(0, worked - included), overageCents: overCents, ceilingCents, atCeiling: worked >= hardMonthlyReads(trucks, ceilingCents) };
}
