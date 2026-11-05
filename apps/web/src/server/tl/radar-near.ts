import { prisma } from "@/lib/db";
import { boundsAround, within, type LatLng } from "@/lib/radius";
import { lookupPlace } from "@/server/geo/place-lookup";
import { numOrNull } from "./convert";
import { currentWorkspaceId } from "./workspace";

/**
 * "What is within so many miles of this place", for the Trucks and Trailers lists: the ids of the units whose last position is inside the radius, with their distances. The database is asked for
 * the box around the centre first (an index-friendly range on the stored position), and only that handful is measured exactly. A unit with no position is never "near" anywhere.
 */
export type Near = { label: string; lat: number; lng: number; radius: number; source: "census" | "mapbox"; miles: Map<string, number> } | { error: string };

/** The place typed, turned into a point, and the ids of the trucks or trailers around it (the workspace's, and the chosen terminal's when one is). */
export async function unitsNear(kind: "trucks" | "trailers", text: string, radiusGiven: number | null, workspaceId = currentWorkspaceId(), terminal: string | null = null): Promise<Near> {
  const found = await lookupPlace(text);
  if (!found) return { error: `Could not find "${text}". Try a ZIP code, or a city and state such as Dallas, TX.` };
  const radius = radiusGiven ?? found.defaultRadius ?? 50;
  const b = boundsAround(found, radius);
  const range = { lastLat: { gte: b.minLat, lte: b.maxLat }, lastLng: { gte: b.minLng, lte: b.maxLng } };
  const rows =
    kind === "trucks"
      ? await prisma.vehicle.findMany({ where: { workspaceId, archivedAt: null, ...(terminal ? { terminal } : {}), ...range }, select: { id: true, lastLat: true, lastLng: true } })
      : await prisma.trailer.findMany({ where: { workspaceId, archivedAt: null, ...(terminal ? { terminal } : {}), ...range }, select: { id: true, lastLat: true, lastLng: true } });
  const points: Array<LatLng & { id: string }> = [];
  for (const r of rows) {
    const lat = numOrNull(r.lastLat);
    const lng = numOrNull(r.lastLng);
    if (lat != null && lng != null) points.push({ id: r.id, lat, lng });
  }
  const miles = new Map<string, number>();
  for (const w of within(points, found, radius)) miles.set(w.item.id, w.miles);
  return { label: found.label, lat: found.lat, lng: found.lng, radius, source: found.source, miles };
}
