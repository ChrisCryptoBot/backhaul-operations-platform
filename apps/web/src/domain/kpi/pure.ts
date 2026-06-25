import { Prisma } from "@prisma/client";
import { safeDivideDecimal } from "@/lib/decimal-utils";
import { shouldIncludeInKpi } from "@/domain/semantics";

export interface PureKpiLoadRow {
  status: string;
  lineHaulRate: Prisma.Decimal;
  fscAmount: Prisma.Decimal;
  tonuAmount?: Prisma.Decimal;
  allInRevenue?: Prisma.Decimal;
  loadedMiles: Prisma.Decimal;
  pickupDeadhead: Prisma.Decimal;
  deliveryDeadhead: Prisma.Decimal;
}

export interface PureWeekSnapshotTotals {
  loadCount: number;
  lineHaulRevenue: Prisma.Decimal;
  fuelSurchargeAmount: Prisma.Decimal;
  totalLoadedMiles: Prisma.Decimal;
  totalPickupDeadhead: Prisma.Decimal;
  totalDeliveryDeadhead: Prisma.Decimal;
  totalEmptyMiles: Prisma.Decimal;
  totalTripMiles: Prisma.Decimal;
  emptyMilePct: Prisma.Decimal | null;
  totalAllInRevenue: Prisma.Decimal;
  totalTonuAmount: Prisma.Decimal;
  inboundRevenue: Prisma.Decimal;
  inboundLoadedMiles: Prisma.Decimal;
  mileMaxMissingInbound: boolean;
  mileMaxRpm: Prisma.Decimal | null;
  /** Net Backhaul Yield = line haul ÷ total trip miles (loaded + all deadhead). */
  nby: Prisma.Decimal | null;
}

export function computeWeekSnapshotTotals(
  loadRows: PureKpiLoadRow[],
  input?: { inboundRevenue?: Prisma.Decimal; inboundLoadedMiles?: Prisma.Decimal }
): PureWeekSnapshotTotals {
  const included = loadRows.filter((load) =>
    shouldIncludeInKpi({
      status: load.status,
      lineHaulRate: load.lineHaulRate,
      fscAmount: load.fscAmount,
      loadedMiles: load.loadedMiles,
      pickupDeadhead: load.pickupDeadhead,
      deliveryDeadhead: load.deliveryDeadhead
    })
  );

  const lineHaulRevenue = included.reduce((acc, load) => acc.plus(load.lineHaulRate), new Prisma.Decimal(0));
  const fuelSurchargeAmount = included.reduce((acc, load) => acc.plus(load.fscAmount), new Prisma.Decimal(0));
  const totalTonuAmount = included.reduce((acc, load) => acc.plus(load.tonuAmount ?? new Prisma.Decimal(0)), new Prisma.Decimal(0));
  const totalAllInRevenue = included.reduce(
    (acc, load) => acc.plus(load.allInRevenue ?? load.lineHaulRate.plus(load.fscAmount).plus(load.tonuAmount ?? new Prisma.Decimal(0))),
    new Prisma.Decimal(0)
  );
  const totalLoadedMiles = included.reduce((acc, load) => acc.plus(load.loadedMiles), new Prisma.Decimal(0));
  const totalPickupDeadhead = included.reduce((acc, load) => acc.plus(load.pickupDeadhead), new Prisma.Decimal(0));
  const totalDeliveryDeadhead = included.reduce((acc, load) => acc.plus(load.deliveryDeadhead), new Prisma.Decimal(0));
  const totalEmptyMiles = totalPickupDeadhead.plus(totalDeliveryDeadhead);
  const totalTripMiles = totalLoadedMiles.plus(totalEmptyMiles);
  const inboundRevenue = input?.inboundRevenue ?? new Prisma.Decimal(0);
  const inboundLoadedMiles = input?.inboundLoadedMiles ?? new Prisma.Decimal(0);
  const hasInboundInput = inboundRevenue.greaterThan(0) || inboundLoadedMiles.greaterThan(0);
  const emptyMilePct = safeDivideDecimal(totalEmptyMiles, totalTripMiles);
  const mileMaxNumerator = totalAllInRevenue.plus(inboundRevenue);
  const mileMaxDenominator = totalTripMiles.plus(inboundLoadedMiles);
  const mileMaxRpm = hasInboundInput
    ? safeDivideDecimal(mileMaxNumerator, mileMaxDenominator)
    : safeDivideDecimal(lineHaulRevenue, totalLoadedMiles.plus(totalPickupDeadhead));
  const nby = safeDivideDecimal(lineHaulRevenue, totalTripMiles);

  return {
    loadCount: included.length,
    lineHaulRevenue,
    fuelSurchargeAmount,
    totalLoadedMiles,
    totalPickupDeadhead,
    totalDeliveryDeadhead,
    totalEmptyMiles,
    totalTripMiles,
    emptyMilePct,
    totalAllInRevenue,
    totalTonuAmount,
    inboundRevenue,
    inboundLoadedMiles,
    mileMaxMissingInbound: !hasInboundInput,
    mileMaxRpm,
    nby
  };
}

export interface KpiParityDiff {
  metric: keyof PureWeekSnapshotTotals;
  current: string | number | null;
  next: string | number | null;
}

export function diffWeekSnapshotTotals(current: PureWeekSnapshotTotals, next: PureWeekSnapshotTotals): KpiParityDiff[] {
  const metrics: Array<keyof PureWeekSnapshotTotals> = [
    "loadCount",
    "lineHaulRevenue",
    "fuelSurchargeAmount",
    "totalLoadedMiles",
    "totalPickupDeadhead",
    "totalDeliveryDeadhead",
    "totalEmptyMiles",
    "totalTripMiles",
    "emptyMilePct",
    "totalAllInRevenue",
    "totalTonuAmount",
    "inboundRevenue",
    "inboundLoadedMiles",
    "mileMaxMissingInbound",
    "mileMaxRpm",
    "nby"
  ];

  const diffs: KpiParityDiff[] = [];
  for (const metric of metrics) {
    const c = current[metric];
    const n = next[metric];
    const cValue = c instanceof Prisma.Decimal ? c.toString() : typeof c === "boolean" ? String(c) : c;
    const nValue = n instanceof Prisma.Decimal ? n.toString() : typeof n === "boolean" ? String(n) : n;
    if (cValue !== nValue) {
      diffs.push({
        metric,
        current: cValue ?? null,
        next: nValue ?? null
      });
    }
  }
  return diffs;
}

