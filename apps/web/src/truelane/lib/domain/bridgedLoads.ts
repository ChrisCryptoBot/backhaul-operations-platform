// VENDORED from TrueLane lib/domain/bridgedLoads.ts @ 06678c59. Do not edit; run scripts/vendor-truelane.mjs.
/**
 * Bridged loads are the carrier's, not the driver's (Wallet + Bridge plan, Phase 2 step 1). A load the carrier's desk sent through the bridge carries `external_dispatch_id` (v27,
 * local-only). Its pay, costs and misses belong to the carrier's books: they never enter the driver's own P&L (Analytics, the Wallet), their taxes (Tax info, the tax CSV) or their
 * leaks. The driver still sees and runs the load on Loads and the trip screens; only the owner-operator's money views leave it out. Math audit R7-22.
 *
 * One rule, used at every door: computeAnalytics / revenueLoadsInPeriod (lib/analytics.ts), countsForTaxes (lib/domain/taxCounts.ts), loadLeaks (lib/domain/leaks.ts), and the Wallet
 * summary (hooks/useWalletSummary.ts) before anything else.
 */
import { asContractorMoney, isContractorLoad } from '@/truelane/lib/domain/contractorLoads';

export type BridgeMark = { externalDispatchId?: string | null };

export const isBridgedLoad = (l: BridgeMark): boolean => typeof l.externalDispatchId === 'string' && l.externalDispatchId.length > 0;

/**
 * The driver's own loads: every load that did not come from a carrier through the bridge, plus a CONTRACTOR's loads from a company's desk (finalization plan F2), read through
 * their money view (lib/domain/contractorLoads.ts: the desk's gross, the fee as a dispatcher fee or a leased-on cut). An employee's bridged load is never in it.
 */
export function personalLoads<T extends BridgeMark>(loads: readonly T[]): T[] {
  return loads.flatMap((l) => (!isBridgedLoad(l) ? [l] : isContractorLoad(l) ? [asContractorMoney(l)] : []));
}

/** Where the driver's carrier link stands for this sync: connected, not connected, or the bridge could not be asked. */
export type CarrierLinkState = 'linked' | 'none' | 'unreachable';

/**
 * Whether the phone reads loads the carrier dispatched (bridge.external_dispatch). A driver connected to a carrier by code gets them (Chris 2026-11-22: a dispatched load shows on the
 * phone). The old fleet switches (fleetMode + bridgeDispatch) still open it for the parked fleet build. Without either, nothing is read: an owner-operator is untouched. An unreachable
 * link answer reads nothing this round; the next sync asks again.
 */
export function dispatchPullAllowed(i: { fleetSwitchesOn: boolean; link: CarrierLinkState }): boolean {
  return i.fleetSwitchesOn || i.link === 'linked';
}
