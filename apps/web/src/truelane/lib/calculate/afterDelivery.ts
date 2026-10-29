// VENDORED from TrueLane lib/calculate/afterDelivery.ts @ a3a9c0f4. Do not edit; run scripts/vendor-truelane.mjs.
/**
 * "After delivery" wording: one source for the Calculator's mileage-basis line, the trip screen's row and the wrap-up line.
 *
 * The backhaul is an ASSUMPTION that becomes a fact later: the Calculator counts the drive home as empty miles until the driver says a paid load covers it
 * (lib/calculate/emptyMiles.ts: `returnTo` is the source of truth). The all-in $/mi the verdict shows is per mile of that basis, so the basis is written next to
 * the number ("All-in $2.41/mi on 687 mi · 237 mi empty home"): the metric cannot be read without its mileage, however fast the driver scrolls. Nothing here
 * computes a mile: the total is the one the verdict already divides by, and every state is words only. Pure, so a unit test pins every sentence.
 */
import type { ReturnTo } from '@/truelane/lib/calculate/emptyMiles';

export type AfterDeliveryTone = 'caution' | 'neutral';

const mi = (n: number): string => `${Math.round(n)} mi`;

/**
 * The Calculator's basis: what miles the all-in $/mi is per, and what the empty part of them is.
 * `totalMiles` is the verdict's own denominator (never rebuilt here); `returnMiles` is the return field as typed or filled (a load back counts none of it).
 * `returnTyped` is true when the driver typed that number themselves: a typed 0 (delivery near home) is a fact, not a missing figure. Null until there is a route to talk about.
 */
export function mileageBasis(p: {
  returnTo: ReturnTo;
  totalMiles: number;
  returnMiles: number;
  hasHomeBase: boolean;
  hasRoute: boolean;
  returnTyped?: boolean;
}): { tone: AfterDeliveryTone; text: string } | null {
  if (!p.hasRoute || !(p.totalMiles > 0)) return null;
  const on = `on ${mi(p.totalMiles)}`;
  const ret = Math.max(0, p.returnMiles);
  if (p.returnTo === 'nextLoad') return { tone: 'neutral', text: `${on} · load back, trip home not counted` };
  if (p.returnTo === 'elsewhere') {
    return ret > 0
      ? { tone: 'neutral', text: `${on} · ${mi(ret)} to your next stop` }
      : { tone: 'caution', text: `${on} · miles to your next stop not entered` };
  }
  if (ret > 0) return { tone: 'caution', text: `${on} · ${mi(ret)} empty home` };
  // A number the driver typed, even 0, is theirs to stand on.
  if (p.returnTyped) return { tone: 'neutral', text: `${on} · no empty miles home` };
  // Home empty with nothing to include: the verdict is silently optimistic here, which is the case this line exists to catch.
  return {
    tone: 'caution',
    text: p.hasHomeBase ? `${on} · home miles not included` : `${on} · set a home base to include the miles home`,
  };
}

/** The line in front of the basis: the all-in rate it is per. Without a rate the basis stands alone, capitalised. */
export function basisSentence(rate: string | null, text: string): string {
  return rate ? `All-in ${rate} ${text}` : text.charAt(0).toUpperCase() + text.slice(1);
}

/** The two answers a driver can give once the freight is on the truck. */
export type AfterDeliveryChoice = 'home' | 'nextLoad';

/**
 * The trip screen's row and the wrap-up line: what the calculation includes after delivery. It says what is counted, never that the driver went anywhere (the app does not
 * know), and it is true whether the saved return miles are the drive home or the miles to a next stop ("somewhere else" saves the same way). `returnMiles` is the saved
 * return miles; a load back saves none, by the rule the Calculator and Load Details have always saved by. `missingMiles` is true when the load is not a load back and has none
 * saved: the line then offers a way to add them.
 */
export function afterDeliveryWords(p: {
  isBackhaul: boolean;
  returnMiles: number;
  /** The trip is over (wrap-up): "Includes ..." rather than "... counted". */
  done?: boolean;
}): { choice: AfterDeliveryChoice; tone: AfterDeliveryTone; text: string; missingMiles: boolean } {
  if (p.isBackhaul) {
    return { choice: 'nextLoad', tone: 'neutral', missingMiles: false, text: p.done ? 'Load back · trip home not included' : "Load back · trip home not in this load's miles" };
  }
  const ret = Math.max(0, p.returnMiles);
  if (ret > 0) {
    return { choice: 'home', tone: 'caution', missingMiles: false, text: p.done ? `Includes ${mi(ret)} empty after delivery` : `Empty after delivery · ${mi(ret)} counted` };
  }
  return { choice: 'home', tone: 'caution', missingMiles: true, text: p.done ? 'No miles after delivery included' : 'No miles after delivery counted' };
}

/** What a flip to "home" cannot restore: the miles were not kept while this was a load back. The line Load Details has always used for it. */
export const HOME_MILES_NOT_KEPT =
  "The miles home weren't kept while this was a load back — enter them on the expense screen after the trip.";
