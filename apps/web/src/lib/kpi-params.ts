import { asKpiPeriod, type KpiPeriod } from "./kpi-periods";

/**
 * What the KPI page, its CSV exports and its printable report all read from the address: the period, whether to compare with
 * the one before, the four filters, and which empty-miles view the driver chart shows. Defaults are left out of the address,
 * so a plain /kpi is the last four weeks, compared, unfiltered.
 */
export type KpiFilters = { lane?: string; broker?: string; driver?: string; truck?: string };
export type KpiParams = { period: KpiPeriod; compare: boolean; filters: KpiFilters; dh: "pct" | "miles" };

type Raw = Record<string, string | string[] | undefined> | undefined;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const clean = (v: string | string[] | undefined) => {
  const s = one(v)?.trim();
  return s ? s : undefined;
};

export function parseKpiParams(sp: Raw): KpiParams {
  const filters: KpiFilters = {};
  for (const k of ["lane", "broker", "driver", "truck"] as const) {
    const v = clean(sp?.[k]);
    if (v) filters[k] = v;
  }
  return { period: asKpiPeriod(one(sp?.period)), compare: one(sp?.compare) !== "off", filters, dh: one(sp?.dh) === "miles" ? "miles" : "pct" };
}

/** The query string for these params (no leading "?"), omitting every default. `over` changes some of them. */
export function kpiQuery(p: KpiParams, over: Partial<KpiParams> = {}): string {
  const m = { ...p, ...over, filters: { ...p.filters, ...over.filters } };
  const q = new URLSearchParams();
  if (m.period !== "4w") q.set("period", m.period);
  if (!m.compare) q.set("compare", "off");
  for (const k of ["lane", "broker", "driver", "truck"] as const) if (m.filters[k]) q.set(k, m.filters[k]!);
  if (m.dh === "miles") q.set("dh", "miles");
  return q.toString();
}

export const kpiHref = (base: string, p: KpiParams, over: Partial<KpiParams> = {}) => {
  const q = kpiQuery(p, over);
  return q ? `${base}?${q}` : base;
};

export const hasFilters = (f: KpiFilters) => Boolean(f.lane || f.broker || f.driver || f.truck);
