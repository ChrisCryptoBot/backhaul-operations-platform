import type { Prisma } from "@prisma/client";
import { buildDecisionSnapshotFromBreakdown, buildTripSnapshotFields } from "@/truelane/lib/costProfileSnapshot";
import { computeCostProfileFloorBreakdown } from "@/truelane/lib/domain/calculators";
import { num, numOrNull } from "./convert";
import { ASSUMED_AVG_MPH, profileMathInput, resolveLabour } from "./evaluate";

/**
 * Freeze what a load was booked with, so a later edit to the truck's cost profile never rewrites a load that is already agreed: the
 * break-even floor, the insurance and miles it was spread over, the truck's type of cost model and mpg, whether a carrier's cut came off
 * fuel surcharge, and the detention terms (only when the profile had a rate: a blank is not a contract term). Each is written once, when
 * it is still empty, as the phone does at Accept. The driver pay and the carrier's cut, which depend on who is driving, are written at
 * every assignment until the load is on the road.
 *
 * Runs inside the caller's transaction. Returns false when there was nothing to freeze (no truck, or a truck with no cost profile).
 */
export async function freezeLoadSnapshot(tx: Prisma.TransactionClient, loadId: string, opts: { labour: boolean }): Promise<boolean> {
  const l = await tx.load.findUnique({ where: { id: loadId }, include: { vehicle: { include: { costProfile: true } }, assignment: true } });
  const profile = l?.vehicle?.costProfile;
  if (!l || !profile) return false;

  const breakdown = computeCostProfileFloorBreakdown(profileMathInput(profile as never));
  const miles = num(l.pickupDeadheadMiles) + num(l.loadedMiles) + (l.isBackhaul ? 0 : num(l.returnDeadheadMiles));
  const decision = buildDecisionSnapshotFromBreakdown(breakdown, num(profile.estimatedMonthlyMiles));
  const labour = resolveLabour(profile as never, l.assignment, miles);
  const trip = buildTripSnapshotFields(
    {
      archetype: labour.archetype,
      carrierCutPct: numOrNull(profile.carrierCutPct),
      laborBurdenPct: labour.burden,
      hiredDriverHourlyRate: labour.hourlyRate,
      hiredDriverPayKind: labour.payKind,
      hiredDriverRatePerMile: labour.ratePerMile,
      fscCutApplies: profile.fscCutApplies,
      detentionHourlyRate: numOrNull(profile.detentionHourlyRate),
      freeGraceMinutes: profile.freeGraceMinutes
    },
    miles / ASSUMED_AVG_MPH,
    miles
  );

  const once: Record<string, unknown> = {
    snapshotBaseFloorRpm: decision.snapshotBaseFloorRpm,
    snapshotTotalInsuranceMonthly: decision.snapshotTotalInsuranceMonthly,
    snapshotEstimatedMonthlyMiles: decision.snapshotEstimatedMonthlyMiles,
    snapshotArchetype: decision.snapshotArchetype,
    snapshotMpg: numOrNull(l.vehicle?.mpg),
    snapshotFscCutApplies: trip.snapshotFscCutApplies,
    snapshotDetentionRate: trip.snapshotDetentionRate,
    snapshotFreeGraceMinutes: trip.snapshotFreeGraceMinutes
  };
  const row = l as unknown as Record<string, unknown>;
  const data: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(once)) if (row[k] == null && v != null) data[k] = v;
  if (opts.labour) {
    data.snapshotCarrierCutPct = trip.snapshotCarrierCutPct;
    data.snapshotLaborCpm = trip.snapshotLaborCpm;
  }
  if (Object.keys(data).length === 0) return false;
  await tx.load.update({ where: { id: loadId }, data: data as Prisma.LoadUncheckedUpdateInput });
  return true;
}
