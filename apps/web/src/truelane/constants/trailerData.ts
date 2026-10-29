// VENDORED from TrueLane constants/trailerData.ts @ a3a9c0f4. Do not edit; run scripts/vendor-truelane.mjs.
/**
 * Trailer types for the trailer-pulling freight modes (heavy_tl + hotshot).
 * Used by the calculator's trailer picker, the load-height gate (open-deck only), and the
 * (future) DAT market-rate lookup, which prices on equipment class.
 */

export type TrailerType =
  | 'dry_van'
  | 'reefer'
  | 'flatbed'
  | 'step_deck'
  | 'rgn'
  | 'conestoga'
  | 'tanker'
  | 'car_hauler'
  | 'power_only';

export const TRAILER_TYPES: { value: TrailerType; label: string }[] = [
  { value: 'dry_van', label: 'Dry van' },
  { value: 'reefer', label: 'Reefer' },
  { value: 'flatbed', label: 'Flatbed' },
  { value: 'step_deck', label: 'Step deck / drop deck' },
  { value: 'rgn', label: 'RGN / lowboy' },
  { value: 'conestoga', label: 'Conestoga' },
  { value: 'tanker', label: 'Tanker' },
  { value: 'car_hauler', label: 'Car hauler' },
  { value: 'power_only', label: 'Power only' },
];

/**
 * Retired trailer values that old loads may still carry. 'hopper' (Hopper / dump) was removed from
 * TrailerType because the app doesn't price dump loads — but a saved load can still hold it, so it is
 * DISPLAYED (never silently rewritten); choosing a listed trailer replaces it.
 */
const RETIRED_TRAILER_LABELS: Record<string, string> = {
  hopper: 'Hopper / dump (no longer listed)',
};

/** Equipment not on the list, typed by the driver: stored as `other:<text>` (e.g. "other:Hopper"). */
export const OTHER_TRAILER_PREFIX = 'other:';
export const OTHER_TRAILER_MAX = 40;

export function isOtherTrailer(value: string | null | undefined): boolean {
  return (value ?? '').trim().toLowerCase().startsWith(OTHER_TRAILER_PREFIX);
}

/** The typed text of an Other trailer ('' when none). */
export function otherTrailerText(value: string | null | undefined): string {
  return isOtherTrailer(value) ? (value ?? '').trim().slice(OTHER_TRAILER_PREFIX.length).trim() : '';
}

export function makeOtherTrailer(text: string): string {
  return `${OTHER_TRAILER_PREFIX}${text.replace(/\s+/g, ' ').trimStart().slice(0, OTHER_TRAILER_MAX)}`;
}

/** A trailer is chosen: a listed/retired value, or Other with some text typed. */
export function isTrailerSet(value: string | null | undefined): boolean {
  const v = (value ?? '').trim();
  if (!v) return false;
  return isOtherTrailer(v) ? otherTrailerText(v).length > 0 : true;
}

/** Display label for a stored trailer value: listed label, retired label, raw value, or "Not set". */
export function trailerLabel(value: string | null | undefined): string {
  const v = (value ?? '').trim();
  if (!v) return 'Not set';
  if (isOtherTrailer(v)) {
    const text = otherTrailerText(v);
    return text ? `Other — ${text}` : 'Other (type it in)';
  }
  const listed = TRAILER_TYPES.find((t) => t.value === v);
  if (listed) return listed.label;
  return RETIRED_TRAILER_LABELS[v] ?? v;
}

/**
 * Open-deck trailers carry uncovered/variable-height freight, so load height is a real input (and an
 * over-height permit trigger). Enclosed trailers cap height at the trailer, so load height is moot.
 */
export function isOpenDeckTrailer(type: TrailerType | string | null | undefined): boolean {
  return type === 'flatbed' || type === 'step_deck' || type === 'rgn' || type === 'conestoga';
}

/** DAT RateView equipment classes — the only axis DAT prices on. */
export type DatEquipment = 'van' | 'reefer' | 'flatbed';

/**
 * Map a trailer to its closest DAT equipment class for market-rate lookup, or null when DAT has no
 * meaningful equivalent (specialized equipment / unknown deck). Open-deck variants proxy to flatbed.
 */
export function trailerToDatEquipment(type: TrailerType | string | null | undefined): DatEquipment | null {
  switch (type) {
    case 'dry_van':
      return 'van';
    case 'reefer':
      return 'reefer';
    case 'flatbed':
    case 'step_deck':
    case 'rgn':
    case 'conestoga':
      return 'flatbed';
    case 'tanker':
    case 'car_hauler':
    case 'power_only':
    default:
      return null;
  }
}
