import type { Prisma } from "@prisma/client";
import type { LoadSpecs, TruckLimits } from "@/lib/load-fit";
import { numOrNull } from "./convert";

/**
 * A truck and a load as the load check (`truckFit`, src/lib/load-fit.ts) reads them, from their database rows. Kept apart from quote.ts and dispatch.ts so either can use it without
 * importing the other.
 */

/** What a truck holds and carries. */
export const truckLimits = (t: { payloadLbs: number | null; maxLengthFt: Prisma.Decimal | null; maxWidthFt: Prisma.Decimal | null; maxHeightIn: Prisma.Decimal | null; hasLiftgate: boolean; hasRamp: boolean; hasPalletJack: boolean }): TruckLimits => ({
  payloadLbs: t.payloadLbs,
  maxLengthFt: numOrNull(t.maxLengthFt),
  maxWidthFt: numOrNull(t.maxWidthFt),
  maxHeightIn: numOrNull(t.maxHeightIn),
  hasLiftgate: t.hasLiftgate,
  hasRamp: t.hasRamp,
  hasPalletJack: t.hasPalletJack
});

/** What a load needs of a truck. */
export const loadSpecsOf = (l: {
  weightLbs: number | null;
  lengthFt: Prisma.Decimal | null;
  widthFt: Prisma.Decimal | null;
  loadHeightIn: Prisma.Decimal | null;
  hazmatClass: string | null;
  requiresLiftgate: boolean | null;
  requiresRamp: boolean | null;
  requiresPalletJack: boolean | null;
}): LoadSpecs => ({
  weightLbs: l.weightLbs,
  lengthFt: numOrNull(l.lengthFt),
  widthFt: numOrNull(l.widthFt),
  heightIn: numOrNull(l.loadHeightIn),
  hazmatClass: l.hazmatClass,
  requiresLiftgate: l.requiresLiftgate === true,
  requiresRamp: l.requiresRamp === true,
  requiresPalletJack: l.requiresPalletJack === true
});
