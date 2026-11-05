import { prisma } from "@/lib/db";
import { syncEld } from "./eld";
import { vetDriverCarrier } from "./vetting";
import { POLLED } from "./sync-policy";

/**
 * The partner schedule (docs/PARTNER_BACKBONE.md): the connections that are read on a clock rather than told by a webhook. A connection whose time has come is run once; how each call went
 * is already recorded by the call itself (server/partners/health.ts: failures, the reason, "error" after three in a row, the next try backing off). This only sets the normal rhythm after
 * a call that was not a failure: ELD hours every 15 minutes, carrier checks once a day. One fleet or one company failing never stops the others, and a company that is not live yet
 * (its adapter answers "not implemented") is asked again at the normal rhythm, not hammered and not marked as failing.
 */
/** From the policy table (sync-policy.ts): only the polled kinds are run here; the rest are told by webhook or asked for by a person. */
export const SYNC_EVERY_MINUTES: Record<string, number> = POLLED;
const VET_BATCH = 25;

export type SyncResult = { ran: number; ok: number; waiting: number; failed: number };

export async function runPartnerSync(opts: { now?: Date; workspaceId?: string; limit?: number } = {}): Promise<SyncResult> {
  const now = opts.now ?? new Date();
  const due = await prisma.partnerConnection.findMany({
    where: { capability: { in: Object.keys(SYNC_EVERY_MINUTES) }, status: { in: ["connected", "error"] }, OR: [{ nextSyncAt: null }, { nextSyncAt: { lte: now } }], ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}) },
    orderBy: { nextSyncAt: "asc" },
    take: opts.limit ?? 100
  });
  const out: SyncResult = { ran: 0, ok: 0, waiting: 0, failed: 0 };
  for (const c of due) {
    out.ran += 1;
    let verdict: "ok" | "waiting" | "failed" = "waiting";
    try {
      if (c.capability === "eld") {
        const r = await syncEld(now, c.workspaceId);
        verdict = r.ok ? "ok" : r.code === "upstream_error" ? "failed" : "waiting";
      } else if (c.capability === "vetting") {
        const stale = new Date(now.getTime() - 24 * 3_600_000);
        const drivers = await prisma.driver.findMany({ where: { workspaceId: c.workspaceId, active: true, OR: [{ carrierMcNumber: { not: null } }, { carrierDotNumber: { not: null } }], AND: [{ OR: [{ vetCheckedAt: null }, { vetCheckedAt: { lt: stale } }] }] }, select: { id: true }, take: VET_BATCH });
        let sawFailure = false;
        let sawOk = false;
        for (const d of drivers) {
          const r = await vetDriverCarrier(d.id, now, c.workspaceId);
          if (r.ok) sawOk = true;
          else if (r.code === "upstream_error") sawFailure = true;
        }
        verdict = sawFailure ? "failed" : sawOk ? "ok" : "waiting";
      }
    } catch {
      verdict = "failed";
    }
    out[verdict === "ok" ? "ok" : verdict === "failed" ? "failed" : "waiting"] += 1;
    // A failure has already set its own, backed-off next try (health.ts); anything else goes on the normal rhythm.
    if (verdict !== "failed") await prisma.partnerConnection.update({ where: { id: c.id }, data: { nextSyncAt: new Date(now.getTime() + SYNC_EVERY_MINUTES[c.capability]! * 60_000) } });
  }
  return out;
}
