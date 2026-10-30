import { isOtherTrailer, trailerLabel } from "@/truelane/constants/trailerData";
import { trailerBlocker, trailerClearanceSoon, type TrailerCompliance } from "./trailer-clearance";

/**
 * Can this trailer take this load? Pure, in the shape of lib/load-fit.ts. A blocker is a limit the trailer cannot meet: the wrong kind of trailer, a load heavier
 * or longer than it is rated for, a trailer in the shop or out of service, a lapsed registration or inspection. A warning is something to know and not a stop: a
 * date coming due, a trailer hooked to a different tractor than the load's. A load with nothing typed about its trailer, weight or length passes every trailer, as a
 * quote with only an offer prices every truck.
 */
export type TrailerFacts = TrailerCompliance & {
  number: string;
  type: string | null;
  maxPayloadLbs: number | null;
  lengthFt: number | null;
  currentVehicleId: string | null;
};
export type LoadNeeds = { trailerType: string | null; weightLbs: number | null; lengthFt: number | null; vehicleId: string | null };
export type TrailerFit = { blocker: string | null; warnings: string[] };

export function trailerFit(load: LoadNeeds, trailer: TrailerFacts, now: Date, soonDays: number): TrailerFit {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const wanted = (load.trailerType ?? "").trim();
  // "Other" equipment is typed text with no list to compare against, so it is not a mismatch either way.
  if (wanted && trailer.type && !isOtherTrailer(wanted) && wanted !== trailer.type) blockers.push(`The load needs ${trailerLabel(wanted).toLowerCase()}; ${trailer.number} is ${trailerLabel(trailer.type).toLowerCase()}.`);
  if (load.weightLbs != null && trailer.maxPayloadLbs != null && load.weightLbs > trailer.maxPayloadLbs) blockers.push(`The load weighs ${load.weightLbs.toLocaleString("en-US")} lb; ${trailer.number} is rated for ${trailer.maxPayloadLbs.toLocaleString("en-US")} lb.`);
  if (load.lengthFt != null && trailer.lengthFt != null && load.lengthFt > trailer.lengthFt) blockers.push(`The load is ${load.lengthFt} ft long; ${trailer.number} is ${trailer.lengthFt} ft.`);
  const why = trailerBlocker(trailer, now);
  if (why) blockers.push(`${trailer.number}: ${why.toLowerCase()}.`);
  else {
    const soon = trailerClearanceSoon(trailer, now, soonDays);
    if (soon) warnings.push(`${trailer.number}'s ${soon.what} lapses in ${soon.inDays} ${soon.inDays === 1 ? "day" : "days"}.`);
  }
  if (load.vehicleId && trailer.currentVehicleId && trailer.currentVehicleId !== load.vehicleId) warnings.push(`${trailer.number} is hooked to another tractor than this load's.`);
  return { blocker: blockers.length > 0 ? blockers.join(" ") : null, warnings };
}
