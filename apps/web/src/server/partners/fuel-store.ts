import { terminalFilter, type Terminals } from "@/lib/scope";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { recordAudit } from "@/server/tl/audit";
import { num, numOrNull } from "@/server/tl/convert";
import { currentWorkspaceId } from "@/server/tl/workspace";
import { callPartner, providerName } from "./call";

/**
 * Fuel card purchases, kept (the `fuel_transactions` table): one row per purchase by the company's own id, so reading the same days twice never doubles a purchase. A purchase is tied to the
 * load the truck was running when it was bought (the truck's load whose stops, a day either side, cover the purchase), and through that load to the driver statement it is on. `amount` is what
 * the card was charged after its discount. Nothing here moves any money: a purchase is a record, and a statement deduction is a person's decision (a later piece of work).
 */
export type PurchaseIn = { on: string; gallons: number | null; amount: number; id?: string; location?: string | null; pricePerGallon?: number | null; discountPerGallon?: number | null; discount?: number | null };

const whole = (n: number) => n - (n % 1);
const gap = (a: number, b: number) => (a > b ? a - b : b - a);
const dec = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? null : new Prisma.Decimal(n));
const externalOf = (p: PurchaseIn) => p.id ?? `${p.on}:${p.amount}:${p.gallons ?? ""}`;
/** A purchase's day is a calendar date; it is kept at noon UTC so no zone shifts it onto a neighbouring day. */
const postedOf = (on: string) => new Date(`${on.slice(0, 10)}T12:00:00Z`);

/** Keep a batch of purchases for one truck, tied to a load when one is given. Re-reading the same purchases changes nothing but a missing load tie. Returns how many were new. */
export async function storePurchases(provider: string, purchases: PurchaseIn[], where: { workspaceId: string; vehicleId: string | null; loadFor?: (on: string) => string | null }): Promise<number> {
  let fresh = 0;
  for (const p of purchases) {
    const externalId = externalOf(p);
    const loadId = where.loadFor?.(p.on) ?? null;
    const key = { workspaceId_provider_externalId: { workspaceId: where.workspaceId, provider, externalId } };
    const had = await prisma.fuelTransaction.findUnique({ where: key, select: { id: true, loadId: true } });
    if (had) {
      if (!had.loadId && loadId) await prisma.fuelTransaction.update({ where: key, data: { loadId } });
      continue;
    }
    await prisma.fuelTransaction.create({
      data: { workspaceId: where.workspaceId, provider, externalId, vehicleId: where.vehicleId, loadId, postedAt: postedOf(p.on), location: p.location ?? null, gallons: dec(p.gallons), pricePerGallon: dec(p.pricePerGallon), discountPerGallon: dec(p.discountPerGallon), discount: dec(p.discount), amount: new Prisma.Decimal(p.amount) }
    });
    fresh += 1;
  }
  return fresh;
}

export type FuelSync = { ok: true; trucks: number; purchases: number; fresh: number } | { ok: false; error: string; code?: string };

const dayOf = (d: Date) => d.toISOString().slice(0, 10);
const DAY = 86_400_000;

/** The most days one read goes back. The card company's own limits are its own; this keeps one click from asking for years. */
export const FUEL_MAX_DAYS = 120;

/**
 * Read the last `days` of purchases for every truck that has a fuel card set, and keep them. A truck whose card cannot be reached is named and the rest are still read; the first truck's
 * refusal for a reason that applies to all of them (no keys, not connected) stops the run with that reason.
 */
export async function syncFuelCards(days: number, now = new Date(), workspaceId = currentWorkspaceId()): Promise<FuelSync> {
  const span = Math.min(Math.max(1, whole(days)), FUEL_MAX_DAYS);
  const since = new Date(now.getTime() - span * DAY);
  const trucks = await prisma.vehicle.findMany({ where: { workspaceId, archivedAt: null, costProfile: { fuelCardAccountId: { not: null } } }, include: { costProfile: true }, orderBy: { name: "asc" }, take: 2000 });
  if (trucks.length === 0) return { ok: false, error: "No truck has a fuel card set. Add one on the truck's page." };
  let purchases = 0;
  let fresh = 0;
  let read = 0;
  const unreached: string[] = [];
  for (const t of trucks) {
    const profile = t.costProfile!;
    const { provider, result } = await callPartner("fuel_card", profile.fuelCardProvider, { vehicleName: t.name, accountId: profile.fuelCardAccountId!, since: dayOf(since), until: dayOf(now) }, workspaceId);
    if (!result.ok) {
      if (result.code === "not_configured" || result.code === "not_connected" || result.code === "not_implemented") return { ok: false, error: result.message ?? "The fuel card could not be reached.", code: result.code };
      unreached.push(t.name ?? "a truck");
      continue;
    }
    // This truck's loads around those days, to tie each purchase to the load it was bought on.
    const loads = await prisma.load.findMany({
      where: { workspaceId, vehicleId: t.id, deletedAt: null, status: { in: ["accepted", "in_progress", "completed"] }, stops: { some: { timeWindowEarliest: { gte: new Date(since.getTime() - 5 * DAY) } } } },
      select: { id: true, stops: { select: { timeWindowEarliest: true, timeWindowLatest: true } } }
    });
    const spans = loads
      .map((l) => {
        const times = l.stops.flatMap((s) => [s.timeWindowEarliest, s.timeWindowLatest]).filter((d): d is Date => d != null).map((d) => d.getTime());
        return times.length > 0 ? { id: l.id, from: Math.min(...times) - DAY, to: Math.max(...times) + DAY } : null;
      })
      .filter((s): s is { id: string; from: number; to: number } => s != null);
    const loadFor = (on: string) => {
      const at = postedOf(on).getTime();
      const hit = spans.filter((s) => at >= s.from && at <= s.to).sort((a, b) => gap(at, (a.from + a.to) / 2) - gap(at, (b.from + b.to) / 2))[0];
      return hit?.id ?? null;
    };
    const got = result.data.purchases;
    purchases += got.length;
    fresh += await storePurchases(provider, got, { workspaceId, vehicleId: t.id, loadFor });
    read += 1;
  }
  if (read === 0) return { ok: false, error: `The fuel card could not be reached for ${unreached.slice(0, 3).join(", ")}.`, code: "upstream_error" };
  await recordAudit({ entity: "fleet", action: "fuel_imported", summary: `${fresh} new fuel ${fresh === 1 ? "purchase" : "purchases"} read for ${read} ${read === 1 ? "truck" : "trucks"} (last ${span} days)${unreached.length > 0 ? `; not reached: ${unreached.slice(0, 3).join(", ")}` : ""}`, at: now, workspaceId });
  return { ok: true, trucks: read, purchases, fresh };
}

export const FUEL_PAGE = 50;
export type FuelRow = {
  id: string;
  postedAt: Date;
  truckId: string | null;
  truck: string | null;
  location: string | null;
  provider: string;
  providerName: string;
  gallons: number | null;
  pricePerGallon: number | null;
  discountPerGallon: number | null;
  discount: number | null;
  amount: number;
  loadId: string | null;
  loadNumber: string | null;
  statementId: string | null;
  statementNumber: string | null;
  /** The purchase was deducted from the driver's pay on that statement (not only on a load that is on it). */
  deducted: boolean;
};
export type FuelTotals = { purchases: number; gallons: number; charged: number; discount: number; netPerGallon: number | null };

/** The purchases of the last `days`, newest first, a page at a time, with the totals for the whole period and the load and driver statement each is tied to. */
export async function listFuel(opts: { days?: number; page?: number; terminal?: Terminals } = {}, now = new Date(), workspaceId = currentWorkspaceId()): Promise<{ rows: FuelRow[]; totals: FuelTotals; page: number; pageSize: number; total: number }> {
  const span = Math.min(Math.max(1, whole(opts.days ?? 30)), 366);
  const page = Math.max(1, whole(opts.page ?? 1));
  const where: Prisma.FuelTransactionWhereInput = { workspaceId, postedAt: { gte: new Date(`${dayOf(new Date(now.getTime() - span * DAY))}T00:00:00Z`) }, ...(opts.terminal != null ? { vehicle: { terminal: terminalFilter(opts.terminal) } } : {}) };
  const [rows, total, sums] = await Promise.all([
    prisma.fuelTransaction.findMany({ where, include: { vehicle: { select: { name: true } }, settlement: { select: { id: true, number: true, status: true } }, load: { select: { loadNumber: true, settlement: { select: { settlement: { select: { id: true, number: true, status: true } } } } } } }, orderBy: [{ postedAt: "desc" }, { id: "asc" }], skip: (page - 1) * FUEL_PAGE, take: FUEL_PAGE }),
    prisma.fuelTransaction.count({ where }),
    prisma.fuelTransaction.aggregate({ where, _sum: { gallons: true, amount: true, discount: true } })
  ]);
  const gallons = num(sums._sum.gallons);
  const charged = num(sums._sum.amount);
  return {
    rows: rows.map((r) => {
      // The statement it was deducted on comes first; failing that, the statement the load it is tied to is on.
      const direct = r.settlement && r.settlement.status !== "void" ? r.settlement : null;
      const st = direct ?? r.load?.settlement?.settlement;
      return {
        id: r.id,
        postedAt: r.postedAt,
        truckId: r.vehicleId,
        truck: r.vehicle?.name ?? null,
        location: r.location,
        provider: r.provider,
        providerName: providerName(r.provider),
        gallons: numOrNull(r.gallons),
        pricePerGallon: numOrNull(r.pricePerGallon),
        discountPerGallon: numOrNull(r.discountPerGallon),
        discount: numOrNull(r.discount),
        amount: num(r.amount),
        loadId: r.loadId,
        loadNumber: r.load?.loadNumber ?? null,
        // A statement that was voided is not a statement the load is on.
        statementId: st && st.status !== "void" ? st.id : null,
        statementNumber: st && st.status !== "void" ? st.number : null,
        deducted: direct != null
      };
    }),
    totals: { purchases: total, gallons, charged, discount: num(sums._sum.discount), netPerGallon: gallons > 0 ? new Prisma.Decimal(charged).div(gallons).toDecimalPlaces(3).toNumber() : null },
    page,
    pageSize: FUEL_PAGE,
    total
  };
}
