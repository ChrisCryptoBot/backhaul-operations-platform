import { prisma } from "@/lib/db";
import { stopZoneOf } from "@/server/geo/stop-zone";
import { workspaceTimezone } from "./zone";

/**
 * The clock at each stop of a load (src/lib/tz.ts: stop local time), in stop order. A time a person types for a stop (when the window opens, when the driver arrived) is the dock's time,
 * as the rate confirmation prints it, so the server reads it on this zone and never on one the browser sent. A stop whose place cannot be told falls back to the workspace's own zone.
 */
export type StopClock = { id: string; zone: string; timed: boolean };

export async function stopClocksOf(loadId: string, workspaceId: string): Promise<StopClock[]> {
  const [rows, carrier] = await Promise.all([
    prisma.stop.findMany({ where: { loadId, load: { workspaceId } }, orderBy: { stopSequence: "asc" }, select: { id: true, lat: true, lng: true, addressString: true, timeWindowEarliest: true, timeWindowLatest: true } }),
    workspaceTimezone(workspaceId)
  ]);
  return rows.map((r) => ({ id: r.id, zone: stopZoneOf(r, carrier), timed: r.timeWindowEarliest != null || r.timeWindowLatest != null }));
}

/** The clock at the first stop that has a time (the one a reschedule moves), else the first stop, else the carrier's. */
export const pickupClock = (clocks: StopClock[], carrier: string): string => (clocks.find((c) => c.timed) ?? clocks[0])?.zone ?? carrier;
