// VENDORED from TrueLane lib/loadReadiness.ts @ a3a9c0f4. Do not edit; run scripts/vendor-truelane.mjs.
/**
 * What a load still needs before Start Trip — one rule, used by the Start Trip gate, the Loads
 * list's NEEDS DETAILS chip and the Load details checklist. Saving is never blocked by these.
 *
 * Trailer is required only when the app shows the trailer picker for the load's vehicle
 * (trailer-pulling trucks); cargo vans and box trucks are never asked.
 */
import { isTrailerSet } from '@/truelane/constants/trailerData';
import { isFieldRendered } from '@/truelane/lib/domain/fieldRelevance';

export type StartTripRequirement = 'weight' | 'loadNumber' | 'pickupNumber' | 'trailer';

export type StartTripReadinessInput = {
  weightLbs: number | null | undefined;
  loadNumber: string | null | undefined;
  /** Pickup-stop reference numbers plus load-level PU#s (either one counts). */
  pickupRefs: readonly string[];
  trailerType: string | null | undefined;
  trailerRequired: boolean;
};

export const START_TRIP_REQUIREMENT_LABEL: Record<StartTripRequirement, string> = {
  weight: 'weight',
  loadNumber: 'load number',
  pickupNumber: 'pickup number (PU# / Release # on a pickup stop)',
  trailer: 'trailer / equipment',
};

export function trailerRequiredForVehicle(vehicleType: string | null | undefined): boolean {
  return isFieldRendered(vehicleType, 'trailerType');
}

export function getStartTripMissing(i: StartTripReadinessInput): StartTripRequirement[] {
  const missing: StartTripRequirement[] = [];
  if (!(i.weightLbs != null && i.weightLbs > 0)) missing.push('weight');
  if (!(i.loadNumber ?? '').trim()) missing.push('loadNumber');
  if (!i.pickupRefs.some((r) => r.trim().length > 0)) missing.push('pickupNumber');
  if (i.trailerRequired && !isTrailerSet(i.trailerType)) missing.push('trailer');
  return missing;
}
