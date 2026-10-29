import { prisma } from "@/lib/db";
import { DEMO_WORKSPACE_ID } from "@/server/tl/workspace";
import { num } from "@/server/tl/convert";
import { measureQuote, type Measured, type MeasureInput } from "./measure";
import { saveTruckHomeCoordinates } from "./persist";

const select = { id: true, homeBaseAddress: true, homeBaseLat: true, homeBaseLng: true } as const;

/**
 * Measure a route with the base of every truck that has one, so each truck gets its own empty miles. A base is measured from its stored point;
 * a truck that has an address but no point yet (it was saved before points were kept, or with no map key) is found once here and kept, so the
 * next measure does not look it up again. A screen that only wants the road miles (a rate confirmation's review) skips the trucks entirely.
 */
export async function measureForDesk(stops: MeasureInput["stops"], workspaceId = DEMO_WORKSPACE_ID, opts: { homes?: boolean } = {}): Promise<Measured> {
  if (opts.homes === false) return measureQuote({ stops, homes: [] });
  const where = { workspaceId, archivedAt: null, homeBaseAddress: { not: null } };
  let trucks = await prisma.vehicle.findMany({ where, select });
  const missing = trucks.filter((t) => (t.homeBaseAddress ?? "").trim() !== "" && (t.homeBaseLat == null || t.homeBaseLng == null));
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
