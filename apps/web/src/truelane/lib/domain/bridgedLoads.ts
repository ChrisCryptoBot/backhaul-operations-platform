// VENDORED from TrueLane lib/domain/bridgedLoads.ts @ fa7e4650. Do not edit; run scripts/vendor-truelane.mjs.
/**
 * Bridged loads are the carrier's, not the driver's (Wallet + Bridge plan, Phase 2 step 1). A load the carrier's desk sent through the bridge carries `external_dispatch_id` (v27,
 * local-only). Its pay, costs and misses belong to the carrier's books: they never enter the driver's own P&L (Analytics, the Wallet), their taxes (Tax info, the tax CSV) or their
 * leaks. The driver still sees and runs the load on Loads and the trip screens; only the owner-operator's money views leave it out. Math audit R7-22.
 *
 * One rule, used at every door: computeAnalytics / revenueLoadsInPeriod (lib/analytics.ts), countsForTaxes (lib/domain/taxCounts.ts), loadLeaks (lib/domain/leaks.ts), and the Wallet
 * summary (hooks/useWalletSummary.ts) before anything else.
 */
export type BridgeMark = { externalDispatchId?: string | null };

export const isBridgedLoad = (l: BridgeMark): boolean => typeof l.externalDispatchId === 'string' && l.externalDispatchId.length > 0;

/** The driver's own loads: every load that did not come from a carrier through the bridge. */
export function personalLoads<T extends BridgeMark>(loads: readonly T[]): T[] {
  return loads.filter((l) => !isBridgedLoad(l));
}
