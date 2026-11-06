/**
 * Scope: what part of a fleet a person is looking at, and what they are allowed to look at. A scope is a set of terminals (a terminal, several, or every terminal of a region), or null for everything.
 * Two things meet here and never mix up: the LIMIT (a permission: the regions and terminals an admin pointed this person at; none means not limited, and an admin is never limited) and the CHOICE
 * (a view: what the person picked in the header). The effective scope is the choice inside the limit; a choice outside it falls back to the whole limit, never past it. Pure, shared by the server and the browser.
 *
 * A load belongs to a scope when it is on a truck or with a driver of one of its terminals, or is not placed anywhere yet (so a booking waiting for a truck is seen by everyone who can assign it);
 * the SQL and Prisma forms of that rule are `terminalSetSql` (server/tl/terminal-sql.ts) and `inTerminal` (server/tl/queries.ts).
 */

/** What a list or a query is scoped to: a terminal name, several, or null for all of them. The one type every scoped function takes. */
export type Terminals = string | readonly string[] | null;

/** The terminals as a list, or null for everything. */
export const termList = (t: Terminals): string[] | null => (t == null ? null : typeof t === "string" ? [t] : [...t]);

export const SCOPE_COOKIE = "desk-scope";
/** The id the "Unassigned" bucket (terminals no region holds) goes by in a choice. */
export const UNASSIGNED = "none";

export type RegionInfo = { id: string; name: string; /** Its active terminals, by name. */ terminals: string[] };

export type ScopeChoice = { kind: "all" } | { kind: "region"; id: string } | { kind: "terminals"; names: string[] };

/** What a person is allowed: everything, or these regions and terminals. */
export type ScopeLimit = { kind: "all" } | { kind: "some"; regionIds: string[]; terminals: string[] };

/** A choice as the cookie keeps it: "all", "r:<region id>", or "t:<name>|<name>". A bare name is an older cookie, from when the scope was one terminal. */
export function parseChoice(raw: string | null | undefined): ScopeChoice | null {
  if (!raw) return null;
  let v = raw;
  try {
    v = decodeURIComponent(raw);
  } catch {
    /* keep the text as it is */
  }
  v = v.trim();
  if (!v) return null;
  if (v === "all") return { kind: "all" };
  if (v.startsWith("r:")) return v.length > 2 ? { kind: "region", id: v.slice(2) } : null;
  const names = (v.startsWith("t:") ? v.slice(2) : v).split("|").map((n) => n.replace(/\s+/g, " ").trim()).filter(Boolean);
  return names.length > 0 ? { kind: "terminals", names } : null;
}

export function choiceText(c: ScopeChoice): string {
  return c.kind === "all" ? "all" : c.kind === "region" ? `r:${c.id}` : `t:${c.names.join("|")}`;
}

const lower = (s: string) => s.toLowerCase();
const uniq = (xs: string[]) => [...new Set(xs)];

/** The terminals a person may see, or null for everything. Terminals that no longer exist are dropped; a region that is gone grants nothing. */
export function allowedNames(limit: ScopeLimit, regions: readonly RegionInfo[], terminals: readonly string[]): string[] | null {
  if (limit.kind === "all") return null;
  const byRegion = limit.regionIds.flatMap((id) => regions.find((r) => r.id === id)?.terminals ?? []);
  const named = limit.terminals.map((n) => terminals.find((t) => lower(t) === lower(n))).filter((n): n is string => n != null);
  return uniq([...byRegion, ...named]);
}

/** The terminals a choice names: a region's, the unassigned ones, or the names picked that still exist. `undefined` means everything (or a choice that names nothing real). */
export function chosenNames(c: ScopeChoice | null, regions: readonly RegionInfo[], terminals: readonly string[]): string[] | null | undefined {
  if (!c) return undefined;
  if (c.kind === "all") return null;
  if (c.kind === "region") {
    if (c.id === UNASSIGNED) {
      const held = new Set(regions.flatMap((r) => r.terminals.map(lower)));
      const rest = terminals.filter((t) => !held.has(lower(t)));
      return rest.length > 0 ? rest : undefined;
    }
    const r = regions.find((x) => x.id === c.id);
    return r && r.terminals.length > 0 ? [...r.terminals] : undefined;
  }
  const real = c.names.map((n) => terminals.find((t) => lower(t) === lower(n))).filter((n): n is string => n != null);
  return real.length > 0 ? uniq(real) : undefined;
}

export type ResolvedScope = {
  /** The terminals in view, or null for everything. An empty list is a person limited to nothing that exists: only unplaced loads show. */
  names: string[] | null;
  kind: "all" | "region" | "terminals";
  /** The region, when the terminals in view are exactly one region's. */
  regionId: string | null;
  /** Said in the header and at the head of every page: "All terminals", "Texas region", "Dallas terminal", "3 terminals". */
  label: string;
  /** The person is limited (a permission), so "All" is not on offer. */
  limited: boolean;
  /** The person has picked this view; false when it is only the default (an admin who has not chosen yet). */
  chosen: boolean;
};

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.some((y) => lower(y) === lower(x)));

/**
 * The effective scope. `admin`: an admin who has chosen nothing is never shown everything by default; they start on the first region (when the fleet has any), and the page says so until they pick.
 * Everyone else with no choice starts on all they may see.
 */
export function resolveScope(i: { choice: ScopeChoice | null; limit: ScopeLimit; regions: readonly RegionInfo[]; terminals: readonly string[]; admin?: boolean }): ResolvedScope {
  const allowed = allowedNames(i.limit, i.regions, i.terminals);
  const limited = allowed != null;
  let want = chosenNames(i.choice, i.regions, i.terminals);
  // Only an admin defaulted to a region has not "picked": everyone else's default (all they may see) is simply what there is.
  let chosen = true;
  if (want === undefined && i.admin && !limited && i.regions.some((r) => r.terminals.length > 0)) {
    const first = [...i.regions].filter((r) => r.terminals.length > 0).sort((a, b) => a.name.localeCompare(b.name))[0]!;
    want = [...first.terminals];
    chosen = false;
  }
  let names: string[] | null;
  if (allowed == null) names = want === undefined ? null : want;
  else if (want == null) names = allowed;
  else {
    const inside = want.filter((n) => allowed.some((a) => lower(a) === lower(n)));
    names = inside.length > 0 ? inside : allowed;
  }
  if (names == null) return { names: null, kind: "all", regionId: null, label: "All terminals", limited: false, chosen };
  const region = i.regions.find((r) => r.terminals.length > 0 && sameSet(r.terminals, names!)) ?? null;
  if (region) return { names, kind: "region", regionId: region.id, label: `${region.name} region`, limited, chosen };
  const label = names.length === 1 ? `${names[0]} terminal` : names.length === 0 ? "No terminals" : `${names.length} terminals`;
  return { names, kind: "terminals", regionId: null, label, limited, chosen };
}

/** The value a scoped function takes for a resolved scope: null for everything, the name for one terminal, a list for several. */
export const termsOf = (s: Pick<ResolvedScope, "names">): Terminals => (s.names == null ? null : s.names.length === 1 ? s.names[0]! : s.names);

/** What the header menu offers: everything, each region with its terminals (and the unassigned ones), each with what is based there. */
export type MenuTerminal = { name: string; trucks: number; drivers: number };
export type MenuRegion = { id: string; name: string; terminals: MenuTerminal[]; trucks: number; drivers: number };
export type ScopeMenu = { regions: MenuRegion[]; unassigned: MenuTerminal[]; total: { trucks: number; drivers: number }; canAll: boolean };

/** The menu for a person: limited people see only what they are allowed (no "All"). */
export function buildMenu(i: { regions: readonly RegionInfo[]; terminals: readonly string[]; counts: ReadonlyMap<string, { trucks: number; drivers: number }>; allowed: string[] | null }): ScopeMenu {
  const ok = (n: string) => i.allowed == null || i.allowed.some((a) => lower(a) === lower(n));
  const mt = (name: string): MenuTerminal => ({ name, trucks: i.counts.get(lower(name))?.trucks ?? 0, drivers: i.counts.get(lower(name))?.drivers ?? 0 });
  const held = new Set(i.regions.flatMap((r) => r.terminals.map(lower)));
  const regions = [...i.regions]
    .map((r) => {
      const terminals = r.terminals.filter(ok).map(mt);
      return { id: r.id, name: r.name, terminals, trucks: terminals.reduce((s, t) => s + t.trucks, 0), drivers: terminals.reduce((s, t) => s + t.drivers, 0) };
    })
    .filter((r) => r.terminals.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name));
  const unassigned = i.terminals.filter((t) => !held.has(lower(t)) && ok(t)).map(mt);
  const all = [...regions.flatMap((r) => r.terminals), ...unassigned];
  return { regions, unassigned, total: { trucks: all.reduce((s, t) => s + t.trucks, 0), drivers: all.reduce((s, t) => s + t.drivers, 0) }, canAll: i.allowed == null };
}

/** The choice that a set of ticked terminals stands for: all of them is "all", exactly one region's is that region, anything else is the names. */
export function choiceFor(ticked: readonly string[], regions: readonly RegionInfo[], terminals: readonly string[]): ScopeChoice {
  if (ticked.length === 0 || sameSet(ticked, terminals)) return { kind: "all" };
  const region = regions.find((r) => r.terminals.length > 0 && sameSet(r.terminals, ticked));
  return region ? { kind: "region", id: region.id } : { kind: "terminals", names: [...ticked] };
}

/** A Prisma filter on a terminal column for a scope: nothing for everything (undefined is no filter), the name for one terminal, `in` for several. */
export const terminalFilter = (t: Terminals): string | { in: string[] } | undefined => (t == null ? undefined : typeof t === "string" ? t : { in: [...t] });

/** A scope in words for a sentence: "Dallas terminal", "3 terminals"; null for everything. */
export const scopeWords = (t: Terminals): string | null => {
  const l = termList(t);
  return l == null ? null : l.length === 1 ? `${l[0]} terminal` : l.length === 0 ? "no terminals" : `${l.length} terminals`;
};

/** Whether a unit based at `name` is inside the scope: everything is, a list is when it holds the name (ignoring case). A unit with no terminal is in no listed terminal. */
export const inScope = (t: Terminals, name: string | null | undefined): boolean => {
  const l = termList(t);
  return l == null ? true : name != null && l.some((x) => x.toLowerCase() === name.toLowerCase());
};
