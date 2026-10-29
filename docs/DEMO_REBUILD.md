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

## Desk rework, Wave 4 (done): planner, disruptions, detention, fleet editing, broker and lane scorecards
- **Planner** (`/planner`; `lib/planner.ts`, `server/tl/planner.ts`). Seven days, one row per driver and a "Needs a driver" tray; a load
  is a bar from its first pickup window to its last delivery window, coloured by state (assigned and not sent, sent or accepted, on the
  road, delivered) and marked red when the driver is double-booked. Above it, a "Due now" list of stops that are past due, due today,
  coming up or already reached, read from the stop windows and the recorded arrivals. Days are Dallas days (`lib/zoned.ts`).
- **Change of plans** on a load (`lib/disruptions.ts`, `server/tl/disruptions.ts`, `components/desk/disruption-dialogs.tsx`). Move the
  pickup (every stop shifts by the same amount; a driver who already has the load is asked to confirm again; a new double-booking is
  refused), cancel (the driver comes off), or record a TONU (the fee counts as revenue and the load closes). Each takes a reason from a
  short list, and "Other" needs a note. Each writes an audit event in the same transaction. Reasons are counted on the KPI page.
- **Detention** (`lib/detention.ts`, `server/tl/detention.ts`). The recorded wait at each stop against the free time (the truck's, else the
  one in Settings) and the truck's detention rate gives what can be billed. The load view shows it under "Waiting at the docks"; the
  invoice dialog has a checkbox that adds it to the invoice as an extra charge, using TrueLane's own invoice total; the Invoices page
  lists what is billable and what was billed; an info alert says when money is still unbilled.
- **Fleet editing** (`lib/fleet-forms.ts`, `server/tl/fleet.ts`, `components/desk/fleet-forms.tsx`). Add, edit, take out of service and
  bring back drivers (a driver on an open load cannot be taken out); add, edit, archive and restore trucks (same rule). A truck's page
  edits its cost profile with the break-even floor redrawn as you type; saving recomputes the floors on the server, tells you how many
  open loads will now be judged on the new floor (finished loads keep the floor they were accepted at), and writes an audit event.
  A blank form says nothing until a field is changed; pressing the button then shows every message.
- **Brokers and Lanes** (`/brokers`, `/lanes`; `kpi-brokers` export). Scorecards over finished loads in the chosen period: loads, gross,
  per mile, against market, days to pay, wait at a stop and how many fell through (brokers); empty miles split before and after, and
  against market (lanes). Each broker links to the KPI page filtered to it.
- **KPI additions.** "Why loads fell through" (cancelled loads and TONUs by reason, with the share of loads meant to run), "Arrived on
  time" among the bullets, and "Loads finished" saying how many were TONUs.
- **Seed.** Stops carry arrival times and waits; two cancelled loads and one TONU; detention terms on the cost profiles ($65 an hour after
  two hours free). Load windows are set relative to the moment the seed runs, so re-run the seed before a demo to put "today" back
  where it belongs.
- Verified: `tsc` and eslint clean; vitest 17 files / 224 tests pass including the database tests (`RUN_DB_INTEGRATION=true`); the demo
  database left as seeded (45 loads, 163 events). In the browser at 1440 wide: planner and due list, reschedule and cancel from the load
  drawer (including the refusal for "Other" with no note), the detention section and invoice, drivers (add, edit with a lapsed card,
  take out of service with Undo, the blocked state), a truck's cost profile (live floor, save, audit entry), brokers (period tabs,
  search, export link), lanes, the KPI reasons card; the planner and a truck page in Day. At 1024 wide: no page-level overflow on the
  planner, drivers, brokers, lanes, KPI and invoices pages; the planner's week scrolls inside its frame with the driver column pinned.
- Not done: recording a TONU and reactivating a driver were exercised by the database tests, not in the browser; a TONU fee cannot be
  invoiced yet; detention is not added to the KPI gross; a production build, a keyboard-only walk and the print dialog (Wave 5).

## Desk rework, between waves (done): the Rate confirmations page
The page was one card with two buttons and nothing under it. It is now a working intake, in the desk's own patterns.
- **Read.** A drop zone (drag a file on it, or choose one: PDF, photo or screenshot, up to 10 MB) and the two invented samples. The file goes
  to the server as an upload (`readUploadedRateConAction`; `serverActions.bodySizeLimit` is 10 MB in `next.config.mjs`). A sample's file
  name still reads with no key; anything else needs `ANTHROPIC_API_KEY`, and the page says so up front rather than after a drop.
- **Check.** Three steps across the top. Load fields, money and terms (the rate worked out per printed mile as you type), and every stop as a
  card with its facility, address and appointment editable (moving an appointment moves the end of its window by the same amount). A
  "Will be saved as" panel stays beside it with the lane, truck, rate, anything the reader was unsure of, and what still blocks saving
  (no rate, no stop, an empty address). What else the document prints (commodity, weight, dock terms, notes) is shown for checking.
  Nothing is saved until the box is ticked, and no verdict appears: the load is already agreed.
- **Runs on.** A truck can be chosen before saving. Nothing else in the desk sets a load's truck afterwards, and without one the load's own
  screen has no floor to read it against. It is a field on the review, remembered between documents.
- **Read so far.** The latest eight loads that came from a document, with their rate, per printed mile, where each stands and when it was
  read, and the total. A save shows up at once. The seed now makes a third of its loads (15) rate-confirmation loads, each with its
  `rate_con_saved` event, so the list is never empty on a fresh seed (events: 163 to 178).
- **A bug fixed on the way.** A rate confirmation's flat fuel surcharge was saved on the load as well as inside its all-in rate, and the
  load's surcharge field is a per-mile or percent rate, so the $800 sample showed as "$15,320 all-in" and would have invoiced at $860.
  The load now keeps the all-in rate and no separate surcharge; the page still says how much of the rate is fuel. The phone app's own
  mapping of the same field was not checked.
- Verified: `tsc` and eslint clean; vitest 18 files / 226 tests pass with the database tests. In the browser: both samples read, the
  rate cleared and retyped (Save blocked, then allowed), an appointment moved, a truck chosen, saved, the new load at the top of the
  list, its page showing $800 all-in against the truck's floor; at 1440 wide in Night, at 1024 wide (the review stacks into one column,
  no page overflow) in Night and Day.
- Not done: reading a real file (it needs a key, so the live path is still unverified from this app); dragging a file onto the zone or
  choosing one with the file picker (both are written, but only the two samples were run); a keyboard-only walk; a production build.

## Desk rework, Wave 5 (done): the phone's cost profile and driver pay
Plan: `~/.claude/plans/radiant-stargazing-spark.md` (bring the phone's Calculate, cost profile and Loads to the desk for a fleet dispatcher whose
drivers work for them). This wave is the foundation Quote and Loads read from. The phone's own code stays as it is.
- **More of the phone vendored** (`scripts/vendor-truelane.mjs`, six files): `costProfileHero`, `costProfileSnapshot`, `fuelPriceForRates`,
  `insuranceFields`, `vehicleData` (the industry numbers by vehicle type) and `fieldRelevance`. The refresh changed only the header line of the
  files the desk already had.
- **Cost profile, in the phone's steps on one page** (`/fleet/[id]`; `lib/fleet-forms.ts`, `components/desk/fleet-forms.tsx`, `server/tl/fleet.ts`).
  Insurance as one total or five buckets; the other fixed bills; miles and upkeep; fuel; who drives (By its owner, Leased on to a carrier, By a paid
  driver: the phone's Solo, Leased-on and Owner + driver) with the fields each needs; factoring; daily target; an optional route minimum; detention.
  A truck with no profile starts from the industry numbers for its type, and "Fill with typical numbers" puts them back. The live preview uses the
  phone's hero and build-up functions and stays live while a required labour number is still blank. Required answers follow the phone: miles and a pay
  target always; a paid driver's pay by the basis chosen (burden starts at 18%); a leased-on truck's cut (0 allowed, 20% offered) and its fuel-surcharge
  answer; a route minimum's base. A percent of 50 or more, and a fuel price or reserve outside the phone's usual range, are confirmed before saving.
  Fields the answers do not use are not checked and are left as they were, so switching a truck back finds the driver's pay where it was.
- **Truck types and fuel** now use the phone's categories (cargo van, passenger van, pickup, sprinter, box truck, heavy duty); an old "tractor" reads as
  heavy duty and "gas" as gasoline.
- **Driver pay.** A driver has a usual pay (per mile, hourly or flat) on the Drivers page; choosing a driver on a load starts the pay from it. A load with
  a driver assigned is judged on that driver's pay (`resolveLabour` in `server/tl/evaluate.ts`): per mile and hourly are the phone's two models as they
  are; a flat pay becomes a per-mile rate over every mile of the trip (a covered way home does not count); burden is the truck's, or the phone's 18%
  start. A leased-on truck keeps the carrier's cut. With nobody assigned the truck's profile decides, as before. The load page says which it used.
- **Frozen at booking** (`server/tl/snapshot.ts`, migration `20261030000000`). The floor, insurance, miles, truck type, mpg, whether the cut came off fuel
  surcharge and the detention terms are written once, when a rate confirmation is saved with a truck or a driver is first assigned; the driver pay and
  cut are refreshed at each assignment until the load is on the road. KPI "cleared the floor" and detention now read the frozen values.
- **Route minimum** columns exist and the verdict now reads them (it passed nothing before).
- **Two bugs fixed.** A stored fuel surcharge was read as a per-mile rate (a $60 surcharge on 257 miles counted as about $15,400); it now converts back to
  the unit it was entered in, as the phone does. And a load still on the road whose delivery window closed on an earlier day dropped out of its driver's
  planner row; it now stays until delivered.
- **Seed.** Truck types follow the phone's; drivers have usual pays; seeded assignment pay is lower and more usual (per mile 0.50, a flat 45% of the offer).
  With driver pay counted, 8 of the 12 open seeded loads read below cost (4 before): the seed's offers were set for owner-driven trucks.
- Verified: `tsc` and eslint clean; vitest 19 files / 252 tests pass with the database tests. In the browser: the editor at 1440 and 1024 (sections,
  typical hints, live floor matching the stored $0.77, paid-driver fields and the required-pay message, itemising keeps the floor, leased-on prefill, the
  confirm dialog for a 60% cut, save and its audit entry), the Drivers page usual pay, and the assign form starting from it and the load page naming the
  assignment's pay.
- Not done: the dispatcher's margin (revenue minus driver pay minus truck cost), which needs its definition agreed first; the confirm dialog's "Save as typed"
  and "Fill with typical numbers" were not clicked; a flat pay as a per-mile rate is my reading and is flagged for sign-off; burden is per truck, not per driver;
  no CDL number on drivers; a production build, a keyboard-only walk and the print dialog (Wave 8).

## Desk rework, Wave 6 (done): Quote a load (the phone's Calculate for a dispatcher)
Plan: `~/.claude/plans/radiant-stargazing-spark.md`. The phone's Calculate prices one load for one truck; here an offer is priced for every truck and
every driver who runs it, with the same verdict maths, so "which of my trucks should take this, and does it clear?" has an answer before it is booked.
- **The page** (`/quote`; `components/desk/quote-desk.tsx`, `lib/quote.ts`, `server/tl/quote.ts`). The load (stops with a pickup first and a delivery last,
  middle stops either; broker with the desk's brokers as suggestions; trailer), the money (offer, fuel surcharge as a percent or dollars a loaded mile,
  market rate as a total, pay terms, factoring) and the miles (loaded, empty to the pickup, empty home, "I have a load back"). It prices as you type
  (a short pause, then `priceQuoteAction`); nothing is written until a quote is saved or booked.
- **Truck and driver table.** One row per truck and driver (a truck with no driver set gets one row), best first, a driver who cannot take it last. Each
  row is the offer run through `evaluateTlLoad` with that driver's usual pay as the labour (the truck's own profile when they have none), so a driver on a
  truck changes the answer. The verdict band uses the phone's words (Below your cost, Add mpg and fuel price, Strong caution, Negotiate up, At market, Above
  market, Add a market rate). Empty miles to the pickup can be typed per truck, because the desk has no routing to work it out. A lapsed card, or another load
  at that time (when both times are typed), blocks a driver's row and says why.
- **The verdict panel.** The band, the per-mile figure with the miles it is per ("$1.19/mi all-in on 545 mi · 237 mi empty home", the phone's own golden
  case), the floor it used and what the load clears or misses it by, pay with surcharge, the market comparison, the pay needed to cover it when it does
  not, fuel, whose driver pay is in it, and every reason to pause (route minimum, thin margin, time trap, rests, a missing fuel price).
- **A reason when one is needed.** The accept gate is the phone's `acceptGate` (vendored): below cost, no fuel price, below market or no market rate asks for
  a reason first, with the phone's four reasons and its question for each gate. The server works the verdict out again and refuses a booking without the
  reason; the decision (`LoadDecision`: accepted, or overridden with the reason and notes) and a `booked` audit entry are written with it.
- **Quotes are loads with status `quote`** (`lib/quote-status.ts`). One predicate, `notQuote`, is in every general load query (board, analytics, aging,
  load detail, alerts, KPI rows, search, the sidebar counts, a truck's load counts), and the planner and the due list name their statuses, so a quote is
  on none of them; the Quote page is the one place that lists them (saved quotes, with Reopen and Discard). Booking changes the quote's status to
  `draft` (needs a driver): same row, no copy.
- **Book.** Needs a time at both ends (the desk cannot yet edit a stop, and a load with no times cannot be planned or chased), a truck with a cost profile,
  and the reason if one is asked. It creates the load (number `QT-...`, channel `dispatch`) with its stops, freezes the floor and dock terms
  (`freezeLoadSnapshot`), and, if a driver's row was chosen and they have a usual pay, assigns them at it (not sent). If the driver cannot be assigned (a lapsed
  card, or a clash) the load is still booked and the page says why.
- **What the desk already knows.** Last time on this lane (the five latest finished loads between the same two cities, with the average per loaded mile) and
  the broker's record (loads, finished, fell through, average per loaded mile and days to pay), from the desk's own loads.
- Verified: `tsc` and eslint clean; vitest 21 files / 271 tests pass with the database tests (11 new for quoting, 8 for the form). In the browser at 1440 and
  1024: the page, pricing as typed, the table and its selection, the lane and broker cards, reopening a saved quote, the missing-times message, the override
  question (the Book button stays off until a reason is picked), a booking with an override and a clean booking with its driver, and the success panel.
- Not done: address autocomplete, routed miles and drive hours (they need a Mapbox key, which is Chris's to set; typed miles and a 50 mph drive time stand in), the
  fuel price from EIA (the truck profile's price is used), the phone's load size and requirement fields, the lead-time tip, a "pass on it" decision, editing a booked
  load's stops (Wave 7); at 1024 the verdict panel sits below the form; a production build and a keyboard-only walk (Wave 8).
