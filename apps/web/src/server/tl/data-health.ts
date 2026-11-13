import { prisma } from "@/lib/db";
import { buildDataHealth, fuelTaxCheck, type DataHealth, type FuelTaxCheck, type HealthDriver, type HealthLoad, type HealthTrailer, type HealthTruck, type PingPoint, type PingTrip } from "@/lib/data-health";
import { returnDrift } from "@/lib/ifta-return";
import { recentQuarters } from "@/lib/ifta-rates-csv";
import { countFlags, flagContextStart, readFlags } from "@/server/partners/fuel-flags";
import { iftaFiling } from "@/server/partners/ifta-filing";
import { iftaReturn } from "@/server/partners/ifta-return";
import { DAY_MS, periodWindow, type KpiPeriod, type TimeWindow } from "@/lib/kpi-periods";
import { terminalFilter, termList, type Terminals } from "@/lib/scope";
import { invoiceRateTotal } from "@/truelane/lib/invoice";
import { answerCache, clockBucket } from "./answer-cache";
import { ALL_TIME_DAYS } from "./kpi";
import { terminalSetSql } from "./terminal-sql";
import { currentWorkspaceId } from "./workspace";
import { workspaceTimezone } from "./zone";

/**
 * The Data Health read (lib/data-health.ts has the rules): the finished loads of the window and the units of the terminals in view, as plain rows, then the checks. `terminals` is the scope (null is the
 * whole fleet), so a region, a terminal or everything is one question. The position-ping check reads only the last week (that is all the pings the desk keeps) and at most the newest few dozen trips.
 */
export type HealthQuery = { period: KpiPeriod; terminals?: readonly string[] | null };
export type HealthRead = DataHealth & { window: TimeWindow; windowStart: number; truncated: boolean; pingDays: number; fuelTax: FuelTaxCheck };

/** The most finished loads read for one answer (a fleet's "All time" is more than a screen can usefully check). */
export const MAX_HEALTH_LOADS = 20_000;
/** The most trips the position-ping check measures, newest first. */
export const MAX_PING_TRIPS = 60;
/** The desk keeps pings for a week. */
export const PING_DAYS = 7;
const UNIT_CAP = 10_000;

type Raw = {
  id: string;
  load_number: string | null;
  status: string;
  completed_at: Date | null;
  broker_name: string | null;
  origin_address: string | null;
  destination_address: string | null;
  loaded_miles: number | null;
  quoted_revenue: number | null;
  actual_revenue: number | null;
  vehicle_id: string | null;
  truck: string | null;
  market_benchmark: number | null;
  floor: number | null;
  expense_fuel: number | null;
  pod_note: string | null;
  closed_without_pod: boolean | null;
  rate_con_path: string | null;
  payment_status: string | null;
  invoiced_amount: number | null;
  fuel_surcharge: number | null;
  invoice_lines: unknown;
  stops: number;
  arrivals: number;
  pod_doc: boolean;
  ratecon_doc: boolean;
  driver_id: string | null;
  pay_rate: number | null;
  pay_estimate: number | null;
  card_fuel: number | null;
  card_gallons: number | null;
};

const answers = answerCache<HealthRead>(120);
/** Tests clear it between cases. */
export const clearHealthCache = () => answers.clear();

function linesOf(v: unknown): Array<{ label: string; amount: number }> | null {
  if (!Array.isArray(v)) return null;
  const out = v.flatMap((x) => (x && typeof x === "object" && typeof (x as { label?: unknown }).label === "string" && typeof (x as { amount?: unknown }).amount === "number" ? [{ label: (x as { label: string }).label, amount: (x as { amount: number }).amount }] : []));
  return out.length > 0 ? out : null;
}

function toLoad(r: Raw): HealthLoad {
  return {
    id: r.id,
    loadNumber: r.load_number,
    status: r.status,
    completedAt: r.completed_at ? r.completed_at.getTime() : null,
    broker: r.broker_name,
    origin: r.origin_address,
    destination: r.destination_address,
    loadedMiles: r.loaded_miles ?? 0,
    quotedRevenue: r.quoted_revenue ?? 0,
    actualRevenue: r.actual_revenue,
    vehicleId: r.vehicle_id,
    truck: r.truck,
    hasDriver: r.driver_id != null,
    driverPay: (r.pay_rate ?? 0) > 0 || r.pay_estimate != null,
    marketBenchmark: r.market_benchmark,
    floor: r.floor,
    stops: r.stops,
    stopsWithArrival: r.arrivals,
    hasPod: r.pod_doc || !!r.pod_note?.trim(),
    podWaived: r.closed_without_pod === true,
    hasRateCon: r.ratecon_doc || !!r.rate_con_path,
    expenseFuel: r.expense_fuel ?? 0,
    cardFuel: r.card_fuel,
    cardGallons: r.card_gallons,
    paymentStatus: r.payment_status,
    invoicedAmount: r.invoiced_amount,
    rateTotal: invoiceRateTotal({ quotedRevenue: r.quoted_revenue ?? 0, fuelSurcharge: r.fuel_surcharge }),
    invoiceLines: linesOf(r.invoice_lines)
  };
}

/** The finished trips of the last week with enough arrivals to know when the truck was on the road, and the pings it left in that time, for the newest trips. */
async function pingTrips(workspaceId: string, loads: HealthLoad[], nowMs: number): Promise<PingTrip[]> {
  const since = nowMs - PING_DAYS * DAY_MS;
  const recent = loads
    .filter((l) => l.status === "completed" && l.vehicleId != null && l.loadedMiles > 0 && l.completedAt != null && l.completedAt >= since)
    .sort((a, b) => b.completedAt! - a.completedAt!)
    .slice(0, MAX_PING_TRIPS * 2);
  if (recent.length === 0) return [];
  const legs = await prisma.$queryRaw<Array<{ load_id: string; first: Date; last: Date }>>`
    select s.load_id, min(s.arrived_at) as first, max(s.arrived_at) as last from stops s
    where s.load_id = any(${recent.map((l) => l.id)}) and s.arrived_at is not null group by s.load_id having count(s.arrived_at) >= 2`;
  const legOf = new Map(legs.map((g) => [g.load_id, g] as const));
  const trips: PingTrip[] = [];
  const todo = recent.filter((l) => legOf.has(l.id)).slice(0, MAX_PING_TRIPS);
  for (let i = 0; i < todo.length; i += 10) {
    const got = await Promise.all(
      todo.slice(i, i + 10).map(async (l) => {
        const g = legOf.get(l.id)!;
        const pts = await prisma.$queryRaw<Array<{ lat: number; lng: number; at: Date }>>`
          select lat::float8 as lat, lng::float8 as lng, at from vehicle_pings
          where workspace_id = ${workspaceId} and vehicle_id = ${l.vehicleId} and at >= ${g.first} and at <= ${g.last} order by at`;
        return { id: l.id, label: l.loadNumber ?? "Load", loadedMiles: l.loadedMiles, points: pts.map((p): PingPoint => ({ lat: p.lat, lng: p.lng, at: p.at.getTime() })) } satisfies PingTrip;
      })
    );
    trips.push(...got);
  }
  return trips;
}

/**
 * Fuel and fuel tax (Wave 5 step 9): the window's purchases in the terminals in view (by the truck's terminal; a purchase on no truck only in the whole-fleet view), their open exception flags (read
 * the way Fuel reads them), what is missing on them, and where the last finished quarter's IFTA return stands (the whole fleet's filing, whatever the view): not filed with its blockers, or filed
 * and changed since. Counts only.
 */
async function fuelTaxRead(workspaceId: string, since: Date, terminals: readonly string[] | null, tz: string, now: Date): Promise<FuelTaxCheck> {
  const scoped = terminals == null ? {} : { vehicle: { terminal: terminalFilter(terminals) } };
  const rows = await prisma.fuelTransaction.findMany({
    where: { workspaceId, ...scoped, OR: [{ purchasedAt: { gte: since } }, { purchasedAt: null, postedAt: { gte: since } }] },
    select: { id: true, vehicleId: true, purchaseState: true, product: true, status: true },
    take: UNIT_CAP * 5
  });
  const flags = await readFlags(flagContextStart(since, now), workspaceId);
  const counts = countFlags(flags, rows.map((r) => r.id));
  const settled = rows.filter((r) => r.status === "settled");
  const tax = settled.filter((r) => r.product === "road_diesel" || r.product === "unknown");
  const last = recentQuarters(now, tz)[1] ?? null;
  let quarter: FuelTaxCheck["quarter"] = null;
  if (last) {
    const [r, filing] = await Promise.all([iftaReturn(last, now, workspaceId), iftaFiling(last, workspaceId)]);
    if (r.ok) quarter = { quarter: last, dueDate: r.dueDate, filed: filing.filed != null, changedSinceFiled: filing.filed ? returnDrift(filing.filed, r).changed : false, rateState: r.rateState, blockers: r.blockers.map((b) => ({ code: b.code, count: b.count, text: b.text })) };
  }
  return fuelTaxCheck({
    purchases: settled.length,
    flaggedPurchases: counts.purchases,
    openFlags: counts.open,
    flagsPartial: counts.partial,
    noState: tax.filter((r) => r.purchaseState == null).length,
    noTruck: tax.filter((r) => r.vehicleId == null).length,
    unknownProduct: settled.filter((r) => r.product === "unknown").length,
    quarter
  });
}

export async function getDataHealth(q: HealthQuery, now = new Date(), workspaceId = currentWorkspaceId()): Promise<HealthRead> {
  const tz = await workspaceTimezone(workspaceId);
  const terminals = termList(q.terminals ?? null)?.slice().sort() ?? null;
  return answers.remember([workspaceId, q.period, terminals, clockBucket(now.getTime(), 3_600_000), tz], workspaceId, async () => {
    const window = periodWindow(q.period, now.getTime(), tz);
    const windowStart = window.start ?? now.getTime() - ALL_TIME_DAYS * DAY_MS;
    const since = new Date(windowStart);
    const scope = terminalSetSql(terminals, workspaceId);
    const here = terminals == null ? {} : { terminal: terminalFilter(terminals) };
    const [raw, trucks, drivers, trailers, cardRows] = await Promise.all([
      prisma.$queryRaw<Raw[]>`
        select l.id, l.load_number, l.status, l.completed_at, l.broker_name, l.origin_address, l.destination_address,
          l.loaded_miles::float8, l.quoted_revenue::float8, l.actual_revenue::float8, l.vehicle_id, v.name as truck,
          l.market_benchmark::float8, l.snapshot_base_floor_rpm::float8 as floor, l.expense_fuel_actual::float8 as expense_fuel,
          l.pod_note, l.closed_without_pod, l.rate_con_path, l.payment_status, l.invoiced_amount::float8, l.fuel_surcharge::float8, l.invoice_lines,
          (select count(*)::int from stops s where s.load_id = l.id) as stops,
          (select count(*)::int from stops s where s.load_id = l.id and s.arrived_at is not null) as arrivals,
          exists (select 1 from load_documents d where d.load_id = l.id and d.kind = 'pod') as pod_doc,
          exists (select 1 from load_documents d where d.load_id = l.id and d.kind = 'rate_con') as ratecon_doc,
          a.driver_id, a.pay_rate::float8, a.pay_estimate::float8,
          (select sum(f.amount)::float8 from fuel_transactions f where f.load_id = l.id and f.status = 'settled') as card_fuel,
          (select sum(f.gallons)::float8 from fuel_transactions f where f.load_id = l.id and f.status = 'settled' and f.product <> 'def') as card_gallons
        from loads l left join vehicles v on v.id = l.vehicle_id left join assignments a on a.load_id = l.id
        where l.workspace_id = ${workspaceId} and l.deleted_at is null and l.status in ('completed', 'tonu') and coalesce(l.completed_at, l.updated_at) >= ${since}${scope}
        order by coalesce(l.completed_at, l.updated_at) desc limit ${MAX_HEALTH_LOADS + 1}`,
      prisma.vehicle.findMany({ where: { workspaceId, archivedAt: null, ...here }, select: { id: true, name: true, mpg: true, homeBaseAddress: true, homeBaseLat: true, costProfile: { select: { vehicleId: true } } }, take: UNIT_CAP, orderBy: { name: "asc" } }),
      prisma.driver.findMany({ where: { workspaceId, active: true, ...here }, select: { id: true, name: true, cdlExpiry: true, medicalCardExpiry: true, phone: true }, take: UNIT_CAP, orderBy: { name: "asc" } }),
      prisma.trailer.findMany({ where: { workspaceId, archivedAt: null, ...here }, select: { id: true, number: true, registrationExpiry: true, inspectionExpiry: true }, take: UNIT_CAP, orderBy: { number: "asc" } }),
      prisma.fuelTransaction.count({ where: { workspaceId, status: "settled" } })
    ]);
    const truncated = raw.length > MAX_HEALTH_LOADS;
    const loads = raw.slice(0, MAX_HEALTH_LOADS).map(toLoad);
    const unitTrucks: HealthTruck[] = trucks.map((t) => ({ id: t.id, name: t.name ?? "Truck", hasProfile: t.costProfile != null, hasBase: !!t.homeBaseAddress?.trim() || t.homeBaseLat != null, hasMpg: t.mpg != null }));
    const unitDrivers: HealthDriver[] = drivers.map((d) => ({ id: d.id, name: d.name, hasCdlDate: d.cdlExpiry != null, hasMedicalDate: d.medicalCardExpiry != null, hasPhone: !!d.phone?.trim() }));
    const unitTrailers: HealthTrailer[] = trailers.map((t) => ({ id: t.id, number: t.number, hasRegistration: t.registrationExpiry != null, hasInspection: t.inspectionExpiry != null }));
    const [trips, fuelTax] = await Promise.all([pingTrips(workspaceId, loads, now.getTime()), fuelTaxRead(workspaceId, since, terminals, tz, now)]);
    const health = buildDataHealth({ loads, trucks: unitTrucks, drivers: unitDrivers, trailers: unitTrailers, hasCardData: cardRows > 0, trips });
    return { ...health, window, windowStart, truncated, pingDays: PING_DAYS, fuelTax };
  });
}

