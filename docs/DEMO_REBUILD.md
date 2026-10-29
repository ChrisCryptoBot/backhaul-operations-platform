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
  a reader (demo path works with no key; the live Anthropic path mirrors TrueLane's function and was checked live on 2026-10-29, see Wave 7b), and a
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
- Not done at the time: reading a real file (it needed a key; checked live later, see Wave 7b); dragging a file onto the zone or
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

## Desk rework, Wave 7 (done): loads and billing parity
Plan: `~/.claude/plans/radiant-stargazing-spark.md`. The phone's Loads tab is where a load is edited, run and billed. This wave gives the desk the same,
for a dispatcher entering it on behalf of drivers. **Driver settlement is split off as Wave 7b** (it needs a new model and migration of its own and a
decision on what a finalized statement locks); add and remove stops, a proof-of-delivery file upload, email sending and aligning the cancel reasons are not done
(each needs a decision about who is acting, or storage the desk does not have).
- **Migration** `20261031000000_load_details_and_invoice_lines`: on `loads`, weight, cargo length, width and height, hazmat class, liftgate, ramp and pallet
  jack needs, broker phone and email, notes, a proof-of-delivery note, and `invoice_lines` (what an invoice was billed as). Applied to the demo database only.
- **Edit a load** (`Edit details` on the load; `lib/load-edit.ts`, `server/tl/edit.ts`, `components/desk/load-actions.tsx`). Broker and MC, load and PO number,
  trailer, weight and size, what it needs, pay terms, notes, and for each stop its place, window, facility, references, contact and notes. Checked in the
  dialog and again on the server, with each error next to its field. A cancelled or TONU load, or a quote, is refused; a load on the road or delivered keeps
  its stops where they are but its details can be corrected. If a driver has the load and a place or time changes, their assignment goes back to sent (they
  confirm again, version up one), and a move that would put them on two loads at once is refused. The audit entry lists only what changed, before and after.
- **Enter a trip for the driver** (`Trip` on the load; `lib/trip.ts`, `server/tl/execution.ts`). Pickup (arrival, wait, seal; needs the load and the driver's
  answer accepted), delivery (arrival and wait at the later stops, when it was delivered, proof of delivery received or the reason there is none, fuel, tolls
  and other costs) and expenses on their own. The same record the phone writes: the load goes on the road then to delivered, actual revenue is the agreed rate,
  and the waits add up to the dock wait detention reads. Times are Dallas time, cannot be more than ten minutes ahead, and the delivery cannot precede the
  pickup. Each entry is audited as entered by the desk.
- **Invoices** (`lib/invoicing.ts`, `server/tl/invoicing.ts`). A dialog on the load and on every Ready to invoice row: number (default `INV-` and the load number,
  unique on the desk), terms, detention, lumper, layover and one other charge, and the total as you type from the phone's own `invoiceTotalDue`. A delivered load
  with nobody to bill, no load number or no rate is refused; a missing broker contact or proof-of-delivery note only cautions. The invoice keeps its lines.
  Mark paid takes the amount that came in: a short payment is recorded as it came and says by how much (on the load, the list and the audit entry). Undo
  payment (with a reason) puts it back to out and waiting. `/invoices/<id>` is the invoice as billed on a sheet that prints or saves as a PDF; an overdue
  invoice gets Copy reminder, a ready-written message for the dispatcher's own email (nothing is sent from the desk; if the browser blocks the clipboard the
  text opens in a dialog, selected).
- **Loads: Open and History** (`lib/loads-history.ts`). Open is the live board (needs a driver, accepted, on the road, below cost); History is delivered,
  cancelled and TONU loads grouped by month, filtered All, Owed or Cancelled and sorted newest, oldest, pay or dollars per mile, with where the money is on
  each row (Paid, Out and waiting, Overdue by the invoice's own terms, Not invoiced yet, the cancel reason). Search now covers PO, invoice number and the broker's
  MC; when it narrows to one broker, a line gives how they have treated the desk (invoiced, paid, days to pay, short pays, still out, cancelled). An old link to
  `?status=completed` lands on History.
- **Rate-confirmation review checks** (`lib/rate-con-checks.ts`). Not vendored: the phone's file sits on the 1,387-line Community precheck and a closure of
  eight more, and carries rate-per-mile bands tuned for drivers. The desk's own follow the same two levels: stops out of order, a delivery first or a pickup
  last, and three or more stops need the new "I checked the stops and their order" box before Save; a first appointment in the past, a window that ends before it
  opens, a stop with no appointment and no printed miles only caution.
- **Trucks: make, model, year and specs** (Chris's request during the wave; `lib/truck-specs.ts`). The truck form had type, fuel and miles per gallon only. It now
  has the phone's Make, Model and Year pickers: choosing a model fills the type, miles per gallon, payload and cargo size from the phone's dataset, and it only
  fills a field that is blank or still holds the previous model's value, so a number typed by hand is never overwritten. A truck that is not listed is typed in
  (Make and Model each offer "Not listed, type it in"; a typed make types its model; the specs are entered by hand). Stored values show on the truck page and list;
  the audit entry lists them.
- Verified: `tsc` and eslint clean; vitest 28 files / 338 tests pass with the database tests (67 new, 9 of them against the database: edit, refusal, reconfirm and
  clash, trip entry, invoicing, short pay and undo, the board and invoice list). In the browser at 1440 and 1024 on a clean seed: History (months, Owed, sort,
  search by broker with its pay record, an overdue row), a load's Trip section (the guard before the driver accepts, the pickup, the delivery with expenses), Create
  invoice with a lumper, the invoice page, a short payment and Undo payment with its reason, the Edit dialog (sections, stops, footer), the Invoices list
  (View, Mark paid, Copy reminder on the two overdue rows), a three-stop rate confirmation needing the stops box, and the truck form (a listed model filling its
  specs; a typed make, model and year saved, shown on the truck page, then removed). The demo database was reseeded afterwards.
- Found, not fixed: an action that ends in the older redirect (assign, send, driver answer, Undo payment) opens the load drawer on top of the full load page, so the
  page shows twice until you move on. It predates this wave; the new dialogs refresh in place and do not do it.
- Not done: driver settlement (Wave 7b); the phone's profit-per-mile and dollars-per-hour sorts (the desk has no per-load net or drive hours; dollars per mile on
  every mile stands in); the CSV export does not follow the History filters (it takes the search only); the proof-of-delivery file itself; sending an invoice or a
  reminder; the dispatcher margin and the flat-pay reading, which still need Chris's sign-off; a production build and a keyboard-only walk (Wave 8).

## Desk rework, Wave 7b (done): driver pay (a percent of the rate or a set amount) and statements
Plan: `~/.claude/plans/radiant-stargazing-spark.md`. Chris asked that a dispatcher can pay a driver a set amount or a percentage of the rate
confirmation. A set amount already existed (the flat pay kind); a percent did not, so it is a fourth pay kind, and the statements built on top of
pay follow each load's own assignment.
- **Percent of the rate** (`lib/pay.ts`). A driver's usual pay and a load's assignment can be per mile, hourly, a set amount for the load, or a percent.
  The percent is taken of what the rate confirmation pays: the agreed rate plus its fuel surcharge, not detention, lumper or other extras (share those as a
  line on the statement). It is above 0 and at most 99.99. It is worked out wherever pay is: the estimate stored on an assignment, the labour in the verdict
  (a percent is a set amount once worked out, so it reads like a flat pay: over every mile of the trip, with the 18% burden, same reading as flat and still
  awaiting Chris's sign-off), Quote's driver rows (a percent of the offer plus surcharge) and the statement. The assign form shows the dollars as the percent
  is typed ("$162.50 on this load's $650.00"). The driver is never sent the rate: the driver-facing payload carries a percent as the set amount it comes to.
  The audit and the load page say "25% of the rate". `payEstimate` and `resolveLabour` now need the rate confirmation's total, so a caller cannot forget it.
- **A cent bug fixed on the way.** The estimate multiplied rate by miles in floating point before rounding, so 0.051 a mile over 185 miles ($9.435) came out
  $9.43 where the database rounds $9.44. It now multiplies as decimals; the statement maths uses the same rule, checked against it over thousands of cases.
- **Statements** (`/settlements`; `lib/settlement.ts`, `server/tl/settlement.ts`, `components/desk/settlement-forms.tsx`; migration
  `20261101000000_driver_settlements`, applied to the demo database only). A statement is one driver and a period of two Dallas dates (Last week, Last two
  weeks, This month so far and Last month are one click; at most 92 days). It lists the driver's loads delivered in the period that are not already paid on a
  final statement, worked out from the loads each time it is shown. Each load pays under the pay it was assigned with: per loaded mile times loaded miles, the
  set amount, hourly times hours (the hours the assignment was sent with, or typed; an hourly load with neither blocks finalizing), or the percent. Typed
  adjustments cover everything else (an advance, a fuel card charge, a reimbursement, a bonus, a share of detention; a deduction is negative). The editor totals as
  you type with the same function the server freezes. The broker's payment status is shown on each load and cautions, but does not hold a statement.
- **What finalizing locks.** The load lines, adjustments and total are frozen (a load edited afterwards does not rewrite what was paid), and each load is tied to
  the statement by a row that is unique per load in the database, so a load cannot be paid on two statements even if two are finalized at once. A final statement
  cannot be edited. **Void** (with a reason) keeps it as it was, marks it void and releases its loads for another statement; a draft is **discarded**. Start,
  finalize, void and discard are audited (Money group). The load page says which statement a load was paid on. Finalized and voided statements print as a sheet.
- **Not payroll.** It is gross pay. Taxes, payroll burden and withholding are not worked out, and the sheet says so.
- **The keys, and what is wired.** Checked 2026-10-29 (names and status only; values never printed). The desk reads one key, `ANTHROPIC_API_KEY`, for live rate
  confirmation reading; it was not in the desk's env. The phone project's `.env` holds Anthropic, Mapbox (public and secret), EIA and FMCSA keys; the four the desk
  can use were copied into the desk's own gitignored `apps/web/.env.local` as `ANTHROPIC_API_KEY`, `MAPBOX_ACCESS_TOKEN`, `EIA_API_KEY` and `FMCSA_WEBKEY` (the Mapbox
  secret was not copied), and `.env.example` lists the names. Each was tried once and accepted: Anthropic, Mapbox geocoding and directions (Dallas to Houston came
  back 239.6 mi, 3.7 h), EIA (US on-highway diesel $6.352 for the week of 26 Oct) and FMCSA. Live rate confirmation reading is now on: a made-up one-page rate
  confirmation was read through the desk's own reader (`scripts/live-read-check.ts`) in 12.6 s with every field right (broker, load and PO number, $1,300 all in, 452
  miles, Net 30, both stops with correct Dallas times and reference numbers). **Mapbox, EIA and FMCSA have keys but no desk code yet**: address autocomplete, routed
  miles and drive hours, the fuel price, and a broker authority lookup are still the typed-miles stand-ins. No real broker document was sent anywhere. The key
  copied from the phone project may be the dev key that `CONVERGENCE_BUILD_PLAN.md` says to rotate; if it is, rotate it.
- Verified: `tsc` and eslint clean; vitest 31 files / 373 tests pass with the database tests (35 new: pay, statements, and 8 against the database covering a percent
  assignment and what the driver is told, the period edges at Dallas midnight, hours, adjustments, finalize and freeze, the unique rule, void, discard and the
  unsettled summary). In the browser at 1440 and 1024: Settlements (what is owed per driver), the start dialog with its presets, a draft with a per mile and a set
  amount load, an advance and live totals, finalize through its confirmation, the printed sheet, void with a reason and its banner, the audit entries, the load page
  marker, a percent on the assign form (live dollars, then the load, estimate and verdict note), the Drivers form offering all four kinds, and a draft with a
  percent line (30% of $952.00 = $285.60) and an hourly load (9 hours = $216.00) with Finalize waiting on the hours. The demo database was reseeded afterwards.
- Not done: a CSV of statements, emailing a statement, a per-driver burden, a per-statement note, rules to pay a driver only after the broker pays, a percent of a
  different base (say the line haul alone), a share of detention as an automatic line; the dispatcher margin and the flat/percent per-mile reading still need
  Chris's sign-off; wiring Mapbox, EIA and FMCSA; a production build and a keyboard-only walk (Wave 8).

## Desk rework, Wave A (done): design foundation (look and feel to match the phone's rules)
Plan: `~/.claude/plans/cryptic-splashing-bumblebee.md`. Chris's review of the Quote screen: the pills are "unsexy", the screen is "underdesigned and fake luxurious", space is filled for its own sake. Three read-only audits (the desk's visuals against `docs/reference/DESIGN_PRINCIPLES.md` and `DESIGN_OVERHAUL_MAP.md`, the Mapbox gap, desk against phone function) fed the plan. This wave is the shared layer; the page-by-page passes follow in C0-C4. Decisions from Chris: keep and redesign both themes, match the phone's look but allow desktop exceptions (tables, KPI charts, planner grid).
- **Status is a dot and a kicker.** `.tl-chip` is now a 7 px dot and an uppercase Barlow Condensed label with no fill, border or radius, so all 27 call sites (Loads, drawer, dispatch, drivers, planner, audit, invoices, quote, alerts) change at once. The tone map (`lib/desk-format.ts`) was muddled and is fixed: gold asks the dispatcher to act ("Needs a driver", "Assigned, not sent"), green is settled (accepted, delivered, covers cost), steel is moving ("On the road"), amber is waiting on someone ("Sent, waiting"), red is wrong, grey is closed. Healthy drivers no longer carry a green "Clear" pill (a blocker still speaks). Count pills in the nav are plain figures (a dot when collapsed); alert levels and KPI deltas lost their fills.
- **Sections, not boxes.** `.tl-card`, `.sec-box` and the drawer's sections are open: a gold Condensed kicker over a hairline, content on the page. Stats are a strip (label over a condensed tabular figure, thin rules between, no card each); the drawer's "What it pays" is a three-column strip with the all-in figure as the hero; the KPI matrix is hairline-divided cells on the page. Alerts and the dispatch queue are ruled rows; only a blocking alert keeps a container (a 1.5 px red border, radius 14).
- **Tabs and tables.** Filters and views are underlined text tabs with a gold underline on the selected one (no pill). Tables lost the zebra and the tint-plus-red-edge on a flagged row (the status label carries it), and their header cells are Condensed kickers.
- **Tokens.** Radius by role (press 6, field 8, tile 10, note 14, card 20) added; buttons use press, modals and the hero panels use card. Shadows are gone (the `--db-shadow-*` tokens are now a hairline rim; toast and sticky seam too); the toast is a tone-bordered note with no side stripe and now pauses while pointed at or focused, with a short grace. Motion is 110 / 200 / 220 / 320 ms with a 0.98 press scale. Kickers are Condensed everywhere. The header no longer repeats the page title (the page's h1 does that).
- **Contrast, both themes.** Dim text was 3.87:1 on a raised surface and 4.36:1 on a selected row; it is now `#8d97a4` (night) and `#675a50` (day), 4.5:1 or better on every surface. Placeholders have a rule, the focus ring no longer reshapes what it rings, the dimmed finished-load card in the planner no longer uses opacity on small text, and the day theme's card and field borders are a step firmer. `tests/theme-contrast.test.ts` now also checks body, mid and dim text on raised surfaces, inputs and the selected-row fill, and the gold kicker on every surface (98 checks, up from 58).
- Verified: `tsc` and eslint clean; vitest 31 files / 413 tests pass with the database tests. In the browser at 1440 in the night theme (Loads, Quote, Invoices, a load's page) and the day theme (Loads). Not seen yet in this wave: the drawer over the board (its route was still compiling), 1024, Settlements, KPI, Planner, Alerts and Dispatch in the new look, and the keyboard pass.
- Not done in A (planned for the module passes): sortable headers with `aria-sort`; a `StatStrip` and `Section` React component (the look is done in CSS, call sites still use `Stat` and `Card`); a hero figure treatment on the Quote verdict beyond its size and font; the page subtitles are still 15 to 34 words; the boxed `.rc-stop`, `.st-choice`, `.wl-row` bar, planner grid and KPI charts remain (desktop exceptions or next); fixed Pickup/Delivery labels are now a dot and a word but still shown on first and last stops; sentence-length labels (invoices detention status) read long in uppercase and need rewording.


## Desk rework, Wave B (done): live addresses and measured miles (Mapbox)
Chris's review: "cities arent autopopulating via mapbox". Decision: a desk-owned server module (no phone-repo edits; the token never reaches the browser). Everything fails soft: with no key or an outage every box is a plain input and the miles are typed.
- **Address boxes suggest places.** One `AddressInput` (ARIA combobox: 250 ms debounce, three characters, a superseded request is cancelled, arrow keys, Enter, Escape) is on the Quote stops, the rate-confirmation review stops, the load edit dialog stops (locked once the schedule is locked) and a truck's home base. Suggestions come from `GET /geo/suggest` (a route handler outside `/api`, so it never queues behind Quote's pricing action) and read "Dallas, TX", "Dallas, TX 75201" or "1600 Pennsylvania Avenue, Lorain, OH 44052"; US and Canada only. The list is drawn on the page body, so no dialog clips it, and it opens upward near the bottom of the screen.
- **Quote measures the road.** Once every stop is something a map can find (900 ms after the route stops changing) `POST /geo/measure` fills the loaded miles and the drive hours for them, each truck's empty miles to the pickup from its own home base, and its empty miles home from the last stop. A delivery followed by a pickup inside the route is empty driving and is counted as empty, never dropped (the phone's rule, `legKinds`/`splitRouteMiles`). Anything typed by hand wins and stays: blanking a box hands it back to the map, typing loaded miles clears the measured hours, typing "empty home" replaces each truck's own. A reopened quote does not re-measure on open.
- **Hours are measured, not 50 mph.** New nullable `loads.estimated_loaded_hours` (migration `20261102000000_loaded_hours`, applied to the demo database only). `driveHoursFor` spreads the loaded leg's hours over every mile at the same speed (the phone's `driveHoursForAllMiles`); a load with no measured hours still uses the flat 50 mph. The verdict, the snapshot and an hourly driver's labour all use it.
- **A booked load carries its own truck's empties.** Booking used to store the form's shared empty-to-pickup/home figures whichever truck was chosen; it now stores that truck's own (measured or typed).
- **Coordinates are stored, from the permanent endpoint only.** After a booked quote, a saved rate confirmation or a load edit, each stop with no coordinates gets its lat/lng from Mapbox's permanent geocoding (suggestions and measuring use the temporary endpoint and store nothing). Six decimal places, never overwrites, never fails the save; a stop whose address was edited loses its old coordinates first.
- **Found and fixed on the way (not Wave B's own):** the shared `Modal` re-ran its autofocus effect on every render because callers pass a fresh `onClose`, so typing in any dialog form (the load edit dialog showed it) bounced focus to the first field after each keystroke. `onClose` is now held in a ref.
- **Seed data:** the three demo trucks are based in Dallas, Houston and Oklahoma City (all were Dallas), so per-truck empties differ.
- Verified: `tsc` and eslint clean; vitest 33 files / 440 tests pass with the database tests (23 in `tests/geo.test.ts`: label condensing, route parsing, the loaded/empty split, the Mapbox URLs and parameters with `fetch` replaced, the lookup memory, soft failure, and `driveHoursFor`; 4 against the database in `tl-waveB.integration.test.ts`: six-place coordinates and no repeat lookup, no key means no coordinates and an unaffected save, the stored hours and their effect on an hourly driver's leftover, and the truck's own empties on a booked load). Live: Dallas to Atlanta measured 783.8 loaded miles and about 11.8 h; per truck the Oklahoma City base was 206 mi from the Dallas pickup, Houston 239.2, Dallas 0, with 849.1, 793.4 and 783.8 home. Browser at 1440 and 1024: suggestions and keyboard pick on Quote, the truck form (list flips upward) and the load edit dialog.
- Not done (next, B2): rate-confirmation time zones are still the Central-states guess in `server/ratecon/map.ts` (wrong in daylight time and outside Central; plan is the phone's `stopTime` plus `tz-lookup`); the EIA fuel price on the cost profile and Quote; the FMCSA MC lookup on load edit, Quote and rate-con review; filling missing printed miles on the rate-confirmation review from the map; stored truck home coordinates. The browser was not walked through the rate-confirmation review for this wave (it uses the same input, and its save calls the same coordinate step, but only the quote-booking path is tested against the database). The Mapbox key's origin (it may be the phone's dev key) is still Chris's call to rotate.

## Desk rework, Wave C0 (done): core load integrity
The functional gaps the audit found in how a load is kept straight, before the module passes. Plan: `~/.claude/plans/cryptic-splashing-bumblebee.md`.
- **A load's money and truck can be corrected.** The edit dialog has a "The deal" section: truck, agreed rate, fuel surcharge (dollars on the load), loaded miles, empty miles to the pickup and home. A truck change needs a truck with a cost profile and a load that has not started (draft or accepted), and refreezes the floor and the other once-only snapshot fields; a started load keeps its truck but its rate and miles can still be corrected; an invoiced load, or one on a driver statement, keeps all of it (what was billed and paid), with the reason said in the dialog. A change to loaded miles clears the measured drive hours (they described the old miles). A per-mile or percent driver is owed dollars that follow the rate and miles: the estimate is recomputed and, if the driver already has the load and the figure moved, they are asked to confirm again. Every figure is in the audit entry, before and after.
- **Delete a load that should never have been entered** (a duplicate, a slip, a practice load): reason from a short list (Other needs a note), soft delete via `deletedAt` (so it leaves the board, planner, alerts, KPI and the driver's calendar through the filters that were already there), its audit stays, and the toast has a 20-second Undo that restores it exactly (the assignment is never removed). Refused for a load on the road, an invoiced one, or one on a statement. It is not a cancellation: a cancelled load is still counted as fell through. The invoice-number index only covers live loads, so a deleted load's numbers are free again.
- **A rate confirmation keeps what it says.** Saving now writes the weight, the notes plus the printed dock terms, the file name (`rate_con_path`), decimal printed miles (the field took whole numbers only), and the document's detention free time and hourly rate as this load's own terms (they win over the truck's profile). A second load with the same number from the same broker (or either broker unnamed) is refused with a link to the existing one and a "Save anyway"; two different named brokers can share a number.
- **The company on the paperwork.** Settings has a Company section (name, MC, DOT, address, phone, billing email, remit-to, payment note; migration `20261103000000_company_and_payment`, nullable columns, demo database only). The invoice prints the company line and address and, until it is paid, a "How to pay" block; the driver statement prints the company line and address. The change is audited with what changed.
- **Payments say when and how.** Mark paid takes the day it came in (Dallas date, never before the invoice or in the future; default today) and how (ACH, check, wire, card, paid by the factor, other); the audit entry and the invoice show both, and undoing the payment clears them.
- **Invoice numbers cannot collide.** The check moved inside the transaction that writes the number, backed by a partial unique index (`workspace, invoice_number` where not deleted); losing the race reads as "already on …", not an error.
- **Quote keeps the broker's paperwork.** New optional Quote fields (broker MC, the broker's own load number, PO, phone, email) go onto the booked load; a typed load number replaces the desk's `QT-` number, otherwise the `QT-` stays.
- **Small fixes:** the dead `invoiceAction` and `markPaidAction` are gone; the assign form no longer guesses 0.65 a mile (the rate is blank until a usual pay or a typed figure) and accepts any step, so 0.051 is fine; the planner lists open loads that have no times in a "No times yet" section instead of dropping them; the "Play the driver" buttons sit behind a "Demo controls" disclosure.
- **Found and fixed on the way:** the schedule check in the edit rule compared stop times to the millisecond while the form holds whole minutes, so any stop time with stray seconds (the seed's) counted as a change: a started load could not be corrected, and a driver was asked to confirm again for a rate that did not move their pay. It now compares to the minute. The seed gave box-truck loads a trailer type of `box_truck` (a vehicle type, not in the trailer list), which made the edit dialog refuse to save any of them; box-truck loads now have no trailer.
- Verified: `tsc` and eslint clean; vitest 35 files / 464 tests pass with the database tests (12 unit in `tests/core-integrity.test.ts`; 12 against the database in `tl-waveC0.integration.test.ts`: the rate/surcharge/miles correction with the driver's percent pay and reconfirm, the truck move refreezing the floor and its refusals, started and invoiced and statement locks, the minute-precision regression, delete and Undo and their refusals, the rate-confirmation save fields and duplicate guard, the company details and invoice, the invoice-number rule at the form and the index, and a payment's date, method and undo). The wave-5 test now saves its sample rate confirmation a second time with `allowDuplicate`. In the browser at 1440 and 1024: Settings > Company (validation, save, and the invoice sheet reading it), the edit dialog's deal section and a save that changed the rate and the truck (floor refroze to the new truck's), Delete and Undo, the Mark paid dialog, and Quote's new fields. The demo database was reseeded afterwards.
- Not done: a list of deleted loads (Undo is the toast only, and an audit row for a deleted load links to a page that no longer opens); a "deleted" reason counted anywhere; statement-level company details beyond the header; the duplicate guard was not walked in the browser (its rate-confirmation review needs a document; the save path is tested); Quote's saved quotes still show the desk's `QT-` number in lists even when a broker number was typed; hourly and set-amount driver pay do not follow a rate change (they were never dollars of the rate).

## Desk rework, Wave C1 (done): Quote, Rate confirmations, Loads, the load drawer and page
Plan: `~/.claude/plans/you-re-taking-over-mid-project-enumerated-dewdrop.md` (C1 of `docs/DESK_REWORK_PLAN.md`). Chris chose C1 before B2.
- **What a truck can carry.** Three more phone modules are vendored (`equipmentDrift`, `oversize`, `loadReadiness`, from the phone at `a3a9c0f4`; `computeCapacityWarnings` was left out because the drift check already covers weight and size). Quote has a "Load details" group: weight, length, width, height, trailer, hazmat class and what it needs (liftgate, ramp, pallet jack), saved with the quote and the booked load. A load heavier or bigger than a truck is rated for blocks that truck: it is priced and listed last with the reason, Book is disabled, and `bookQuote` refuses it on the server. Equipment the truck is not marked as carrying, oversize freight (permits and escorts are not in the verdict) and a hazmat class are warnings under the truck. A load with nothing typed prices exactly as before. Trucks have a "Carries" row (liftgate, ramp, pallet jack; migration `20261104000000_vehicle_equipment`, demo database only); unticked reads as not equipped, as on the phone, so an existing truck warns until it is marked. The seeded trucks now carry real limits (tractors 44,000 lb and 53 ft; the box truck 9,500 lb, 26 ft, with a liftgate and a pallet jack).
- **Quote screen.** The three cards are one ruled form (Route, The deal, Miles, Load details); the broker's paperwork and the load details are groups that open on their own when they hold something; about fifteen hint lines are down to five that earn their place; the Pickup and Delivery chips are plain labels; the verdict is the one hero (46 px, a new `--db-text-hero` token) in the sticky side panel; each fit row has one verdict dot and the reasons sit under the truck, with the Note column gone. A truck's block reads "This truck cannot take it".
- **Pass, and quote like this.** "Pass on it" takes a reason from a short list (Other needs a note) and keeps the quote as a `LoadDecision` of type `passed`; the load stays `status = "quote"`, so it stays out of every list of loads. A quote that was only typed is saved first. Saved quotes show Open or Passed with the reason. `/quote?like=<load id>` starts a quote from any load (lane, broker, trailer, size, miles and offer carry over; its load number, PO and both times do not) and writes nothing; it is on every saved quote and on the load page. A passed quote's audit entry (`quote_passed`) has no link, because a quote has no page.
- **Send readiness.** The load page footer lists what the phone would stop a driver on (weight, load number, pickup number, trailer for a truck that pulls one) plus the two times. A load that lacks something shows "Not ready: still missing ..." with a "Send anyway" button; the server decides, refuses a send without the confirm (`not_ready`) and the audit entry says "Sent to X, without weight". `dispatchLoad` itself is unchanged for every existing caller.
- **Rate confirmations review.** "The load" and "Money and terms" are one section; the role chips are plain labels; the agreed rate is the hero in the side panel; hints that only repeated the field name are gone, and one that was no longer true ("a load has nowhere to keep these yet") is removed.
- **Loads.** Below cost is one signal, the verdict label, plus the "Below cost" tab: the dead row flag (no CSS ever drew it), the red per-mile figure and the duplicate alert dot are gone. A "New load" button opens two doors (price an offer, or read a rate confirmation). The Export CSV link carries the screen it was asked from (view, status tab, below-cost flag, history filter and sort, search), and the file follows it; asked with no view it is every load, as before. Eight columns are appended (Delivered, Invoice number, Invoiced, Invoiced amount, Paid, Expenses, Driver pay estimate, Cancel reason; the first fifteen are unchanged).
- **Load drawer and page.** One hero first (all-in per mile, large, with the dollars and the miles under it; per loaded mile and the floor beside it); sections in work order (needs attention, where it is, driver, trip, stops, invoice, waiting, how it was booked, count every mile, what the driver sees, activity, more); "More" holds change of plans, delete and quote like this together at the end. A new "How it was booked" section shows the stored decision (booked on its numbers, or over a warning and why). Stops show the window close, the contact and the seal. The full page uses the width (main column and a 380 px rail above 1100 px) instead of the 760 px cap, and the head no longer repeats the money.
- **Found and fixed on the way:** React warned about `open={false}` on the new disclosures (passes `undefined` now); `prisma generate` cannot replace the engine while the dev server holds it, so the migration was applied and the server restarted by touching `next.config.mjs` (restored; git shows no change) to load the new client.
- Verified: `tsc` and eslint clean; vitest 38 files / 494 tests pass with the database tests (new: `load-fit` 10, `send-readiness` 6, `quote` +3, and `tl-waveC1.integration.test.ts` 11: equipment saved and audited; a plain load unchanged; weight and size block and sort last; oversize and equipment warnings; booking refuses a blocked truck; specs saved and reopened; pass with its decision and audit and the quote staying off the board; quote like this writing nothing; the send gaps and the audit line; the Loads file following its view, tab and filter). In the browser at 1440 (night): Quote priced live, a 12,000 lb load ruling out the 9,500 lb truck with its reason, the equipment warning on the tractors and not the liftgate truck, Pass with real clicks and its row in Saved quotes, Quote like this, the Loads board and its New load doors, the CSV counts against the board (all 45, open 12, needs a driver 5, below cost 8, history 33, cancelled 3), a finished load's page, a rate confirmation sample, the truck form's Carries row, and Send anyway end to end (assign, then send, then the audit line). At 1024: Quote (no overflow), the drawer (no overflow, section order). Day theme: Quote. Keyboard: Enter on the Load details heading opens it, and the Pass dialog holds focus, disables its button until a reason and closes on Escape. No console errors in a clean tab across Quote, Loads, History, a load page, Rate confirmations and the truck page. The demo database was reseeded afterwards.
- Not done: the full load page was looked at only at 1440 (its single-column fall-back at 1100 px is untested by eye), and the day theme only on Quote; at 1024 the Quote verdict sits below the form (the side panel stops being sticky), so the dispatcher scrolls for it, and a compact bar would fix that; the `sendAction` form action is clicked and its parts are tested, but it has no test of its own; send readiness is on the load page only (the dispatch queue and planner open it); a pass can be undone only by booking or discarding the quote, and passes are not counted anywhere yet (no win and loss figure); there is no blank "new load" form by design; Quote like this is on saved quotes and the load page but not on History rows; the rate-confirmation review was walked with a sample but not saved or sent; the B2 items (time zones, EIA, FMCSA, printed miles, truck home coordinates) are untouched.

## Desk rework, Wave B2 (done): time zones, fuel price, MC lookup, measured miles, truck home points, and "Customer"
Plan: `~/.claude/plans/cryptic-splashing-bumblebee.md` (B2 of `docs/DESK_REWORK_PLAN.md`; groundwork in `docs/HANDOFF_2026-10-29_B2.md`). At plan review Chris added that dispatchers also work with shippers and direct customers, so the desk says **Customer** with a broker as one kind, across the whole desk in this wave.
- **Rate-confirmation times are read in the stop's own zone.** The fixed `-06:00` / `-05:00` guess is gone (it was an hour out for every Central stop from March to November, and read Mountain and Pacific as Eastern). Each stop's zone comes from its coordinates (a temporary Mapbox geocode of the address, never stored, then the phone's `zoneAt` with `tz-lookup`), else its state when the whole state is one zone, else Central, flagged as assumed. The phone's `stopTime`, `appointmentWindow`, `eiaRegion` and `tz-lookup.d.ts` are vendored (the vendor run added only those four files; nothing already vendored changed). Only `instantInZone`, `zoneAt`, `zoneForState`, `stateOfAddress` and `zoneLabel` are used: the phone's `windowFromWall` falls back to the machine's own clock and turns a date-only stop into an all-day window, neither of which the desk does, so the mapper keeps its own "start, end or start" logic and a zone is never null. The desk still shows every time in Dallas time; the review adds "Printed 8:00 AM ET, the time zone at the stop" under any stop outside Central, and a plain note when the zone had to be assumed. `cityState` moved to `lib/city-state.ts` so the screen does not pull `tz-lookup` into the browser bundle.
- **A third demo sample** (Atlanta, GA to Denver, CO; two zones, daylight time, no miles printed) so these paths can be walked; the first two samples are all Texas with miles printed.
- **Customer MC lookup (FMCSA).** `lib/fmcsa.ts` ports the phone's parser and normalisers (their test cases included); `server/fmcsa/lookup.ts` asks the docket-number endpoint with the key as `webKey` (8 s timeout, a clean answer remembered for an hour and a not-found for five minutes, a failure never remembered); `GET /fmcsa/lookup?mc=` is a route handler outside `/api`. The status is a dot and a word (broker authority active, carrier authority only, found with no active authority, no carrier with that MC, lookup unavailable) with the registered name and city under it. It runs when an MC box is left, on Quote, in the load edit dialog and in a new **Customer** group on the rate-confirmation review (which gains an editable MC box), fills the customer's name **only if that box is empty**, is display only (nothing stored, no migration) and never blocks a save. A shipper or direct customer has no MC: the box says "brokers and carriers", a blank asks nothing and says nothing. A rate confirmation saved with "MC 1515" typed used to read "MC MC 1515" on the load; the MC is now saved as digits.
- **Fuel price (EIA).** `lib/eia.ts` (the phone's request and series), `server/fuel/eia.ts` (8 s timeout, six-hour memory, national price when a region has none and says so, a failure never remembered) and `GET /fuel/eia`. On a truck's cost profile a "Today's regional price" button (region from the truck's home base, fuel from the truck) fills the Fuel price box **only on click**, and a box that already holds another number is never replaced silently: both numbers are shown and "Replace" is its own click; the profile still needs its own Save. On Quote a "Fuel price" box (blank means each truck's own) with the same button prices the check on that fuel for diesel trucks; it is **for that check only**: not saved on the quote or the load (a reopened quote prices with each truck's own price, and a booked load is judged on its truck's own), gasoline trucks keep theirs, and the verdict panel says so while it is set.
- **Miles on a rate confirmation that printed none** are measured from the stops the way Quote does it, in the review: `POST /geo/measure` takes `homes: false` so the review does not measure truck bases; a typed figure wins, blanking the box hands it back to the map, a changed stop measures again unless typed, and the box is labelled "Miles" (not "Printed miles") with "Measured on the road" under it.
- **Truck home points are stored.** `vehicles.home_base_lat/lng` (migration `20261105000000_vehicle_home_coordinates`, demo database only), found once from the **permanent** endpoint after a truck save and never failing it, cleared when the address changes, left alone when something else is edited; a measure starts from the stored point, and a truck that has an address but no point (saved before points were kept, or with no map key) is found once on its first measure and kept.
- **"Customer" across the whole desk.** The nav item and page (now `/customers`, with a permanent redirect from `/brokers` and `/brokers/*`, query kept), header search, Quote, the load edit dialog and its audit labels, the load page, the rate-confirmation review, Invoices, KPI and its report, Loads search hints, settlement status words, the Company form hints, invoice and reminder wording, the TONU label, the cancel and reschedule reasons ("Customer cancelled", "Customer asked for a new time"), the pass reason, and three CSV headers ("Broker" → "Customer"; the Customers export file is `truelane-desk-kpi-customers-…`). **Broker stays only where it is the kind**: the FMCSA status words, the MC box's own label and the hint "A broker, shipper or direct customer". A new `tests/customer-wording.test.ts` fails if the word creeps back into visible text. Unchanged on purpose: database columns and TypeScript names (`brokerName`, `brokerMcNumber`, ...), URL query parameters (`?broker=`), the export kind in its URL (`/export/kpi-brokers`), table ids (saved column choices survive), and anything already written: audit entries and quote decisions from before still read "Broker".
- Verified: `tsc` and eslint clean; vitest 45 files / 546 tests pass with the database tests (was 38 / 494): `stop-zones` 14 (July and January Eastern, Central in July where the old guess was an hour out, Pacific, Arizona, a spring-forward gap, boundary places by coordinates, the state and assumed fallbacks, the printed label, the mixed-zone sample, and the geocode call pinned to the temporary endpoint and the `access_token` parameter name), `fmcsa` 12, `eia` 12, `rate-con-miles` 5 (the rule and the route called without trucks: two lookups and one drive, nothing else), `customer-wording` 1, and integration `tl-waveB2` 3 (a typed fuel price moves a diesel truck's fit and not a gasoline truck's, is checked, and is kept nowhere; a mixed-zone rate confirmation saves the right instants, the measured miles and the MC as digits) and `tl-waveB2-home` 5 (the point saved at six places, cleared and re-found when the address moves, a failed lookup leaves the save intact, no key still saves, and the lazy backfill measuring from the stored point without looking the address up again). Six older tests that pinned the old wording were updated. **Live, once, with the real keys** (`scripts/live-b2-check.ts`, never prints a key): Bowman ND and El Paso TX both resolved to Mountain by coordinates and Atlanta to Eastern, three lookups in 0.4 s; EIA Gulf Coast on-highway diesel $5.951 and national $6.352 for the week of Oct 26; FMCSA MC 1515 read as carrier authority only, Greyhound Lines, Dallas TX. In the browser at 1440 (night) with the third sample: the Customer group, 8:00 AM ET stored as 7:00 Dallas time and 1:00 to 4:00 PM MT as 2:00 to 5:00, 1,396.7 miles measured with the document printing none, the MC lookup filling an emptied name, and the review **saved through to a load** (the first time the review has been saved from the browser) whose page shows the right times, miles, the notes, weight and the customer; the cost-profile button asking before replacing a typed $3.90 with $5.95 and filling on its own click; the Quote fuel button filling $5.95 and flipping the Dallas to Atlanta verdict from $35 left over to $375 short (floor $1.39 → $1.62) with the note under the verdict; Quote's MC status; `/brokers?period=all` landing on `/customers?period=all`, and the renamed nav and page. At 1024 (night): Quote, the review and the Customers page have no horizontal overflow and show the new controls. The demo database was reseeded afterwards.
- Not done: the **day theme** was not looked at on any new piece (they use the existing chip and note styles); the typed-miles and re-measure clicks, the edit dialog's MC lookup and a truck save were not clicked in the browser (the miles rule and the truck path are tested; the lookup hook is shared with the two screens that were clicked and has no test of its own); the zone line appears only for a stop outside Central, and a Texas, Florida or other split-state address with no map key reads as assumed Central; times are still shown in Dallas time everywhere (a stop's own clock is shown only as the printed note); the review's measured miles are saved but their drive hours are not (the load falls back to the flat 50 mph until it is quoted); a Quote fuel price is not remembered with a saved quote; a keyboard-only pass and a production build (Wave D); the FMCSA result is not stored, so an inactive authority is seen, not recorded; history still says "Broker" where it was written before the rename, and the CSV header rename is a deliberate break for anything reading those files by header; the master plan's C3 "Broker record" is now a **customer record with a kind (broker, shipper, other)** (updated in `DESK_REWORK_PLAN.md`). Chris's open items are unchanged (margin definition, the flat and percent per-mile reading, key rotation, the Connect gate, pushing).
