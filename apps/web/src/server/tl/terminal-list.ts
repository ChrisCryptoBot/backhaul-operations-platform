import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { cleanDriverCode } from "@/lib/driver-code";
import { recordAudit } from "./audit";
import { currentWorkspaceId } from "./workspace";

/**
 * The terminals a fleet has, as a list people manage (Settings, Terminals). A terminal is a yard, branch or region. A driver's terminal is their home base, never a fence: any driver can be given
 * a load from anywhere. The `terminal` text columns on drivers, trucks and trailers stay, and hold a name from this list. A name typed anywhere else is matched to the list ignoring case, and a new
 * one is added to it (so the list is always everything in use and a typo in capitals cannot make a second terminal); an admin renames, retires or merges them here.
 */
type Db = Prisma.TransactionClient | typeof prisma;

export const MAX_TERMINAL_NAME = 40;
/** A terminal name as kept: spaces squeezed, trimmed. Empty is "no terminal". */
export const cleanTerminalName = (text: string | null | undefined): string => (text ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_TERMINAL_NAME);

export type TerminalRow = { id: string; name: string; city: string | null; note: string | null; drivers: number; trucks: number; trailers: number };

/** The active terminals with what is based at each. */
export async function terminalRows(workspaceId = currentWorkspaceId()): Promise<TerminalRow[]> {
  const [terms, drivers, trucks, trailers] = await Promise.all([
    prisma.terminal.findMany({ where: { workspaceId, archivedAt: null }, orderBy: { name: "asc" } }),
    prisma.driver.groupBy({ by: ["terminal"], where: { workspaceId, active: true, terminal: { not: null } }, _count: { _all: true } }),
    prisma.vehicle.groupBy({ by: ["terminal"], where: { workspaceId, archivedAt: null, terminal: { not: null } }, _count: { _all: true } }),
    prisma.trailer.groupBy({ by: ["terminal"], where: { workspaceId, archivedAt: null, terminal: { not: null } }, _count: { _all: true } })
  ]);
  const by = (rows: Array<{ terminal: string | null; _count: { _all: number } }>) => {
    const m = new Map<string, number>();
    for (const r of rows) m.set((r.terminal ?? "").toLowerCase(), (m.get((r.terminal ?? "").toLowerCase()) ?? 0) + r._count._all);
    return m;
  };
  const d = by(drivers);
  const v = by(trucks);
  const t = by(trailers);
  return terms.map((x) => ({ id: x.id, name: x.name, city: x.city, note: x.note, drivers: d.get(x.name.toLowerCase()) ?? 0, trucks: v.get(x.name.toLowerCase()) ?? 0, trailers: t.get(x.name.toLowerCase()) ?? 0 }));
}

/** The names a person may pick, active only. */
export async function terminalNames(workspaceId = currentWorkspaceId(), db: Db = prisma): Promise<string[]> {
  const rows = await db.terminal.findMany({ where: { workspaceId, archivedAt: null }, select: { name: true }, orderBy: { name: "asc" } });
  return rows.map((r) => r.name);
}

/**
 * The list's own spelling of each name typed, adding any that are new (and bringing a retired one back). Used by every place that saves a terminal as text, so the list and the columns agree.
 * Blank gives nothing for that name.
 */
export async function canonicalTerminals(db: Db, workspaceId: string, names: Array<string | null | undefined>): Promise<Map<string, string>> {
  const wanted = new Map<string, string>();
  for (const n of names) {
    const c = cleanTerminalName(n);
    if (c) wanted.set(c.toLowerCase(), wanted.get(c.toLowerCase()) ?? c);
  }
  const out = new Map<string, string>();
  if (wanted.size === 0) return out;
  const have = await db.terminal.findMany({ where: { workspaceId, name: { in: [...wanted.values()], mode: "insensitive" } } });
  for (const h of have) {
    out.set(h.name.toLowerCase(), h.name);
    if (h.archivedAt) await db.terminal.update({ where: { id: h.id }, data: { archivedAt: null } });
  }
  for (const [key, name] of wanted) {
    if (out.has(key)) continue;
    await db.terminal.create({ data: { workspaceId, name } });
    out.set(key, name);
  }
  return out;
}

export type TerminalResult = { ok: true; id?: string } | { ok: false; error: string };

export async function addTerminal(input: { name: string; city?: string | null; note?: string | null }, now = new Date(), workspaceId = currentWorkspaceId()): Promise<TerminalResult> {
  const name = cleanTerminalName(input.name);
  if (!name) return { ok: false, error: "Give the terminal a name." };
  const city = input.city?.trim() || null;
  const note = input.note?.trim() || null;
  const dup = await prisma.terminal.findFirst({ where: { workspaceId, name: { equals: name, mode: "insensitive" } } });
  if (dup && !dup.archivedAt) return { ok: false, error: `${dup.name} is already a terminal.` };
  const row = await prisma.$transaction(async (tx) => {
    const r = dup ? await tx.terminal.update({ where: { id: dup.id }, data: { name, city, note, archivedAt: null } }) : await tx.terminal.create({ data: { workspaceId, name, city, note } });
    await recordAudit({ entity: "fleet", entityId: r.id, action: "terminal_added", summary: `Terminal ${name} added`, before: null, after: { Terminal: name, City: city, Note: note }, at: now, workspaceId }, tx);
    return r;
  });
  return { ok: true, id: row.id };
}

/** Rename: the list and every driver, truck and trailer based there change together. */
export async function renameTerminal(id: string, nameInput: string, now = new Date(), workspaceId = currentWorkspaceId()): Promise<TerminalResult> {
  const name = cleanTerminalName(nameInput);
  if (!name) return { ok: false, error: "Give the terminal a name." };
  const t = await prisma.terminal.findFirst({ where: { id, workspaceId, archivedAt: null } });
  if (!t) return { ok: false, error: "That terminal does not exist." };
  if (t.name === name) return { ok: true, id };
  const clash = await prisma.terminal.findFirst({ where: { workspaceId, id: { not: id }, name: { equals: name, mode: "insensitive" } } });
  if (clash) return { ok: false, error: `${clash.name} is already a terminal.` };
  await prisma.$transaction(async (tx) => {
    await tx.terminal.update({ where: { id }, data: { name } });
    const old = { equals: t.name, mode: "insensitive" as const };
    await tx.driver.updateMany({ where: { workspaceId, terminal: old }, data: { terminal: name } });
    await tx.vehicle.updateMany({ where: { workspaceId, terminal: old }, data: { terminal: name } });
    await tx.trailer.updateMany({ where: { workspaceId, terminal: old }, data: { terminal: name } });
    await recordAudit({ entity: "fleet", entityId: id, action: "terminal_renamed", summary: `Terminal ${t.name} renamed ${name}`, before: { Terminal: t.name }, after: { Terminal: name }, at: now, workspaceId }, tx);
  });
  return { ok: true, id };
}

/** Retire a terminal nobody is based at any more. Refused while drivers, trucks or trailers still are: move them first. */
export async function archiveTerminal(id: string, now = new Date(), workspaceId = currentWorkspaceId()): Promise<TerminalResult> {
  const t = await prisma.terminal.findFirst({ where: { id, workspaceId, archivedAt: null } });
  if (!t) return { ok: false, error: "That terminal does not exist." };
  const same = { equals: t.name, mode: "insensitive" as const };
  const [d, v, tr] = await Promise.all([
    prisma.driver.count({ where: { workspaceId, active: true, terminal: same } }),
    prisma.vehicle.count({ where: { workspaceId, archivedAt: null, terminal: same } }),
    prisma.trailer.count({ where: { workspaceId, archivedAt: null, terminal: same } })
  ]);
  if (d + v + tr > 0) {
    const bits = [d ? `${d} ${d === 1 ? "driver" : "drivers"}` : null, v ? `${v} ${v === 1 ? "truck" : "trucks"}` : null, tr ? `${tr} ${tr === 1 ? "trailer" : "trailers"}` : null].filter(Boolean).join(", ");
    return { ok: false, error: `${bits} ${d + v + tr === 1 ? "is" : "are"} still based at ${t.name}. Move ${d + v + tr === 1 ? "it" : "them"} to another terminal first.` };
  }
  await prisma.$transaction(async (tx) => {
    await tx.terminal.update({ where: { id }, data: { archivedAt: now } });
    await recordAudit({ entity: "fleet", entityId: id, action: "terminal_archived", summary: `Terminal ${t.name} retired`, before: { Terminal: t.name }, after: null, at: now, workspaceId }, tx);
  });
  return { ok: true };
}

/** Give drivers a home terminal from the list (null takes it away). Only a terminal on the list may be picked. */
export async function setDriversHome(driverIds: string[], terminal: string | null, now = new Date(), workspaceId = currentWorkspaceId()): Promise<TerminalResult> {
  const ids = [...new Set(driverIds)];
  if (ids.length === 0) return { ok: false, error: "Pick at least one driver." };
  let name: string | null = null;
  if (terminal != null && cleanTerminalName(terminal) !== "") {
    const t = await prisma.terminal.findFirst({ where: { workspaceId, archivedAt: null, name: { equals: cleanTerminalName(terminal), mode: "insensitive" } } });
    if (!t) return { ok: false, error: "That terminal is not on the list. An admin adds terminals in Settings." };
    name = t.name;
  }
  const drivers = await prisma.driver.findMany({ where: { id: { in: ids }, workspaceId }, select: { id: true, name: true, terminal: true } });
  if (drivers.length !== ids.length) return { ok: false, error: "One of those drivers is not on this desk." };
  const moving = drivers.filter((d) => (d.terminal ?? null) !== name);
  if (moving.length === 0) return { ok: true };
  await prisma.$transaction(async (tx) => {
    await tx.driver.updateMany({ where: { id: { in: moving.map((d) => d.id) }, workspaceId }, data: { terminal: name } });
    await recordAudit(
      { entity: "fleet", entityId: moving.length === 1 ? moving[0]!.id : null, action: "driver_home_set", summary: moving.length === 1 ? `${moving[0]!.name}: home terminal ${name ?? "cleared"}` : `${moving.length} drivers: home terminal ${name ?? "cleared"}`, before: moving.length === 1 ? { Terminal: moving[0]!.terminal } : null, after: { Terminal: name, Drivers: moving.map((d) => d.name).slice(0, 20).join(", ") }, at: now, workspaceId },
      tx
    );
  });
  return { ok: true };
}

/** Change a driver's code: letters and digits, up to eight, never one another driver holds. */
export async function setDriverCode(id: string, codeInput: string, now = new Date(), workspaceId = currentWorkspaceId()): Promise<TerminalResult> {
  const code = cleanDriverCode(codeInput);
  if (code.length < 2) return { ok: false, error: "A code is two to eight letters or digits." };
  const d = await prisma.driver.findFirst({ where: { id, workspaceId }, select: { id: true, name: true, code: true } });
  if (!d) return { ok: false, error: "That driver does not exist." };
  if (d.code === code) return { ok: true, id };
  const taken = await prisma.driver.findFirst({ where: { workspaceId, code, id: { not: id } }, select: { name: true } });
  if (taken) return { ok: false, error: `${code} is already ${taken.name}'s code.` };
  await prisma.$transaction(async (tx) => {
    await tx.driver.update({ where: { id }, data: { code } });
    await recordAudit({ entity: "fleet", entityId: id, action: "driver_code_changed", summary: `${d.name}: code ${d.code ?? "none"} to ${code}`, before: { Code: d.code }, after: { Code: code }, at: now, workspaceId }, tx);
  });
  return { ok: true, id };
}
