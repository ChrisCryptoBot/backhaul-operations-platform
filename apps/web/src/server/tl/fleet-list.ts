import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { asSort, pageCount, type SortDir } from "@/lib/paging";
import { notQuote } from "@/lib/quote-status";
import { driverBlocker } from "./dispatch";
import { numOrNull } from "./convert";
import { currentWorkspaceId } from "./workspace";

/**
 * The Trucks and Drivers screens, a page at a time. A big fleet has thousands of each, so the search, the sort and the paging are the database's, and the
 * figures per row (loads, open loads, delivered) are counted for the page's rows only, not by reading every load and assignment of every truck and driver.
 */
export const FLEET_PAGE_SIZE = 50;
const OPEN = ["draft", "accepted", "in_progress"];

const terms = (q: string) => q.split(/\s+/).filter(Boolean).slice(0, 6);
const contains = (field: string, t: string) => ({ [field]: { contains: t, mode: "insensitive" as const } });

// ── Trucks ────────────────────────────────────────────────────────────────────────────────────

export const TRUCK_SORTS = ["truck", "type", "mpg", "fuel", "planned", "breakEven", "survival", "detention"] as const;
export type TruckSort = (typeof TRUCK_SORTS)[number];

const truckOrder = (key: TruckSort, dir: SortDir): Prisma.VehicleOrderByWithRelationInput => {
  const nulls = "last" as const;
  switch (key) {
    case "type": return { type: { sort: dir, nulls } };
    case "mpg": return { mpg: { sort: dir, nulls } };
    case "fuel": return { costProfile: { lastFuelPricePerGallon: { sort: dir, nulls } } };
    case "planned": return { costProfile: { estimatedMonthlyMiles: dir } };
    case "breakEven": return { costProfile: { breakEvenRpm: dir } };
    case "survival": return { costProfile: { survivalFloorRpm: { sort: dir, nulls } } };
    case "detention": return { costProfile: { detentionHourlyRate: { sort: dir, nulls } } };
    default: return { name: { sort: dir, nulls } };
  }
};

/** `terminal`: only that terminal's trucks (null / omitted = all of them). */
export type TruckPageQuery = { q?: string; sort?: string; page?: number; pageSize?: number; terminal?: string | null };

export async function listTrucksPage(query: TruckPageQuery = {}, workspaceId = currentWorkspaceId()) {
  const sort = asSort(query.sort, TRUCK_SORTS, { key: "truck", dir: "asc" });
  const pageSize = query.pageSize ?? FLEET_PAGE_SIZE;
  const q = query.q?.trim() ?? "";
  const where: Prisma.VehicleWhereInput = { workspaceId, ...(query.terminal ? { terminal: query.terminal } : {}), ...(q ? { AND: terms(q).map((t) => ({ OR: [contains("name", t), contains("type", t), contains("make", t), contains("model", t)] })) } : {}) };
  const total = await prisma.vehicle.count({ where });
  const pages = pageCount(total, pageSize);
  const page = Math.min(Math.max(1, query.page ?? 1), pages);
  const trucks = await prisma.vehicle.findMany({
    where,
    include: { costProfile: true },
    // Trucks in service first, then the chosen order.
    orderBy: [{ archivedAt: { sort: "asc", nulls: "first" } }, truckOrder(sort.key, sort.dir), { id: "asc" }],
    skip: (page - 1) * pageSize,
    take: pageSize
  });
  const counts = trucks.length
    ? await prisma.load.groupBy({ by: ["vehicleId", "status"], where: { vehicleId: { in: trucks.map((t) => t.id) }, deletedAt: null, ...notQuote }, _count: { _all: true } })
    : [];
  const loadsOf = new Map<string, { all: number; open: number }>();
  for (const c of counts) {
    if (!c.vehicleId) continue;
    const cur = loadsOf.get(c.vehicleId) ?? { all: 0, open: 0 };
    cur.all += c._count._all;
    if (OPEN.includes(c.status)) cur.open += c._count._all;
    loadsOf.set(c.vehicleId, cur);
  }
  const rows = trucks.map((t) => ({
    id: t.id,
    name: t.name,
    type: t.type,
    make: t.make,
    model: t.model,
    year: t.year,
    mpg: numOrNull(t.mpg),
    fuelPrice: numOrNull(t.costProfile?.lastFuelPricePerGallon),
    breakEvenRpm: numOrNull(t.costProfile?.breakEvenRpm),
    survivalFloorRpm: numOrNull(t.costProfile?.survivalFloorRpm),
    monthlyMiles: numOrNull(t.costProfile?.estimatedMonthlyMiles),
    archetype: t.costProfile?.archetype ?? null,
    archived: t.archivedAt != null,
    homeBase: t.homeBaseAddress,
    terminal: t.terminal,
    fuelType: t.fuelType,
    detentionRate: numOrNull(t.costProfile?.detentionHourlyRate),
    loads: loadsOf.get(t.id)?.all ?? 0,
    open: loadsOf.get(t.id)?.open ?? 0
  }));
  return { rows, total, page, pages, pageSize, sort, q };
}

// ── Drivers ───────────────────────────────────────────────────────────────────────────────────

export const DRIVER_SORTS = ["driver", "truck", "delivered"] as const;
export type DriverSort = (typeof DRIVER_SORTS)[number];

export type DriverPageQuery = { q?: string; sort?: string; page?: number; pageSize?: number; terminal?: string | null };

export async function listDriversPage(query: DriverPageQuery = {}, workspaceId = currentWorkspaceId()) {
  const sort = asSort(query.sort, ["driver", "truck"] as const, { key: "driver", dir: "asc" });
  const pageSize = query.pageSize ?? FLEET_PAGE_SIZE;
  const q = query.q?.trim() ?? "";
  const where: Prisma.DriverWhereInput = {
    workspaceId,
    ...(query.terminal ? { terminal: query.terminal } : {}),
    ...(q ? { AND: terms(q).map((t) => ({ OR: [contains("name", t), contains("phone", t), { assignedVehicle: { name: { contains: t, mode: "insensitive" as const } } }] })) } : {})
  };
  const total = await prisma.driver.count({ where });
  const pages = pageCount(total, pageSize);
  const page = Math.min(Math.max(1, query.page ?? 1), pages);
  const drivers = await prisma.driver.findMany({
    where,
    include: { assignedVehicle: { select: { name: true } } },
    orderBy: [{ active: "desc" }, sort.key === "truck" ? { assignedVehicle: { name: { sort: sort.dir, nulls: "last" } } } : { name: sort.dir }, { id: "asc" }],
    skip: (page - 1) * pageSize,
    take: pageSize
  });
  const ids = drivers.map((d) => d.id);
  // What each driver on this page is doing now, and how many they have delivered: read for these drivers only.
  const [open, delivered] = ids.length
    ? await Promise.all([
        prisma.assignment.findMany({
          where: { driverId: { in: ids }, status: { in: ["draft", "dispatched", "accepted", "in_progress"] }, load: { status: { in: OPEN }, deletedAt: null } },
          select: { driverId: true, status: true, loadId: true, load: { select: { loadNumber: true } } }
        }),
        prisma.assignment.groupBy({ by: ["driverId"], where: { driverId: { in: ids }, status: "completed" }, _count: { _all: true } })
      ])
    : [[], []];
  const rows = drivers.map((d) => {
    const mine = open.filter((a) => a.driverId === d.id);
    return {
      id: d.id,
      name: d.name,
      phone: d.phone,
      email: d.email,
      cdlClass: d.cdlClass,
      cdlExpiry: d.cdlExpiry,
      medicalCardExpiry: d.medicalCardExpiry,
      blocker: driverBlocker(d),
      truck: d.assignedVehicle?.name ?? null,
      active: d.active,
      current: mine.filter((a) => a.status !== "draft").map((a) => ({ loadId: a.loadId, loadNumber: a.load.loadNumber, status: a.status })),
      delivered: delivered.find((x) => x.driverId === d.id)?._count._all ?? 0,
      truckId: d.assignedVehicleId,
      payKind: d.defaultPayKind,
      payRate: numOrNull(d.defaultPayRate),
      terminal: d.terminal,
      carrierMc: d.carrierMcNumber,
      carrierDot: d.carrierDotNumber,
      payrollWorkerType: d.payrollWorkerType,
      payrollEmployeeId: d.payrollEmployeeId,
      vetStatus: d.vetStatus,
      coiExpiresAt: d.coiExpiresAt,
      vetCheckedAt: d.vetCheckedAt,
      openLoadNumbers: mine.map((a) => a.load.loadNumber ?? "a load")
    };
  });
  return { rows, total, page, pages, pageSize, sort, q };
}
