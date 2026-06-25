import type { ViewKpiDashboard } from "@/lib/ui/kpi-mappers";

export interface TrendSeriesPoint {
  id: string;
  week: string;
  weekLabel: string;
  loads: number;
  rev: number;
  empty: number;
  nby: number | null;
  mileMax: number | null;
  isCurrent: boolean;
}

export function buildTrendSeries(points: ViewKpiDashboard["trend"]): TrendSeriesPoint[] {
  const fallbackPoint =
    points.length > 0 ? points : [{ week: "—", loads: 0, rev: 0, empty: 0, nby: null, mileMax: null }];
  const lastIndex = fallbackPoint.length - 1;
  return fallbackPoint.map((point, index) => {
    const weekLabel = point.week.startsWith("W") ? point.week : point.week.replace(/^(\d{4})-/, "");
    return {
      id: `${weekLabel}-${index}`,
      week: point.week,
      weekLabel,
      loads: point.loads,
      rev: point.rev ?? 0,
      empty: point.empty ?? 0,
      nby: point.nby ?? null,
      mileMax: point.mileMax ?? null,
      isCurrent: index === lastIndex
    };
  });
}
