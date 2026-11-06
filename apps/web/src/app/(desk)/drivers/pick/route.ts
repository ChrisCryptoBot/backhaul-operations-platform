import { terminalFilter } from "@/lib/scope";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { driverBlocker } from "@/lib/clearance";
import { driverClashNotes } from "@/server/tl/dispatch";
import { checkLoad, dateKeyOf, flagWords } from "@/lib/shifts";
import { loadSchedules } from "@/server/tl/shifts";
import { workspaceTimezone } from "@/server/tl/zone";
import { numOrNull } from "@/server/tl/convert";
import { currentTerminal } from "@/server/tl/terminal";
import { currentAllowed } from "@/server/tl/scope";
import { currentWorkspaceId } from "@/server/tl/workspace";
import { guardRoute } from "@/server/tl/access";

export const dynamic = "force-dynamic";

/**
 * Drivers for a type-ahead box on a load: GET /drivers/pick?q=an&load=<id>. A fleet has too many drivers for a list, so the load page and the Assign window show the
 * best few and search the rest here. With nothing typed the box offers the header's terminal; once the dispatcher types, the search reaches every terminal.
 * `inactive=1` also offers drivers who are out of service (for pay still owed them). Each driver comes back with what stops them (a lapsed card, another load at the same time) and their usual pay, the shape the Assign form already takes.
 */
export async function GET(request: Request) {
  const denied = await guardRoute("read");
  if (denied) return denied;
  const params = new URL(request.url).searchParams;
  const q = (params.get("q") ?? "").trim().slice(0, 60);
  const loadId = params.get("load");
  const inactive = params.get("inactive") === "1";
  // A typed search reaches every terminal the person may see (all of them when they are not limited), never past their limit.
  const terminal = q ? await currentAllowed() : await currentTerminal();
  const drivers = await prisma.driver.findMany({
    where: { workspaceId: currentWorkspaceId(), ...(inactive ? {} : { active: true }), ...(terminal != null ? { terminal: terminalFilter(terminal) } : {}), ...(q ? { OR: [{ name: { contains: q, mode: "insensitive" as const } }, { code: { contains: q, mode: "insensitive" as const } }] } : {}) },
    select: { id: true, name: true, code: true, terminal: true, cdlExpiry: true, medicalCardExpiry: true, defaultPayKind: true, defaultPayRate: true },
    orderBy: { name: "asc" },
    take: 12
  });
  const load = loadId ? await prisma.load.findFirst({ where: { id: loadId, workspaceId: currentWorkspaceId(), deletedAt: null }, select: { id: true, stops: true } }) : null;
  const busyBy = load ? await driverClashNotes(drivers.map((d) => d.id), load.id, load.stops) : new Map<string, string>();
  // A caution beside the clash note: does a stop of this load fall outside the driver's shift (the carrier's clock). Never a blocker.
  const tz = await workspaceTimezone(currentWorkspaceId());
  const stopTimes = load ? load.stops.map((s) => ({ role: s.stopRole ?? s.stopType, earliest: s.timeWindowEarliest, latest: s.timeWindowLatest })) : [];
  const times = stopTimes.map((s) => (s.earliest ?? s.latest)?.getTime()).filter((t): t is number => t != null);
  const schedules = times.length > 0 ? await loadSchedules(currentWorkspaceId(), drivers.map((d) => d.id), dateKeyOf(Math.min(...times), tz), dateKeyOf(Math.max(...times), tz)) : new Map();
  const shiftNote = (id: string) => {
    const f = checkLoad(schedules.get(id) ?? null, stopTimes, tz);
    return f ? flagWords(f, tz) : null;
  };
  return NextResponse.json(
    {
      drivers: drivers.map((d) => ({ id: d.id, name: d.name, code: d.code, home: d.terminal, terminal: d.terminal, blocker: driverBlocker(d), busy: busyBy.get(d.id) ?? null, shiftNote: shiftNote(d.id), payKind: d.defaultPayKind, payRate: numOrNull(d.defaultPayRate) }))
    },
    { headers: { "Cache-Control": "private, no-store" } }
  );
}
