import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { currentTerminal } from "@/server/tl/terminal";
import { currentWorkspaceId } from "@/server/tl/workspace";

export const dynamic = "force-dynamic";

/**
 * Trucks for a type-ahead box: GET /fleet/pick?q=un. A fleet has too many trucks to put in a list, so a box that picks one asks as you type.
 * Only trucks in service, a dozen at most, by name. With nothing typed the box offers the header's terminal; once the dispatcher types, the search reaches every terminal.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const q = (params.get("q") ?? "").trim().slice(0, 60);
  const ready = params.get("ready") === "1";
  const terminal = q ? null : await currentTerminal();
  const trucks = await prisma.vehicle.findMany({
    where: { workspaceId: currentWorkspaceId(), archivedAt: null, ...(terminal ? { terminal } : {}), ...(ready ? { costProfile: { isNot: null } } : {}), ...(q ? { name: { contains: q, mode: "insensitive" as const } } : {}) },
    select: { id: true, name: true, terminal: true },
    orderBy: { name: "asc" },
    take: 12
  });
  return NextResponse.json({ trucks: trucks.map((t) => ({ id: t.id, name: t.name ?? "Unnamed truck", terminal: t.terminal })) }, { headers: { "Cache-Control": "private, no-store" } });
}
