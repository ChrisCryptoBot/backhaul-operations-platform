import { notQuote } from "@/lib/quote-status";
import { prisma } from "@/lib/db";
import { DEMO_WORKSPACE_ID } from "./workspace";

/**
 * The header search: loads, drivers, brokers and cities that match what was typed.
 * A driver, broker or city opens the Loads screen filtered to it (/loads?q=...), a load opens the load.
 */
export type SearchHit = { kind: "load" | "driver" | "broker" | "city"; label: string; sub: string; href: string };

const filterHref = (text: string) => `/loads?q=${encodeURIComponent(text)}`;

export async function searchDesk(raw: string, workspaceId = DEMO_WORKSPACE_ID): Promise<SearchHit[]> {
  const q = raw.trim();
  if (q.length < 2) return [];
  const has = (field: string) => ({ [field]: { contains: q, mode: "insensitive" as const } });

  const [loads, drivers, brokers, lanes] = await Promise.all([
    prisma.load.findMany({
      where: { workspaceId, deletedAt: null, ...notQuote, OR: [has("loadNumber"), has("poNumber"), has("brokerName"), has("originAddress"), has("destinationAddress")] },
      orderBy: [{ scheduledDate: "desc" }, { createdAt: "desc" }],
      take: 6
    }),
    prisma.driver.findMany({ where: { workspaceId, OR: [has("name"), has("phone")] }, orderBy: { name: "asc" }, take: 4 }),
    prisma.load.groupBy({ by: ["brokerName"], where: { workspaceId, deletedAt: null, ...notQuote, ...has("brokerName") }, _count: { _all: true }, orderBy: { brokerName: "asc" }, take: 4 }),
    prisma.load.findMany({ where: { workspaceId, deletedAt: null, ...notQuote, OR: [has("originAddress"), has("destinationAddress")] }, select: { originAddress: true, destinationAddress: true }, take: 300 })
  ]);

  const needle = q.toLowerCase();
  const cities = [...new Set(lanes.flatMap((l) => [l.originAddress, l.destinationAddress]).filter((c): c is string => !!c && c.toLowerCase().includes(needle)))].sort().slice(0, 4);

  return [
    ...loads.map((l): SearchHit => ({ kind: "load", label: l.loadNumber ?? "Load", sub: `${l.originAddress ?? "?"} → ${l.destinationAddress ?? "?"} · ${l.brokerName ?? "no customer"}`, href: `/loads/${l.id}` })),
    ...drivers.map((d): SearchHit => ({ kind: "driver", label: d.name, sub: "Their loads", href: filterHref(d.name) })),
    ...brokers.filter((b) => b.brokerName).map((b): SearchHit => ({ kind: "broker", label: b.brokerName!, sub: `${b._count._all} ${b._count._all === 1 ? "load" : "loads"}`, href: filterHref(b.brokerName!) })),
    ...cities.map((c): SearchHit => ({ kind: "city", label: c, sub: "Loads to or from here", href: filterHref(c) }))
  ];
}
