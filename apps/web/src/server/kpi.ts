import { Prisma } from "@prisma/client";
import { safeDivideDecimal } from "@/lib/decimal-utils";
import { computeAllInRevenue } from "@/domain/semantics";

export interface LoadMetricInput {
  lineHaulRate: Prisma.Decimal;
  loadedMiles: Prisma.Decimal;
  puDeadheadMiles: Prisma.Decimal;
  delDeadheadMiles: Prisma.Decimal;
  fscApplies: boolean;
  fscRateUsed: Prisma.Decimal | null;
}

export interface LoadComputedMetrics {
  totalTripMiles: Prisma.Decimal;
  negotiableMiles: Prisma.Decimal;
  loadedRpm: Prisma.Decimal | null;
  emptyMilePct: Prisma.Decimal | null;
  fscAmount: Prisma.Decimal;
  allInRevenue: Prisma.Decimal;
}

function ensureDecimal(value: Prisma.Decimal): Prisma.Decimal {
  if (!(value instanceof Prisma.Decimal)) {
    throw new Error("KPI calculations require Prisma.Decimal values");
  }
  return value;
}

export function computeLoadMetrics(input: LoadMetricInput): LoadComputedMetrics {
  const lineHaulRate = ensureDecimal(input.lineHaulRate);
  const loadedMiles = ensureDecimal(input.loadedMiles);
  const puDeadheadMiles = ensureDecimal(input.puDeadheadMiles);
  const delDeadheadMiles = ensureDecimal(input.delDeadheadMiles);

  const totalTripMiles = loadedMiles.plus(puDeadheadMiles).plus(delDeadheadMiles);
  const negotiableMiles = loadedMiles.plus(puDeadheadMiles);
  const loadedRpm = safeDivideDecimal(lineHaulRate, loadedMiles);
  const emptyMiles = puDeadheadMiles.plus(delDeadheadMiles);
  const emptyMilePct = safeDivideDecimal(emptyMiles, totalTripMiles);
  // FSC parked (spot-broker-first): fuel surcharge contributes 0 regardless of fscApplies/
  // fscRateUsed (those columns are kept dormant for a future direct-3PL re-add).
  const fscAmount = new Prisma.Decimal(0);
  const allInRevenue = computeAllInRevenue({
    lineHaulRate,
    fscAmount
  });

  return {
    totalTripMiles,
    negotiableMiles,
    loadedRpm,
    emptyMilePct,
    fscAmount,
    allInRevenue
  };
}
