import { toNumber } from "@/lib/ui/parse";
import { assertMileMaxUsage } from "@/domain/semantics";

export interface KpiCardDto {
  key: string;
  label: string;
  value: string | number;
  delta: string | number | null;
  deltaLabel: string;
  inverted?: boolean;
  noPrior?: boolean;
}

export interface KpiLaneRowDto {
  lane: string;
  target: string | number | null;
  targetSource?: "MANUAL_WEEKLY" | "LANE_DEFAULT" | "NONE";
  loads: number;
  revenue: string | number | null;
  vsTarget: string | number | null;
  emptyPct: string | number | null;
  nby?: string | number | null;
  fsc?: string | number | null;
  tonu?: string | number | null;
  driverType?: string | null;
  laneNote?: string | null;
  revLoad: string | number | null;
  status: "ON_TARGET" | "BELOW_NEAR" | "BELOW" | "NO_LOADS";
}

export interface KpiTrendPointDto {
  week: string;
  loads: number;
  rev: string | number;
  empty: string | number;
  nby?: string | number | null;
  mileMax?: string | number | null;
}

export interface KpiDashboardResponse {
  contractVersion?: string;
  weekIso: string;
  comparisonWeekIso: string | null;
  comparisonMode?: "wow" | "rolling4" | "qtd";
  cards: KpiCardDto[];
  lanes: KpiLaneRowDto[];
  trend: KpiTrendPointDto[];
  chartCatalog?: {
    weeklyRevenueTrend: Array<{ weekIso: string; totalAllInRevenue: string | number }>;
    emptyMilePctTrend: Array<{ weekIso: string; emptyMilePct: string | number }>;
    mileMaxRpmTrend: Array<{ weekIso: string; mileMaxRpm: string | number }>;
    deadheadMixTrend: Array<{
      weekIso: string;
      loadedMiles: string | number;
      pickupDeadhead: string | number;
      deliveryDeadhead: string | number;
      emptyMiles: string | number;
    }>;
    revenueSplitTrend: Array<{
      weekIso: string;
      baseRevenue: string | number;
      fscRevenue: string | number;
      tonuAmount: string | number;
      totalAllInRevenue: string | number;
    }>;
    tonuEventsTrend: Array<{ weekIso: string; tonuEvents: number; tonuAmount: string | number }>;
  };
  managementNotes: string[];
  laneDrilldowns?: Array<{
    lane: string;
    trend: KpiTrendPointDto[];
  }>;
  availableFilters?: {
    lanes: string[];
    brokers: string[];
    lots: string[];
    severities: Array<"INFO" | "WARN" | "ACTION_REQUIRED">;
  };
  activeFilters?: {
    lane?: string;
    broker?: string;
    lot?: string;
    severity?: "INFO" | "WARN" | "ACTION_REQUIRED";
    weeks?: number;
  };
  alerts?: Array<{
    id: string;
    code: string;
    severity: "INFO" | "WARN" | "ACTION_REQUIRED";
    title: string;
    message: string;
    lane?: string;
    acknowledgedAt?: string | null;
    acknowledgedBy?: string | null;
  }>;
  comparisonInsights?: Array<{
    key: string;
    wowDelta: number | null;
    rolling4Delta: number | null;
    qtdDelta: number | null;
  }>;
  reportMeta?: {
    generatedAtIso: string;
    regionId: string;
  };
  regions?: Array<{ id: string; code: string; name: string }>;
  activeRegionId?: string;
  mileMaxMissingInbound?: boolean;
  rules: Array<{
    code: string;
    title: string;
    severity: "INFO" | "WARN" | "ACTION_REQUIRED";
    statement: string;
    appliesTo: string;
  }>;
}

export interface ViewKpiDashboard {
  weekIso: string;
  comparisonWeekIso: string | null;
  comparisonMode: "wow" | "rolling4" | "qtd";
  cards: Array<{
    key: string;
    label: string;
    value: string | number;
    delta: number | null;
    deltaLabel: string;
    inverted: boolean;
    noPrior: boolean;
  }>;
  lanes: Array<{
    lane: string;
    target: number | null;
    targetSource: "MANUAL_WEEKLY" | "LANE_DEFAULT" | "NONE";
    loads: number;
    revenue: number | null;
    vsTarget: number | null;
    emptyPct: number | null;
    nby: number | null;
    fsc: number | null;
    tonu: number | null;
    driverType: string | null;
    laneNote: string | null;
    revLoad: number | null;
    status: "ON_TARGET" | "BELOW_NEAR" | "BELOW" | "NO_LOADS";
  }>;
  trend: Array<{
    week: string;
    loads: number;
    rev: number | null;
    empty: number | null;
    nby: number | null;
    mileMax: number | null;
  }>;
  chartCatalog: {
    weeklyRevenueTrend: Array<{ weekIso: string; totalAllInRevenue: number }>;
    emptyMilePctTrend: Array<{ weekIso: string; emptyMilePct: number }>;
    mileMaxRpmTrend: Array<{ weekIso: string; mileMaxRpm: number }>;
    deadheadMixTrend: Array<{
      weekIso: string;
      loadedMiles: number;
      pickupDeadhead: number;
      deliveryDeadhead: number;
      emptyMiles: number;
    }>;
    revenueSplitTrend: Array<{
      weekIso: string;
      baseRevenue: number;
      fscRevenue: number;
      tonuAmount: number;
      totalAllInRevenue: number;
    }>;
    tonuEventsTrend: Array<{ weekIso: string; tonuEvents: number; tonuAmount: number }>;
  };
  laneDrilldowns: Array<{
    lane: string;
    trend: Array<{
      week: string;
      loads: number;
      rev: number | null;
      empty: number | null;
    }>;
  }>;
  availableFilters: {
    lanes: string[];
    brokers: string[];
    lots: string[];
    severities: Array<"INFO" | "WARN" | "ACTION_REQUIRED">;
  };
  activeFilters: {
    lane?: string;
    broker?: string;
    lot?: string;
    severity?: "INFO" | "WARN" | "ACTION_REQUIRED";
    weeks?: number;
  };
  alerts: Array<{
    id: string;
    code: string;
    severity: "INFO" | "WARN" | "ACTION_REQUIRED";
    title: string;
    message: string;
    lane?: string;
    acknowledgedAt?: string | null;
    acknowledgedBy?: string | null;
  }>;
  comparisonInsights: Array<{
    key: string;
    wowDelta: number | null;
    rolling4Delta: number | null;
    qtdDelta: number | null;
  }>;
  reportMeta?: {
    generatedAtIso: string;
    regionId: string;
  };
  regions: Array<{ id: string; code: string; name: string }>;
  activeRegionId?: string;
  mileMaxMissingInbound: boolean;
  managementNotes: string[];
  rules: KpiDashboardResponse["rules"];
}

function requiredNumber(value: string | number | null | undefined): number | null {
  const parsed = toNumber(value ?? null);
  return parsed === null ? null : parsed;
}

export function mapKpiDashboardToView(input: KpiDashboardResponse): ViewKpiDashboard {
  for (const lane of input.lanes) {
    if ("mileMaxRpm" in lane) {
      assertMileMaxUsage({ level: "lane", reason: "Lane DTO must not expose MileMax." });
    }
  }
  return {
    weekIso: input.weekIso,
    comparisonWeekIso: input.comparisonWeekIso,
    comparisonMode: input.comparisonMode ?? "wow",
    cards: input.cards.map((card) => ({
      key: card.key,
      label: card.label,
      value: card.value,
      delta: toNumber(card.delta),
      deltaLabel: card.deltaLabel,
      inverted: Boolean(card.inverted),
      noPrior: Boolean(card.noPrior)
    })),
    lanes: input.lanes.map((lane) => ({
      lane: lane.lane,
      target: toNumber(lane.target),
      targetSource: lane.targetSource ?? "NONE",
      loads: lane.loads,
      revenue: toNumber(lane.revenue),
      vsTarget: toNumber(lane.vsTarget),
      emptyPct: toNumber(lane.emptyPct),
      nby: toNumber(lane.nby ?? null),
      fsc: toNumber(lane.fsc ?? null),
      tonu: toNumber(lane.tonu ?? null),
      driverType: lane.driverType ?? null,
      laneNote: lane.laneNote ?? null,
      revLoad: toNumber(lane.revLoad),
      status: lane.status
    })),
    trend: input.trend.map((point) => ({
      week: point.week,
      loads: point.loads,
      rev: toNumber(point.rev),
      empty: toNumber(point.empty),
      nby: toNumber(point.nby ?? null),
      mileMax: toNumber(point.mileMax ?? null)
    })),
    chartCatalog: {
      weeklyRevenueTrend: (input.chartCatalog?.weeklyRevenueTrend ?? []).reduce<Array<{ weekIso: string; totalAllInRevenue: number }>>(
        (rows, point) => {
          const totalAllInRevenue = requiredNumber(point.totalAllInRevenue);
          if (totalAllInRevenue === null) {
            return rows;
          }
          rows.push({ weekIso: point.weekIso, totalAllInRevenue });
          return rows;
        },
        []
      ),
      emptyMilePctTrend: (input.chartCatalog?.emptyMilePctTrend ?? []).reduce<Array<{ weekIso: string; emptyMilePct: number }>>(
        (rows, point) => {
          const emptyMilePct = requiredNumber(point.emptyMilePct);
          if (emptyMilePct === null) {
            return rows;
          }
          rows.push({ weekIso: point.weekIso, emptyMilePct });
          return rows;
        },
        []
      ),
      mileMaxRpmTrend: (input.chartCatalog?.mileMaxRpmTrend ?? []).reduce<Array<{ weekIso: string; mileMaxRpm: number }>>(
        (rows, point) => {
          const mileMaxRpm = requiredNumber(point.mileMaxRpm);
          if (mileMaxRpm === null) {
            return rows;
          }
          rows.push({ weekIso: point.weekIso, mileMaxRpm });
          return rows;
        },
        []
      ),
      deadheadMixTrend: (input.chartCatalog?.deadheadMixTrend ?? []).reduce<
        Array<{ weekIso: string; loadedMiles: number; pickupDeadhead: number; deliveryDeadhead: number; emptyMiles: number }>
      >((rows, point) => {
        const loadedMiles = requiredNumber(point.loadedMiles);
        const pickupDeadhead = requiredNumber(point.pickupDeadhead);
        const deliveryDeadhead = requiredNumber(point.deliveryDeadhead);
        const emptyMiles = requiredNumber(point.emptyMiles);
        if (loadedMiles === null || pickupDeadhead === null || deliveryDeadhead === null || emptyMiles === null) {
          return rows;
        }
        rows.push({ weekIso: point.weekIso, loadedMiles, pickupDeadhead, deliveryDeadhead, emptyMiles });
        return rows;
      }, []),
      revenueSplitTrend: (input.chartCatalog?.revenueSplitTrend ?? []).reduce<
        Array<{ weekIso: string; baseRevenue: number; fscRevenue: number; tonuAmount: number; totalAllInRevenue: number }>
      >((rows, point) => {
        const baseRevenue = requiredNumber(point.baseRevenue);
        const fscRevenue = requiredNumber(point.fscRevenue);
        const tonuAmount = requiredNumber(point.tonuAmount);
        const totalAllInRevenue = requiredNumber(point.totalAllInRevenue);
        if (baseRevenue === null || fscRevenue === null || tonuAmount === null || totalAllInRevenue === null) {
          return rows;
        }
        rows.push({ weekIso: point.weekIso, baseRevenue, fscRevenue, tonuAmount, totalAllInRevenue });
        return rows;
      }, []),
      tonuEventsTrend: (input.chartCatalog?.tonuEventsTrend ?? []).reduce<Array<{ weekIso: string; tonuEvents: number; tonuAmount: number }>>(
        (rows, point) => {
          const tonuAmount = requiredNumber(point.tonuAmount);
          if (tonuAmount === null) {
            return rows;
          }
          rows.push({ weekIso: point.weekIso, tonuEvents: point.tonuEvents, tonuAmount });
          return rows;
        },
        []
      )
    },
    laneDrilldowns: (input.laneDrilldowns ?? []).map((group) => ({
      lane: group.lane,
      trend: group.trend.map((point) => ({
        week: point.week,
        loads: point.loads,
        rev: toNumber(point.rev),
        empty: toNumber(point.empty)
      }))
    })),
    availableFilters: input.availableFilters ?? { lanes: [], brokers: [], lots: [], severities: ["INFO", "WARN", "ACTION_REQUIRED"] },
    activeFilters: input.activeFilters ?? {},
    alerts: input.alerts ?? [],
    comparisonInsights: input.comparisonInsights ?? [],
    reportMeta: input.reportMeta,
    regions: input.regions ?? [],
    activeRegionId: input.activeRegionId,
    mileMaxMissingInbound: input.mileMaxMissingInbound ?? true,
    managementNotes: input.managementNotes,
    rules: input.rules
  };
}
