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

## Moved to Stage 2 on purpose
These are coupled to the schema and ingestion rewrite, so doing them first would mean touching everything twice:
- Region dimension and employer vocabulary (Region, RegionConfig, UserRegionRole, `runInRegionScope`, MG/TMW, MileMax,
  Carlisle, Leesport, Sealed Air, "Drop Bucket", relay/drop-lot terms). `WeekSnapshot`, `snapshots.ts` and `lane-week-*`
  stay (the KPI dashboard needs them), re-keyed to one demo workspace.
- AWS S3/SQS and the cron queue (replaced by local upload and synchronous parse), together with the old `server/llm/*`
  layer, `LlmProviderConfig` and `@anthropic-ai/sdk` (replaced by the TrueLane-schema rate-con reader).
- Live DAT client and `DatProviderConfig` (mock variance stays), FSC table, route and tool.
- Clerk replaced by a `DEMO_MODE` session behind an `auth()` seam.

## Next
Stage 4: retire the old board, KPI, reference, review and settings pages and server code (and the old tables), make the desk
the root route, then the final greps and a full browser walk.
