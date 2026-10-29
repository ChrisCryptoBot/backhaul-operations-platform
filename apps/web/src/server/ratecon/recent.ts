import { prisma } from "@/lib/db";
import { currentWorkspace } from "@/server/tl/workspace";
import { num } from "@/server/tl/convert";

/** One load that was made from a rate confirmation, newest read first. */
export type RecentRateCon = {
  id: string;
  loadNumber: string | null;
  broker: string | null;
  from: string | null;
  to: string | null;
  stops: number;
  rate: number;
  loadedMiles: number;
  /** Agreed rate over the printed miles; null when no miles were printed. */
  perMile: number | null;
  status: string;
  /** Whether a driver is on it. A draft with none is "needs a driver". */
  hasDriver: boolean;
  pickup: Date | null;
  readAt: Date;
};

/** The loads the "Read so far" table lists: each one has a `rate_con_saved` audit event, which says when it was read. */
export async function listRecentRateCons(limit = 8): Promise<{ rows: RecentRateCon[]; total: number }> {
  const ws = await currentWorkspace();
  const where = { workspaceId: ws.id, action: "rate_con_saved", loadId: { not: null } };
  const [events, total] = await Promise.all([
    prisma.auditEvent.findMany({ where, orderBy: { createdAt: "desc" }, take: limit }),
    prisma.auditEvent.count({ where })
  ]);
  const ids = events.map((e) => e.loadId!).filter(Boolean);
  const loads = await prisma.load.findMany({ where: { id: { in: ids } }, include: { assignment: { select: { id: true } } } });
  const byId = new Map(loads.map((l) => [l.id, l]));
  const rows: RecentRateCon[] = [];
  for (const e of events) {
    const l = byId.get(e.loadId!);
    if (!l) continue; // the load was deleted since
    const rate = num(l.quotedRevenue);
    const loadedMiles = num(l.loadedMiles);
    rows.push({
      id: l.id,
      loadNumber: l.loadNumber,
      broker: l.brokerName,
      from: l.originAddress,
      to: l.destinationAddress,
      stops: l.stopsCount ?? 0,
      rate,
      loadedMiles,
      perMile: loadedMiles > 0 ? rate / loadedMiles : null,
      status: l.status,
      hasDriver: l.assignment != null,
      pickup: l.scheduledDate,
      readAt: e.createdAt
    });
  }
  return { rows, total };
}
