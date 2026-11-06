import { prisma } from "@/lib/db";
import { recordAudit } from "./audit";
import { cleanTerminalName } from "./terminal-list";
import { currentWorkspaceId } from "./workspace";

/**
 * Regions: groups of terminals (Texas, the Southeast) that a person can be pointed at, so a big fleet is read one region at a time (lib/scope.ts). An admin makes, renames and retires them and says which
 * region each terminal belongs to; units stay assigned to a terminal and a terminal belongs to at most one region. A region is never retired, and a terminal never retired, while a person is limited
 * to it: that would quietly leave them seeing nothing, so the admin moves them first. Everything is audited.
 */
export const MAX_REGION_NAME = 40;
export const cleanRegionName = (text: string | null | undefined): string => (text ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_REGION_NAME);

export type RegionResult = { ok: true; id?: string } | { ok: false; error: string };

export type RegionRow = { id: string; name: string; note: string | null; terminals: Array<{ id: string; name: string; trucks: number; drivers: number }>; people: number };

/** The live regions with their terminals, what is based at each, and how many people are limited to the region. */
export async function regionRows(workspaceId = currentWorkspaceId()): Promise<{ regions: RegionRow[]; unassigned: Array<{ id: string; name: string; trucks: number; drivers: number }> }> {
  const [regions, terminals, trucks, drivers, scopes] = await Promise.all([
    prisma.region.findMany({ where: { workspaceId, archivedAt: null }, orderBy: { name: "asc" } }),
    prisma.terminal.findMany({ where: { workspaceId, archivedAt: null }, orderBy: { name: "asc" }, select: { id: true, name: true, regionId: true } }),
    prisma.vehicle.groupBy({ by: ["terminal"], where: { workspaceId, archivedAt: null, terminal: { not: null } }, _count: { _all: true } }),
    prisma.driver.groupBy({ by: ["terminal"], where: { workspaceId, active: true, terminal: { not: null } }, _count: { _all: true } }),
    prisma.memberScope.groupBy({ by: ["regionId"], where: { regionId: { not: null }, member: { workspaceId } }, _count: { _all: true } })
  ]);
  const n = (rows: Array<{ terminal: string | null; _count: { _all: number } }>) => {
    const m = new Map<string, number>();
    for (const r of rows) m.set((r.terminal ?? "").toLowerCase(), (m.get((r.terminal ?? "").toLowerCase()) ?? 0) + r._count._all);
    return m;
  };
  const tr = n(trucks);
  const dr = n(drivers);
  const row = (t: { id: string; name: string }) => ({ id: t.id, name: t.name, trucks: tr.get(t.name.toLowerCase()) ?? 0, drivers: dr.get(t.name.toLowerCase()) ?? 0 });
  const people = new Map(scopes.map((s) => [s.regionId, s._count._all]));
  const live = new Set(regions.map((r) => r.id));
  return {
    regions: regions.map((r) => ({ id: r.id, name: r.name, note: r.note, terminals: terminals.filter((t) => t.regionId === r.id).map(row), people: people.get(r.id) ?? 0 })),
    unassigned: terminals.filter((t) => !t.regionId || !live.has(t.regionId)).map(row)
  };
}

export async function addRegion(input: { name: string; note?: string | null }, now = new Date(), workspaceId = currentWorkspaceId()): Promise<RegionResult> {
  const name = cleanRegionName(input.name);
  if (!name) return { ok: false, error: "Give the region a name." };
  const note = input.note?.trim() || null;
  const dup = await prisma.region.findFirst({ where: { workspaceId, archivedAt: null, name: { equals: name, mode: "insensitive" } } });
  if (dup) return { ok: false, error: `${dup.name} is already a region.` };
  const row = await prisma.$transaction(async (tx) => {
    const r = await tx.region.create({ data: { workspaceId, name, note } });
    await recordAudit({ entity: "fleet", entityId: r.id, action: "region_added", summary: `Region ${name} added`, before: null, after: { Region: name, Note: note }, at: now, workspaceId }, tx);
    return r;
  });
  return { ok: true, id: row.id };
}

export async function renameRegion(id: string, nameInput: string, now = new Date(), workspaceId = currentWorkspaceId()): Promise<RegionResult> {
  const name = cleanRegionName(nameInput);
  if (!name) return { ok: false, error: "Give the region a name." };
  const r = await prisma.region.findFirst({ where: { id, workspaceId, archivedAt: null } });
  if (!r) return { ok: false, error: "That region does not exist." };
  if (r.name === name) return { ok: true, id };
  const clash = await prisma.region.findFirst({ where: { workspaceId, archivedAt: null, id: { not: id }, name: { equals: name, mode: "insensitive" } } });
  if (clash) return { ok: false, error: `${clash.name} is already a region.` };
  await prisma.$transaction(async (tx) => {
    await tx.region.update({ where: { id }, data: { name } });
    await recordAudit({ entity: "fleet", entityId: id, action: "region_renamed", summary: `Region ${r.name} renamed ${name}`, before: { Region: r.name }, after: { Region: name }, at: now, workspaceId }, tx);
  });
  return { ok: true, id };
}

/** Retire a region. Its terminals become unassigned. Refused while a person is limited to it: they would be left seeing nothing. */
export async function archiveRegion(id: string, now = new Date(), workspaceId = currentWorkspaceId()): Promise<RegionResult> {
  const r = await prisma.region.findFirst({ where: { id, workspaceId, archivedAt: null } });
  if (!r) return { ok: false, error: "That region does not exist." };
  const people = await prisma.memberScope.count({ where: { regionId: id, member: { workspaceId } } });
  if (people > 0) return { ok: false, error: `${people} ${people === 1 ? "person is" : "people are"} limited to ${r.name}. Change what ${people === 1 ? "they" : "they"} can see first (Settings, Team).` };
  await prisma.$transaction(async (tx) => {
    await tx.terminal.updateMany({ where: { workspaceId, regionId: id }, data: { regionId: null } });
    await tx.region.update({ where: { id }, data: { archivedAt: now } });
    await recordAudit({ entity: "fleet", entityId: id, action: "region_archived", summary: `Region ${r.name} retired`, before: { Region: r.name }, after: null, at: now, workspaceId }, tx);
  });
  return { ok: true };
}

/** Put a terminal in a region, or (null) take it out of its region. */
export async function setTerminalRegion(terminalId: string, regionId: string | null, now = new Date(), workspaceId = currentWorkspaceId()): Promise<RegionResult> {
  const t = await prisma.terminal.findFirst({ where: { id: terminalId, workspaceId, archivedAt: null }, include: { region: { select: { name: true } } } });
  if (!t) return { ok: false, error: "That terminal does not exist." };
  let region: { id: string; name: string } | null = null;
  if (regionId) {
    region = await prisma.region.findFirst({ where: { id: regionId, workspaceId, archivedAt: null }, select: { id: true, name: true } });
    if (!region) return { ok: false, error: "That region does not exist." };
  }
  if ((t.regionId ?? null) === (region?.id ?? null)) return { ok: true };
  // Moving a terminal out of the region a person is limited to would change what that person sees: said, not silent (the audit line names both).
  await prisma.$transaction(async (tx) => {
    await tx.terminal.update({ where: { id: terminalId }, data: { regionId: region?.id ?? null } });
    await recordAudit({ entity: "fleet", entityId: terminalId, action: "terminal_region_set", summary: `Terminal ${t.name}: ${region ? `in ${region.name}` : "no region"}`, before: { Region: t.region?.name ?? "None" }, after: { Region: region?.name ?? "None" }, at: now, workspaceId }, tx);
  });
  return { ok: true };
}

export type MemberScopeInput = { regionIds: string[]; terminals: string[] };

/**
 * What a person may see. Empty means not limited. An admin is never limited (they run the desk), so one cannot be pointed at a region; the other roles can. The regions and terminals must exist on this
 * desk; a terminal is kept by its name, and a rename keeps the rows in step (terminal-list.ts).
 */
export async function setMemberScope(memberId: string, input: MemberScopeInput, now = new Date(), workspaceId = currentWorkspaceId()): Promise<RegionResult> {
  const m = await prisma.member.findFirst({ where: { id: memberId, workspaceId }, select: { id: true, name: true, role: true, scopes: { select: { regionId: true, terminal: true, region: { select: { name: true } } } } } });
  if (!m) return { ok: false, error: "That person is not on this desk." };
  const regionIds = [...new Set((input.regionIds ?? []).map(String))];
  const wantTerminals = [...new Set((input.terminals ?? []).map((t) => cleanTerminalName(t)).filter(Boolean))];
  if (m.role === "admin" && (regionIds.length > 0 || wantTerminals.length > 0)) return { ok: false, error: "An admin always sees everything. Change their role first to limit what they see." };
  const [regions, terminals] = await Promise.all([
    regionIds.length ? prisma.region.findMany({ where: { workspaceId, archivedAt: null, id: { in: regionIds } }, select: { id: true, name: true } }) : Promise.resolve([]),
    wantTerminals.length ? prisma.terminal.findMany({ where: { workspaceId, archivedAt: null, name: { in: wantTerminals, mode: "insensitive" } }, select: { name: true } }) : Promise.resolve([])
  ]);
  if (regions.length !== regionIds.length) return { ok: false, error: "One of those regions does not exist." };
  const canonical = new Map(terminals.map((t) => [t.name.toLowerCase(), t.name]));
  if (wantTerminals.some((t) => !canonical.has(t.toLowerCase()))) return { ok: false, error: "One of those terminals does not exist." };
  const names = [...new Set(wantTerminals.map((t) => canonical.get(t.toLowerCase())!))];
  const words = (rs: string[], ts: string[]) => ([...rs, ...ts].length === 0 ? "Everything" : [...rs.map((r) => `${r} region`), ...ts].join(", "));
  const before = words(m.scopes.flatMap((s) => (s.region ? [s.region.name] : [])), m.scopes.flatMap((s) => (s.terminal ? [s.terminal] : [])));
  const after = words(regions.map((r) => r.name), names);
  if (before === after) return { ok: true };
  await prisma.$transaction(async (tx) => {
    await tx.memberScope.deleteMany({ where: { memberId } });
    if (regions.length + names.length > 0) await tx.memberScope.createMany({ data: [...regions.map((r) => ({ memberId, regionId: r.id })), ...names.map((t) => ({ memberId, terminal: t }))] });
    await recordAudit({ entity: "settings", entityId: memberId, action: "member_scope_changed", summary: `${m.name} can see: ${after}`, before: { Sees: before }, after: { Sees: after }, at: now, workspaceId }, tx);
  });
  return { ok: true };
}
