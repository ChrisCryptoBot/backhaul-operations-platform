// VENDORED from TrueLane lib/eiaRegion.ts @ a3a9c0f4. Do not edit; run scripts/vendor-truelane.mjs.
/**
 * Map a US address string to an EIA PADD region for on-highway fuel prices.
 * Prefer origin (where the trip starts / fuel often bought first); fall back to destination.
 */

export type EiaPadd =
  | 'R10' // East Coast (PADD 1)
  | 'R20' // Midwest (PADD 2)
  | 'R30' // Gulf Coast (PADD 3)
  | 'R40' // Rocky Mountain (PADD 4)
  | 'R50' // West Coast (PADD 5)
  | 'NUS'; // U.S. national

export const EIA_PADD_LABELS: Record<EiaPadd, string> = {
  R10: 'East Coast (PADD 1)',
  R20: 'Midwest (PADD 2)',
  R30: 'Gulf Coast (PADD 3)',
  R40: 'Rocky Mountain (PADD 4)',
  R50: 'West Coast (PADD 5)',
  NUS: 'U.S. National',
};

const STATE_TO_PADD: Record<string, Exclude<EiaPadd, 'NUS'>> = {
  // PADD 1 East Coast
  CT: 'R10', ME: 'R10', MA: 'R10', NH: 'R10', RI: 'R10', VT: 'R10',
  DE: 'R10', DC: 'R10', MD: 'R10', NJ: 'R10', NY: 'R10', PA: 'R10',
  FL: 'R10', GA: 'R10', NC: 'R10', SC: 'R10', VA: 'R10', WV: 'R10',
  // PADD 2 Midwest
  IL: 'R20', IN: 'R20', IA: 'R20', KS: 'R20', KY: 'R20', MI: 'R20',
  MN: 'R20', MO: 'R20', NE: 'R20', ND: 'R20', OH: 'R20', OK: 'R20',
  SD: 'R20', TN: 'R20', WI: 'R20',
  // PADD 3 Gulf Coast
  AL: 'R30', AR: 'R30', LA: 'R30', MS: 'R30', NM: 'R30', TX: 'R30',
  // PADD 4 Rockies
  CO: 'R40', ID: 'R40', MT: 'R40', UT: 'R40', WY: 'R40',
  // PADD 5 West Coast
  AK: 'R50', AZ: 'R50', CA: 'R50', HI: 'R50', NV: 'R50', OR: 'R50', WA: 'R50',
};

const STATE_NAME_TO_ABBR: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA',
  colorado: 'CO', connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA',
  hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA',
  kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD',
  massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS',
  missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH',
  'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC',
  'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA',
  'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN',
  texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA', washington: 'WA',
  'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
  'district of columbia': 'DC',
};

/** Extract a US state abbreviation from a free-form address, or null. */
export function extractUsStateAbbr(address: string | null | undefined): string | null {
  if (!address || !address.trim()) return null;
  const raw = address.trim();

  // ", TX," / ", TX " / " TX " near end (common Mapbox / form shapes)
  const abbrMatch = raw.match(/,\s*([A-Za-z]{2})(?:\s*,|\s+\d{5}|$)/);
  if (abbrMatch?.[1]) {
    const abbr = abbrMatch[1].toUpperCase();
    if (STATE_TO_PADD[abbr]) return abbr;
  }

  const lower = raw.toLowerCase();
  // Longer names first so "new mexico" beats "mexico" if ever present
  const names = Object.keys(STATE_NAME_TO_ABBR).sort((a, b) => b.length - a.length);
  for (const name of names) {
    if (lower.includes(name)) return STATE_NAME_TO_ABBR[name]!;
  }
  return null;
}

export function paddForStateAbbr(abbr: string | null | undefined): EiaPadd {
  if (!abbr) return 'NUS';
  return STATE_TO_PADD[abbr.toUpperCase()] ?? 'NUS';
}

/**
 * Resolve EIA region from lane endpoints.
 * Prefer origin (fueling often starts there); else destination; else national.
 */
export function resolveLaneEiaPadd(
  originAddress: string | null | undefined,
  destinationAddress: string | null | undefined
): { padd: EiaPadd; stateAbbr: string | null; source: 'origin' | 'destination' | 'national' } {
  const originState = extractUsStateAbbr(originAddress);
  if (originState) {
    return { padd: paddForStateAbbr(originState), stateAbbr: originState, source: 'origin' };
  }
  const destState = extractUsStateAbbr(destinationAddress);
  if (destState) {
    return { padd: paddForStateAbbr(destState), stateAbbr: destState, source: 'destination' };
  }
  return { padd: 'NUS', stateAbbr: null, source: 'national' };
}
