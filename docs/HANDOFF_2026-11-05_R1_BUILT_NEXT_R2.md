# Handoff, 2026-11-05 (evening): R1 built and uncommitted, R2 next

Written for a fresh Claude session. It supersedes `docs/HANDOFF_2026-11-05_RECONCILIATION_AND_PHASE_B.md` (still useful for the audit detail and the gotchas, and still untracked: leave it). Read this whole file first, then `docs/SCOPE.md`, `docs/LEAK_LEDGER.md`, `docs/ASSET_HISTORY.md`. The full approved plan is reproduced at the bottom, unedited, so nothing has to be guessed; the status table directly below says where each step stands.

Repo: `C:\Users\14698\OneDrive\Desktop\TRUELANE\dispatch-desk`, app in `apps/web`, branch `demo/truelane-dispatch`. The outer `TRUELANE` repo is the phone app (separate git); the desk is its own repo.

## 1. Where it stands (exact)

| Step | State | Commit |
|---|---|---|
| E whereabouts: hover on Trucks/Trailers lists and map pins, tabbed `/fleet/[id]` and `/trailers/[id]` (Where it is, History, Cost/Status, Loads, Details), "At" a facility only within 300 m AND standing | **done, committed** | `9d325bd` |
| E5 asset history: History tab (check calls, tractor stays kept 13 months, trailer hooks and drops, arrivals with driver), migration `20261201000000_asset_history` | **done, committed** | `e22a78f` |
| C KPI weekly charts as smooth monotone curves with a flat wash | **done, committed** | `4b955f7` |
| B1 Leak ledger `/leaks` (+ CSVs, KPI headline, gate = `bill` capability) | **done, committed** | `87b2b40` |
| Pinned module head + tab bar (`--ph-h`), description line scrolls away | **done, committed** | `75c72cb` |
| **R1 regions + scope core + member permission + header scope menu** | **BUILT, VERIFIED IN THE BROWSER, NOT COMMITTED** | none yet |
| R2 every screen into scope | not started | |
| R3 Quote nearest-25 + chips | not started | |
| B4 Data Health, B6 importer | not started | |
| B2/B3 (signals, channels, cron) | parked: needs Chris's email provider, Slack webhook, Vercel cron go | |

Nothing is pushed. Unpushed local commits since origin: `0693235`, `54f95c8` (older), then `9d325bd`, `e22a78f`, `4b955f7`, `87b2b40`, `75c72cb`. Push only when Chris says.

## 2. Exactly where I stopped

R1 is in the working tree. **Immediately before stopping I had just repaired `tests/pinned-header.test.ts`** (a bad edit had put literal line breaks in a regex; it is rewritten and passes). At that moment: `npx tsc --noEmit` clean; `tests/pinned-header.test.ts` + `tests/forms-keep-fields.test.ts` 15/15; ESLint was clean on the previous check. The last **full** run (before the repair) was 1,980 passed, 2 failed, and both failures are now fixed (a stale `forms-keep-fields` exemption for the deleted `terminal-scope.tsx`, and the broken pinned-header test). **The full suite has not been re-run since.** I stopped a background full run (`b2puxry8b`) when asked to hand off.

### Do this first, in order
1. `cd apps/web`, then `npx tsc --noEmit`, `npx eslint src tests scripts --max-warnings=0`, and the full suite: `DATABASE_URL=postgresql://demo:demo@localhost:54330/demo RUN_DB_INTEGRATION=true npx vitest run` (expect about 1,982 passing, 0 failing, 3 skipped files).
2. Scale perf: `DATABASE_URL=postgresql://demo:demo@localhost:54330/demo_scale RUN_SCALE=true npx vitest run tests/perf` (the ledger, whereabouts and scale tests passed before R1; R1 widened the terminal filters, so re-check).
3. Production build: `NEXT_DIST_DIR=.next-prod npx next build`, then from the repo root `git checkout -- apps/web/tsconfig.json`.
4. **Commit R1** locally in one or two pieces, trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Suggested message: "Desk: regions and scope (a region groups terminals; a person can be limited to a region or terminals, enforced on the server; header scope menu and a scope chip on every page)". Stage explicitly (do not `git add -A`: leave `apps/scratch/`, `scratch/`, the redesign `.zip` and the old handoff untracked).
5. Then start R2 (section 4), asking Chris for the go only if he has changed direction.

## 3. What R1 is (all in the working tree)

Full description in `docs/SCOPE.md`. Summary:

- **Schema** `prisma/migrations/20261202000000_regions_scope` (applied to the local `demo` and `demo_scale` databases): `regions`, `terminals.region_id`, `member_scopes` (a row names a region or a terminal, never both). Seeds nothing. `supabase/` regenerated with `npm run db:export-supabase` (the RLS lockdown file was renamed again to `20261202000001_enable_rls.sql`).
- **`src/lib/scope.ts` (pure)**: `Terminals` type (a name, a list, or null for everything), `termList`, `terminalFilter` (Prisma), `inScope`, `scopeWords`, the cookie codec (`desk-scope`: `all`, `r:<id>`, `t:<a>|<b>`; the older `desk-terminal` cookie still reads), `allowedNames`, `resolveScope`, `buildMenu`, `choiceFor`. Rules: effective scope = the **choice inside the limit**; a choice outside the limit falls back to the whole limit, never past it; an admin who has chosen nothing is defaulted to the first region (header says "pick one") and is never silently shown everything; anyone not limited starts on all.
- **`src/server/tl/scope.ts`**: `currentScope`, `currentTerminals`, `scopeMenu`, `requestLimit`, `limitOf`. Outside a request (scripts, tests) the scope is everything. The demo Dispatcher and Driver manager are limited to the first region (or first terminal when there are no regions); the other demo roles see everything. **`currentTerminal()` (in `server/tl/terminal.ts`) is kept under its name and now returns `Terminals`**, so every one of the ~40 call sites already honours a region, several terminals and the permission. `listTerminals` moved to `server/tl/terminals-in-use.ts` (re-exported) to avoid an import cycle.
- Every scoped function's parameter widened to `Terminals`; filters use `terminalFilter`; SQL uses `terminalSetSql` / `terminalSql` (`server/tl/terminal-sql.ts`, also holds the Prisma `inTerminal`, re-exported from `queries.ts`). Booking guard in `quote.ts` uses `inScope`/`scopeWords`.
- **`src/server/tl/regions.ts`**: add, rename, retire a region; `setTerminalRegion`; `setMemberScope` (an admin cannot be limited; before/after audited). A region or terminal a person is limited to cannot be retired; renaming a terminal updates `member_scopes`; making someone admin clears their limit. New audit actions `region_added`, `region_renamed`, `region_archived`, `terminal_region_set`, `member_scope_changed` (registered in `lib/audit-diff.ts`). Five admin actions in `actions.ts` and in `tests/loads-roles.test.ts`.
- **UI**: Settings gets a **Regions** tab (`regions-card.tsx`), a **Region** select per terminal (`terminals-card.tsx`), and a **Can see** editor per person (`team-card.tsx`). Header: `scope-menu.tsx` (a portal pop-over drawn on `document.body` because the header's backdrop filter traps fixed children), and a `ScopeChip` in every `PageHead`. `shell.ts` now carries `scope` instead of `terminal`. Old `terminal-scope.tsx` deleted.
- **Tests**: `tests/scope.test.ts` (15, pure), `tests/integration/scope.integration.test.ts` (6, real lists: a dispatcher limited to Texas never sees Memphis however they choose; retire guards; rename; promotion; ledger scope), updated `no-legacy` model list, `forms-keep-fields`, `tl-waveE1` shell assertion.
- **Verified in the browser** (dev server on 3102): created region "Texas", put Dallas and Houston in it, the admin defaulted to Texas with "pick one", choosing All worked, the demo Dispatcher is limited to Texas (two trucks, no "All"), and a forged `desk-scope` cookie asking for Oklahoma City still returned Texas on Trucks, Loads, Drivers and Planner.
- **Local demo data changed**: the `demo` database now has a region "Texas" with Dallas and Houston (made through the UI). Harmless; Chris can retire it.

### Known limits of R1 (these are R2's job)
The header's own counts (open loads, needs a driver, alerts), KPI, Lanes, Customers, lane detail, Messages, Audit, global search, most exports, Quote's open pickups, Planner (still builds every row first) and Radar loads are **not all scoped yet**: those that already receive `currentTerminal()` now honour it; the rest still read the whole fleet. Until R2 a limited person's header counts and those screens can show whole-fleet figures. The KPI cache key does not carry the scope yet.

## 4. R2 and after (the plan below has the full text; this is the order and the gotchas)

**R2: bring every screen into scope**, each with a test that a scoped request never returns another terminal's rows:
- `getDeskKpi` takes the scope and puts it in its cache key (`server/tl/kpi.ts` ~L742; **update the pin in `tests/money-follows-workspace-zone.test.ts` deliberately**), filter dropdowns become type-ahead (top 50 + search), driver leaderboard shows top and bottom ten with "All drivers" expanding, Lanes and Customers get server paging and search with the scope applied, lane detail (`lanes/detail/page.tsx` `listBoardRows()`), header and sidebar counts (`server/tl/shell.ts` ~L70-95: counts must follow the scope for a limited person), Messages (threads, startable drivers), exports (`server/tl/exports.ts`), Quote open pickups (`listOpenPickups`), Planner (filter before building rows), Radar loads query, Audit and global search. `getKpiRows` already takes `terminals` and `finishedOnly`.
- Per the plan, the Leak Ledger already takes a scope; the KPI headline passes `termList(terminal)`.

**R3 Quote nearest-25 + chips**, then **B4 Data Health** (printable "Data Readiness" report with a clean executive layout following the existing `.rp` sheet rules, same as `/kpi/report`), then **B6 load-history importer**. **B2/B3 are parked** until Chris supplies his email provider, a Slack webhook to test with, and his go for a Vercel cron.

## 5. Rules (do not break)

- **Never name the previous employer** anywhere (`tests/no-legacy.test.ts` scans code and docs; it also trips on a short letter run that sits inside some ordinary English words, so avoid any word that contains it, such as a word meaning "without a single defect").
- **Never push.** Commit locally in logical pieces only. The desk has its **own** Supabase project, never `truelane-prod`. **Chris applies production migrations by hand**; never print keys or connection strings. Any migration then `npm run db:export-supabase`.
- Design: radius 0, 1px rules, tokens only, **no coloured edge strips**, no gradients/shadows, desktop only (check 1440 and 1024), typed fields use `useDraft` and are covered by `tests/forms-keep-fields.test.ts` (it auto-scans), ESLint bans `Number()`/`Math.*` in `src/server/**` (put math in `src/lib/**`).
- Tone: crisp, peer-like, lead with what changed, mark what is verified versus likely, never claim perfection.
- Gates before any commit: tsc, eslint `--max-warnings=0`, full vitest with `RUN_DB_INTEGRATION=true`, scale perf, production build (then `git checkout -- apps/web/tsconfig.json`).

## 6. Things Chris must still do himself

1. Apply on the desk's own Supabase, in order: `20261201000000_asset_history` and `20261202000000_regions_scope` (both in `prisma/migrations/` and `supabase/migrations/`), then re-run `supabase/lockdown_rls.sql` (the lockdown file is always last and has been renamed twice; tell him if he applied an older one: `20261130000001`, then `20261201000001`, now `20261202000001`).
2. Decide whether to push the seven local commits.
3. For B3 later: email provider, Slack webhook, Vercel cron go.

## 7. Environment and gotchas (carry-over)

- **Windows shell**: the Bash tool breaks on heredocs that contain python with backslashes, triple quotes or odd apostrophes. Use the Write tool for files, and Edit for edits. `use `python - <<'PYEOF'` edits only for plain text; never write regex escapes inside a Python-written JS file (that is how a literal line break got into a regex).
- `prisma generate` fails with EPERM while a dev server holds the engine file; the types still update. Restart the dev server by touching `apps/web/next.config.mjs` (do not kill processes; the classifier blocks it).
- Dev preview for Chris: `http://localhost:3102` (database `demo`, BYPASS_AUTH; sign in with "Demo as Admin"; sign-in page buttons "Demo as Dispatcher" etc.). It was running and signed in as the demo Admin when I stopped. The browser pane's `javascript_tool` times out on long fetch loops; keep scripts short. The pane may show a stale console buffer; trust `tsc`.
- Windows line endings: files read as CRLF; tests that slice source should strip `\r` (`String.fromCharCode(13)`), as `tests/pinned-header.test.ts` now does.
- Scale database `demo_scale`: 1,500 trucks, 5,000 trailers, about 4,000 loads, seeded positions. Local Postgres on port 54330.
- Memory notes for the user's auto-memory live in `C:\Users\14698\.claude\projects\C--Users-14698-OneDrive-Desktop-TRUELANE\memory\` (see `desk-whereabouts-history-status.md`).

---

# THE FULL APPROVED PLAN (verbatim, unedited)

(The status of each step is in the table at the top of this file. The plan was approved by Chris on 2026-11-05 and amended mid-build by the four additions listed under "Chris's additions".)

# Full plan: whereabouts → Leak Ledger → chart restyle → reconciliation → data health → importer

## Build order at a glance

| # | Step | What it delivers | Needs from Chris |
|---|---|---|---|
| E | **Equipment whereabouts** (new ask) | Hover on trucks and trailers; tabbed detail pages with a "Where it is" tab | nothing |
| B1 | **Leak Ledger** | One weekly dollar figure per leak, trend, drill to loads, `/leaks` + KPI headline | nothing |
| C | **KPI line-chart restyle** | Sexier trend charts inside the design rules | nothing |
| R1 | **Region + scope core** | Region above terminals, scope as a permission, Scope menu | apply 1 migration |
| R2 | **Every screen into scope** | KPI, Lanes, Customers, counts, Messages, exports, Planner, Radar, Audit, search | nothing |
| R3 | **Quote desk nearest-25 + chips** | Verdict card usable again at fleet size | nothing |
| B4 | **Data Health engine** | Completeness + cross-source checks, "Data Readiness" report | nothing |
| B6 | **Load-history importer** | CSV/TMS/tracker import with mapping, preview, dedupe | nothing |
| B2/B3 | Signals store, channels, cron (parked) | Alerts by Slack/email, self-sending weekly report | email provider, Slack webhook, Vercel cron go |
| B5/B7 | "Why it moved", detention evidence pack (after B3) | | |

## Context

Dispatch desk (`dispatch-desk/apps/web`, branch `demo/truelane-dispatch`; 2 local commits unpushed: `0693235`, `54f95c8`). The desk is sold as a package (dispatch desk + driver app + eventual TMS) whose point is one environment, one data model, accurate data, so freight leaks can be seen and patched. The consulting page sells "signals"; the product must back every claim on it.

**Handoff verified this session** — every file it names exists and the line refs hold: `server/tl/{kpi,detention,dwell,terminal,access,quote,radar}.ts`, `components/desk/{quote-desk,kpi/trend-grid}.tsx`, `currentTerminal()` still cookie-only (`terminal.ts:29`), `MAX_FIT_ROWS = 50` (`quote.ts:102`), `inTerminal` (`queries.ts:195`), `checkAccess` (`access.ts:20`), Quote page ships all trucks (`quote/page.tsx:22-30`). No Phase B or reconciliation code exists. Working tree: only untracked `scratch/`, `apps/scratch/`, the redesign zip (not mine) and the handoff file.

### Decisions (final — not re-opened)
From the handoff:
1. **Region sits above terminals** (Region → Terminal → trucks/drivers/trailers). Units stay assigned to a terminal; nothing existing moves.
2. **Scope is a permission** for non-admins (assigned per member in Team settings, enforced server-side). Admins and members with no assignment can still see everything and can narrow themselves.
3. **Admins open on their last scope, never silently "All"**; first time they are asked to pick; "All" is one click away; the page head always says what is in view.
4. **Quote a load narrows to the nearest 25 trucks to the pickup inside the scope**, "Show more" for the next 25, chips for trailer fit, on shift, available.

From this session:
5. **Whereabouts goes first**, before B1.
6. **"At a company" comes from load stops** (facility name + coordinates), else the nearest town from the offline gazetteer. No new table.
7. **Leak Ledger empty-mile cost = the load's frozen floor** (`snapshotBaseFloorRpm`); loads without a floor: miles counted, dollars left unpriced and labelled.
8. **Ledger dollar lines visible to** admin + billing + whoever passes the KPI gate.

Defaults I'm assuming unless you say otherwise: regions start empty (migration seeds nothing; terminals show in an "Unassigned" bucket); demo role buttons get sensible scopes (Admin: asked to pick; Dispatcher **and Driver Manager**: first terminal/region; Viewer: All).

Chris's additions (2026-11-05, mid-build): (1) Driver Manager gets the same default scope as Dispatcher in R1; (2) the B4 Data Readiness report must have a clean printable executive layout following the existing `.rp` sheet rules; (3) the 300 m stationary check for "At" stays — large DCs falling back to "Near" is the intended behaviour until named spot pins exist; (4) the dev server on localhost:3102 is live, so in R1 bounce it briefly around `prisma generate` to avoid the Windows engine DLL lock.

### Standing rules
Never name the previous employer anywhere (`tests/no-legacy.test.ts` scans code and docs). Never push; commit locally in logical pieces with trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. The desk has its **own** Supabase project, never `truelane-prod`; Chris applies production migrations by hand; I never touch or print connection strings/keys (reuse the phone `.env` keys by name). Any migration → `npm run db:export-supabase` (RLS lockdown re-run is Chris's; add new models to the list in `tests/no-legacy.test.ts`). Design: radius 0, 1px rules, tokens only (no hex in components), **no coloured edge strips**, no gradients/shadows/blur, gold = label colour, pos/neg/warn only for verdicts and deltas, typed figures use `rd-typed`, every typed field uses `useDraft` and is listed in `tests/forms-keep-fields.test.ts`, desktop only (check 1440 and 1024). ESLint bans `Number()`/`Math.*`/unary coercion in `src/server/**`: math lives in `src/lib/**`. Every dollar on screen is computed from stored loads; none invented. Tone: crisp, lead with the change, mark verified vs likely.

---

## Step E — Truck and trailer whereabouts (hover + tabbed detail pages)

### What the phone's Places logic gives the desk (reviewed)
Read `lib/community/placeTag.ts`, `docs/tabs/community/design/slices/PLACES_SLICE.md`, `lib/community/dock.ts` in the outer repo. Borrowed:
1. **Label tiers**: exact name → "near City, ST" (≤5 mi) → "within 25 miles of City, ST" → regional pot. Desk: *At [facility]* → *Near City, ST* (≤5 mi) → *Within 25 mi of City, ST* → nearest town ≤60 mi (`nearestPlace`, `lib/gazetteer/place-index.ts:70`, already built).
2. **Strict dock match: 300 m + normalised name; "a wrong dock is worse than none."** I tighten my earlier "half a mile" to **300 m**, and say "At" only when the unit is not moving (parked / idling / dropped trailer). A truck passing a dock at 60 mph gets "Near".
3. **Display-only firewall**: a place never feeds a figure, ranking or verdict. A test pins that `lib/leaks.ts`, the KPI and the verdict don't import the whereabouts module.
4. **Mapbox terms** (Search Box data is temporary-use only): hover and the tab make **no provider calls** — stored coordinates + the offline gazetteer only. Free and inside the spend guardrails.
Not built now, offered later: a "Name this spot" action (a dispatcher's own named pin, like the phone's custom place) — small table + migration.

### E1 — pure `src/lib/whereabouts.ts` (+ `tests/whereabouts.test.ts`)
`whereIs({lat,lng,speedMph,engine,headingDeg,locatedAt}, stops[], now)` → `{ tier: "at"|"near"|"around"|"town"|"none", label, facility?, town?, road?, coords, ageMinutes, stale }`. Reuses `nearestPlace`, `nearestCorridor`/`speedLine` (`lib/telematics.ts:153,169`), `haversineMiles` (`lib/geo.ts:114`), `boundsAround`/`within` (`lib/radius.ts`). Tests: tier boundaries at 300 m / 5 mi / 25 mi, moving-past-a-dock = near, no stops, no fix, name normalisation, stale fix.

### E2 — server `src/server/tl/whereabouts.ts`
`getWhereabouts(unitIds, kind)` for just the rows on screen: one query for the units, one for candidate stops (workspace stops with lat/lng + facility name on loads from the last 90 days, bounding-boxed around the page's units — no full-fleet scan; index checked at `demo_scale`). A hooked trailer inherits its tractor's position (same rule as `getRadarData`, `radar.ts:143`). Returns hover `TipData` (`kit/tooltip.tsx`) built server-side: place line, lat/lng, road + speed + heading, engine/idle sentence (`idleSentence`), driver, current load #, hooked-to, dwell sentence (`dwellSentence`), last-fix age. Uses `currentTerminal()` now; R2 swaps it for scope.

### E3 — hover
- Trucks (`fleet/page.tsx`) and Trailers (`trailers/page.tsx`) tables: hover/focus on the unit cell shows the tooltip (reuse `TipPopup`; keyboard-focus parity). Payload gains only the page's rows' tips.
- Radar map pins (`radar-map.tsx` — today only click + pointer cursor, ~L316): hover shows name + state immediately from the lean `RadarPoint`, then details after ~150 ms from a small `/fleet/map/unit?id=` GET (cached, same builder). Pins stay lean.

### E4 — tabbed detail pages (full pages, not drawers)
`/fleet/[id]?tab=` and `/trailers/[id]?tab=`, server-rendered, tab strip in the load drawer's `cp-nav` style, keys 1–4 like the cockpit.
- **Truck tabs:** Where it is (default) · Cost & floor (break-even hero, cost profile, fuel card) · Loads · Details & changes.
- **Trailer tabs:** Where it is (default) · Status & papers (can-go-out hero, hook, dwell + adjust) · Loads · Details & changes.
- **Where it is tab:** place line + tier, coordinates, road/speed/heading, engine + idle leak, fix age, hooked-to / driver, current load with route and ETA (reuse `load-tracker.tsx` / `load-tracking.ts`), trailer dwell, compact map (`radar-map` compact mode) centred on the unit. No history shown unless stored — no invented breadcrumbs.
- Existing content moves into tabs unchanged (no logic change); forms stay on `useDraft`.

Side note, not touched unless asked: `components/desk/load-view.tsx:375` has a `borderLeft: 3px` strip, against the no-edge-strip rule.

Commit: "Desk: whereabouts on trucks and trailers (hover, Where it is tab)".

---

## Step B1 — Leak Ledger (scope-aware from day one)

**Goal:** one weekly **dollar** figure per leak, with trend and a drill to the loads behind each line; page `/leaks` and a headline on the KPI.

Takes `scope: string[] | null` from day one (`null` = everything; reuse `terminalSql`/`inTerminal`). Pure math in `src/lib/leaks.ts`, server read in `src/server/tl/leaks.ts`, screen under `app/(desk)/leaks/`, nav entry, same gate as the KPI page (admin + billing + KPI gate), CSV export, tests.

**Leak lines and where each input already exists:**
- **Empty-mile cost** = empty miles × the load's frozen `snapshotBaseFloorRpm` (break-even $/driven mile before fuel). Empty miles from `Fact.emptyMiles`/`pickupEmpty`/`returnEmpty` (`server/tl/kpi.ts`: `deadheadMilesOf`, `effectiveMiles`). No floor → miles counted, dollars unpriced, said so.
- **Unbilled detention** (+ **waived** dollars): `detentionOfLoad` (`detention.ts:36`) + `waivedDetentionLoads` (`:49`), `summarizeDetention` in `lib/detention.ts`. `getDetentionRecovery` reads 90 days and already filters waived rows; write a sibling that also returns waived dollars (audit `detention_waived` with reason; waived rows currently get `unbilled: 0`), bucketed by `completedAt` week.
- **Trailer dwell owed / waived**: `dwell()` in `lib/telematics.ts` with company terms (`dwellFreeHours`/`dwellPerDayRate`) and per-trailer overrides; audit actions `dwell_adjusted`/`dwell_waived`/`dwell_reset`. Dwell is current-stay only: show currently-owed on dropped trailers + waived/adjusted from the audit trail, and say history builds from now.
- **Below-floor shortfall**: `(gross − expenses) / drivenMiles >= snapshotBaseFloorRpm` is "cleared"; shortfall = `floor × drivenMiles − (gross − expenses)` when positive; TONU excluded.
- **TONU not invoiced**: `status = 'tonu'`, `tonuRevenue`, `paymentStatus` null (alert `READY_TO_INVOICE`, `lib/alerts.ts:272`); sum not-invoiced `tonuRevenue`, plus TONU trend.
- *Optional later:* net lane profit from frozen floor, fuel and detention, marked an estimate.

**Output shape:** `LeakLedger = { weeks: [{ weekStart, lines: {key,label,dollars,loads,unpriced}[], total }], current, prior, byLane/byCustomer/byTruck drill, loads: { key, loadId, loadNumber, dollars }[] }`, ratio of sums over `Fact`s like the KPI, cached with `answerCache` (key includes scope and the extras stamp).

**Wording discipline:** every figure labelled with its basis ("at the truck's own floor"), unpriced loads counted separately, no invented numbers.

**Tests/perf:** `tests/leaks.test.ts` (each line, week bucketing, unpriced handling, scope), integration test for the server read, add the actions to `tests/loads-roles.test.ts`, a scale perf test at `demo_scale` (stay near today's ~1 s KPI at 1,500 trucks / ~50,000 loads).

Commit: "Desk: Leak Ledger".

---

## Step C — KPI line-chart restyle
Files: `components/desk/kpi/trend-grid.tsx`, `trends.tsx` (SmallMultiples), `lib/kpi-view.ts:80,100` (`sparkPath/sparkPoints`), CSS `.sm-*`/`.kc` in `app/(desk)/desk.css` (~:351, :418-428, :1022-1027). Today: raw SVG 220×56, gold 2px straight path, round end dot, hover guide + tooltip.
Planned (within the rules): flat single-token area fill (fill-opacity, no gradient), **square** markers instead of round, dashed ghost line for the prior period on the same scale (`growthOf`), min/max markers with values, 1px gridlines at min/mid/max, end value tagged at the line end with its change (existing `DeltaChip`), faint fleet-average rule; straight segments (honest for weekly data). Tokens only. Check 1440 and 1024.
Commit: "Desk: KPI trend charts restyled".

---

## Step R — Reconciliation (the "too much data at once" fix)

### The problem (audit findings; paths under `apps/web/src`)
Admins see every driver and truck in Quote, KPI and elsewhere; the verdict card is unusable at fleet size. `Terminal` is a flat per-workspace list with no region; scope is a cookie (`desk-terminal`) that is a view filter, not a permission; `Member` has no terminal/region. The only server enforcement of the cookie is `bookQuote` refusing a truck outside the terminal (`quote.ts:899-900`).

**Screens that ignore scope:** Quote (ships ALL trucks, drivers, cost profiles), KPI (`getDeskKpi` has no scope; filter dropdowns list every lane/customer/driver/truck; leaderboard draws every driver), Lanes and Customers (unscoped, unpaged), lane detail (`listBoardRows()`), header/sidebar counts (`shell.ts:70-75`), Messages, Audit, global search, exports (fuel, ifta, trailers, audit, `kpi-*`, quote-decisions), radar loads query, Quote's brokers and open pickups, `rankDrivers` (a base, never a fence), typed pickers. **Already scoped:** Dispatch, Loads board/History, Planner (but builds all rows first), Schedules, Drivers/Trucks/Trailers lists, Settlements, Payroll, Fuel, Invoices, Alerts, Radar tractors/trailers.

**Quote specifics:** `fitQuote` (`quote.ts:256`) prices every truck × driver, sorts blocked last then margin-per-mile, slices to `MAX_FIT_ROWS = 50`; the client re-sorts those 50 by deadhead, so "closest" is the closest of the 50 *best-margin* (bug). A real per-truck deadhead exists only for the 40 nearest bases; everyone else is priced with the single typed `emptyToPickup`, so far trucks can outrank near ones (bug). Trailer type only yields a note. "Fleet deadhead to pickup" renders one chip per truck; the unpriced table renders every truck; fit re-prices every truck per keystroke.

### R1 — Region layer + scope core
1. **Region layer:** new `Region` (workspace, name, note, archived) and `Terminal.regionId`. Settings gets a Regions tab beside Terminals (admin); Terminals get a Region select. Migration seeds nothing.
2. **A scope, not a terminal:** `Scope = { regions, terminals }` resolved to a set of terminal names, or `null` for everything. `currentScope()` replaces `currentTerminal()` as the one thing every list asks; `currentTerminal()` stays as a thin wrapper so ~30 call sites move one screen at a time. Helpers `terminalWhere(field, scope)` (Prisma) and `terminalSqlIn(scope)` (raw SQL); `inTerminal`/`terminalSql` keep the "truck or driver in it, or unplaced" rule, extended to a set.
3. **Permission as well as view:** `MemberScope` (member → region or terminal), enforced on the server. `checkAccess` already re-reads the Member each call; `Identity` gains `scope`; `currentScope()` returns the cookie choice **intersected** with what the person may see. A dispatcher assigned Dallas+Houston cannot see or book Memphis. Team card in Settings gets the assignment; demo role buttons get sensible scopes.
4. **Picker:** header's one-terminal select becomes a Scope menu: All, a region (with its terminals), or several terminals, with driver/truck counts, remembered per person (last scope; never silent All for admins); page head states the scope ("Texas region: 3 terminals, 140 trucks, 160 drivers").
5. Migration → `npm run db:export-supabase`; deliberately update `tests/money-follows-workspace-zone.test.ts` (KPI cache-key pin) when `scope` joins the key.
Commit: "Desk: regions and scope".

### R2 — Bring every screen into scope
Each with a test that a scoped request never returns another terminal's rows: KPI (`getDeskKpi` takes scope, in its cache key; load read, drivers, lanes, customers, trucks, trend, extras), Lanes, Customers, lane detail, header counts, Messages, exports, Quote open pickups, Planner (filter before building rows), Radar loads, Audit and global search, whereabouts (E2) and the Leak Ledger (B1). **Big lists get searched, not scrolled:** KPI filter dropdowns become type-ahead (top 50 + search); the driver leaderboard shows top and bottom ten with "All drivers" expanding; Lanes and Customers get server paging and search with scope applied.

### R3 — Quote a load made usable
Page ships only the scope's trucks (or none plus a typed truck search). Pricing is **nearest first**: pick the N nearest bases to the pickup inside scope (haversine, then road for the shortlist), price those with their own deadhead, then rank by margin; default N = 25 with "Show more" (fixes both bugs). Chips: Trailer fits (type + length), On shift, Available (no clash, papers good), Terminal. "Fleet deadhead to pickup" = the ten nearest plus a search; unpriced table shows a slice; Assign picker defaults to the scope's home drivers with "Everyone" one click away (still a base, never a fence). Copy like "N trucks in scope, showing the best 25 of the nearest 25". Perf budgets at 1,500 trucks (page payload, shortlist).

### R tests and docs
Pure scope tests (set resolution, intersection with assignment, load-membership rule on a set); integration tests that scoped KPI, Lanes, Customers, Quote fit and exports never return another terminal's rows, and a dispatcher assigned to one region cannot read or book another's; `docs/SCOPE.md`; update `docs/DESK_AUDIT_2026-11.md:199`.

---

## Step B4 — Data Health engine
Completeness score per module; loads missing times/miles/arrival/market rate/driver pay; cross-source checks (fuel-card gallons vs trip fuel, ELD miles vs billed loaded miles, rate confirmation vs invoice); printable "Data Readiness" report (the $750 read can be produced from the desk's own data) with a clean executive layout that follows the existing `.rp` sheet print rules (same as `/kpi/report`). Scope-aware.

## Step B6 — Load-history importer
CSV / TMS export / weekly-tracker template, column mapping, preview, dedupe. The desk already imports trucks/trailers/drivers via `lib/import-csv.ts`; this adds loads.

## Parked — B2/B3 (then B5, B7)
**B2** stored signals (first/last seen, status; thresholds in Settings > Rules). **B3** notification adapter seam like `server/partners/adapters` (sandbox that records and sends nothing, Slack incoming webhook, email provider, SMS later), secret-guarded `/signals/cron`, weekly report that sends itself. **Needs from Chris:** the email provider (Resend/Postmark/SMTP), a Slack webhook URL to test with, and his go to add a Vercel cron (`vercel.json` has none today; pattern exists in `app/(public)/partners/cron`). **B5** "why it moved"; **B7** detention evidence pack. Site copy suggestions stay in `LEAK_AUDIT_2026-11.md` §6; the site itself is not edited.

---

## Gotchas to remember
`.sp` = splash CSS, split-pane classes are `.spl-*`. MapLibre: use `setMissingStyleImageResolver` for cluster images; no `maxzoom` on the clustered source. Radar CSS test forbids `border-left/right` except `1px solid var(--line[-hi])`. Loaded miles use `eff.loaded`, not `revenueMiles`. `loads-roles.test.ts` lists every role-gated action — add new ones. Prisma `Decimal` in raw SQL: cast `::float8`. `prisma generate` EPERM while a dev server holds the engine (stop my preview before migrating; delete leftover `query_engine-windows.dll.node.tmp*`). RLS lockdown file is `20261130000001_enable_rls.sql` — tell Chris if he applied the old `20261129000000`. Heredocs with odd quoting fail: write scripts with the Write tool. Restart the dev server via a `next.config` touch (classifier blocks `taskkill`).

## Verification (every step, before each commit)
From `apps/web`: `npx tsc --noEmit`; `npx eslint src tests scripts --max-warnings=0`; `DATABASE_URL=postgresql://demo:demo@localhost:54330/demo RUN_DB_INTEGRATION=true npx vitest run`; `DATABASE_URL=postgresql://demo:demo@localhost:54330/demo_scale RUN_SCALE=true npx vitest run tests/perf`; `NEXT_DIST_DIR=.next-prod npx next build` then `git checkout -- apps/web/tsconfig.json` from the repo root. Migrations: `npx prisma migrate deploy --schema=./prisma/schema.prisma` on both `demo` and `demo_scale`.
Preview: keep `desk-scale` (port 3102, `demo_scale`, BYPASS_AUTH; sign in with "Demo as Admin") running for Chris — config lives in the OUTER `TRUELANE/.claude/launch.json`, revert it after. Walk hover on Trucks/Trailers/map, each detail tab, `/leaks`, the charts and (later) the Scope menu and Quote at 1440 and 1024; say which things were verified in the browser versus by tests only.
