# Demo rebuild: TrueLane-shaped dispatch interface

Branch `demo/truelane-dispatch`. Goal: reuse this app as a demo of dispatch software for the TrueLane Build page,
rebuilt around TrueLane's current schema (`TRUELANE/db/schema.ts`), with made-up data only. Plan of record:
`C:\Users\14698\.claude\plans\i-put-the-web-cheeky-clock.md` (decisions: demo-first and standalone, no prod Supabase,
no Clerk orgs, no real keys; copilot removed; rate-con reader kept and rewired; KPI dashboard kept).

## Baseline before any change (2026-10-28)
`tsc --noEmit` clean; vitest 89 files / 590 tests pass.

## Stage 1 (done): copilot removed
Deleted `server/copilot/*`, `components/copilot/*`, `app/api/copilot`, `lib/ui/alert-fix.ts`, `CopilotIcon`, the `.db-cop*`
and `.db-fab` CSS, the copilot model setting, its tests, and the stale `docs/HANDOFF/*`. `tests/no-copilot.test.ts` keeps it gone.
After: `tsc` clean; vitest 84 files / 492 tests pass. `create_relayed_load` (relay-load creation) existed only in the
deleted `tools.ts`; recover it from commit `3b422f3` if it is ever wanted.


## Stage 2 (done): TrueLane-shaped data layer, alongside the old one
- Scope note (2026-10-28): the website, scripts and Build-page work are out of this plan; everything is the dispatcher web desktop.
- `src/truelane/` holds TrueLane's pure math (break-even floor, verdict, market variance, load economics, invoice aging,
  analytics, rate-con reader core, equipment mapper) copied by `scripts/vendor-truelane.mjs` with the source commit in
  `VENDORED.md`. Golden test: `tests/truelane-domain.test.ts` ($650 over 545.2 mi = $1.19/mi; over 308.2 mi = $2.11/mi).
- New Prisma models mirror TrueLane's tables (`workspaces, vehicles, cost_profiles, loads, stops, trip_segments,
  load_decisions, drivers, assignments`), migration `20261028000000_truelane_shaped_models`. They are **additive**: the old
  Load/Region/etc. tables are still there because the old board, KPI dashboard and reference code (about 8,000 lines) read
  them. Stage 3 builds the new pages on the new tables and retires old code as each page is replaced.
- `src/server/tl/`: `workspace` (tenancy seam), `convert` (rows -> phone math inputs), `evaluate` (the Calculate verdict on a
  dispatcher's load), `projector` (driver-safe `load_summary` + confidentiality gate), `queries` (board rows, analytics,
  aging), `dispatch` (assign, send, record the driver's answer, CDL/medical-card block).
- `src/server/ratecon/`: canned readings of the two fictional sample rate cons, mapper to a load draft (never a verdict),
  a reader (demo path works with no key; the live Anthropic path mirrors TrueLane's function and is **unverified**), and a
  review gate (`saveReviewedDraft` refuses an unconfirmed draft).
- Demo data: `scripts/seed-demo.ts` (3 trucks, 4 drivers, 42 loads; the deadhead-trap load reads $1.19/mi, floor $1.34,
  reject, and flips with a load back). Run it against a throwaway Postgres only:
  `docker run -d --name backhaul-demo-pg -e POSTGRES_PASSWORD=demo -e POSTGRES_USER=demo -e POSTGRES_DB=demo -p 54330:5432 postgres:16`,
  then `DATABASE_URL=postgresql://demo:demo@localhost:54330/demo npx prisma migrate deploy` and `npx tsx scripts/seed-demo.ts`.
  `tests/integration/tl-dispatch.integration.test.ts` runs the whole dispatcher flow there with `RUN_DB_INTEGRATION=true`.
- After: `tsc` clean; vitest 88 files / 513 tests pass (2 integration files skipped without a database).


## Stage 3 (done): the dispatcher desk, new pages on the new tables
Route group `src/app/(desk)` (own layout, no Clerk, no region): `/loads` (board with a verdict per load), `/loads/[id]`
(count-every-mile what-if, stops, assign a driver and pay, send, record the driver's answer, a preview of exactly what the
driver is sent), `/dispatch` (needs a driver, sent and waiting, moving), `/drivers`, `/fleet` (trucks and their floors),
`/invoices` (create, mark paid), `/rate-cons` (read a sample, check it, confirm, save), `/kpi` (the rebuilt KPI dashboard).
- The KPI dashboard is rebuilt on the new tables: `src/server/tl/kpi.ts` (`buildDeskKpi`, pure) feeds `/kpi` with the
  vendored analytics, load economics and invoice aging: revenue by week and month, empty-mile share, pipeline, verdict mix
  on open loads, money owed, top lanes and brokers, market variance, per-driver roll-up. The old region/week KPI code is
  untouched and still reads the old tables until the Stage 4 teardown.
- Styling reuses the app's dark theme tokens (`--db-*`); the new layout classes are in `(desk)/desk.css`. Times are shown in Central.
- Run it: start the throwaway Postgres (see Stage 2), seed it, then
  `DATABASE_URL=postgresql://demo:demo@localhost:54330/demo BYPASS_AUTH=true npx next dev apps/web -p 3100` from the repo root
  and open http://localhost:3100/loads. `.claude/launch.json` has a `desk-demo` entry with the same settings.
- Verified in the browser pane against the seeded database: every page returns 200 with no console errors; assign, send and
  accept on the deadhead-trap load ($1.19/mi on 545 mi, floor $1.34, below cost; $2.11/mi on 308 mi with a load back, covers
  cost); the driver preview carries no revenue.
- After: `tsc` and eslint clean on the new code; vitest 89 files / 520 tests pass.

## Stage 4 (done): the old coordinator-task app is retired
- Deleted: every old page and API route, the old board, KPI, reference, review, settings, audit and market-variance code, the
  region/week/drop-lot server layer, the old LLM and queue layers, the AWS storage and queue code, Clerk and its middleware, the
  old tests, scripts and docs, and the 24 old tables (migration `20261028010000_retire_legacy_dispatch_tables`, destructive:
  run it only on a database you can lose the old data from).
- The TrueLane models now carry their bare names (`Workspace, Vehicle, CostProfile, Load, Stop, TripSegment, LoadDecision,
  Driver, Assignment`), mapped to TrueLane's table names. The root route redirects to `/loads`.
- Guard test `tests/no-legacy.test.ts` fails if the old vocabulary or any employer-specific name comes back.
- Verified: a clean production build (`next build`), then every desk page returns 200 from the production server, the old
  routes return 404, `/` redirects to `/loads`, and assign, send and accept work in the browser with a clean console.
  (Note: build into a clean `.next` before `next start`; a `next dev` that ran against the same folder leaves mixed output and
  every page but one returns 500.)
- After: `tsc` and eslint clean; vitest 7 files / 37 tests pass, including the 5 database tests (`RUN_DB_INTEGRATION=true`).
- Left as history: the migration folder still contains the old tables' creation migrations (their names carry the old
  vocabulary); they are not scanned by the guard test and are superseded by the retire migration.
- Unverified and left for you: the live rate-confirmation read (needs a key), a production deploy (this is a demo), and rotating
  the old dev API key noted in `docs/CONVERGENCE_BUILD_PLAN.md`.

## Desk rework, Wave 1 (done): look, shell, tables
- Two themes on the TrueLane palette: Night (the phone app's colours, the default) and Day (warm manila). Chosen in Settings, kept in
  cookies (`desk-theme`, `desk-density`, `desk-sidebar`) and read by the root layout, so nothing flashes. `tests/theme-contrast.test.ts`
  holds both palettes to WCAG AA.
- Shell: collapsible grouped sidebar with live count pills, header with day totals. `DataTable` (banded groups, pinned first
  columns, row flags, search, row density) on Loads, Drivers, Trucks and Invoices. Shared kit in `components/desk/kit/`.

## Desk rework, Wave 2 (done): load drawer, audit trail, alerts, search
- **Load drawer.** A load opens in a side panel over whichever page you were on (an intercepting route: `app/(desk)/@drawer/(.)loads/[id]`),
  and as a full page on a direct link or reload (`/loads/[id]`). Both are one component, `components/desk/load-view.tsx`: alerts, what it
  pays (per loaded mile, per mile on every mile, the floor), an eight-step timeline read from existing timestamps
  (`lib/desk-timeline.ts`), the count-every-mile comparison as two bars against the floor, driver and pay, stops, the driver-safe
  payload, and the load's activity. Closing returns to the page underneath (`components/desk/underlay.tsx`); a catch-all in the slot
  (`@drawer/[...rest]`) is what makes the drawer let go on any other URL.
- **Audit trail.** New table `audit_events` (migration `20261029000000_audit_events`, additive). Every assignment, change of driver or pay,
  send, driver answer, unassignment, invoice, payment and rate-confirmation save writes an event in the same transaction as the change
  (`server/tl/audit.ts`). Page: `/audit` (filter by group, search, before/after diff in a dialog). The seed backfills the history.
- **Alerts.** Derived on each request, nothing stored (`lib/alerts.ts`, loaded by `server/tl/alerts.ts`): driver's CDL or medical card
  lapsed (block), driver double-booked (block), pickup within 24 h with no driver sent (block), sent and no answer for 4 h (warn),
  card lapsing within 30 days (warn), below the truck's cost with no driver sent (warn), invoice past terms (warn), a stop with no
  reference number (info), delivered and not invoiced (info). Pages: `/alerts`, the rules at `/settings/rules`, a dot on each load row,
  a pill in the sidebar, and a "Needs attention" panel on the dispatch queue. The timings are fixed for now.
- **Double-booking guard.** `assignDriver` refuses a driver who is already on another open load at the same time (first stop's earliest
  to last stop's latest) unless a reason is given; the reason goes in the audit event. `unassignLoad` takes a driver off a load, and
  needs a reason once the load was sent or accepted.
- **Header search.** `/` focuses it; loads, drivers, brokers and cities, from `GET /search?q=` (a route inside the desk group, because
  the guard test forbids a top-level `src/app/api`). A driver, broker or city opens Loads filtered to it (`/loads?q=`).
- **Seed changes.** The open loads are spread so no driver is on two at once, except one overlap on purpose; one draft picks up in
  about 20 hours; one driver's medical card lapses in 20 days; sent loads have real waits; no payment is dated in the future.
- Verified: `tsc` and eslint clean; vitest 9 files / 112 tests pass, and the 12 database tests with `RUN_DB_INTEGRATION=true`. In the
  browser: open, act inside and close the drawer (Esc, the close button, the dim area), assign, send, decline, re-assign, remove with a
  reason, assign over a double-booking with and without a reason, the audit details dialog, header search, Night and Day.
- Not done: a production build of this wave, and a keyboard-only walk (both come in Wave 5).

## Desk rework, Wave 3 (done): KPI dashboard, comparisons, exports, thresholds
- **Periods and comparison.** Last four weeks (the default), this month, year to date, all time. Each compares with the equivalent stretch
  before it (the four weeks before; the same days of last month; the same dates last year), with matching lengths so a part-month is
  never set against a whole one. Months and years start at midnight Central (`lib/zoned.ts`, `lib/kpi-periods.ts`), daylight saving included.
  Filters by lane, broker, driver and truck narrow every number on the page. The page, its CSV files and the printable report all read
  the same address parameters (`lib/kpi-params.ts`).
- **Numbers.** Finished loads become one fact each (`server/tl/kpi.ts`); every figure is a sum or a ratio of sums over the facts in a
  window, run through TrueLane's own analytics, load-economics and market-variance functions. New measures: share of loads that cleared
  the truck's floor frozen at accept (pay after tracked fuel, tolls and other costs, per mile driven), paid within terms, days to pay,
  average wait at a stop, empty miles per driver and per lane (split before the pickup and after the delivery), and each load's rate
  against its market rate.
- **Charts** (`components/desk/kpi/`, plain SVG and CSS rendered on the server, no chart library): a hairline matrix of eight headline
  numbers with change chips (colour is the judgement, the glyph is the direction, so a fall in empty miles is a green down arrow); twelve
  weeks as four small charts plus last-four-against-prior-four growth bars on one scale; drivers ranked by empty miles with the amber and
  red lines and the fleet's own mark (empty % or empty miles); bullets for floor, payment and dock time; a histogram of rate against
  the market with loads that have no market rate kept apart; empty miles per lane split before and after; and a lane scorecard. Every
  chart carries its unit, a one-line caption and a footer saying how it is worked out, and says so in words when it has nothing to show.
- **Thresholds** (Settings, `lib/thresholds.ts`, `server/tl/thresholds.ts`, migration `20261029010000_workspace_thresholds`): seven
  nullable columns on `workspaces` (empty-miles amber and red lines, default pay terms, free time at a dock, and the three alert
  timings). Blank means the default. The form checks as you type and redraws a bar with the fleet's real empty-miles share on it;
  saving writes an audit event with the before and after values. Alerts, invoice terms and the KPI lines now read them.
- **Exports.** `GET /export/<kind>` with the same filters as the screen: `loads`, `invoices`, `kpi-drivers`, `kpi-lanes`, `kpi-weeks`.
  CSV with a byte order mark and CRLF line ends; text that a spreadsheet would run as a formula is defused (`lib/csv.ts`). The Loads
  filter is one shared function (`lib/board-filter.ts`), so the file always holds the rows on screen.
- **Report.** `/kpi/report` is a one-sheet management report for the same period and filters, with a print stylesheet; "Print or save as
  PDF" opens the browser's print dialog.
- **Seed.** Empty miles lowered a little (shorter runs home, more loads with a load back) so the fleet shows a spread of green, amber and
  red instead of all red.
- Verified: `tsc` and eslint clean; vitest 13 files / 175 tests pass including the 18 database tests (`RUN_DB_INTEGRATION=true`), now run
  one file at a time because they share one database. In the browser: every chart in Night and Day, period tabs, compare on and off,
  filters, both leaderboard views, the empty state, the Settings form (inline errors, live preview, save, audit event, dashboard recolours),
  every export, the report page.
- Not done: the browser's print dialog was not exercised (the report page and its print stylesheet were), a production build of this
  wave, and a keyboard-only walk (Wave 5).
