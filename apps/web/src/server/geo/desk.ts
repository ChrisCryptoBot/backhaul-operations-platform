import { prisma } from "@/lib/db";
import { currentWorkspaceId } from "@/server/tl/workspace";
import { num } from "@/server/tl/convert";
import { measureQuote, type Measured, type MeasureInput } from "./measure";
import { saveTruckHomeCoordinates } from "./persist";

const select = { id: true, homeBaseAddress: true, homeBaseLat: true, homeBaseLng: true } as const;

/**
 * Measure a route with the base of every truck that has one, so each truck gets its own empty miles. A base is measured from its stored point;
 * a truck that has an address but no point yet (it was saved before points were kept, or with no map key) is found once here and kept, so the
 * next measure does not look it up again. A screen that only wants the road miles (a rate confirmation's review) skips the trucks entirely.
 */
export async function measureForDesk(stops: MeasureInput["stops"], workspaceId = currentWorkspaceId(), opts: { homes?: boolean; terminal?: string | null } = {}): Promise<Measured> {
  if (opts.homes === false) return measureQuote({ stops, homes: [] });
  const where = { workspaceId, archivedAt: null, homeBaseAddress: { not: null }, ...(opts.terminal ? { terminal: opts.terminal } : {}) };
  let trucks = await prisma.vehicle.findMany({ where, select });
  // A few unlocated bases are found (and kept) each time, so a fleet whose points were never stored fills in over its next quotes without a burst of map requests.
  const missing = trucks.filter((t) => (t.homeBaseAddress ?? "").trim() !== "" && (t.homeBaseLat == null || t.homeBaseLng == null)).slice(0, 8);
  if (missing.length > 0) {
    const found = await Promise.all(missing.map((t) => saveTruckHomeCoordinates(t.id)));
    if (found.some(Boolean)) trucks = await prisma.vehicle.findMany({ where, select });
  }
  return measureQuote({
    stops,
    homes: trucks.map((t) => {
      const address = t.homeBaseAddress ?? "";
      const point = t.homeBaseLat != null && t.homeBaseLng != null ? { label: address, lat: num(t.homeBaseLat), lng: num(t.homeBaseLng) } : null;
      return { id: t.id, address, point };
    })
  });
}
