import { Prisma } from "@prisma/client";

export type CanonicalLoadLifecycleStatus =
  | "PLANNED"
  | "DISPATCHED"
  | "PICKED_UP"
  | "DELIVERED"
  | "POD_RECEIVED"
  | "COMPLETED"
  | "CANCELED"
  | "FAILED";

export type CanonicalTaskToggle = "DONE" | "NOT_DONE";
export type CanonicalRuleSeverity = "INFO" | "WARN" | "ACTION_REQUIRED";

export interface CanonicalFinancialInput {
  lineHaulRate: Prisma.Decimal;
  fscAmount: Prisma.Decimal;
  tonuAmount?: Prisma.Decimal | null;
}

export interface CanonicalMovementInput {
  loadedMiles: Prisma.Decimal;
  pickupDeadhead: Prisma.Decimal;
  deliveryDeadhead: Prisma.Decimal;
}

export interface KpiInclusionContext extends CanonicalFinancialInput, CanonicalMovementInput {
  status: string;
}

function decimalOrZero(value?: Prisma.Decimal | null): Prisma.Decimal {
  return value ?? new Prisma.Decimal(0);
}

export function mapToCanonicalLoadStatus(status: string): CanonicalLoadLifecycleStatus {
  const normalized = status.trim().toUpperCase();
  if (normalized === "BOOKED") return "PLANNED";
  if (normalized === "PLANNED") return "PLANNED";
  if (normalized === "DISPATCHED") return "DISPATCHED";
  if (normalized === "PICKED_UP") return "PICKED_UP";
  if (normalized === "DELIVERED") return "DELIVERED";
  if (normalized === "POD_RECEIVED") return "POD_RECEIVED";
  if (normalized === "COMPLETED") return "COMPLETED";
  if (normalized === "CANCELED") return "CANCELED";
  if (normalized === "FAILED") return "FAILED";
  throw new Error(`Unsupported load status: ${status}`);
}

export function computeAllInRevenue(input: CanonicalFinancialInput): Prisma.Decimal {
  // FSC parked (spot-broker-first): all-in = line haul (+ TONU). The fscAmount term is
  // intentionally excluded while fuel surcharge is neutralized; re-add it when direct-3PL
  // contract FSC returns. `input.fscAmount` is retained on the type for that future use.
  return input.lineHaulRate.plus(decimalOrZero(input.tonuAmount));
}

export function computeTripTotals(input: CanonicalMovementInput): {
  totalTripMiles: Prisma.Decimal;
  totalEmptyMiles: Prisma.Decimal;
  negotiableMiles: Prisma.Decimal;
} {
  const totalEmptyMiles = input.pickupDeadhead.plus(input.deliveryDeadhead);
  const totalTripMiles = input.loadedMiles.plus(totalEmptyMiles);
  const negotiableMiles = input.loadedMiles.plus(input.pickupDeadhead);
  return { totalTripMiles, totalEmptyMiles, negotiableMiles };
}

export function hasOperationalMovement(input: CanonicalMovementInput): boolean {
  const { totalTripMiles } = computeTripTotals(input);
  return totalTripMiles.greaterThan(0);
}

export function hasFinancialImpact(input: CanonicalFinancialInput): boolean {
  return computeAllInRevenue(input).greaterThan(0);
}

export function shouldIncludeInKpi(context: KpiInclusionContext): boolean {
  const canonicalStatus = mapToCanonicalLoadStatus(context.status);
  if (canonicalStatus !== "CANCELED" && canonicalStatus !== "FAILED") {
    return true;
  }
  // Section 9.2.1: canceled/failed remain included when movement occurred
  // or when there is direct financial impact (line-haul/FSC/TONU).
  return (
    hasOperationalMovement(context) ||
    hasFinancialImpact({
      lineHaulRate: context.lineHaulRate,
      fscAmount: context.fscAmount,
      tonuAmount: context.tonuAmount
    })
  );
}

export function assertMileMaxUsage(input: { level: "totals" | "lane"; reason?: string }): void {
  if (input.level !== "totals") {
    throw new Error(`MileMax invariant violated: totals-level only. ${input.reason ?? ""}`.trim());
  }
}

