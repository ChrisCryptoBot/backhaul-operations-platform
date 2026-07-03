import { z } from "zod";

export const kpiContractVersion = "v1";
const numericValueSchema = z.union([z.number(), z.string()]);
const severitySchema = z.enum(["INFO", "WARN", "ACTION_REQUIRED"]);
const comparisonModeSchema = z.enum(["wow", "rolling4", "qtd"]);

export const kpiDashboardCardSchema = z.object({
  key: z.string(),
  label: z.string(),
  value: numericValueSchema,
  delta: z.union([z.number(), z.string(), z.null()]),
  deltaLabel: z.string(),
  noPrior: z.boolean().optional(),
  inverted: z.boolean().optional()
});

export const kpiDashboardLaneSchema = z.object({
  lane: z.string(),
  target: numericValueSchema.nullable(),
  targetSource: z.enum(["MANUAL_WEEKLY", "LANE_DEFAULT", "NONE"]).optional(),
  loads: z.number(),
  revenue: numericValueSchema.nullable(),
  vsTarget: numericValueSchema.nullable(),
  emptyPct: numericValueSchema.nullable(),
  nby: numericValueSchema.nullable().optional(),
  fsc: numericValueSchema.nullable().optional(),
  tonu: numericValueSchema.nullable().optional(),
  driverType: z.string().nullable().optional(),
  laneNote: z.string().nullable().optional(),
  revLoad: numericValueSchema.nullable(),
  status: z.enum(["ON_TARGET", "BELOW_NEAR", "BELOW", "NO_LOADS"])
});

export const kpiDashboardTrendSchema = z.object({
  week: z.string(),
  loads: z.number(),
  rev: numericValueSchema,
  empty: numericValueSchema,
  nby: numericValueSchema.nullable().optional(),
  mileMax: numericValueSchema.nullable().optional()
});

export const kpiDashboardChartCatalogSchema = z.object({
  weeklyRevenueTrend: z.array(
    z.object({
      weekIso: z.string().regex(/^\d{4}-W\d{2}$/),
      totalAllInRevenue: numericValueSchema
    })
  ),
  emptyMilePctTrend: z.array(
    z.object({
      weekIso: z.string().regex(/^\d{4}-W\d{2}$/),
      emptyMilePct: numericValueSchema
    })
  ),
  mileMaxRpmTrend: z.array(
    z.object({
      weekIso: z.string().regex(/^\d{4}-W\d{2}$/),
      mileMaxRpm: numericValueSchema
    })
  ),
  deadheadMixTrend: z.array(
    z.object({
      weekIso: z.string().regex(/^\d{4}-W\d{2}$/),
      loadedMiles: numericValueSchema,
      pickupDeadhead: numericValueSchema,
      deliveryDeadhead: numericValueSchema,
      emptyMiles: numericValueSchema
    })
  ),
  revenueSplitTrend: z.array(
    z.object({
      weekIso: z.string().regex(/^\d{4}-W\d{2}$/),
      baseRevenue: numericValueSchema,
      fscRevenue: numericValueSchema,
      tonuAmount: numericValueSchema,
      totalAllInRevenue: numericValueSchema
    })
  ),
  tonuEventsTrend: z.array(
    z.object({
      weekIso: z.string().regex(/^\d{4}-W\d{2}$/),
      tonuEvents: z.number(),
      tonuAmount: numericValueSchema
    })
  )
});

const onTimeBucketSchema = z.object({
  onTime: z.number(),
  total: z.number(),
  unverified: z.number()
});

const growthMetricSchema = z.object({
  current: z.number(),
  prior: z.number().nullable(),
  pct: z.number().nullable()
});

/** Ops-analytics extension (Drivers + Reliability tabs, variance & growth charts). Optional: an
 * empty/failed week omits it and the rest of the dashboard still renders. */
export const kpiOpsAnalyticsSchema = z.object({
  config: z.object({
    emptyPctAmber: z.number(),
    emptyPctRed: z.number(),
    onTimeTargetPct: z.number()
  }),
  shuttleLeaderboard: z.array(
    z.object({
      key: z.string(),
      driverId: z.string().nullable(),
      driverName: z.string().nullable(),
      deadheadMiles: z.number(),
      loadedMiles: z.number(),
      emptyPct: z.number()
    })
  ),
  deadheadSplit: z.object({
    controllable: z.object({ pickupDh: z.number(), deliveryDh: z.number() }),
    expected: z.object({ pickupDh: z.number(), deliveryDh: z.number() })
  }),
  deadheadRadius: z.array(
    z.object({ weekIso: z.string(), avgRadius: z.number(), loadCount: z.number() })
  ),
  rateVarianceHistogram: z.object({
    bins: z.array(z.object({ lo: z.number(), hi: z.number(), count: z.number(), underTarget: z.boolean() })),
    median: z.number().nullable(),
    count: z.number(),
    binSize: z.number()
  }),
  reliability: z.object({
    otd: onTimeBucketSchema,
    otp: onTimeBucketSchema,
    firmAppt: onTimeBucketSchema,
    missed: z.object({ missed: z.number(), total: z.number(), unverified: z.number() })
  }),
  disruptionBreakdown: z.object({
    reasons: z.array(
      z.object({ reason: z.string(), label: z.string(), cancel: z.number(), reschedule: z.number() })
    ),
    totalCancel: z.number(),
    totalReschedule: z.number(),
    trackedFromWeekIso: z.string().nullable()
  }),
  growth: z.object({
    loadCount: growthMetricSchema,
    lineHaulRevenue: growthMetricSchema
  })
});

export const kpiDashboardSchema = z.object({
  contractVersion: z.literal(kpiContractVersion),
  weekIso: z.string().regex(/^\d{4}-W\d{2}$/),
  comparisonWeekIso: z.string().regex(/^\d{4}-W\d{2}$/).nullable(),
  comparisonMode: comparisonModeSchema,
  cards: z.array(kpiDashboardCardSchema),
  opsAnalytics: kpiOpsAnalyticsSchema.optional(),
  lanes: z.array(kpiDashboardLaneSchema),
  trend: z.array(kpiDashboardTrendSchema),
  chartCatalog: kpiDashboardChartCatalogSchema,
  laneDrilldowns: z.array(
    z.object({
      lane: z.string(),
      trend: z.array(kpiDashboardTrendSchema)
    })
  ),
  availableFilters: z.object({
    lanes: z.array(z.string()),
    brokers: z.array(z.string()),
    lots: z.array(z.string()),
    severities: z.array(severitySchema)
  }),
  activeFilters: z.object({
    lane: z.string().optional(),
    broker: z.string().optional(),
    lot: z.string().optional(),
    severity: severitySchema.optional(),
    weeks: z.number().int().min(4).max(52).optional()
  }),
  alerts: z.array(
    z.object({
      id: z.string(),
      code: z.string(),
      severity: severitySchema,
      title: z.string(),
      message: z.string(),
      lane: z.string().optional(),
      acknowledgedAt: z.string().nullable().optional(),
      acknowledgedBy: z.string().nullable().optional()
    })
  ),
  comparisonInsights: z.array(
    z.object({
      key: z.string(),
      wowDelta: z.number().nullable(),
      rolling4Delta: z.number().nullable(),
      qtdDelta: z.number().nullable()
    })
  ),
  reportMeta: z.object({
    generatedAtIso: z.string().datetime(),
    regionId: z.string()
  }),
  activeRegionId: z.string(),
  mileMaxMissingInbound: z.boolean(),
  managementNotes: z.array(z.string()),
  rules: z.array(
    z.object({
      code: z.string(),
      title: z.string(),
      severity: severitySchema,
      statement: z.string(),
      appliesTo: z.string()
    })
  )
});

export type KpiDashboardContract = z.infer<typeof kpiDashboardSchema>;
export type KpiOpsAnalytics = z.infer<typeof kpiOpsAnalyticsSchema>;

