import { prisma } from "@/lib/db";
import { CARRIER_ZONES, asZone, isCarrierZone } from "@/lib/tz";
import { recordAudit } from "./audit";
import { clearAgingCache } from "./aging";
import { currentWorkspaceId } from "./workspace";
import { forgetWorkspaceTimezone } from "./zone";

export type TimezoneResult = { ok: true; changed: boolean; zone: string } | { ok: false; error: string };

/**
 * Change the carrier's clock. It moves where a billing day ends, how an invoice ages, the weeks a statement covers and what "this month" means, so it is audited and the kept answers that
 * were counted on the old clock are dropped. It never moves a stored time: those are instants, and read on the new clock they are the same moments.
 */
export async function setWorkspaceTimezone(raw: unknown, now = new Date(), workspaceId = currentWorkspaceId()): Promise<TimezoneResult> {
  if (!isCarrierZone(raw)) return { ok: false, error: "Pick one of the time zones in the list." };
  const prev = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { timezone: true } });
  if (!prev) return { ok: false, error: "That fleet does not exist." };
  if (asZone(prev.timezone) === raw) return { ok: true, changed: false, zone: raw };
  const name = (id: string) => CARRIER_ZONES.find((z) => z.id === id)?.name ?? id;
  await prisma.$transaction(async (tx) => {
    await tx.workspace.update({ where: { id: workspaceId }, data: { timezone: raw } });
    await recordAudit({ entity: "settings", action: "timezone_changed", summary: `Time zone changed from ${name(asZone(prev.timezone))} to ${name(raw)}`, before: { "Time zone": name(asZone(prev.timezone)) }, after: { "Time zone": name(raw) }, at: now, workspaceId }, tx);
  });
  forgetWorkspaceTimezone(workspaceId);
  clearAgingCache();
  return { ok: true, changed: true, zone: raw };
}
