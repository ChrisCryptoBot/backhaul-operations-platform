# Scope: regions, terminals and what a person may see (R1), built 2026-11-05

A big fleet is read one slice at a time. **Region -> terminal -> trucks, drivers, trailers.** A region groups terminals; units stay assigned to a terminal; a terminal belongs to at most one region ("Not in a region" is its own group). A **scope** is the set of terminals in view, or everything.

## Two things that never mix

| | What it is | Where it lives | Who changes it |
|---|---|---|---|
| **Limit** | a permission: the regions and terminals a person may see. None means not limited. An admin is never limited. | `member_scopes` rows (a region, or a terminal by name) | an admin, in Settings, Team ("Can see") |
| **Choice** | a view: what the person picked in the header | the `desk-scope` cookie (`all`, `r:<region id>`, `t:<name>\|<name>`; the older one-terminal `desk-terminal` cookie still works) | the person, in the header menu |

The effective scope is the choice **inside** the limit (`lib/scope.ts` `resolveScope`). A choice outside the limit falls back to the whole limit, never past it; "All" for a limited person is everything they may see. The limit is read from the member table on every request, like the role, so taking someone off a region takes effect on their next click. The server enforces it on every list; nothing the browser sends widens it (checked: a forged cookie for another region still returns the person's own region).

- **Admins** who have chosen nothing are never silently shown everything: they start on the first region (when the fleet has any) and the header says "pick one" until they choose. "All terminals" is one click away.
- **Anyone not limited** starts on all, and can narrow themselves.
- **The demo's** Dispatcher and Driver manager are limited to the first region (or the first terminal when there are no regions) so the limit can be seen working; the other demo roles see everything.
- A load is in a scope when its truck or its driver is in one of the terminals, **or it is not placed anywhere yet** (so a booking waiting for a truck is seen by everyone who can assign it). `terminalSetSql` (SQL) and `inTerminal` (Prisma) are the two forms of that rule.
- **Remembered:** in the browser (the cookie, a year). Not stored on the member.

## What is built

- Schema (`20261202000000_regions_scope`): `regions`, `terminals.region_id`, `member_scopes` (a check that a row names a region or a terminal, never both; one live region per name per desk). Seeds nothing.
- `lib/scope.ts` (pure): the cookie codec, `allowedNames`, `resolveScope`, the menu (`buildMenu`), and the helpers every scoped function uses (`Terminals`, `termList`, `terminalFilter`, `inScope`, `scopeWords`).
- `server/tl/scope.ts`: `currentScope`, `scopeMenu`; `currentTerminal()` (kept under its name, in `server/tl/terminal.ts`) now returns `Terminals`: null for everything, one name, or a list. About forty call sites already pass it through, so every screen that asked for "the terminal" now honours a region, several terminals and the permission.
- `server/tl/regions.ts`: add, rename, retire a region; put a terminal in a region; set what a person may see. All audited (`region_*`, `terminal_region_set`, `member_scope_changed`). A region or a terminal a person is limited to cannot be retired out from under them; renaming a terminal keeps their limit in step; making a person an admin clears their limit.
- Settings: **Regions** tab, a **Region** select on each terminal, and **Can see** on each person in Team.
- Header: the **scope menu** (all, each region with its terminals and counts, any terminals ticked) and a **scope chip** at the head of every page.
- The Leak Ledger already took a list of terminals; it now follows the scope.

## Not yet (R2 and after)

- The header's own counts (open loads, needs a driver, alerts) and the KPI, Lanes, Customers, Messages, Audit, global search and exports are not all scoped yet: some read the scope through `currentTerminal()`, the rest still read the whole fleet (the R2 list in `docs/DESK_AUDIT_2026-11.md`). Until R2 lands, a limited person's header counts and those screens can still show the whole fleet's figures.
- Quote's nearest-25 and the chips (R3).
- The KPI cache key does not carry the scope yet (the dashboard is unscoped).

## Tests

`tests/scope.test.ts` (pure), `tests/integration/scope.integration.test.ts` (regions, limits, the limit holding on the board, trucks and the ledger, retire guards, rename, promotion), `tests/loads-roles.test.ts` (the five new admin actions).
