import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import type { AuditSnapshot } from "@/lib/audit-diff";
import { asSort, pageCount, type SortDir } from "@/lib/paging";
import { loadWindow, windowsOverlap } from "@/lib/schedule";
import { alertThresholds } from "@/lib/thresholds";
import { trailerFit, type TrailerFit } from "@/lib/trailer-fit";
import { complianceState, statusLabel, trailerBlocker } from "@/lib/trailer-clearance";
import { OWNERSHIPS, validateTrailer, type TrailerValues } from "@/lib/trailer-forms";
import { ymdOf } from "@/lib/fleet-forms";
import { trailerLabel } from "@/truelane/constants/trailerData";
import { recordAudit } from "./audit";
import { num, numOrNull } from "./convert";
import { getThresholds } from "./thresholds";
import { currentWorkspaceId } from "./workspace";

/**
 * The trailer registry: add and change a trailer, archive it, hook it to a tractor, put it on a load. Every change is one transaction with its audit event, and the event
 * carries the trailer's id so its history is found by id. A trailer is a unit of its own (its number, plate, compliance dates and place) and a tractor pulls one at a time.
 */
export type SaveResult = { ok: true; id: string; changed: boolean } | { ok: false; errors?: Partial<Record<keyof TrailerValues, string>>; error?: string };
export type ActResult = { ok: true } | { ok: false; error: string };

const OPEN_LOAD = ["draft", "accepted", "in_progress"];
const ymd = ymdOf;
const yesNo = (b: boolean) => (b ? "yes" : "");
const isUnique = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";

type TrailerRow = NonNullable<Awaited<ReturnType<typeof prisma.trailer.findFirst>>>;

/** A stored trailer as the form's own values, so "nothing changed" and the before/after of the audit are read the same way a save is. */
export function valuesOf(t: TrailerRow): TrailerValues {
  const n = (d: unknown) => (d == null ? "" : String(num(d as never)));
  return {
    number: t.number,
    type: t.type ?? "",
    plate: t.plate ?? "",
    plateState: t.plateState ?? "",
    vin: t.vin ?? "",
    ownership: t.ownership,
    lengthFt: n(t.lengthFt),
    widthIn: n(t.widthIn),
    tareLbs: t.tareLbs == null ? "" : String(t.tareLbs),
    maxPayloadLbs: t.maxPayloadLbs == null ? "" : String(t.maxPayloadLbs),
    axles: t.axles == null ? "" : String(t.axles),
    hasLiftgate: yesNo(t.hasLiftgate),
    hasETrack: yesNo(t.hasETrack),
    status: t.status,
    terminal: t.terminal ?? "",
    location: t.location ?? "",
    registrationExpiry: ymd(t.registrationExpiry),
    inspectionExpiry: ymd(t.inspectionExpiry),
    notes: t.notes ?? ""
  };
}

function snapshot(v: TrailerValues): AuditSnapshot {
  return {
    Number: v.number,
    Type: v.type ? trailerLabel(v.type) : null,
    Plate: v.plate ? `${v.plate}${v.plateState ? ` (${v.plateState})` : ""}` : null,
    VIN: v.vin || null,
    Ownership: OWNERSHIPS.find((o) => o.key === v.ownership)?.label ?? v.ownership,
    "Length (ft)": v.lengthFt || null,
    "Width (in)": v.widthIn || null,
    "Empty weight (lb)": v.tareLbs || null,
    "Payload (lb)": v.maxPayloadLbs || null,
    Axles: v.axles || null,
    Liftgate: v.hasLiftgate === "yes" ? "Yes" : null,
    "E-track": v.hasETrack === "yes" ? "Yes" : null,
    Status: statusLabel(v.status),
    Terminal: v.terminal || null,
    Location: v.location || null,
    "Registration good through": v.registrationExpiry || null,
    "Inspection good through": v.inspectionExpiry || null,
    Notes: v.notes || null
  };
}

function dataOf(v: TrailerValues, n: { lengthFt: number | null; widthIn: number | null; tareLbs: number | null; maxPayloadLbs: number | null; axles: number | null; registrationExpiry: Date | null; inspectionExpiry: Date | null }) {
  return {
    number: v.number,
    type: v.type || null,
    plate: v.plate || null,
    plateState: v.plateState || null,
    vin: v.vin || null,
    ownership: v.ownership,
    lengthFt: n.lengthFt,
    widthIn: n.widthIn,
    tareLbs: n.tareLbs,
    maxPayloadLbs: n.maxPayloadLbs,
    axles: n.axles,
    hasLiftgate: v.hasLiftgate === "yes",
    hasETrack: v.hasETrack === "yes",
    status: v.status,
    terminal: v.terminal || null,
    location: v.location || null,
    registrationExpiry: n.registrationExpiry,
    inspectionExpiry: n.inspectionExpiry,
    notes: v.notes || null
  };
}

const NUMBER_TAKEN = { number: "A trailer with that number is already in service." };

export async function saveTrailer(raw: Record<string, unknown>, id: string | null, now = new Date(), workspaceId = currentWorkspaceId()): Promise<SaveResult> {
  const check = validateTrailer(raw);
  if (!check.ok) return { ok: false, errors: check.errors };
  const v = check.value;
  const clash = await prisma.trailer.findFirst({ where: { workspaceId, archivedAt: null, number: { equals: v.number, mode: "insensitive" }, ...(id ? { id: { not: id } } : {}) } });
  if (clash) return { ok: false, errors: NUMBER_TAKEN };
  const data = dataOf(v, check.numbers);
  const after = snapshot(v);
  try {
    if (id == null) {
      const created = await prisma.$transaction(async (tx) => {
        const t = await tx.trailer.create({ data: { workspaceId, ...data } });
        await recordAudit({ entity: "trailer", entityId: t.id, action: "trailer_added", summary: `${v.number} added as a trailer`, before: null, after, at: now, workspaceId }, tx);
        return t;
      });
      return { ok: true, id: created.id, changed: true };
    }
    const prev = await prisma.trailer.findFirst({ where: { id, workspaceId } });
    if (!prev) return { ok: false, error: "That trailer does not exist." };
    const before = snapshot(valuesOf(prev));
    const moved = Object.keys(after).filter((k) => String(before[k] ?? "") !== String(after[k] ?? ""));
    if (moved.length === 0) return { ok: true, id, changed: false };
    await prisma.$transaction(async (tx) => {
      await tx.trailer.update({ where: { id }, data });
      await recordAudit({ entity: "trailer", entityId: id, action: "trailer_changed", summary: `${v.number}: changed ${moved.join(", ").toLowerCase()}`, before, after, at: now, workspaceId }, tx);
    });
    return { ok: true, id, changed: true };
  } catch (e) {
    if (isUnique(e)) return { ok: false, errors: NUMBER_TAKEN };
    throw e;
  }
}

/** Archive a trailer (out of new work, history kept) or restore it. One on an open load cannot be archived; archiving unhooks it. */
export async function setTrailerArchived(id: string, archived: boolean, now = new Date(), workspaceId = currentWorkspaceId()): Promise<ActResult> {
  const t = await prisma.trailer.findFirst({ where: { id, workspaceId }, include: { currentVehicle: { select: { name: true } }, loads: { where: { deletedAt: null, status: { in: OPEN_LOAD } }, select: { loadNumber: true } } } });
  if (!t) return { ok: false, error: "That trailer does not exist." };
  if (archived) {
    if (t.archivedAt) return { ok: true };
    if (t.loads.length > 0) return { ok: false, error: `${t.number} is on ${t.loads.map((l) => l.loadNumber ?? "a load").join(", ")}. Take it off first.` };
  } else {
    if (!t.archivedAt) return { ok: true };
    const clash = await prisma.trailer.findFirst({ where: { workspaceId, archivedAt: null, number: { equals: t.number, mode: "insensitive" } } });
    if (clash) return { ok: false, error: `Another trailer numbered ${t.number} is in service.` };
  }
  await prisma.$transaction(async (tx) => {
    await tx.trailer.update({ where: { id }, data: { archivedAt: archived ? now : null, ...(archived ? { currentVehicleId: null } : {}) } });
    await recordAudit(
      { entity: "trailer", entityId: id, action: archived ? "trailer_archived" : "trailer_restored", summary: `${t.number} ${archived ? `archived${t.currentVehicle ? `; unhooked from ${t.currentVehicle.name}` : ""}` : "restored"}`, before: { Status: archived ? "In service" : "Archived" }, after: { Status: archived ? "Archived" : "In service" }, at: now, workspaceId },
      tx
    );
  });
  return { ok: true };
}

/** Hook a trailer to a tractor, or (with no tractor) unhook it. A tractor pulls one trailer at a time. */
export async function hookTrailer(id: string, vehicleId: string | null, now = new Date(), workspaceId = currentWorkspaceId()): Promise<ActResult> {
  const t = await prisma.trailer.findFirst({ where: { id, workspaceId, archivedAt: null }, include: { currentVehicle: { select: { name: true } } } });
  if (!t) return { ok: false, error: "That trailer is not available." };
  if (vehicleId == null) {
    if (!t.currentVehicleId) return { ok: true };
    await prisma.$transaction(async (tx) => {
      await tx.trailer.update({ where: { id }, data: { currentVehicleId: null } });
      await recordAudit({ entity: "trailer", entityId: id, action: "trailer_unhooked", summary: `${t.number} unhooked from ${t.currentVehicle?.name ?? "its tractor"}`, before: { Tractor: t.currentVehicle?.name ?? null }, after: { Tractor: null }, at: now, workspaceId }, tx);
    });
    return { ok: true };
  }
  const truck = await prisma.vehicle.findFirst({ where: { id: vehicleId, workspaceId, archivedAt: null }, select: { id: true, name: true } });
  if (!truck) return { ok: false, error: "That tractor is not available." };
  if (t.currentVehicleId === truck.id) return { ok: true };
  const other = await prisma.trailer.findFirst({ where: { workspaceId, archivedAt: null, currentVehicleId: truck.id, id: { not: id } }, select: { number: true } });
  if (other) return { ok: false, error: `${truck.name ?? "That tractor"} already pulls ${other.number}. Unhook it first.` };
  try {
    await prisma.$transaction(async (tx) => {
      await tx.trailer.update({ where: { id }, data: { currentVehicleId: truck.id } });
      await recordAudit({ entity: "trailer", entityId: id, action: "trailer_hooked", summary: `${t.number} hooked to ${truck.name ?? "a tractor"}`, before: { Tractor: t.currentVehicle?.name ?? null }, after: { Tractor: truck.name ?? null }, at: now, workspaceId }, tx);
    });
  } catch (e) {
    if (isUnique(e)) return { ok: false, error: `${truck.name ?? "That tractor"} already pulls a trailer. Unhook it first.` };
    throw e;
  }
  return { ok: true };
}

export type AssignTrailerResult = { ok: true; warnings: string[] } | { ok: false; error: string };

/**
 * Put a trailer on a load, or (with no trailer) take it off. The trailer must be able to take the load (trailer-fit.ts: the kind, the weight, the length, its state and
 * its dates) and must not already be on another open load at the same time. A load with no kind of trailer typed takes the trailer's kind.
 */
export async function assignTrailerToLoad(loadId: string, trailerId: string | null, now = new Date(), workspaceId = currentWorkspaceId()): Promise<AssignTrailerResult> {
  const load = await prisma.load.findFirst({ where: { id: loadId, workspaceId, deletedAt: null, status: { in: OPEN_LOAD } }, include: { stops: true, trailer: { select: { id: true, number: true } } } });
  if (!load) return { ok: false, error: "That load is not open." };
  if (trailerId == null) {
    if (!load.trailerId) return { ok: true, warnings: [] };
    const was = load.trailer?.number ?? "the trailer";
    await prisma.$transaction(async (tx) => {
      await tx.load.update({ where: { id: loadId }, data: { trailerId: null } });
      await recordAudit({ entity: "trailer", entityId: load.trailerId, action: "trailer_assigned", loadId, loadNumber: load.loadNumber, summary: `${was} taken off ${load.loadNumber ?? "a load"}`, before: { Trailer: was }, after: { Trailer: null }, at: now, workspaceId }, tx);
    });
    return { ok: true, warnings: [] };
  }
  const trailer = await prisma.trailer.findFirst({ where: { id: trailerId, workspaceId, archivedAt: null } });
  if (!trailer) return { ok: false, error: "That trailer is not available." };
  if (load.trailerId === trailer.id) return { ok: true, warnings: [] };
  const soon = alertThresholds(await getThresholds(workspaceId)).clearanceDays;
  const fit: TrailerFit = trailerFit(
    { trailerType: load.trailerType, weightLbs: load.weightLbs, lengthFt: numOrNull(load.lengthFt), vehicleId: load.vehicleId },
    { number: trailer.number, type: trailer.type, maxPayloadLbs: trailer.maxPayloadLbs, lengthFt: numOrNull(trailer.lengthFt), currentVehicleId: trailer.currentVehicleId, status: trailer.status, registrationExpiry: trailer.registrationExpiry, inspectionExpiry: trailer.inspectionExpiry },
    now,
    soon
  );
  if (fit.blocker) return { ok: false, error: fit.blocker };
  const window = loadWindow(load.stops);
  if (window) {
    const others = await prisma.load.findMany({ where: { trailerId: trailer.id, id: { not: loadId }, deletedAt: null, status: { in: OPEN_LOAD } }, select: { loadNumber: true, stops: { select: { timeWindowEarliest: true, timeWindowLatest: true } } } });
    for (const o of others) {
      const w = loadWindow(o.stops);
      if (w && windowsOverlap(window, w)) return { ok: false, error: `${trailer.number} is already on ${o.loadNumber ?? "another load"} at that time.` };
    }
  }
  await prisma.$transaction(async (tx) => {
    await tx.load.update({ where: { id: loadId }, data: { trailerId: trailer.id, ...(load.trailerType ? {} : trailer.type ? { trailerType: trailer.type } : {}) } });
    await recordAudit({ entity: "trailer", entityId: trailer.id, action: "trailer_assigned", loadId, loadNumber: load.loadNumber, summary: `${trailer.number} put on ${load.loadNumber ?? "a load"}`, before: { Trailer: load.trailer?.number ?? null }, after: { Trailer: trailer.number }, at: now, workspaceId }, tx);
  });
  return { ok: true, warnings: fit.warnings };
}

// ── Reading ────────────────────────────────────────────────────────────────────────────────────

export const TRAILER_PAGE_SIZE = 50;
export const TRAILER_SORTS = ["number", "type", "status", "terminal", "registration", "inspection"] as const;
export type TrailerSort = (typeof TRAILER_SORTS)[number];
export const COMPLIANCE_FILTERS = ["lapsed", "soon", "ok"] as const;

const order = (key: TrailerSort, dir: SortDir): Prisma.TrailerOrderByWithRelationInput => {
  const nulls = "last" as const;
  switch (key) {
    case "type": return { type: { sort: dir, nulls } };
    case "status": return { status: dir };
    case "terminal": return { terminal: { sort: dir, nulls } };
    case "registration": return { registrationExpiry: { sort: dir, nulls } };
    case "inspection": return { inspectionExpiry: { sort: dir, nulls } };
    default: return { number: dir };
  }
};

export type TrailerPageQuery = { q?: string; sort?: string; page?: number; pageSize?: number; terminal?: string | null; type?: string; status?: string; ownership?: string; compliance?: string; archived?: boolean };

/** The compliance filter as a where clause: lapsed is a date in the past, soon a date within the window, ok neither. */
function complianceWhere(kind: string | undefined, now: Date, days: number): Prisma.TrailerWhereInput {
  const soonBy = new Date(now.getTime() + days * 86_400_000);
  const lapsed: Prisma.TrailerWhereInput = { OR: [{ registrationExpiry: { lt: now } }, { inspectionExpiry: { lt: now } }] };
  const soon: Prisma.TrailerWhereInput = { OR: [{ registrationExpiry: { gte: now, lte: soonBy } }, { inspectionExpiry: { gte: now, lte: soonBy } }] };
  if (kind === "lapsed") return lapsed;
  if (kind === "soon") return { AND: [{ NOT: lapsed }, soon] };
  if (kind === "ok") return { AND: [{ NOT: lapsed }, { NOT: soon }] };
  return {};
}

const terms = (q: string) => q.split(/\s+/).filter(Boolean).slice(0, 6);
const has = (field: "number" | "plate" | "vin", t: string) => ({ [field]: { contains: t, mode: "insensitive" as const } });

export async function listTrailersPage(query: TrailerPageQuery = {}, now = new Date(), workspaceId = currentWorkspaceId()) {
  const sort = asSort(query.sort, TRAILER_SORTS, { key: "number", dir: "asc" });
  const pageSize = query.pageSize ?? TRAILER_PAGE_SIZE;
  const q = query.q?.trim() ?? "";
  const days = alertThresholds(await getThresholds(workspaceId)).clearanceDays;
  const where: Prisma.TrailerWhereInput = {
    workspaceId,
    archivedAt: query.archived ? { not: null } : null,
    ...(query.terminal ? { terminal: query.terminal } : {}),
    ...(query.type ? { type: query.type } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(query.ownership ? { ownership: query.ownership } : {}),
    ...(q ? { AND: terms(q).map((t) => ({ OR: [has("number", t), has("plate", t), has("vin", t)] })) } : {}),
    ...(query.compliance ? { AND: [complianceWhere(query.compliance, now, days)] } : {})
  };
  const total = await prisma.trailer.count({ where });
  const pages = pageCount(total, pageSize);
  const page = Math.min(Math.max(1, query.page ?? 1), pages);
  const trailers = await prisma.trailer.findMany({
    where,
    include: { currentVehicle: { select: { id: true, name: true } }, loads: { where: { deletedAt: null, status: { in: OPEN_LOAD } }, select: { id: true, loadNumber: true }, take: 2 } },
    orderBy: [order(sort.key, sort.dir), { id: "asc" }],
    skip: (page - 1) * pageSize,
    take: pageSize
  });
  const rows = trailers.map((t) => ({
    id: t.id,
    number: t.number,
    type: t.type,
    plate: t.plate,
    plateState: t.plateState,
    ownership: t.ownership,
    status: t.status,
    terminal: t.terminal,
    location: t.location,
    hookedTo: t.currentVehicle?.name ?? null,
    onLoads: t.loads,
    registrationExpiry: t.registrationExpiry,
    inspectionExpiry: t.inspectionExpiry,
    compliance: complianceState(t, now, days),
    blocker: trailerBlocker(t, now),
    archived: t.archivedAt != null
  }));
  return { rows, total, page, pages, pageSize, sort, q };
}

export async function getTrailerDetail(id: string, workspaceId = currentWorkspaceId()) {
  const t = await prisma.trailer.findFirst({
    where: { id, workspaceId },
    include: { currentVehicle: { select: { id: true, name: true } }, loads: { where: { deletedAt: null, status: { in: OPEN_LOAD } }, orderBy: { scheduledDate: "asc" }, select: { id: true, loadNumber: true, status: true, scheduledDate: true, originAddress: true, destinationAddress: true } } }
  });
  return t;
}

/** Trailers that could take a kind of load now: in service, available, with no date lapsed and not on an open load. For the Quote's "trailers available". */
export async function countTrailersAvailable(trailerType: string | null, terminal: string | null, now = new Date(), workspaceId = currentWorkspaceId()): Promise<number> {
  return prisma.trailer.count({
    where: {
      workspaceId,
      archivedAt: null,
      status: "available",
      ...(trailerType ? { type: trailerType } : {}),
      ...(terminal ? { terminal } : {}),
      AND: [{ OR: [{ registrationExpiry: null }, { registrationExpiry: { gte: now } }] }, { OR: [{ inspectionExpiry: null }, { inspectionExpiry: { gte: now } }] }],
      loads: { none: { deletedAt: null, status: { in: OPEN_LOAD } } }
    }
  });
}
