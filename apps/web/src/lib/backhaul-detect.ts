import { haversineMiles } from "./geo";

export type OpenPickupCandidate = {
  loadId: string;
  loadNumber: string;
  address: string;
  lat: number | null;
  lng: number | null;
};

export type BackhaulMatch = {
  loadId: string;
  loadNumber: string;
  address: string;
  distanceMiles: number | null;
};

export type BackhaulOpportunity = {
  count: number;
  nearestMiles: number | null;
  matches: BackhaulMatch[];
};

/**
 * Detect open pickup opportunities near a delivery destination.
 * Uses straight-line haversine miles when coordinates are available (<= radiusMiles),
 * or city/state string matching when coordinates are unmeasured.
 */
export function findBackhauls(
  delivery: { address: string; lat?: number | null; lng?: number | null },
  candidates: readonly OpenPickupCandidate[],
  radiusMiles = 50
): BackhaulOpportunity {
  if (!delivery.address.trim()) {
    return { count: 0, nearestMiles: null, matches: [] };
  }

  const deliveryHasPoint = delivery.lat != null && delivery.lng != null;
  const dPoint = deliveryHasPoint ? { lat: delivery.lat!, lng: delivery.lng! } : null;
  const dCity = delivery.address.trim().toLowerCase();

  const matches: BackhaulMatch[] = [];

  for (const c of candidates) {
    if (dPoint && c.lat != null && c.lng != null) {
      const dist = haversineMiles(dPoint, { lat: c.lat, lng: c.lng });
      if (dist <= radiusMiles) {
        matches.push({
          loadId: c.loadId,
          loadNumber: c.loadNumber,
          address: c.address,
          distanceMiles: Math.round(dist * 10) / 10
        });
      }
    } else {
      // Fallback: match by city/state substring when coordinates are unmeasured
      const cCity = c.address.trim().toLowerCase();
      if (cCity && (dCity.includes(cCity) || cCity.includes(dCity))) {
        matches.push({
          loadId: c.loadId,
          loadNumber: c.loadNumber,
          address: c.address,
          distanceMiles: null
        });
      }
    }
  }

  matches.sort((a, b) => {
    if (a.distanceMiles == null && b.distanceMiles == null) return 0;
    if (a.distanceMiles == null) return 1;
    if (b.distanceMiles == null) return -1;
    return a.distanceMiles - b.distanceMiles;
  });

  return {
    count: matches.length,
    nearestMiles: matches[0]?.distanceMiles ?? null,
    matches
  };
}
