import { prisma } from "@/lib/db";
import { cityState } from "@/lib/city-state";
import type { Terminals } from "@/lib/scope";
import { hhmm } from "@/lib/shifts";
import { zoneAbbr } from "@/lib/tz";
import { centralParts } from "@/lib/zoned";
import { numOrNull } from "./convert";
import { inTerminal } from "./terminal-sql";
import { workspaceTimezone } from "./zone";

/**
 * The radar's open freight: every load that needs a driver, pinned at its pickup, so a dispatcher sees uncovered freight beside the empty and parked trucks. "Needs a driver" is the header's own
 * rule and scope (src/server/tl/shell.ts): a draft load with no assignment, or one still a draft or declined; in the terminals in view, or not placed anywhere yet. A load whose pickup has no map point
 * is counted, not pinned. Read only.
 */
export type OpenLoadPin = { id: string; number: string; lat: number; lng: number; lane: string; rate: string | null; rpm: string | null; pickupDue: string | null; equipment: string | null };
export type RadarOpenLoads = { mode: "open_loads"; pins: OpenLoadPin[]; unplaced: number };

const LIMIT = 500;
const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

export async function radarOpenLoads(workspaceId: string, terminal: Terminals, now = new Date()): Promise<RadarOpenLoads> {
  const [loads, tz] = await Promise.all([
    prisma.load.findMany({
      where: { workspaceId, deletedAt: null, AND: [inTerminal(terminal)], status: "draft", OR: [{ assignment: null }, { assignment: { status: { in: ["draft", "declined"] } } }] },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: LIMIT,
      select: {
        id: true,
        loadNumber: true,
        originAddress: true,
        destinationAddress: true,
        quotedRevenue: true,
        loadedMiles: true,
        trailerType: true,
        stops: { orderBy: { stopSequence: "asc" }, select: { lat: true, lng: true, addressString: true, stopRole: true, stopType: true, timeWindowEarliest: true, timeWindowLatest: true } }
      }
    }),
    workspaceTimezone(workspaceId)
  ]);
  const when = (d: Date) => {
    const p = centralParts(d.getTime(), tz);
    const today = centralParts(now.getTime(), tz);
    const day = p.y === today.y && p.m0 === today.m0 && p.d === today.d ? "Today" : `${p.m0 + 1}/${p.d}`;
    return `${day} ${hhmm(d.getTime(), tz)} ${zoneAbbr(tz)}`;
  };
  const pins: OpenLoadPin[] = [];
  let unplaced = 0;
  for (const l of loads) {
    // Pinned at its pickup (the first pickup stop, else the first stop): a load whose pickup has no point is counted, never pinned at its delivery.
    const first = l.stops.find((s) => (s.stopRole ?? s.stopType) === "pickup") ?? l.stops[0];
    const lat = numOrNull(first?.lat);
    const lng = numOrNull(first?.lng);
    if (!first || lat == null || lng == null) {
      unplaced += 1;
      continue;
    }
    const last = l.stops[l.stops.length - 1];
    const from = cityState(l.originAddress ?? l.stops[0]?.addressString ?? null) ?? "?";
    const to = cityState(l.destinationAddress ?? last?.addressString ?? null) ?? "?";
    const rate = numOrNull(l.quotedRevenue) ?? 0;
    const miles = numOrNull(l.loadedMiles) ?? 0;
    const due = first.timeWindowLatest ?? first.timeWindowEarliest;
    pins.push({
      id: l.id,
      number: l.loadNumber ?? "Open load",
      lat,
      lng,
      lane: `${from} → ${to}`,
      rate: rate > 0 ? money(rate) : null,
      rpm: rate > 0 && miles > 0 ? `$${(rate / miles).toFixed(2)}/mi` : null,
      pickupDue: due ? when(due) : null,
      equipment: l.trailerType ?? null
    });
  }
  return { mode: "open_loads", pins, unplaced };
}
