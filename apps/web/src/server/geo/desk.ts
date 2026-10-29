import { prisma } from "@/lib/db";
import { DEMO_WORKSPACE_ID } from "@/server/tl/workspace";
import { measureQuote, type Measured, type MeasureInput } from "./measure";

/** Measure a route with the base of every truck that has one, so each truck gets its own empty miles. */
export async function measureForDesk(stops: MeasureInput["stops"], workspaceId = DEMO_WORKSPACE_ID): Promise<Measured> {
  const trucks = await prisma.vehicle.findMany({ where: { workspaceId, archivedAt: null, homeBaseAddress: { not: null } }, select: { id: true, homeBaseAddress: true } });
  return measureQuote({ stops, homes: trucks.map((t) => ({ id: t.id, address: t.homeBaseAddress ?? "" })) });
}
