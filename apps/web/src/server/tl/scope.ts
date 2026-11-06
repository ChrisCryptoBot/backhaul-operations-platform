import { cookies } from "next/headers";
import { prisma } from "@/lib/db";
import { TERMINAL_COOKIE } from "@/lib/terminal";
import { SCOPE_COOKIE, allowedNames, buildMenu, parseChoice, resolveScope, termsOf, type RegionInfo, type ResolvedScope, type ScopeChoice, type ScopeLimit, type ScopeMenu, type Terminals } from "@/lib/scope";
import { sessionIdentity, authOn, demoIdentity } from "./identity";
import { listTerminals } from "./terminals-in-use";
import { currentWorkspaceId } from "./workspace";

/**
 * The scope of the request: what the person is looking at, inside what they are allowed to look at (lib/scope.ts has the rules). The limit is read from the member table on every request,
 * the same way their role is (a person taken off a region loses it on their next click); the choice is the header's cookie. Outside a request (a script, a test) there is no person and so no scope:
 * everything, as before.
 */
export type ScopeData = { regions: RegionInfo[]; terminals: string[] };

/** The workspace's live regions with their live terminals, and every terminal in use. */
export async function scopeData(workspaceId = currentWorkspaceId()): Promise<ScopeData> {
  const [regions, terminals] = await Promise.all([
    prisma.region.findMany({ where: { workspaceId, archivedAt: null }, orderBy: { name: "asc" }, select: { id: true, name: true, terminals: { where: { archivedAt: null }, select: { name: true }, orderBy: { name: "asc" } } } }),
    listTerminals(workspaceId)
  ]);
  return { regions: regions.map((r) => ({ id: r.id, name: r.name, terminals: r.terminals.map((t) => t.name) })), terminals };
}

/** A member's limit from their stored rows: none means not limited. */
export function limitOf(rows: ReadonlyArray<{ regionId: string | null; terminal: string | null }>): ScopeLimit {
  if (rows.length === 0) return { kind: "all" };
  return { kind: "some", regionIds: rows.flatMap((r) => (r.regionId ? [r.regionId] : [])), terminals: rows.flatMap((r) => (r.terminal ? [r.terminal] : [])) };
}

/** Who the request is, for scope: an admin (never limited, and never silently shown everything) and the limit. `null` outside a request. */
export async function requestLimit(data: ScopeData, workspaceId = currentWorkspaceId()): Promise<{ limit: ScopeLimit; admin: boolean } | null> {
  if (authOn()) {
    const id = sessionIdentity();
    if (!id) return null;
    const m = await prisma.member.findFirst({ where: { clerkUserId: id.userId, workspaceId }, select: { role: true, scopes: { select: { regionId: true, terminal: true } } } });
    if (!m) return null;
    return { admin: m.role === "admin", limit: m.role === "admin" ? { kind: "all" } : limitOf(m.scopes) };
  }
  const demo = demoIdentity();
  const role = demo?.role ?? "admin";
  if (role === "admin") return { admin: true, limit: { kind: "all" } };
  // The demo's dispatcher and driver manager work one patch: the first region, or the first terminal when there are no regions, so the limit can be seen working. Everyone else sees everything.
  if (role === "dispatcher" || role === "driver_manager") {
    const first = data.regions.find((r) => r.terminals.length > 0);
    if (first) return { admin: false, limit: { kind: "some", regionIds: [first.id], terminals: [] } };
    if (data.terminals[0]) return { admin: false, limit: { kind: "some", regionIds: [], terminals: [data.terminals[0]] } };
  }
  return { admin: false, limit: { kind: "all" } };
}

/** The header's choice from the cookies (the scope cookie, or the older one-terminal cookie), or null; also false when there is no request to read. */
function choiceFromCookies(): { inRequest: boolean; choice: ScopeChoice | null } {
  try {
    const jar = cookies();
    return { inRequest: true, choice: parseChoice(jar.get(SCOPE_COOKIE)?.value) ?? parseChoice(jar.get(TERMINAL_COOKIE)?.value) };
  } catch {
    return { inRequest: false, choice: null };
  }
}

export type RequestScope = ResolvedScope & { data: ScopeData; allowed: string[] | null };

const EVERYTHING: ResolvedScope = { names: null, kind: "all", regionId: null, label: "All terminals", limited: false, chosen: true };

/** The scope of this request. `choice` and `person` are only for tests and scripts that stand in for a request. */
export async function currentScope(workspaceId = currentWorkspaceId(), stand?: { choice?: ScopeChoice | null; limit?: ScopeLimit; admin?: boolean }): Promise<RequestScope> {
  const data = await scopeData(workspaceId);
  if (stand) {
    const limit = stand.limit ?? { kind: "all" };
    return { ...resolveScope({ choice: stand.choice ?? null, limit, regions: data.regions, terminals: data.terminals, admin: stand.admin }), data, allowed: allowedNames(limit, data.regions, data.terminals) };
  }
  const c = choiceFromCookies();
  if (!c.inRequest) return { ...EVERYTHING, data, allowed: null };
  const who = await requestLimit(data, workspaceId);
  // Not a person on this desk (signed out): a page guard turns them away; nothing is shown from here.
  if (!who) return { ...resolveScope({ choice: null, limit: { kind: "some", regionIds: [], terminals: [] }, regions: data.regions, terminals: data.terminals }), data, allowed: [] };
  return { ...resolveScope({ choice: c.choice, limit: who.limit, regions: data.regions, terminals: data.terminals, admin: who.admin }), data, allowed: allowedNames(who.limit, data.regions, data.terminals) };
}

/** What a scoped list takes: null for everything, a name, or a list of terminals. */
export async function currentTerminals(workspaceId = currentWorkspaceId()): Promise<Terminals> {
  return termsOf(await currentScope(workspaceId));
}

/**
 * What the person may reach whatever they have chosen to look at: null for anyone not limited, else the terminals of their limit. The header's choice only narrows; anything that widens a view
 * (a typed search, an "everyone" link, a driver picked by id) is held to this instead, so no link or form can go past the limit. A unit with no terminal is outside every limit.
 */
export async function currentAllowed(workspaceId = currentWorkspaceId()): Promise<Terminals> {
  const a = (await currentScope(workspaceId)).allowed;
  return a == null ? null : a.length === 1 ? a[0]! : a;
}

/** The header menu for this request: the regions and terminals the person may pick, with what is based at each. */
export async function scopeMenu(scope: RequestScope, workspaceId = currentWorkspaceId()): Promise<ScopeMenu> {
  const [trucks, drivers] = await Promise.all([
    prisma.vehicle.groupBy({ by: ["terminal"], where: { workspaceId, archivedAt: null, terminal: { not: null } }, _count: { _all: true } }),
    prisma.driver.groupBy({ by: ["terminal"], where: { workspaceId, active: true, terminal: { not: null } }, _count: { _all: true } })
  ]);
  const counts = new Map<string, { trucks: number; drivers: number }>();
  for (const r of trucks) {
    const k = (r.terminal ?? "").toLowerCase();
    counts.set(k, { trucks: (counts.get(k)?.trucks ?? 0) + r._count._all, drivers: counts.get(k)?.drivers ?? 0 });
  }
  for (const r of drivers) {
    const k = (r.terminal ?? "").toLowerCase();
    counts.set(k, { trucks: counts.get(k)?.trucks ?? 0, drivers: (counts.get(k)?.drivers ?? 0) + r._count._all });
  }
  return buildMenu({ regions: scope.data.regions, terminals: scope.data.terminals, counts, allowed: scope.allowed });
}
