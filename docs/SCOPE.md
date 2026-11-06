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

## R2: every screen follows the scope (built 2026-11-05)

The terminals in view (the choice, inside the limit) narrow everything below; the limit itself (`currentAllowed()`) is what holds a typed search, a link or an id.

- **KPI, Lanes, Customers:** `getDeskKpi` takes `terminals`; the kept answer is one per slice (the sorted terminals are in its key). Moved loads and offers belong to the terminal of their load. The four filter boxes are type-aheads (`/kpi/choices`, a few at a time) instead of lists of every lane, customer, driver and truck. The driver chart shows the best ten and the worst ten, "All drivers" opens the rest. Lanes and Customers are searched, sorted and paged on the server (`lib/list-page.ts`), fifty to a page. A limited person sees the customers with loads in their terminals plus the ones with no loads anywhere yet (`listCustomerRecordsInScope`).
- **Header and sidebar:** open loads, needs a driver, sent, on the road, ready to invoice, overdue, the finished totals, the alert counts and unread messages are for the terminals in view. Alerts are read inside the scope, so the cap on delivered loads applies per scope.
- **Messages:** conversations, the unread count and "start a conversation" (a name or code search, fifty at a time) are the scope's drivers; opening a driver by id, writing to one, marking one read and opening a message file all hold to the limit.
- **Audit and search:** an event on a load follows the load; an event on a truck, driver or trailer follows that unit's terminal; an event about neither (settings, team, regions, customers, partners) is shown only to someone who can see every terminal. The header search finds only the scope's loads, drivers, customers and cities. The audit CSV, Fuel CSV, Trailers CSV and KPI CSVs follow the scope; the IFTA export is stored per quarter for the whole desk and stays whole-desk.
- **Planner:** the scope is in the query that names the loads (a load is in when nobody holds it or its driver is an active driver of the scope), so other terminals' loads are never read; "N held elsewhere" counts only what the "everyone" link could show the person.
- **Quote page:** saved quotes, open pickups, the customer box and the truck list are the scope's; a quote on a truck outside the limit is "gone" by id (open, pass, quote like it).
- **Fences on actions:** assigning a driver outside the limit is refused ("is based outside the terminals you work"), a load outside the limit is "not found", unassign and pass follow, the typed pickers and the planner's everyone link stay inside the limit, and a limited person is only offered drivers inside their limit when ranking.
- **A unit with no terminal is outside every limit** (a driver with no terminal cannot be assigned or messaged by a limited person until an admin gives them one). A load nobody holds yet is everyone's, so a booking waiting for a truck is seen by everyone who can assign it.

## R3: Quote a load prices the nearest trucks (built 2026-11-05)

A fleet has far more trucks than anyone can read, so the Quote desk prices the nearest first (`lib/quote-nearest.ts`, `server/tl/quote.ts fitQuote`):

- **Which trucks:** the trucks of the terminals in view whose empty miles to the pickup are measured on the road (the map measures the forty nearest bases) or typed, nearest first; the first 25 are priced, and "Show 25 more" asks for the next 25 (up to 100, or as many as are measured). A truck with no base on file fills the page after the measured ones (priced with the typed empty miles, the page says nothing is measured for it). **A truck with a base that was not among the nearest is left out, never priced as if it were as near as the typed figure.** With nothing measured (no pickup yet, no map) the first trucks by name are priced and the line says it is not a distance ranking.
- **Order:** the priced trucks are ranked by what each mile clears over the floor, blocked ones last. (Before, the best fifty by margin were re-sorted by distance, so "closest" meant the closest of the fifty best.)
- **The truck a saved quote is on** is always priced, whatever its distance.
- **Chips** over the table: **Trailer fits** (the trailer hooked to the truck against the kind and length the load needs; a longer trailer takes a shorter load, a 53 ft takes a 48 ft load, and a shorter one does not; with no trailer hooked an own-body truck is judged by its body and a tractor is unknown, never a no), **On shift** (a driver with no schedule is kept), **Available** (no other load at that time, no lapsed card, nothing over the truck's limits), and **Terminal** when the priced trucks span several. They narrow what was priced; nothing in a price reads them.
- **The page ships fifty trucks, not the fleet;** "Nearest to the pickup" under the route is the ten nearest priced. Rows carry their own base and terminal.
- Tests: `tests/quote-nearest.test.ts` (pure, including trailer length), `tests/integration/quote-nearest.integration.test.ts`; scale budget in `tests/perf/scale.perf.test.ts`.

## Not yet

- The IFTA export per scope; no manager or time zone per terminal.

## Tests

`tests/scope.test.ts` (pure), `tests/integration/scope.integration.test.ts` (regions, limits, the limit holding on the board, trucks and the ledger, retire guards, rename, promotion), `tests/loads-roles.test.ts` (the five new admin actions). R2: `tests/integration/scope-fences`, `scope-kpi`, `scope-shell`, `scope-audit` (and `tests/list-page.test.ts`); the scale budgets are in `tests/perf/scale.perf.test.ts`.
