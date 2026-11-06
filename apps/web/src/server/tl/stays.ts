import type { Prisma } from "@prisma/client";
import { engineStateOf } from "@/lib/telematics";
import { stepStay, type OpenStay } from "@/lib/stays";
import { numOrNull } from "./convert";

/**
 * Keeps a tractor's stays as the ELD is read (the rules are in lib/stays.ts). One read of the open stays for the tractors in this sync, then at most one write each: open, extend, or close. Called inside
 * the ELD sync's own transaction, so a stay and the fix that made it are written together or not at all.
 */
export type StayFixInput = { workspaceId: string; vehicleId: string; lat: number; lng: number; speedMph: number | null; engine: string | null; at: Date };

export type StayWrites = { opened: number; extended: number; closed: number; dropped: number };

export async function applyStays(db: Prisma.TransactionClient, fixes: readonly StayFixInput[]): Promise<StayWrites> {
  const out: StayWrites = { opened: 0, extended: 0, closed: 0, dropped: 0 };
  if (fixes.length === 0) return out;
  const ids = [...new Set(fixes.map((f) => f.vehicleId))];
  const rows = await db.unitStay.findMany({ where: { vehicleId: { in: ids }, leftAt: null }, orderBy: { arrivedAt: "asc" } });
  // A tractor with more than one open stay (it should never happen) is read by the newest; the older ones are closed where they were last seen.
  const openOf = new Map<string, OpenStay>();
  for (const r of rows) {
    const older = openOf.get(r.vehicleId);
    if (older) await db.unitStay.update({ where: { id: older.id }, data: { leftAt: new Date(older.lastSeenAt) } });
    openOf.set(r.vehicleId, { id: r.id, lat: numOrNull(r.lat)!, lng: numOrNull(r.lng)!, arrivedAt: r.arrivedAt.getTime(), lastSeenAt: r.lastSeenAt.getTime() });
  }
  for (const f of [...fixes].sort((a, b) => a.at.getTime() - b.at.getTime())) {
    const step = stepStay(openOf.get(f.vehicleId) ?? null, { lat: f.lat, lng: f.lng, speedMph: f.speedMph, engine: engineStateOf(f.engine), at: f.at.getTime() });
    const start = async (p: { lat: number; lng: number; at: number }) => {
      const made = await db.unitStay.create({ data: { workspaceId: f.workspaceId, vehicleId: f.vehicleId, lat: p.lat, lng: p.lng, arrivedAt: new Date(p.at), lastSeenAt: new Date(p.at) } });
      openOf.set(f.vehicleId, { id: made.id, lat: p.lat, lng: p.lng, arrivedAt: p.at, lastSeenAt: p.at });
      out.opened += 1;
    };
    if (step.kind === "open") await start(step);
    else if (step.kind === "extend") {
      await db.unitStay.update({ where: { id: step.id }, data: { lastSeenAt: new Date(step.at) } });
      const cur = openOf.get(f.vehicleId)!;
      openOf.set(f.vehicleId, { ...cur, lastSeenAt: step.at });
      out.extended += 1;
    } else if (step.kind === "close") {
      openOf.delete(f.vehicleId);
      if (step.keep) {
        await db.unitStay.update({ where: { id: step.id }, data: { leftAt: new Date(step.leftAt) } });
        out.closed += 1;
      } else {
        await db.unitStay.delete({ where: { id: step.id } });
        out.dropped += 1;
      }
      if (step.next) await start(step.next);
    }
  }
  return out;
}
