import { Prisma } from "@prisma/client";
import { runInRegionScope } from "@/lib/db";
import { safeDivideDecimal } from "@/lib/decimal-utils";
import { computeComparisonInsights } from "@/server/kpi-comparisons";
import { evaluateKpiAlerts, hydrateAlertAcknowledgements } from "@/server/kpi-alerts";
import { assertMileMaxUsage, shouldIncludeInKpi } from "@/domain/semantics";
import { kpiContractVersion } from "@/contracts/kpi";
import { decodeLaneWeekMetadata } from "@/server/lane-week-metadata";
import { getRegionConfig } from "@/server/region-config";

export type ComparisonMode = "wow" | "rolling4" | "qtd";

export interface KpiDashboardFilters {
  lane?: string;
  broker?: string;
  lot?: string;
  severity?: "INFO" | "WARN" | "ACTION_REQUIRED";
}

type NumericLike = Prisma.Decimal | number | string | null;

function toNumber(value: NumericLike): number | null {
  if (value === null) {
    return null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  try {
    const parsed = new Prisma.Decimal(value).toNumber();
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function toStringNumber(value: NumericLike): string {
  if (value === null) {
    return "0";
  }
  if (typeof value === "string") {
    return value;
  }
  return value.toString();
}

function buildCardDelta(current: number | null, prior: number | null): { delta: number | null; noPrior: boolean } {
  if (current === null || prior === null) {
    return { delta: null, noPrior: true };
  }
  return { delta: current - prior, noPrior: false };
}

function laneLabel(input: { pickupCity: string | null; pickupState: string | null; deliveryCity: string | null; deliveryState: string | null }): string {
  const from = `${input.pickupCity ?? "Unknown"}, ${input.pickupState ?? "??"}`;
  const to = `${input.deliveryCity ?? "Unknown"}, ${input.deliveryState ?? "??"}`;
  return `${from} → ${to}`;
}

function normalizePart(value: string | null | undefined): string {
  return (value ?? "").trim().toUpperCase();
}

function laneKey(input: {
  pickupCity: string | null;
  pickupState: string | null;
  deliveryCity: string | null;
  deliveryState: string | null;
}): string {
  return [
    normalizePart(input.pickupCity),
    normalizePart(input.pickupState),
    normalizePart(input.deliveryCity),
    normalizePart(input.deliveryState)
  ].join("|");
}

type SnapshotRow = {
  weekIso: string;
  loadCount: number;
  lineHaulRevenue: number | string;
  totalAllInRevenue: number | string;
  totalTonuAmount: number | string;
  fuelSurchargeAmount: number | string;
  totalLoadedMiles: number | string;
  totalPickupDeadhead: number | string;
  totalDeliveryDeadhead: number | string;
  totalEmptyMiles: number | string;
  totalTripMiles: number | string;
  inboundRevenue: number | string;
  inboundLoadedMiles: number | string;
  mileMaxMissingInbound: boolean;
  mileMaxRpm: number | string | null;
  emptyMilePct: number | string | null;
  laneIssueNotes: unknown;
};

/** Net Backhaul Yield = line haul ÷ total trip miles (loaded + all deadhead), totals-level. */
function snapshotNby(row: SnapshotRow): string | null {
  const nby = safeDivideDecimal(new Prisma.Decimal(row.lineHaulRevenue), new Prisma.Decimal(row.totalTripMiles));
  return nby?.toString() ?? null;
}

async function fetchSnapshotRows(
  tx: { $queryRaw: <T>(query: Prisma.Sql) => Promise<T> },
  input: { regionId: string; weekIso: string; limit: number }
): Promise<SnapshotRow[]> {
  const rows = await tx.$queryRaw<Array<{ payload: Record<string, unknown> }>>(Prisma.sql`
    SELECT row_to_json(ws)::jsonb AS payload
    FROM "WeekSnapshot" ws
    WHERE ws."regionId" = ${input.regionId}
      AND ws."weekIso" <= ${input.weekIso}
    ORDER BY ws."weekIso" DESC
    LIMIT ${input.limit}
  `);
  return rows.map((row) => {
    const payload = (row.payload ?? row) as Record<string, unknown>;
    const lineHaulRevenue = (payload.lineHaulRevenue as number | string | null) ?? "0";
    const fuelSurchargeAmount = (payload.fuelSurchargeAmount as number | string | null) ?? "0";
    const inferredAllIn = new Prisma.Decimal(lineHaulRevenue).plus(new Prisma.Decimal(fuelSurchargeAmount));
    return {
      weekIso: String(payload.weekIso ?? input.weekIso),
      loadCount: toNumber((payload.loadCount as number | string | null | undefined) ?? 0) ?? 0,
      lineHaulRevenue,
      totalAllInRevenue: (payload.totalAllInRevenue as number | string | null) ?? inferredAllIn.toString(),
      totalTonuAmount: (payload.totalTonuAmount as number | string | null) ?? "0",
      fuelSurchargeAmount,
      totalLoadedMiles: (payload.totalLoadedMiles as number | string | null) ?? "0",
      totalPickupDeadhead: (payload.totalPickupDeadhead as number | string | null) ?? "0",
      totalDeliveryDeadhead: (payload.totalDeliveryDeadhead as number | string | null) ?? "0",
      totalEmptyMiles: (payload.totalEmptyMiles as number | string | null) ?? "0",
      totalTripMiles: (payload.totalTripMiles as number | string | null) ?? "0",
      inboundRevenue: (payload.inboundRevenue as number | string | null) ?? "0",
      inboundLoadedMiles: (payload.inboundLoadedMiles as number | string | null) ?? "0",
      mileMaxMissingInbound: (payload.mileMaxMissingInbound as boolean | null) ?? true,
      mileMaxRpm: (payload.mileMaxRpm as number | string | null | undefined) ?? null,
      emptyMilePct: (payload.emptyMilePct as number | string | null | undefined) ?? null,
      laneIssueNotes: payload.laneIssueNotes
    };
  });
}

type WeeklyLoadChartRow = {
  weekIso: string;
  status: string;
  tonuAmount: number | string;
};

async function fetchWeeklyLoadChartRows(
  tx: { $queryRaw: <T>(query: Prisma.Sql) => Promise<T> },
  input: { regionId: string; weekIsos: string[] }
): Promise<WeeklyLoadChartRow[]> {
  if (input.weekIsos.length === 0) return [];
  const rows = await tx.$queryRaw<Array<{ payload: Record<string, unknown> }>>(Prisma.sql`
    SELECT row_to_json(l)::jsonb AS payload
    FROM "Load" l
    WHERE l."regionId" = ${input.regionId}
      AND l."deletedAt" IS NULL
      AND l."weekIso" IN (${Prisma.join(input.weekIsos.map((weekIso) => Prisma.sql`${weekIso}`))})
  `);
  return rows.map((row) => {
    const payload = (row.payload ?? row) as Record<string, unknown>;
    return {
      weekIso: String(payload.weekIso ?? ""),
      status: String(payload.status ?? ""),
      tonuAmount: (payload.tonuAmount as number | string | null) ?? "0"
    };
  });
}

type ScorecardLoadRow = {
  status: string;
  pickupCity: string | null;
  pickupState: string | null;
  deliveryCity: string | null;
  deliveryState: string | null;
  lineHaulRate: number | string;
  loadedMiles: number | string;
  puDeadheadMiles: number | string;
  delDeadheadMiles: number | string;
  fscAmount: number | string;
  tonuAmount: number | string;
  driverType: string | null;
  brokerId: string | null;
  dropLotId: string | null;
};

async function fetchScorecardLoads(
  tx: { $queryRaw: <T>(query: Prisma.Sql) => Promise<T> },
  input: { regionId: string; weekIso: string }
): Promise<ScorecardLoadRow[]> {
  const rows = await tx.$queryRaw<Array<{ payload: Record<string, unknown> }>>(Prisma.sql`
    SELECT row_to_json(l)::jsonb AS payload
    FROM "Load" l
    WHERE l."regionId" = ${input.regionId}
      AND l."weekIso" = ${input.weekIso}
      AND l."deletedAt" IS NULL
  `);
  return rows.map((row) => {
    const payload = (row.payload ?? row) as Record<string, unknown>;
    return {
    status: String(payload.status ?? "UNKNOWN"),
    pickupCity: (payload.pickupCity as string | null | undefined) ?? null,
    pickupState: (payload.pickupState as string | null | undefined) ?? null,
    deliveryCity: (payload.deliveryCity as string | null | undefined) ?? null,
    deliveryState: (payload.deliveryState as string | null | undefined) ?? null,
    lineHaulRate: (payload.lineHaulRate as number | string | null) ?? "0",
    loadedMiles: (payload.loadedMiles as number | string | null) ?? "0",
    puDeadheadMiles: (payload.puDeadheadMiles as number | string | null) ?? "0",
    delDeadheadMiles: (payload.delDeadheadMiles as number | string | null) ?? "0",
    fscAmount: (payload.fscAmount as number | string | null) ?? "0",
    tonuAmount: (payload.tonuAmount as number | string | null) ?? "0",
    driverType: (payload.driverType as string | null | undefined) ?? null,
    brokerId: (payload.brokerId as string | null | undefined) ?? null,
    dropLotId: (payload.dropLotId as string | null | undefined) ?? null
    };
  });
}

type DrilldownLoadRow = {
  weekIso: string;
  status: string;
  pickupCity: string | null;
  pickupState: string | null;
  deliveryCity: string | null;
  deliveryState: string | null;
  lineHaulRate: number | string;
  fscAmount: number | string;
  tonuAmount: number | string;
  loadedMiles: number | string;
  puDeadheadMiles: number | string;
  delDeadheadMiles: number | string;
};

async function fetchDrilldownLoads(
  tx: { $queryRaw: <T>(query: Prisma.Sql) => Promise<T> },
  input: { regionId: string; weekIso: string; limit: number }
): Promise<DrilldownLoadRow[]> {
  const rows = await tx.$queryRaw<Array<{ payload: Record<string, unknown> }>>(Prisma.sql`
    SELECT row_to_json(l)::jsonb AS payload
    FROM "Load" l
    WHERE l."regionId" = ${input.regionId}
      AND l."weekIso" <= ${input.weekIso}
      AND l."deletedAt" IS NULL
    ORDER BY l."weekIso" DESC
    LIMIT ${input.limit}
  `);
  return rows.map((row) => {
    const payload = (row.payload ?? row) as Record<string, unknown>;
    return {
    weekIso: String(payload.weekIso ?? input.weekIso),
    status: String(payload.status ?? "UNKNOWN"),
    pickupCity: (payload.pickupCity as string | null | undefined) ?? null,
    pickupState: (payload.pickupState as string | null | undefined) ?? null,
    deliveryCity: (payload.deliveryCity as string | null | undefined) ?? null,
    deliveryState: (payload.deliveryState as string | null | undefined) ?? null,
    lineHaulRate: (payload.lineHaulRate as number | string | null) ?? "0",
    fscAmount: (payload.fscAmount as number | string | null) ?? "0",
    tonuAmount: (payload.tonuAmount as number | string | null) ?? "0",
    loadedMiles: (payload.loadedMiles as number | string | null) ?? "0",
    puDeadheadMiles: (payload.puDeadheadMiles as number | string | null) ?? "0",
    delDeadheadMiles: (payload.delDeadheadMiles as number | string | null) ?? "0"
    };
  });
}

export async function getWeeklyTrend(input: {
  regionId: string;
  weekIso: string;
  weeks: number;
}) {
  return runInRegionScope(input.regionId, async (tx) => {
    const rows = await fetchSnapshotRows(tx, {
      regionId: input.regionId,
      weekIso: input.weekIso,
      limit: input.weeks
    });
    return rows.reverse().map((row) => ({
      week: row.weekIso.split("-")[1] ?? row.weekIso,
      loads: row.loadCount,
      rev: toStringNumber(row.lineHaulRevenue),
      empty: (toNumber(row.emptyMilePct) ?? 0) * 100,
      nby: snapshotNby(row),
      mileMax: row.mileMaxRpm === null ? null : toStringNumber(row.mileMaxRpm)
    }));
  });
}

export async function getLaneScorecard(input: {
  regionId: string;
  weekIso: string;
  filters?: KpiDashboardFilters;
  manualTargetRates?: Record<string, string>;
}) {
  return runInRegionScope(input.regionId, async (tx) => {
    const [loads, lanes, brokers, lots] = await Promise.all([
      fetchScorecardLoads(tx, { regionId: input.regionId, weekIso: input.weekIso }),
      tx.$queryRaw<
        Array<{
          originCity: string;
          originState: string;
          destinationCity: string;
          destinationState: string;
          targetRate: number | string;
        }>
      >(Prisma.sql`
        SELECT "originCity", "originState", "destinationCity", "destinationState", "targetRate"
        FROM "Lane"
        WHERE "regionId" = ${input.regionId}
          AND "deletedAt" IS NULL
      `),
      tx.$queryRaw<Array<{ id: string; name: string }>>(Prisma.sql`
        SELECT "id", "name"
        FROM "Broker"
        WHERE "regionId" = ${input.regionId}
          AND "deletedAt" IS NULL
      `),
      tx.$queryRaw<Array<{ id: string; name: string }>>(Prisma.sql`
        SELECT "id", "name"
        FROM "DropLot"
        WHERE "regionId" = ${input.regionId}
      `)
    ]);
    const brokerById = new Map(brokers.map((broker) => [broker.id, broker.name]));
    const lotById = new Map(lots.map((lot) => [lot.id, lot.name]));

    const targetByKey = new Map<string, Prisma.Decimal>();
    for (const lane of lanes) {
      const key = laneKey({
        pickupCity: lane.originCity,
        pickupState: lane.originState,
        deliveryCity: lane.destinationCity,
        deliveryState: lane.destinationState
      });
      targetByKey.set(key, new Prisma.Decimal(lane.targetRate));
    }

    const grouped = new Map<
      string,
      {
        lane: string;
        key: string;
        loads: number;
        revenue: Prisma.Decimal;
        loadedMiles: Prisma.Decimal;
        puDh: Prisma.Decimal;
        delDh: Prisma.Decimal;
        fsc: Prisma.Decimal;
        tonu: Prisma.Decimal;
        driverTypes: Set<string>;
      }
    >();

    const activeLoads = loads.filter((load) => {
      if (
        !shouldIncludeInKpi({
          status: load.status,
          lineHaulRate: new Prisma.Decimal(load.lineHaulRate),
          fscAmount: new Prisma.Decimal(load.fscAmount),
          tonuAmount: new Prisma.Decimal(load.tonuAmount),
          loadedMiles: new Prisma.Decimal(load.loadedMiles),
          pickupDeadhead: new Prisma.Decimal(load.puDeadheadMiles),
          deliveryDeadhead: new Prisma.Decimal(load.delDeadheadMiles)
        })
      ) {
        return false;
      }
      if (input.filters?.broker) {
        const brokerName = load.brokerId ? brokerById.get(load.brokerId) : null;
        if (!brokerName || brokerName !== input.filters.broker) return false;
      }
      if (input.filters?.lot) {
        const lotName = load.dropLotId ? lotById.get(load.dropLotId) : null;
        if (!lotName || lotName !== input.filters.lot) return false;
      }
      return true;
    });
    for (const load of activeLoads) {
      const key = laneKey(load);
      const existing = grouped.get(key) ?? {
        lane: laneLabel(load),
        key,
        loads: 0,
        revenue: new Prisma.Decimal(0),
        loadedMiles: new Prisma.Decimal(0),
        puDh: new Prisma.Decimal(0),
        delDh: new Prisma.Decimal(0),
        fsc: new Prisma.Decimal(0),
        tonu: new Prisma.Decimal(0),
        driverTypes: new Set<string>()
      };
      existing.loads += 1;
      existing.revenue = existing.revenue.plus(new Prisma.Decimal(load.lineHaulRate));
      existing.loadedMiles = existing.loadedMiles.plus(new Prisma.Decimal(load.loadedMiles));
      existing.puDh = existing.puDh.plus(new Prisma.Decimal(load.puDeadheadMiles));
      existing.delDh = existing.delDh.plus(new Prisma.Decimal(load.delDeadheadMiles));
      existing.fsc = existing.fsc.plus(new Prisma.Decimal(load.fscAmount));
      existing.tonu = existing.tonu.plus(new Prisma.Decimal(load.tonuAmount));
      if (load.driverType) existing.driverTypes.add(load.driverType);
      grouped.set(key, existing);
    }

    const mapped = Array.from(grouped.values())
      .sort((a, b) => b.loads - a.loads)
      .map((row) => {
        const laneDefaultTarget = targetByKey.get(row.key) ?? null;
        const manualTargetInput = input.manualTargetRates?.[row.lane] ?? null;
        let manualTarget: Prisma.Decimal | null = null;
        if (manualTargetInput) {
          try {
            manualTarget = new Prisma.Decimal(manualTargetInput);
          } catch {
            manualTarget = null;
          }
        }
        const target = manualTarget ?? laneDefaultTarget;
        const emptyPct = safeDivideDecimal(row.puDh.plus(row.delDh), row.loadedMiles.plus(row.puDh).plus(row.delDh));
        const nby = safeDivideDecimal(row.revenue, row.loadedMiles.plus(row.puDh).plus(row.delDh));
        const revLoad = safeDivideDecimal(row.revenue, new Prisma.Decimal(row.loads));
        const vsTarget = target && revLoad ? revLoad.minus(target) : null;
        const status: "ON_TARGET" | "BELOW_NEAR" | "BELOW" | "NO_LOADS" = !target
          ? "NO_LOADS"
          : !vsTarget
            ? "NO_LOADS"
            : vsTarget.greaterThanOrEqualTo(0)
              ? "ON_TARGET"
              : vsTarget.greaterThanOrEqualTo(-100)
                ? "BELOW_NEAR"
                : "BELOW";
        const targetSource: "MANUAL_WEEKLY" | "LANE_DEFAULT" | "NONE" = manualTarget
          ? "MANUAL_WEEKLY"
          : laneDefaultTarget
            ? "LANE_DEFAULT"
            : "NONE";
        return {
          lane: row.lane,
          target: target?.toString() ?? null,
          loads: row.loads,
          revenue: row.revenue.toString(),
          vsTarget: vsTarget?.toString() ?? null,
          emptyPct: emptyPct ? emptyPct.toNumber() * 100 : null,
          nby: nby?.toString() ?? null,
          fsc: row.fsc.toString(),
          tonu: row.tonu.toString(),
          driverType: row.driverTypes.size > 0 ? Array.from(row.driverTypes).sort().join(", ") : null,
          revLoad: revLoad?.toString() ?? null,
          targetSource,
          status
        };
      });
    return mapped.filter((row) => {
      if (input.filters?.lane && row.lane !== input.filters.lane) return false;
      if (input.filters?.severity) {
        if (input.filters.severity === "ACTION_REQUIRED" && row.status !== "BELOW") return false;
        if (input.filters.severity === "WARN" && row.status !== "BELOW_NEAR") return false;
        if (input.filters.severity === "INFO" && row.status === "BELOW") return false;
      }
      return true;
    });
  });
}

async function getLaneDrilldowns(input: {
  regionId: string;
  weekIso: string;
  weeks: number;
  lanes: Array<{ lane: string }>;
}) {
  return runInRegionScope(input.regionId, async (tx) => {
    const rows = await fetchDrilldownLoads(tx, {
      regionId: input.regionId,
      weekIso: input.weekIso,
      limit: input.weeks * 200
    });
    const allowedLanes = new Set(input.lanes.map((lane) => lane.lane));
    const bucket = new Map<string, Map<string, { loads: number; rev: number; emptyMiles: number; totalMiles: number }>>();
    for (const row of rows) {
      const loadedMiles = toNumber(row.loadedMiles) ?? 0;
      const pu = toNumber(row.puDeadheadMiles) ?? 0;
      const del = toNumber(row.delDeadheadMiles) ?? 0;
      const totalTripMiles = loadedMiles + pu + del;
      const lineHaulRate = toNumber(row.lineHaulRate) ?? 0;
      const fscAmount = toNumber(row.fscAmount) ?? 0;
      if (
        !shouldIncludeInKpi({
          status: row.status,
          lineHaulRate: new Prisma.Decimal(lineHaulRate),
          fscAmount: new Prisma.Decimal(fscAmount),
          tonuAmount: new Prisma.Decimal(row.tonuAmount),
          loadedMiles: new Prisma.Decimal(loadedMiles),
          pickupDeadhead: new Prisma.Decimal(pu),
          deliveryDeadhead: new Prisma.Decimal(del)
        })
      ) {
        continue;
      }
      const lane = laneLabel(row);
      if (!allowedLanes.has(lane)) continue;
      const week = (row.weekIso.split("-")[1] ?? row.weekIso).toUpperCase();
      const laneMap = bucket.get(lane) ?? new Map();
      const agg = laneMap.get(week) ?? { loads: 0, rev: 0, emptyMiles: 0, totalMiles: 0 };
      agg.loads += 1;
      agg.rev += lineHaulRate;
      agg.emptyMiles += pu + del;
      agg.totalMiles += totalTripMiles;
      laneMap.set(week, agg);
      bucket.set(lane, laneMap);
    }
    return Array.from(bucket.entries()).map(([lane, laneMap]) => ({
      lane,
      trend: Array.from(laneMap.entries())
        .sort((a, b) => a[0].localeCompare(b[0]))
        .slice(-input.weeks)
        .map(([week, agg]) => ({
          week,
          loads: agg.loads,
          rev: agg.rev.toFixed(0),
          empty: agg.totalMiles > 0 ? ((agg.emptyMiles / agg.totalMiles) * 100).toFixed(1) : "0.0"
        }))
    }));
  });
}

async function buildChartCatalog(input: {
  tx: { $queryRaw: <T>(query: Prisma.Sql) => Promise<T> };
  regionId: string;
  weekIso: string;
  weeks: number;
}) {
  const snapshotRows = (
    await fetchSnapshotRows(input.tx, {
      regionId: input.regionId,
      weekIso: input.weekIso,
      limit: input.weeks
    })
  ).reverse();

  const weekIsos = snapshotRows.map((row) => row.weekIso);
  const loadRows = await fetchWeeklyLoadChartRows(input.tx, { regionId: input.regionId, weekIsos });
  const tonuByWeek = new Map<string, { events: number; amount: Prisma.Decimal }>();
  for (const weekIso of weekIsos) {
    tonuByWeek.set(weekIso, { events: 0, amount: new Prisma.Decimal(0) });
  }
  for (const row of loadRows) {
    const bucket = tonuByWeek.get(row.weekIso);
    if (!bucket) continue;
    const tonuAmount = new Prisma.Decimal(row.tonuAmount);
    const statusHasTonu = row.status.toUpperCase().includes("TONU");
    if (statusHasTonu || tonuAmount.greaterThan(0)) {
      bucket.events += 1;
    }
    if (tonuAmount.greaterThan(0)) {
      bucket.amount = bucket.amount.plus(tonuAmount);
    }
  }

  return {
    weeklyRevenueTrend: snapshotRows.map((row) => ({
      weekIso: row.weekIso,
      totalAllInRevenue: toNumber(row.totalAllInRevenue) ?? 0
    })),
    emptyMilePctTrend: snapshotRows.map((row) => ({
      weekIso: row.weekIso,
      emptyMilePct: (toNumber(row.emptyMilePct) ?? 0) * 100
    })),
    mileMaxRpmTrend: snapshotRows.map((row) => ({
      weekIso: row.weekIso,
      mileMaxRpm: toNumber(row.mileMaxRpm) ?? 0
    })),
    deadheadMixTrend: snapshotRows.map((row) => {
      const pickupDeadhead = toNumber(row.totalPickupDeadhead) ?? 0;
      const deliveryDeadhead = toNumber(row.totalDeliveryDeadhead) ?? 0;
      const emptyMiles = toNumber(row.totalEmptyMiles) ?? pickupDeadhead + deliveryDeadhead;
      return {
        weekIso: row.weekIso,
        loadedMiles: toNumber(row.totalLoadedMiles) ?? 0,
        pickupDeadhead,
        deliveryDeadhead,
        emptyMiles
      };
    }),
    revenueSplitTrend: snapshotRows.map((row) => {
      const linehaul = new Prisma.Decimal(row.lineHaulRevenue);
      const fsc = new Prisma.Decimal(row.fuelSurchargeAmount);
      const tonu = new Prisma.Decimal(row.totalTonuAmount);
      const allIn = new Prisma.Decimal(row.totalAllInRevenue);
      return {
        weekIso: row.weekIso,
        baseRevenue: linehaul.toNumber(),
        fscRevenue: fsc.toNumber(),
        tonuAmount: tonu.toNumber(),
        totalAllInRevenue: allIn.toNumber()
      };
    }),
    tonuEventsTrend: snapshotRows.map((row) => {
      const tonu = tonuByWeek.get(row.weekIso) ?? { events: 0, amount: new Prisma.Decimal(0) };
      return {
        weekIso: row.weekIso,
        tonuEvents: tonu.events,
        tonuAmount: tonu.amount.toNumber()
      };
    })
  };
}

export async function getKpiDashboard(input: {
  regionId: string;
  weekIso: string;
  weeks?: number;
  comparisonMode?: ComparisonMode;
  filters?: KpiDashboardFilters;
}) {
  const trendWeeks = input.weeks ?? 12;
  return runInRegionScope(input.regionId, async (tx) => {
    const snapshots = await fetchSnapshotRows(tx, { regionId: input.regionId, weekIso: input.weekIso, limit: 2 });
    const rules = await tx
      .$queryRaw<
        Array<{
          code: string;
          severity: "INFO" | "WARN" | "ACTION_REQUIRED";
          statement: string;
          metadata: unknown;
        }>
      >(Prisma.sql`
        SELECT "code", "severity", "statement", "metadata"
        FROM "OperationalRule"
        WHERE "regionId" = ${input.regionId}
          AND "deletedAt" IS NULL
        ORDER BY "code" ASC
      `)
      .catch(() => []);
    const current = snapshots.find((snapshot) => snapshot.weekIso === input.weekIso) ?? snapshots[0] ?? null;
    const laneMetadata = decodeLaneWeekMetadata(current?.laneIssueNotes);
    const lanes = await getLaneScorecard({
      regionId: input.regionId,
      weekIso: input.weekIso,
      filters: input.filters,
      manualTargetRates: laneMetadata.marketRates
    }).catch(() => []);
    const allLanes = await getLaneScorecard({
      regionId: input.regionId,
      weekIso: input.weekIso,
      manualTargetRates: laneMetadata.marketRates
    }).catch(() => []);
    const trend = await getWeeklyTrend({ regionId: input.regionId, weekIso: input.weekIso, weeks: trendWeeks }).catch(
      () => []
    );
    const brokers = await tx
      .$queryRaw<Array<{ name: string }>>(Prisma.sql`
        SELECT "name"
        FROM "Broker"
        WHERE "regionId" = ${input.regionId}
          AND "deletedAt" IS NULL
        ORDER BY "name" ASC
      `)
      .catch(() => []);
    const lots = await tx
      .$queryRaw<Array<{ name: string }>>(Prisma.sql`
        SELECT "name"
        FROM "DropLot"
        WHERE "regionId" = ${input.regionId}
        ORDER BY "name" ASC
      `)
      .catch(() => []);

    const prior = snapshots.find((snapshot) => snapshot.weekIso !== input.weekIso) ?? null;
    const currentEmptyPct = toNumber(current?.emptyMilePct ?? null);
    const priorEmptyPct = toNumber(prior?.emptyMilePct ?? null);
    const currentValues: {
      loadCount: number;
      lineHaulRevenue: number | null;
      loadedMiles: number | null;
      emptyPct: number | null;
      mileMaxRpm: number | null;
      nby: number | null;
      fsc: number | null;
    } = current
      ? {
          loadCount: current.loadCount,
          lineHaulRevenue: toNumber(current.lineHaulRevenue),
          loadedMiles: toNumber(current.totalLoadedMiles),
          emptyPct: currentEmptyPct === null ? null : currentEmptyPct * 100,
          mileMaxRpm: toNumber(current.mileMaxRpm),
          nby: toNumber(snapshotNby(current)),
          fsc: toNumber(current.fuelSurchargeAmount)
        }
      : {
          loadCount: 0,
          lineHaulRevenue: 0,
          loadedMiles: 0,
          emptyPct: null,
          mileMaxRpm: null,
          nby: null,
          fsc: null
        };
    const priorValues: {
      loadCount: number;
      lineHaulRevenue: number | null;
      loadedMiles: number | null;
      emptyPct: number | null;
      mileMaxRpm: number | null;
      nby: number | null;
      fsc: number | null;
    } | null = prior
      ? {
          loadCount: prior.loadCount,
          lineHaulRevenue: toNumber(prior.lineHaulRevenue),
          loadedMiles: toNumber(prior.totalLoadedMiles),
          emptyPct: priorEmptyPct === null ? null : priorEmptyPct * 100,
          mileMaxRpm: toNumber(prior.mileMaxRpm),
          nby: toNumber(snapshotNby(prior)),
          fsc: toNumber(prior.fuelSurchargeAmount)
        }
      : null;

    const cards = [
      {
        key: "loads",
        label: "Total Loads",
        value: currentValues.loadCount.toString(),
        delta: priorValues ? currentValues.loadCount - priorValues.loadCount : null,
        deltaLabel: "WoW",
        noPrior: !priorValues
      },
      {
        key: "revenue",
        label: "Total 3P Revenue",
        value: currentValues.lineHaulRevenue?.toFixed(0) ?? "0",
        ...buildCardDelta(currentValues.lineHaulRevenue, priorValues?.lineHaulRevenue ?? null),
        deltaLabel: "WoW"
      },
      {
        key: "loadedMiles",
        label: "Loaded Miles",
        value: currentValues.loadedMiles?.toFixed(0) ?? "0",
        ...buildCardDelta(currentValues.loadedMiles, priorValues?.loadedMiles ?? null),
        deltaLabel: "WoW"
      },
      {
        key: "emptyPct",
        label: "Empty Mile %",
        value: currentValues.emptyPct?.toFixed(1) ?? "—",
        ...buildCardDelta(currentValues.emptyPct, priorValues?.emptyPct ?? null),
        deltaLabel: "WoW",
        inverted: true
      },
      {
        key: "nby",
        label: "NBY ($/mi)",
        value: currentValues.nby?.toFixed(2) ?? "—",
        ...buildCardDelta(currentValues.nby, priorValues?.nby ?? null),
        deltaLabel: "WoW"
      },
      {
        key: "mileMaxRpm",
        label: "MileMax RPM",
        value: currentValues.mileMaxRpm?.toFixed(2) ?? "—",
        ...buildCardDelta(currentValues.mileMaxRpm, priorValues?.mileMaxRpm ?? null),
        deltaLabel: "WoW"
      },
      {
        key: "tender",
        label: "Tender Accept %",
        value: "—",
        delta: null,
        deltaLabel: "no prior",
        noPrior: true
      }
    ];
    const comparisonInsights = computeComparisonInsights({
      currentWeekIso: input.weekIso,
      previousWeekIso: prior?.weekIso ?? null,
      cards,
      trend
    });
    const regionConfig = await getRegionConfig(input.regionId, tx).catch(() => null);
    const alerts = await hydrateAlertAcknowledgements(
      evaluateKpiAlerts({
        weekIso: input.weekIso,
        lanes,
        cards,
        emptyPctAlert: regionConfig?.emptyPctAlert
      })
    );
    const laneDrilldowns = await getLaneDrilldowns({
      regionId: input.regionId,
      weekIso: input.weekIso,
      weeks: Math.max(4, Math.min(trendWeeks, 52)),
      lanes: lanes.slice(0, 8)
    });
    const chartCatalog = await buildChartCatalog({
      tx,
      regionId: input.regionId,
      weekIso: input.weekIso,
      weeks: Math.max(4, Math.min(trendWeeks, 52))
    });

    const rulesView = rules.map((rule) => {
      const metadata = (rule.metadata ?? {}) as Record<string, unknown>;
      const title = typeof metadata.title === "string" ? metadata.title : rule.code;
      const appliesTo = typeof metadata.appliesTo === "string" ? metadata.appliesTo : "Region";
      return {
        code: rule.code,
        title,
        severity: rule.severity,
        statement: rule.statement,
        appliesTo
      };
    });

    const laneIssueNotes = laneMetadata.notes;
    const lanesWithNotes = lanes.map((lane) => ({
      ...lane,
      laneNote: laneIssueNotes[lane.lane] ?? null
    }));

    assertMileMaxUsage({ level: "totals", reason: "Dashboard card is totals-level." });

    return {
      contractVersion: kpiContractVersion,
      weekIso: input.weekIso,
      comparisonWeekIso: prior?.weekIso ?? null,
      comparisonMode: input.comparisonMode ?? "wow",
      cards,
      lanes: lanesWithNotes,
      mileMaxMissingInbound: current?.mileMaxMissingInbound ?? true,
      trend,
      chartCatalog,
      laneDrilldowns,
      availableFilters: {
        lanes: allLanes.map((lane) => lane.lane).sort((a, b) => a.localeCompare(b)),
        brokers: brokers.map((broker) => broker.name),
        lots: lots.map((lot) => lot.name),
        severities: ["INFO", "WARN", "ACTION_REQUIRED"] as Array<"INFO" | "WARN" | "ACTION_REQUIRED">
      },
      activeFilters: {
        lane: input.filters?.lane,
        broker: input.filters?.broker,
        lot: input.filters?.lot,
        severity: input.filters?.severity,
        weeks: trendWeeks
      },
      alerts,
      comparisonInsights,
      reportMeta: {
        generatedAtIso: new Date().toISOString(),
        regionId: input.regionId
      },
      activeRegionId: input.regionId,
      managementNotes: [
        "Weekly management summary generated from filtered lane and snapshot metrics.",
        current?.mileMaxMissingInbound
          ? "IB revenue/miles not entered for this week: MileMax currently falls back to line-haul revenue per negotiable mile."
          : "Detailed narrative can be replaced by coordinator-authored notes."
      ],
      rules: rulesView
    };
  });
}
