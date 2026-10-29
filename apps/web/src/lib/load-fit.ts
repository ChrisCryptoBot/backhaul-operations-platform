import { detectEquipmentDrift } from "@/truelane/lib/domain/equipmentDrift";
import { computeOversize, type OversizeReason } from "@/truelane/lib/domain/oversize";

/**
 * Can this truck take this load? The phone's own checks (equipment drift for weight and size against what the truck holds, oversize against
 * the legal limits), put in the desk's words. Pure. A load with nothing typed about its size, weight or needs passes every truck, so a quote
 * with only an offer and miles prices exactly as it did before.
 *
 * A blocker is a limit the truck cannot meet (the load is heavier or bigger than the truck is rated for): that truck is not offered.
 * A warning is something to know and not a stop: a liftgate, ramp or pallet jack the truck is not marked as carrying, freight that is oversize
 * (permits and escorts are not in the verdict), a hazmat class.
 */
export type LoadSpecs = {
  weightLbs: number | null;
  lengthFt: number | null;
  widthFt: number | null;
  heightIn: number | null;
  hazmatClass: string | null;
  requiresLiftgate: boolean;
  requiresRamp: boolean;
  requiresPalletJack: boolean;
};

export type TruckLimits = {
  payloadLbs: number | null;
  maxLengthFt: number | null;
  maxWidthFt: number | null;
  maxHeightIn: number | null;
  hasLiftgate: boolean;
  hasRamp: boolean;
  hasPalletJack: boolean;
};

export type TruckFit = { blocker: string | null; warnings: string[] };

export const NO_SPECS: LoadSpecs = { weightLbs: null, lengthFt: null, widthFt: null, heightIn: null, hazmatClass: null, requiresLiftgate: false, requiresRamp: false, requiresPalletJack: false };

/** Whether anything about the load's size, weight or needs was typed. */
export const hasAnySpec = (s: LoadSpecs): boolean =>
  s.weightLbs != null || s.lengthFt != null || s.widthFt != null || s.heightIn != null || !!s.hazmatClass || s.requiresLiftgate || s.requiresRamp || s.requiresPalletJack;

const OVERSIZE_WORD: Record<OversizeReason, string> = { width: "wide", height: "tall", length: "long" };

/** The load's oversize reasons in a phrase, or null: "wide and tall". */
export function oversizeWords(s: Pick<LoadSpecs, "lengthFt" | "widthFt" | "heightIn">): string | null {
  const o = computeOversize({ widthFt: s.widthFt, heightIn: s.heightIn, lengthFt: s.lengthFt });
  if (!o.isOversize) return null;
  return o.reasons.map((r) => OVERSIZE_WORD[r]).join(" and ");
}

export function truckFit(specs: LoadSpecs, truck: TruckLimits): TruckFit {
  if (!hasAnySpec(specs)) return { blocker: null, warnings: [] };
  const drift = detectEquipmentDrift(
    { weightLbs: specs.weightLbs, lengthFt: specs.lengthFt, widthFt: specs.widthFt, heightIn: specs.heightIn, requiresLiftgate: specs.requiresLiftgate, requiresRamp: specs.requiresRamp, requiresPalletJack: specs.requiresPalletJack },
    { payloadLbs: truck.payloadLbs, maxLengthFt: truck.maxLengthFt, maxWidthFt: truck.maxWidthFt, maxHeightIn: truck.maxHeightIn, hasLiftgate: truck.hasLiftgate, hasRamp: truck.hasRamp, hasPalletJack: truck.hasPalletJack }
  );
  const blockers = drift.issues.filter((i) => i.level === "BLOCK").map((i) => i.message);
  const warnings = drift.issues.filter((i) => i.level === "WARNING").map((i) => i.message.replace("vehicle", "truck"));
  const wide = oversizeWords(specs);
  if (wide) warnings.push(`Oversize freight (${wide}): permits and escorts may be needed, and they are not in the verdict.`);
  if (specs.hazmatClass) warnings.push(`Hazmat class ${specs.hazmatClass}: check the truck and the driver can carry it.`);
  return { blocker: blockers.length > 0 ? blockers.map((m) => m.replace("vehicle", "truck")).join(" ") : null, warnings };
}
