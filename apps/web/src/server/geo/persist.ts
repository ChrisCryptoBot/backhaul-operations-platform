import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { geocodePermanent } from "./mapbox";

/**
 * After a load is saved, give each of its stops that has an address and no coordinates its lat/lng, from Mapbox's permanent geocoding
 * (the only kind whose results may be stored). It runs after the save has committed and never throws: a stop that cannot be found, a
 * missing key or an outage simply leaves the coordinates empty. Existing coordinates are never overwritten.
 */
export async function saveStopCoordinates(loadId: string): Promise<number> {
  try {
    const stops = await prisma.stop.findMany({ where: { loadId, lat: null, lng: null }, select: { id: true, addressString: true } });
    let saved = 0;
    for (const s of stops) {
      const place = await geocodePermanent(s.addressString);
      if (!place) continue;
      await prisma.stop.update({ where: { id: s.id }, data: { lat: new Prisma.Decimal(place.lat).toDecimalPlaces(6), lng: new Prisma.Decimal(place.lng).toDecimalPlaces(6) } });
      saved += 1;
    }
    return saved;
  } catch {
    return 0;
  }
}
