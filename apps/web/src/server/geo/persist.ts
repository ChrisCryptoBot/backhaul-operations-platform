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

/**
 * Find a truck's home base once and keep it, from the permanent geocoder (the licensed one for a stored point), so measuring a quote can start
 * from the stored point instead of looking the address up every time. It runs after the truck's save has committed and never throws. A truck
 * that already has its point, has no address, or whose address cannot be found is left as it is; an address that changes meanwhile is not
 * overwritten with the answer for the old one.
 */
export async function saveTruckHomeCoordinates(vehicleId: string): Promise<boolean> {
  try {
    const t = await prisma.vehicle.findUnique({ where: { id: vehicleId }, select: { homeBaseAddress: true, homeBaseLat: true, homeBaseLng: true } });
    const address = t?.homeBaseAddress?.trim();
    if (!t || !address || (t.homeBaseLat != null && t.homeBaseLng != null)) return false;
    const place = await geocodePermanent(address);
    if (!place) return false;
    const done = await prisma.vehicle.updateMany({
      where: { id: vehicleId, homeBaseAddress: t.homeBaseAddress, homeBaseLat: null },
      data: { homeBaseLat: new Prisma.Decimal(place.lat).toDecimalPlaces(6), homeBaseLng: new Prisma.Decimal(place.lng).toDecimalPlaces(6) }
    });
    return done.count > 0;
  } catch {
    return false;
  }
}
