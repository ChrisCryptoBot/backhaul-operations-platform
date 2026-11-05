import { prisma } from "@/lib/db";
import type { PartnerResult } from "@/truelane/partners/contract";

/**
 * How a connection is doing, kept on its row (docs/PARTNER_BACKBONE.md). A call that reaches the company and is answered clears the failures and stamps "last synced"; one that fails
 * (`upstream_error`) adds a failure and keeps the code as the reason; after three in a row the connection is "error", which Settings shows with a Retry. Nothing a company wrote is kept:
 * a reason is one of our own codes. A call that never reached the company (not configured, not connected, not implemented) says nothing about the company's health and changes nothing.
 */
export const FAILURES_BEFORE_ERROR = 3;

/** Minutes to wait before the schedule asks again, by how many calls in a row have failed: 5, 15, 60, then six hours. */
export const retryMinutes = (failures: number): number => [5, 15, 60][failures - 1] ?? 360;

export async function recordHealth(workspaceId: string, capability: string, provider: string, result: PartnerResult, now = new Date()): Promise<void> {
  const where = { workspaceId_capability_provider: { workspaceId, capability, provider } };
  if (result.ok) {
    await prisma.partnerConnection.updateMany({ where: { workspaceId, capability, provider, status: { in: ["connected", "error"] } }, data: { status: "connected", failures: 0, lastError: null, lastSyncedAt: now } });
    return;
  }
  if (result.code !== "upstream_error") return;
  const row = await prisma.partnerConnection.findUnique({ where });
  if (!row || (row.status !== "connected" && row.status !== "error")) return;
  const failures = row.failures + 1;
  await prisma.partnerConnection.update({ where, data: { failures, lastError: result.code, status: failures >= FAILURES_BEFORE_ERROR ? "error" : row.status, nextSyncAt: new Date(now.getTime() + retryMinutes(failures) * 60_000) } });
}
