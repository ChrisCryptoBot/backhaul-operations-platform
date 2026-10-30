import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { alertThresholds } from "@/lib/thresholds";
import { trailerFit } from "@/lib/trailer-fit";
import { numOrNull } from "@/server/tl/convert";
import { currentTerminal } from "@/server/tl/terminal";
import { getThresholds } from "@/server/tl/thresholds";
import { currentWorkspaceId } from "@/server/tl/workspace";

export const dynamic = "force-dynamic";

/**
 * Trailers for a type-ahead box: GET /trailers/pick?q=T-20&load=<id>. A fleet has thousands, so the box asks as you type: trailers in service and available, a dozen at most,
 * by number, plate or VIN. With a load named, the ones of the kind it needs come first and each carries what would stop it going on that load (the kind, the weight, a lapsed
 * date) and what to know about it. With nothing typed the box offers the header's terminal; a typed search reaches every terminal.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const q = (params.get("q") ?? "").trim().slice(0, 60);
  const loadId = params.get("load");
  const workspaceId = currentWorkspaceId();
  const terminal = q ? null : await currentTerminal();
  const load = loadId ? await prisma.load.findFirst({ where: { id: loadId, workspaceId, deletedAt: null }, select: { trailerType: true, weightLbs: true, lengthFt: true, vehicleId: true } }) : null;
  const wanted = load?.trailerType && !load.trailerType.startsWith("other:") ? load.trailerType : null;
  const trailers = await prisma.trailer.findMany({
    where: {
      workspaceId,
      archivedAt: null,
      status: "available",
      ...(terminal ? { terminal } : {}),
      ...(q ? { OR: [{ number: { contains: q, mode: "insensitive" as const } }, { plate: { contains: q, mode: "insensitive" as const } }, { vin: { contains: q, mode: "insensitive" as const } }] } : {})
    },
    include: { loads: { where: { deletedAt: null, status: { in: ["draft", "accepted", "in_progress"] } }, select: { loadNumber: true }, take: 1 } },
    orderBy: [{ number: "asc" }],
    take: 40
  });
  const now = new Date();
  const soon = alertThresholds(await getThresholds(workspaceId)).clearanceDays;
  const out = trailers.map((t) => {
    const fit = load
      ? trailerFit(
          { trailerType: load.trailerType, weightLbs: load.weightLbs, lengthFt: numOrNull(load.lengthFt), vehicleId: load.vehicleId },
          { number: t.number, type: t.type, maxPayloadLbs: t.maxPayloadLbs, lengthFt: numOrNull(t.lengthFt), currentVehicleId: t.currentVehicleId, status: t.status, registrationExpiry: t.registrationExpiry, inspectionExpiry: t.inspectionExpiry },
          now,
          soon
        )
      : { blocker: null, warnings: [] };
    return { id: t.id, number: t.number, type: t.type, terminal: t.terminal, onLoad: t.loads[0]?.loadNumber ?? null, blocker: fit.blocker, warnings: fit.warnings };
  });
  // Ones that fit and are of the kind first, then the rest, each by number.
  out.sort((a, b) => Number(a.blocker != null) - Number(b.blocker != null) || Number(wanted != null && b.type === wanted) - Number(wanted != null && a.type === wanted) || a.number.localeCompare(b.number, "en", { numeric: true }));
  return NextResponse.json({ trailers: out.slice(0, 12) }, { headers: { "Cache-Control": "private, no-store" } });
}
