// VENDORED from TrueLane lib/domain/loadEconomics.ts @ a3a9c0f4. Do not edit; run scripts/vendor-truelane.mjs.
/**
 * One load's money, miles and completion date — the single rule every aggregate uses (Analytics,
 * Loads/History, Profile, Tax, Maintenance, Last time on this lane). Node-safe, no I/O.
 *
 *  - Gross (completed): linehaul + fuel surcharge + layover — the additive FSC model
 *    (docs/ORBIT.md). Linehaul is what the broker paid for the haul when it was entered,
 *    else the agreed rate. A 0 "Linehaul paid" is treated as not entered: the Expenses screen
 *    used to save a blank box as 0, which booked a real load as $0.
 *  - Gross (TONU): the TONU fee only. A TONU load keeps its original offer, FSC and planned miles
 *    on the row; none of that was earned or driven.
 *  - Miles, two kinds (math review round 6, V-06 / N-2 / N-4), both from `effectiveMiles` (working
 *    miles, else the planned snapshot):
 *    · revenue miles — the miles the pay covers: every $/mi, RPH weight, mile-weighted average and
 *      market figure. A TONU hauled nothing (0). A backhaul's miles after delivery belong to the next
 *      leg, not this load (the decision left them out too), so they're excluded even when logged.
 *    · driven miles — every mile the truck drove for the load: Tax standard mileage, the Maintenance
 *      reserve and deadhead %. A TONU counts the miles driven to the pickup (`tonuDrivenMiles`, asked
 *      at TONU; blank = 0). The drive away becomes the next load's pickup deadhead — no double count.
 *  - Completion date: `completed_at` when stamped (v45), else the TONU's `cancelled_at`, else the
 *    backfill's estimate (pickup date, else saved date, capped by the earliest later write), and
 *    `updated_at` only when the caller has no created date. `updated_at` alone moves on every edit
 *    (invoice, mark paid, sync).
 */

import { cashTripRevenue } from '@/truelane/lib/domain/calculators';
import { effectiveMiles, type EffectiveMilesInput } from '@/truelane/lib/domain/quotedMiles';
import { estimateCompletionMs } from '@/truelane/lib/domain/completedAt';

export type LoadMoneyInput = {
  status: string;
  actualRevenue: number | null;
  quotedRevenue: number;
  fuelSurcharge: number | null;
  layoverPay: number | null;
  tonuRevenue: number | null;
};

export type LoadMilesInput = {
  status: string;
  /** A backhaul's post-delivery miles aren't revenue miles. */
  isBackhaul?: boolean | null;
  /** v48: a TONU's miles driven to the pickup (null = not entered = 0). */
  tonuDrivenMiles?: number | null;
} & EffectiveMilesInput;

export type LoadDateInput = {
  status: string;
  completedAt?: number | null;
  cancelledAt?: number | null;
  updatedAt: Date | number;
  /** For rows the backfill hasn't dated yet: the same estimate it will write. */
  scheduledDate?: number | null;
  createdAt?: Date | number;
  invoicedAt?: number | null;
  paidAt?: number | null;
};

const finite = (n: number | null | undefined): number =>
  typeof n === 'number' && Number.isFinite(n) ? n : 0;
const pos = (n: number | null | undefined): number => Math.max(0, finite(n));

/** Only completed and TONU loads produce revenue. */
export function isRevenueLoad(l: { status: string }): boolean {
  return l.status === 'completed' || l.status === 'tonu';
}

/** Linehaul actually paid when entered (> 0), else the agreed rate. */
export function linehaul(l: Pick<LoadMoneyInput, 'actualRevenue' | 'quotedRevenue'>): number {
  const actual = finite(l.actualRevenue);
  return actual > 0 ? actual : finite(l.quotedRevenue);
}

/** Everything the load earned, in dollars. */
export function loadGross(l: LoadMoneyInput): number {
  if (l.status === 'tonu') return finite(l.tonuRevenue);
  return cashTripRevenue(linehaul(l), l.fuelSurcharge, l.layoverPay);
}

/** The miles the pay covers — every $/mi and RPH weight. TONU 0; a backhaul leaves out its post-delivery miles. */
export function revenueMiles(l: LoadMilesInput): number {
  if (l.status === 'tonu') return 0;
  const m = effectiveMiles(l);
  return l.isBackhaul ? m.pickupDh + m.loaded : m.total;
}

/** Every mile driven for the load — Tax, Maintenance, deadhead %. A TONU: the miles to the pickup (blank = 0). */
export function drivenMiles(l: LoadMilesInput): number {
  if (l.status === 'tonu') return pos(l.tonuDrivenMiles);
  return effectiveMiles(l).total;
}

/** The empty part of the driven miles: pickup + return deadhead; all of a TONU's miles. */
export function deadheadMilesOf(l: LoadMilesInput): number {
  if (l.status === 'tonu') return pos(l.tonuDrivenMiles);
  const m = effectiveMiles(l);
  return m.pickupDh + m.returnDh;
}

/** Σ deadhead miles ÷ Σ driven miles × 100 — a ratio of sums, never a mean of per-load %s. Null without miles. */
export function deadheadPct(rows: ReadonlyArray<{ drivenMiles: number; deadheadMiles: number }>): number | null {
  let driven = 0;
  let empty = 0;
  for (const r of rows) {
    if (!(r.drivenMiles > 0)) continue;
    driven += r.drivenMiles;
    empty += pos(r.deadheadMiles);
  }
  return driven > 0 ? (empty / driven) * 100 : null;
}

/** When the load was finished (ms epoch). */
export function loadCompletedAtMs(l: LoadDateInput): number {
  if (typeof l.completedAt === 'number' && Number.isFinite(l.completedAt)) return l.completedAt;
  if (l.status === 'tonu' && typeof l.cancelledAt === 'number' && Number.isFinite(l.cancelledAt)) {
    return l.cancelledAt;
  }
  const updatedAt = toMs(l.updatedAt);
  // Not dated yet (the backfill runs at launch and each sync): read it the way the backfill will
  // write it — pickup date, else saved date, capped by the earliest later write.
  if (l.createdAt != null) {
    return estimateCompletionMs({
      scheduledDate: l.scheduledDate,
      createdAt: toMs(l.createdAt),
      updatedAt,
      invoicedAt: l.invoicedAt,
      paidAt: l.paidAt,
    });
  }
  return updatedAt;
}

function toMs(v: Date | number): number {
  return v instanceof Date ? v.getTime() : v;
}

/**
 * Dollars per revenue mile across loads: Σ gross ÷ Σ revenue miles, counting only loads that have
 * them. A load with none (TONU, or a trip finished with nothing logged and no plan) adds no revenue to
 * the numerator either, so it can't inflate the rate. Null when no load has miles.
 */
export function rpm(loads: Array<LoadMoneyInput & LoadMilesInput>): number | null {
  let revenue = 0;
  let miles = 0;
  for (const l of loads) {
    const mi = revenueMiles(l);
    if (!(mi > 0)) continue;
    revenue += loadGross(l);
    miles += mi;
  }
  return miles > 0 ? revenue / miles : null;
}
