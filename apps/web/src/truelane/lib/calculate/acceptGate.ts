// VENDORED from TrueLane lib/calculate/acceptGate.ts @ a3a9c0f4. Do not edit; run scripts/vendor-truelane.mjs.
/**
 * Which button the pinned Calculate footer shows, and when it shows at all. Pure.
 * The rule is the one the result card held inline: the market verdict's own gate wins, otherwise a rejected load needs an override.
 */
import type { AcceptGate } from '@/truelane/lib/domain/marketVerdict';

export function acceptGateFor(o: { marketGate: AcceptGate | undefined; decision: string }): AcceptGate {
  return o.marketGate ?? (o.decision === 'reject' ? 'below_floor' : null);
}

/** There is a load to decide on: an offer and miles. Over an empty form the footer would only invite a "Check your inputs". */
export function hasSomethingToAccept(o: { offer: number; totalMiles: number }): boolean {
  return Number.isFinite(o.offer) && o.offer > 0 && Number.isFinite(o.totalMiles) && o.totalMiles > 0;
}
