// VENDORED from TrueLane lib/domain/quotedMiles.ts @ e7c88066. Do not edit; run scripts/vendor-truelane.mjs.
/**
 * Quote-vs-actual: before the working mileage columns are overwritten with what was actually driven,
 * keep the planned (decision-time) miles once. Idempotent — never clobbers an existing snapshot.
 * Used by the live end-trip path (writeAdjustedMilesToLoad) and by "Skip trip — mark done"
 * (quickCompleteLoad), which keeps the planned miles as the working miles. Node-safe.
 */
export type QuotedMilesFields = {
  pickupDeadheadMiles: number;
  loadedMiles: number;
  returnDeadheadMiles: number;
  quotedPickupDhMiles: number | null;
  quotedLoadedMiles: number | null;
  quotedReturnDhMiles: number | null;
};

export function snapshotQuotedMilesOnce(l: QuotedMilesFields): void {
  if (l.quotedPickupDhMiles == null) l.quotedPickupDhMiles = l.pickupDeadheadMiles;
  if (l.quotedLoadedMiles == null) l.quotedLoadedMiles = l.loadedMiles;
  if (l.quotedReturnDhMiles == null) l.quotedReturnDhMiles = l.returnDeadheadMiles;
}

export type EffectiveMilesInput = {
  pickupDeadheadMiles: number | null | undefined;
  loadedMiles: number | null | undefined;
  returnDeadheadMiles: number | null | undefined;
  quotedPickupDhMiles?: number | null;
  quotedLoadedMiles?: number | null;
  quotedReturnDhMiles?: number | null;
};

export type EffectiveMiles = {
  pickupDh: number;
  loaded: number;
  returnDh: number;
  total: number;
  /** True when the working miles were 0 and the planned (quoted) snapshot is used instead. */
  fromQuote: boolean;
};

const num = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/**
 * The miles every per-mile number uses — one rule for Trip Complete, the Loads list and History so
 * they always agree. The working columns win; when they are all 0 (a trip finished before F2 with
 * no miles typed wrote 0s over the plan), fall back to the planned snapshot.
 */
export function effectiveMiles(l: EffectiveMilesInput): EffectiveMiles {
  const w = { pickupDh: num(l.pickupDeadheadMiles), loaded: num(l.loadedMiles), returnDh: num(l.returnDeadheadMiles) };
  const wTotal = w.pickupDh + w.loaded + w.returnDh;
  if (wTotal > 0) return { ...w, total: wTotal, fromQuote: false };
  const q = { pickupDh: num(l.quotedPickupDhMiles), loaded: num(l.quotedLoadedMiles), returnDh: num(l.quotedReturnDhMiles) };
  const qTotal = q.pickupDh + q.loaded + q.returnDh;
  if (qTotal > 0) return { ...q, total: qTotal, fromQuote: true };
  return { pickupDh: 0, loaded: 0, returnDh: 0, total: 0, fromQuote: false };
}

/** Did the driver type any miles on the trip? No segments (skipped trip) or all 0 → planned. */
export function milesWereLogged(segmentMilesTotal: number): boolean {
  return Number.isFinite(segmentMilesTotal) && segmentMilesTotal > 0;
}
