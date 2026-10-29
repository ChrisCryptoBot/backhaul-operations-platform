// VENDORED from TrueLane lib/domain/oversize.ts @ a3a9c0f4. Do not edit; run scripts/vendor-truelane.mjs.
/**
 * Oversize (permit) detection — a negotiation/awareness signal from a load's dimensions vs. federal
 * legal limits. Oversize freight needs state permits (one per state crossed) and often escort/pilot
 * cars, costs that must be in the rate. Note: this flags OVER-DIMENSION only. Over-WEIGHT permits
 * trigger on GROSS weight (truck + trailer + cargo > 80,000 lbs), which needs a tare/GVWR we don't
 * capture — that's left to the future permit API. The vehicle-payload check (computeCapacityWarnings)
 * separately warns when cargo exceeds the truck's rated payload.
 *
 * SEMANTIC only (no copy) — the UI maps reasons to a coaching nudge, like marketVerdict / leadTime.
 */

// Federal legal limits for permit-free travel (the common thresholds; states vary at the margins).
const LEGAL_WIDTH_FT = 8.5; // 8'6"
const LEGAL_HEIGHT_IN = 162; // 13'6"
const LEGAL_LENGTH_FT = 53; // a standard 53' trailer; freight beyond this reads as over-length

export type OversizeReason = 'width' | 'height' | 'length';

export type OversizeResult = { isOversize: boolean; reasons: OversizeReason[] };

export type OversizeInput = {
  /** Load width in feet (null when not entered). */
  widthFt: number | null;
  /** Load height in inches (null when not entered / not an open-deck trailer). */
  heightIn: number | null;
  /** Load length in feet (null when not entered). */
  lengthFt: number | null;
};

export function computeOversize(input: OversizeInput): OversizeResult {
  const reasons: OversizeReason[] = [];
  if (input.widthFt != null && input.widthFt > LEGAL_WIDTH_FT) reasons.push('width');
  if (input.heightIn != null && input.heightIn > LEGAL_HEIGHT_IN) reasons.push('height');
  if (input.lengthFt != null && input.lengthFt > LEGAL_LENGTH_FT) reasons.push('length');
  return { isOversize: reasons.length > 0, reasons };
}
