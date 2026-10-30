import { prisma } from "@/lib/db";
import { computeAnalytics, isRevenueLoad, type AnalyticsLoadInput } from "@/truelane/lib/analytics";
import { deadheadMilesOf, deadheadPct, drivenMiles } from "@/truelane/lib/domain/loadEconomics";
import { currentWorkspaceId } from "./workspace";

/**
 * The three figures in the header over every finished load: gross, average per mile, empty share. They come from the same vendored math as before
 * (computeAnalytics, deadheadPct), but the rows are read as plain numbers (one narrow query, no Decimal objects) and the answer is kept until a finished
 * load changes, so a screen does not re-add up tens of thousands of loads on every visit.
 */
export type FinishedTotals = { gross: number; avgRpm: number | null; emptyShare: number | null };

type Raw = {
  status: string;
  updated_at: Date;
  completed_at: Date | null;
  cancelled_at: Date | null;
  actual_revenue: number | null;
  quoted_revenue: number;
  fuel_surcharge: number | null;
  layover_pay: number | null;
  tonu_revenue: number | null;
  expense_fuel_actual: number;
  expense_tolls: number;
  expense_misc: number;
  pickup_deadhead_miles: number;
  loaded_miles: number;
  return_deadhead_miles: number;
  quoted_pickup_dh_miles: number | null;
  quoted_loaded_miles: number | null;
  quoted_return_dh_miles: number | null;
  is_backhaul: boolean;
  broker_name: string | null;
  origin_address: string | null;
  destination_address: string | null;
  market_benchmark: number | null;
};

const kept = new Map<string, { mark: string; value: FinishedTotals }>();
/** Tests clear it between cases. */
export const clearFinishedTotals = () => kept.clear();

function toInput(r: Raw): AnalyticsLoadInput {
  return {
    status: r.status,
    updatedAt: r.updated_at,
    completedAt: r.completed_at ? r.completed_at.getTime() : null,
    cancelledAt: r.cancelled_at ? r.cancelled_at.getTime() : null,
    actualRevenue: r.actual_revenue,
    quotedRevenue: r.quoted_revenue,
    fuelSurcharge: r.fuel_surcharge,
    layoverPay: r.layover_pay,
    tonuRevenue: r.tonu_revenue,
    expenseFuelActual: r.expense_fuel_actual,
    expenseTolls: r.expense_tolls,
    expenseMisc: r.expense_misc,
    pickupDeadheadMiles: r.pickup_deadhead_miles,
    loadedMiles: r.loaded_miles,
    returnDeadheadMiles: r.return_deadhead_miles,
    quotedPickupDhMiles: r.quoted_pickup_dh_miles,
    quotedLoadedMiles: r.quoted_loaded_miles,
    quotedReturnDhMiles: r.quoted_return_dh_miles,
    isBackhaul: r.is_backhaul,
    brokerName: r.broker_name,
    originAddress: r.origin_address,
    destinationAddress: r.destination_address,
    marketBenchmark: r.market_benchmark
  };
}

export async function finishedTotals(workspaceId = currentWorkspaceId(), now = new Date()): Promise<FinishedTotals> {
  // A finished load is added, edited, invoiced or deleted: any of those moves the newest update or the count.
  const [m] = await prisma.$queryRaw<Array<{ n: bigint; t: Date | null }>>`
    select count(*) as n, max(updated_at) as t from loads where workspace_id = ${workspaceId} and deleted_at is null and status in ('completed', 'tonu')`;
  const mark = `${m?.n ?? 0}:${m?.t ? m.t.getTime() : 0}`;
  const hit = kept.get(workspaceId);
  if (hit && hit.mark === mark) return hit.value;

  const rows = await prisma.$queryRaw<Raw[]>`
    select status, updated_at, completed_at, cancelled_at,
      actual_revenue::float8, quoted_revenue::float8, fuel_surcharge::float8, layover_pay::float8, tonu_revenue::float8,
      expense_fuel_actual::float8, expense_tolls::float8, expense_misc::float8,
      pickup_deadhead_miles::float8, loaded_miles::float8, return_deadhead_miles::float8,
      quoted_pickup_dh_miles::float8, quoted_loaded_miles::float8, quoted_return_dh_miles::float8,
      is_backhaul, broker_name, origin_address, destination_address, market_benchmark::float8
    from loads where workspace_id = ${workspaceId} and deleted_at is null and status in ('completed', 'tonu')`;
  const inputs = rows.map(toInput);
  const analytics = computeAnalytics(inputs, "all", now, { monthsBack: 1, topN: 1 });
  const finished = inputs.filter((l) => isRevenueLoad(l));
  const milesIn = (l: AnalyticsLoadInput) => ({
    status: l.status,
    isBackhaul: l.isBackhaul,
    pickupDeadheadMiles: l.pickupDeadheadMiles,
    loadedMiles: l.loadedMiles,
    returnDeadheadMiles: l.returnDeadheadMiles,
    quotedPickupDhMiles: l.quotedPickupDhMiles,
    quotedLoadedMiles: l.quotedLoadedMiles,
    quotedReturnDhMiles: l.quotedReturnDhMiles
  });
  const dh = deadheadPct(finished.map((l) => ({ drivenMiles: drivenMiles(milesIn(l)), deadheadMiles: deadheadMilesOf(milesIn(l)) })));
  const value: FinishedTotals = { gross: analytics.summary.grossRevenue, avgRpm: analytics.summary.avgRpm, emptyShare: dh == null ? null : dh / 100 };
  kept.set(workspaceId, { mark, value });
  return value;
}
