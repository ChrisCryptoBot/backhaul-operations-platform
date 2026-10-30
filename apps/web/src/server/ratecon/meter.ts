import { prisma } from "@/lib/db";
import { RATE_CON_FAILED_READS_PER_DAY, rateConReadsPerDay } from "@/lib/plans";
import { claimUsage, type UsageClaim } from "@/server/tl/usage";
import { workspacePlan } from "@/server/tl/plan";
import { recordAudit } from "@/server/tl/audit";
import { currentWorkspaceId } from "@/server/tl/workspace";

/**
 * The daily meter on rate confirmation reads. A read sends a file to a paid reading service, so a workspace gets so many a day and so many failures a day, the same two numbers
 * the driver app's own meter uses. It counts what the desk wrote down: each live read (a sample's own name reads without the service and is not counted) leaves one audit
 * event, "read" or "could not be read", and the day is the last 24 hours.
 */
const DAY_MS = 86_400_000;

export type Meter = { ok: true } | { ok: false; reason: "daily_limit" };

export async function readMeter(now = new Date(), workspaceId = currentWorkspaceId()): Promise<Meter> {
  const since = new Date(now.getTime() - DAY_MS);
  const perDay = rateConReadsPerDay(await workspacePlan(workspaceId));
  const [read, failed] = await Promise.all([
    prisma.auditEvent.count({ where: { workspaceId, action: "rate_con_read", createdAt: { gte: since } } }),
    prisma.auditEvent.count({ where: { workspaceId, action: "rate_con_read_failed", createdAt: { gte: since } } })
  ]);
  return read + failed >= perDay || failed >= RATE_CON_FAILED_READS_PER_DAY ? { ok: false, reason: "daily_limit" } : { ok: true };
}

/**
 * The claim on paid spend, made BEFORE the read (the audit-event count above is written after the call, so a parallel burst all passed it): this desk's plan allowance for the day and
 * everyone's ceiling, in one step (server/tl/usage.ts). A refusal costs nothing. `busy` is the shared ceiling or the kill switch; `daily_limit` is this desk's own.
 */
export async function claimRead(now = new Date(), workspaceId = currentWorkspaceId()): Promise<{ ok: true; claim: UsageClaim } | { ok: false; reason: "daily_limit" | "busy" }> {
  const claim = await claimUsage("anthropic_desk", { workspaceId, now, limits: { workspaceDay: rateConReadsPerDay(await workspacePlan(workspaceId)) } });
  if (claim.ok) return { ok: true, claim };
  return { ok: false, reason: claim.reason === "workspace_day" || claim.reason === "workspace_month" ? "daily_limit" : "busy" };
}

/** Write down that a live read happened, and whether it worked. */
export async function noteRead(worked: boolean, fileName: string, now = new Date(), workspaceId = currentWorkspaceId()): Promise<void> {
  await recordAudit({ entity: "intake", action: worked ? "rate_con_read" : "rate_con_read_failed", summary: `${fileName.slice(0, 80)} ${worked ? "read" : "could not be read"}`, at: now, workspaceId });
}
