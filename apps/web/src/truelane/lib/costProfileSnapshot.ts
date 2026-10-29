// VENDORED from TrueLane lib/costProfileSnapshot.ts @ a3a9c0f4. Do not edit; run scripts/vendor-truelane.mjs.
/**
 * Snapshot values frozen at load/decision time — pure helpers, no DB imports from domain.
 */
import {
  computeTripLaborCPM,
  DEFAULT_LABOR_BURDEN_PCT_LEGACY,
  type CostProfileFloorBreakdown,
} from '@/truelane/lib/domain/calculators';
import { clampFraction } from '@/truelane/lib/formatNumbers';
import { effectiveCarrierCutPct, fscCutAppliesFor } from '@/truelane/lib/domain/costArchetype';
import { DEFAULT_FREE_GRACE_MINUTES } from '@/truelane/lib/domain/detention';

export type DecisionSnapshotFields = {
  snapshotBaseFloorRpm: number;
  snapshotTotalInsuranceMonthly: number;
  snapshotEstimatedMonthlyMiles: number;
  snapshotArchetype: string;
};

export function buildDecisionSnapshotFromBreakdown(
  breakdown: CostProfileFloorBreakdown,
  estimatedMonthlyMiles: number
): DecisionSnapshotFields {
  return {
    snapshotBaseFloorRpm: breakdown.breakEvenRpm,
    snapshotTotalInsuranceMonthly: breakdown.totalInsuranceMonthly,
    snapshotEstimatedMonthlyMiles: estimatedMonthlyMiles,
    snapshotArchetype: breakdown.archetype,
  };
}

/** Profile fields the accept-time trip snapshot reads (a CostProfile row satisfies it). */
export type TripSnapshotProfile = {
  archetype: string | null;
  carrierCutPct: number | null;
  laborBurdenPct: number | null;
  hiredDriverHourlyRate: number | null;
  hiredDriverPayKind: string | null;
  hiredDriverRatePerMile: number | null;
  /** v48: 'yes' | 'no' | 'not_sure' | null — optional so older callers' shapes still fit (null = yes). */
  fscCutApplies?: string | null;
  /** v48 (#24): the profile's detention terms. */
  detentionHourlyRate?: number | null;
  freeGraceMinutes?: number | null;
};

export type TripSnapshotFields = {
  snapshotCarrierCutPct: number;
  snapshotLaborCpm: number;
  /** v48 (V-04): whether the cut came off fuel surcharge when the load was decided. */
  snapshotFscCutApplies: boolean;
  /**
   * v48 (#24): the detention rate and free time the load was accepted with. Null when the profile had no
   * rate — a blank rate isn't a contract term, so the load keeps following the profile until one is set
   * (or the driver enters this load's terms on Expenses).
   */
  snapshotDetentionRate: number | null;
  snapshotFreeGraceMinutes: number | null;
};

/**
 * v46 (H6): the carrier cut and driver pay per mile the load was decided with — Calculate's own math
 * (computeTripLaborCPM over the load's hours and miles). History, the timeline and trip complete read
 * these, so a later profile edit never changes a past load's net pay or profit. v48 adds whether the
 * cut applied to fuel surcharge (only a "No" is false — the same rule Calculate used).
 */
export function buildTripSnapshotFields(
  profile: TripSnapshotProfile,
  tripHours: number,
  tripMiles: number
): TripSnapshotFields {
  return {
    snapshotCarrierCutPct: effectiveCarrierCutPct(profile.archetype, profile.carrierCutPct),
    snapshotLaborCpm: computeTripLaborCPM(
      tripHours > 0 ? tripHours : 0,
      tripMiles,
      profile.hiredDriverHourlyRate ?? 0,
      profile.archetype ?? 'solo_owner',
      clampFraction(profile.laborBurdenPct ?? DEFAULT_LABOR_BURDEN_PCT_LEGACY),
      profile.hiredDriverPayKind ?? 'hourly',
      profile.hiredDriverRatePerMile ?? 0
    ),
    snapshotFscCutApplies: fscCutAppliesFor(profile.fscCutApplies),
    ...detentionSnapshot(profile),
  };
}

function detentionSnapshot(profile: TripSnapshotProfile): Pick<TripSnapshotFields, 'snapshotDetentionRate' | 'snapshotFreeGraceMinutes'> {
  const rate = profile.detentionHourlyRate;
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) {
    return { snapshotDetentionRate: null, snapshotFreeGraceMinutes: null };
  }
  const grace = profile.freeGraceMinutes;
  return {
    snapshotDetentionRate: rate,
    snapshotFreeGraceMinutes:
      typeof grace === 'number' && Number.isFinite(grace) && grace >= 0 ? grace : DEFAULT_FREE_GRACE_MINUTES,
  };
}
