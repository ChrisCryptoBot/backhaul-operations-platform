import { Prisma } from "@prisma/client";
import type { AgingLoadView } from "@/truelane/lib/invoice";
import type { AnalyticsLoadInput } from "@/truelane/lib/analytics";
import type { MarketVarianceLoad } from "@/truelane/lib/domain/marketVariance";

/**
 * Adapters from the TrueLane-shaped rows to the inputs of the vendored phone math. The phone stores money and
 * miles as numbers and times as epoch ms; the database uses Decimal and timestamptz.
 */
type Dec = Prisma.Decimal | number | string | null | undefined;

export const num = (d: Dec): number => (d == null ? 0 : new Prisma.Decimal(d).toNumber());
export const numOrNull = (d: Dec): number | null => (d == null ? null : new Prisma.Decimal(d).toNumber());
export const ms = (d: Date | null | undefined): number | null => (d ? d.getTime() : null);

/** The columns of `loads` that every adapter reads. */
export type TlLoadRow = {
  status: string;
  updatedAt: Date;
  completedAt: Date | null;
  cancelledAt: Date | null;
  actualRevenue: Dec;
  quotedRevenue: Dec;
  fuelSurcharge: Dec;
  layoverPay: Dec;
  tonuRevenue: Dec;
  expenseFuelActual: Dec;
  expenseTolls: Dec;
  expenseMisc: Dec;
  pickupDeadheadMiles: Dec;
  loadedMiles: Dec;
  returnDeadheadMiles: Dec;
  quotedPickupDhMiles: Dec;
  quotedLoadedMiles: Dec;
  quotedReturnDhMiles: Dec;
  isBackhaul: boolean;
  brokerName: string | null;
  originAddress: string | null;
  destinationAddress: string | null;
  marketBenchmark: Dec;
  paymentStatus: string | null;
  invoicedAt: Date | null;
  payTermsDays: number | null;
  invoicedAmount: Dec;
};

export function toAnalyticsInput(l: TlLoadRow): AnalyticsLoadInput {
  return {
    status: l.status,
    updatedAt: l.updatedAt,
    completedAt: ms(l.completedAt),
    cancelledAt: ms(l.cancelledAt),
    actualRevenue: numOrNull(l.actualRevenue),
    quotedRevenue: num(l.quotedRevenue),
    fuelSurcharge: numOrNull(l.fuelSurcharge),
    layoverPay: numOrNull(l.layoverPay),
    tonuRevenue: numOrNull(l.tonuRevenue),
    expenseFuelActual: num(l.expenseFuelActual),
    expenseTolls: num(l.expenseTolls),
    expenseMisc: num(l.expenseMisc),
    pickupDeadheadMiles: num(l.pickupDeadheadMiles),
    loadedMiles: num(l.loadedMiles),
    returnDeadheadMiles: num(l.returnDeadheadMiles),
    quotedPickupDhMiles: numOrNull(l.quotedPickupDhMiles),
    quotedLoadedMiles: numOrNull(l.quotedLoadedMiles),
    quotedReturnDhMiles: numOrNull(l.quotedReturnDhMiles),
    isBackhaul: l.isBackhaul,
    brokerName: l.brokerName,
    originAddress: l.originAddress,
    destinationAddress: l.destinationAddress,
    marketBenchmark: numOrNull(l.marketBenchmark)
  };
}

export function toAgingView(l: TlLoadRow): AgingLoadView {
  return {
    paymentStatus: l.paymentStatus,
    invoicedAt: ms(l.invoicedAt),
    payTermsDays: l.payTermsDays,
    quotedRevenue: num(l.quotedRevenue),
    fuelSurcharge: numOrNull(l.fuelSurcharge),
    invoicedAmount: numOrNull(l.invoicedAmount)
  };
}

export function toMarketVarianceLoad(l: TlLoadRow): MarketVarianceLoad {
  return {
    status: l.status,
    quotedRevenue: num(l.quotedRevenue),
    actualRevenue: numOrNull(l.actualRevenue),
    fuelSurcharge: numOrNull(l.fuelSurcharge),
    marketBenchmark: numOrNull(l.marketBenchmark),
    pickupDeadheadMiles: num(l.pickupDeadheadMiles),
    loadedMiles: num(l.loadedMiles),
    returnDeadheadMiles: num(l.returnDeadheadMiles),
    quotedPickupDhMiles: numOrNull(l.quotedPickupDhMiles),
    quotedLoadedMiles: numOrNull(l.quotedLoadedMiles),
    quotedReturnDhMiles: numOrNull(l.quotedReturnDhMiles)
  };
}
