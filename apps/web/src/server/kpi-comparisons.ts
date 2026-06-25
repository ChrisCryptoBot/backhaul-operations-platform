import { Prisma } from "@prisma/client";

type MaybeNumber = number | string | Prisma.Decimal | null | undefined;

function toNumber(value: MaybeNumber): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  try {
    return new Prisma.Decimal(value).toNumber();
  } catch {
    return null;
  }
}

export interface ComparisonInsight {
  key: string;
  wowDelta: number | null;
  rolling4Delta: number | null;
  qtdDelta: number | null;
}

export function computeComparisonInsights(input: {
  currentWeekIso: string;
  previousWeekIso: string | null;
  cards: Array<{ key: string; value: MaybeNumber }>;
  trend: Array<{ week: string; rev: MaybeNumber; loads: MaybeNumber; empty: MaybeNumber }>;
}): ComparisonInsight[] {
  const avg = (values: Array<number | null>) => {
    const usable = values.filter((value): value is number => value !== null);
    if (usable.length === 0) return null;
    return usable.reduce((sum, value) => sum + value, 0) / usable.length;
  };

  const rolling4 = {
    loads: avg(input.trend.slice(-4).map((point) => toNumber(point.loads))),
    revenue: avg(input.trend.slice(-4).map((point) => toNumber(point.rev))),
    emptyPct: avg(input.trend.slice(-4).map((point) => toNumber(point.empty)))
  };

  const qtdWeeks = input.trend.slice(-13);
  const qtd = {
    loads: avg(qtdWeeks.map((point) => toNumber(point.loads))),
    revenue: avg(qtdWeeks.map((point) => toNumber(point.rev))),
    emptyPct: avg(qtdWeeks.map((point) => toNumber(point.empty)))
  };

  const cardByKey = new Map(input.cards.map((card) => [card.key, toNumber(card.value)]));
  const currentLoads = cardByKey.get("loads") ?? null;
  const currentRevenue = cardByKey.get("revenue") ?? null;
  const currentEmpty = cardByKey.get("emptyPct") ?? null;

  const priorWeek = input.trend.find((point) => point.week === (input.previousWeekIso?.split("-")[1] ?? ""));
  const priorLoads = priorWeek ? toNumber(priorWeek.loads) : null;
  const priorRevenue = priorWeek ? toNumber(priorWeek.rev) : null;
  const priorEmpty = priorWeek ? toNumber(priorWeek.empty) : null;

  return [
    {
      key: "loads",
      wowDelta: currentLoads !== null && priorLoads !== null ? currentLoads - priorLoads : null,
      rolling4Delta: currentLoads !== null && rolling4.loads !== null ? currentLoads - rolling4.loads : null,
      qtdDelta: currentLoads !== null && qtd.loads !== null ? currentLoads - qtd.loads : null
    },
    {
      key: "revenue",
      wowDelta: currentRevenue !== null && priorRevenue !== null ? currentRevenue - priorRevenue : null,
      rolling4Delta: currentRevenue !== null && rolling4.revenue !== null ? currentRevenue - rolling4.revenue : null,
      qtdDelta: currentRevenue !== null && qtd.revenue !== null ? currentRevenue - qtd.revenue : null
    },
    {
      key: "emptyPct",
      wowDelta: currentEmpty !== null && priorEmpty !== null ? currentEmpty - priorEmpty : null,
      rolling4Delta: currentEmpty !== null && rolling4.emptyPct !== null ? currentEmpty - rolling4.emptyPct : null,
      qtdDelta: currentEmpty !== null && qtd.emptyPct !== null ? currentEmpty - qtd.emptyPct : null
    }
  ];
}
