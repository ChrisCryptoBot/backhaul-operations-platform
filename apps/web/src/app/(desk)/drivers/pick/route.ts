import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { driverBlocker } from "@/lib/clearance";
import { driverClashNotes } from "@/server/tl/dispatch";
import { numOrNull } from "@/server/tl/convert";
import { currentTerminal } from "@/server/tl/terminal";
import { currentWorkspaceId } from "@/server/tl/workspace";

export const dynamic = "force-dynamic";

/**
 * Drivers for a type-ahead box on a load: GET /drivers/pick?q=an&load=<id>. A fleet has too many drivers for a list, so the load page and the Assign window show the
 * best few and search the rest here. With nothing typed the box offers the header's terminal; once the dispatcher types, the search reaches every terminal.
 * `inactive=1` also offers drivers who are out of service (for pay still owed them). Each driver comes back with what stops them (a lapsed card, another load at the same time) and their usual pay, the shape the Assign form already takes.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const q = (params.get("q") ?? "").trim().slice(0, 60);
  const loadId = params.get("load");
  const inactive = params.get("inactive") === "1";
  const terminal = q ? null : await currentTerminal();
  const drivers = await prisma.driver.findMany({
    where: { workspaceId: currentWorkspaceId(), ...(inactive ? {} : { active: true }), ...(terminal ? { terminal } : {}), ...(q ? { name: { contains: q, mode: "insensitive" as const } } : {}) },
    select: { id: true, name: true, terminal: true, cdlExpiry: true, medicalCardExpiry: true, defaultPayKind: true, defaultPayRate: true },
    orderBy: { name: "asc" },
    take: 12
  });
  const load = loadId ? await prisma.load.findFirst({ where: { id: loadId, workspaceId: currentWorkspaceId(), deletedAt: null }, select: { id: true, stops: true } }) : null;
  const busyBy = load ? await driverClashNotes(drivers.map((d) => d.id), load.id, load.stops) : new Map<string, string>();
  return NextResponse.json(
    {
      drivers: drivers.map((d) => ({ id: d.id, name: d.name, terminal: d.terminal, blocker: driverBlocker(d), busy: busyBy.get(d.id) ?? null, payKind: d.defaultPayKind, payRate: numOrNull(d.defaultPayRate) }))
    },
    { headers: { "Cache-Control": "private, no-store" } }
  );
}
