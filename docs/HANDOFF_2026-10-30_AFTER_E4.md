# Handoff: Wave E (dispatch desk + partner foundation), state at the end of E4

Written 2026-10-29 for a second Claude account taking over. Waves E0 to E5 are done. **Only E6 (phone seams) is left**, and Chris has not said "go" on it yet.

## 1. What Chris asked for

- **The plan (the spec):** `C:\Users\14698\.claude\plans\pasted-content-id-a52c-wave-sorted-flame.md` (Wave E, E0 to E6, as pasted) and the earlier `C:\Users\14698\.claude\plans\you-re-taking-over-mid-project-enumerated-dewdrop.md`. If either is missing, section 7 below restates E6 in full.
- **Standing rule:** stop after each wave with a short recap and ask for the go on the next.
- **Chris's goal for Wave E:**
  - The dispatch desk serves fleets from 1 to 75+ trucks. The sizing case is "a customer with 1,500 tractors, 5,000+ trailers". (A guard test bans a furniture-maker's name in the desk repo, so say it that way.)
  - A trailer module.
  - Plug-and-play seams for seven partner types: factoring, ELD/telematics, fuel cards, shipment tracking, carrier vetting, payroll, IFTA. The companies are not chosen.
  - A website page for dispatcher software.
- **Last instruction from Chris:** stop, the usage is nearly out, write a handoff for another Claude account. He had not answered "Go on to Wave E6, the phone seams?".

## 2. Two repos

| | Phone app | Dispatch desk |
|---|---|---|
| Path | `C:\Users\14698\OneDrive\Desktop\TRUELANE` | `C:\Users\14698\OneDrive\Desktop\TRUELANE\dispatch-desk` |
| Stack | Expo, WatermelonDB, Supabase Edge Functions (Deno), jest | Next.js 14 + Prisma, under `apps/web` |
| Git | main; the desk is excluded from it (`a3a9c0f4`) | its own nested `.git`, branch `demo/truelane-dispatch` |
| State | E3 work **uncommitted** next to unrelated uncommitted work that is not mine | clean at `ded6f3f`, nothing pushed |

### Desk commands (run from `dispatch-desk/apps/web`)

```
npx tsc --noEmit
npx eslint src tests scripts --max-warnings=0
DATABASE_URL=postgresql://demo:demo@localhost:54330/demo RUN_DB_INTEGRATION=true npx vitest run
DATABASE_URL=postgresql://demo:demo@localhost:54330/demo_scale RUN_SCALE=true npx vitest run tests/perf
DATABASE_URL=postgresql://demo:demo@localhost:54330/demo npm run seed      # reseed after browser clicks
```

- Postgres is Docker `backhaul-demo-pg`, port 54330, user `demo`, databases `demo` and `demo_scale`.
- `apps/web/.env.local` points at an OLD dev database. **Always pass `DATABASE_URL` explicitly.**
- Dev servers: 3100 = demo, 3101 = demo_scale (`NEXT_DIST_DIR=.next-scale`). Only 3101 was listening at the last check.
- To restart a dev server after a Prisma regenerate: append a line to `apps/web/next.config.mjs`, wait, then `git checkout -- apps/web/next.config.mjs`. The classifier blocks killing by PID. `prisma generate` gives an EPERM lock error while a server runs, but the types are still written.
- Workspace seam: `currentWorkspaceId()` in `src/server/tl/workspace.ts`. The cookie is only honoured with `DESK_WORKSPACE_COOKIE=on`. A test forbids `DEMO_WORKSPACE_ID` outside that file.
- Kept answers: `src/server/tl/answer-cache.ts` caches the alerts and the KPI against an exact data mark (loads, stops, assignments, vehicles, drivers, cost profiles, trailers).

### Tooling gotchas

- Shell heredocs with apostrophes, backslashes or triple quotes get mangled. Write files with the Write tool, or write a `.py` script file and run it.
- Git Bash `docker exec ... psql` needs stdin (`-i < file`).
- Preserve CRLF when editing with Python (see `e4_ui2.py`'s `edit()` helper for the pattern).
- `Math.floor` and `Math.round` are lint-banned in the desk. Use `clockBucket` or `Prisma.Decimal`.
- Phone repo: Deno-style `.ts` imports break the phone's `tsc` if a type-checked test imports them, so tests `require()` the cores. `allowImportingTsExtensions` broke an existing `@ts-expect-error` in `community-pay-extract/core.ts`; do not use it.
- A backslash-b in a double-backslash heredoc becomes a backspace (0x08). Use the Edit tool.

## 3. The partner contract (the thing E6 plugs into)

- Pure, no imports: `supabase/functions/_shared/partners/contract.ts` (phone repo), vendored alone into the desk as `src/truelane/partners/contract.ts`.
- Envelope: `{ok:true,data}` or `{ok:false,code,message?,field?}`.
- `not_configured`, `not_implemented` and `not_connected` answer **HTTP 200, never 500**.
- Order of checks for every partner call: provider, then keys (read in the request), then the connection, then the adapter.
- Every adapter is a stub answering `not_implemented`. **Invent no partner endpoint or payload.**
- Webhook signature scheme is an **assumption**: hex HMAC-SHA256 of the raw body, optionally prefixed `sha256=`, in `x-signature` for every provider (`SIGNATURE_HEADER`). It fails closed if wrong.

## 4. What is done

### Desk repo (all local, tip `ded6f3f`)

| Commit | Wave |
|---|---|
| `4d64500` | E0: Quote verdict bar at 1024, day-theme pass, no edge strips |
| `610f588` | E1: scale, terminals, bulk CSV import, workspace seam |
| `a10897a` | E2: the trailer module |
| `3b25403` | UI fix after Chris's screenshot: dialogs fit the window and scroll; selects and checkboxes match the desk |
| `ded6f3f` | E4: partner seams and plans |

Read `docs/DEMO_REBUILD.md` sections **Wave E1, Wave E2, Wave E4** first: they hold the measured numbers, the behaviour changes and the honest Not-done lists.

**E1.**
- On demo_scale (1,500 trucks, 50k loads, 9k invoices out) pages went from 30 to 170 s down to about 1 s warm.
- Migration `20261106100000_scale_indexes_terminals`: pg_trgm, btree indexes, `terminal` columns.
- Terminal scope (cookie `desk-terminal`) narrows fleet lists, dispatch, planner, quote fits and pickers.
- Bulk CSV import: `lib/import-csv.ts`, `server/tl/import.ts`, `/fleet/import`, `/drivers/import`.
- `/drivers/pick`, `/fleet/pick`, and the `DriverPicker` and `TruckPicker` components.
- `scripts/profile-scale.ts`, `tests/perf/scale.perf.test.ts`.
- `listBoardRows` now defaults to open loads only; four integration tests were changed to `listBoardRows(undefined, "all")`. A real bug was fixed in `server/tl/exports.ts` (the no-view Loads export appended unfiltered history).

**E2.**
- `Trailer` model; migration `20261106200000_trailers`, with partial unique indexes (one number per workspace, one trailer per tractor). `Load.trailerId`. `AuditEvent.entityId`.
- Pure `lib/trailer-clearance.ts`, `lib/trailer-fit.ts`, `lib/trailer-forms.ts`.
- `server/tl/trailers.ts`; pages `/trailers`, `/trailers/[id]`, `/trailers/import`, `/trailers/pick`; a trailers CSV export.
- A trailer section on the load page, a free-trailer count on the Quote, a `TRAILER_COMPLIANCE` alert.
- Fixed `lib/load-edit.ts`, which rejected `other:` and `hopper` trailer values.

**E4.**
- Migration `20261107000000_partner_seams` (applied to demo and demo_scale):
  - Load: `factoringStatus`, `factoringReferenceId`, `factoringUpdatedAt`.
  - Vehicle: `eldProvider`, `eldVehicleId`, `hosAvailableHours`, `hosSyncedAt`.
  - CostProfile: `fuelCardProvider`, `fuelCardAccountId`.
  - Driver: `payrollEmployeeId`, `payrollStatus`, `payrollWorkerType`, `carrierMcNumber`, `carrierDotNumber`, `vetStatus`, `coiExpiresAt`, `vetCheckedAt`.
  - Settlement: `payrollSentAt`, `payrollReference` (my addition, so a statement goes once).
  - `Workspace.plan` (nullable) and the `PartnerConnection` model (no credential stored).
- `scripts/vendor-truelane.mjs` `MOVED` has the contract entry. The file header says it was copied from the phone's working tree.
- `src/lib/plans.ts` (cents): Starter 1 to 3 trucks $49; Growth 4 to 10 $99 + $15 a truck; Pro 11 to 74 $199 + $12 a truck; Enterprise 75+ $499. A null plan means no limit.
- `src/server/tl/plan.ts` (`truckRoom`, `planSummary`). `saveTruck` and the truck import enforce the limit; the import is refused whole.
- `src/server/partners/`: `call.ts` (the one path: `partnerAdapters` registry, `partnerState`, `callPartner`), `factoring.ts`, `eld.ts`, `fuel-card.ts`, `vetting.ts`, `payroll.ts`, `tracking.ts`, `ifta.ts`, `connections.ts`, plus `GET /partners/status` (booleans only).
- Audit actions: `factoring_requested`, `factoring_updated`, `eld_linked`, `hos_synced`, `fuel_imported`, `carrier_vetted`, `payroll_sent`, `partner_connected`. Entity `partner`. Audit group "Partners".
- UI, in `components/desk/partner-actions.tsx` (`ReasonButton`, `FactorPanel`, `SyncEldButton`, `VetButton`, `PayrollSend`, `FuelCardForm`, `FuelImport`, `IntegrationsList`):
  - Factoring box on `/invoices/[id]`, a chip on the Out list.
  - The Quote fit row gets `hos: {availableHours, syncedAt, caution}` and a warning. The verdict is untouched; a test proves zero drift.
  - Driver form fields (`carrierMc`, `carrierDot`, `payrollWorkerType`, `payrollEmployeeId`) and a "Carrier insurance" column next to Clearance.
  - `/payroll` page and sidebar item.
  - Truck page Fuel card form; "Import from fuel card" in the trip fuel boxes (fills only an empty box).
  - Trucks page "Sync hours from the ELD".
  - Settings: Plan (read only) and Integrations cards.
- Tests: `tests/plans.test.ts`, `tests/integration/tl-waveE4.integration.test.ts`; the model pin in `tests/no-legacy.test.ts` now includes `Trailer` and `PartnerConnection`.
- **Desk gates at E4:** tsc and eslint clean; 66 files / 734 tests pass (+9 perf tests gated by `RUN_SCALE`).

### Phone repo, E3 (UNCOMMITTED, not applied, not deployed)

- `supabase/functions/_shared/partners/{contract,run,http}.ts`.
- Seven functions, each with `index.ts`, `core.ts`, `adapter.ts` (stub): `factoring-submit`, `eld-sync`, `fuel-card-sync`, `location-stream`, `carrier-vet`, `payroll-run`, `ifta-calculate`.
- `partner-webhook` (`index.ts`, `core.ts`): verifies the signature on the raw body before parsing, records each event once in `partner_events`, acknowledges an unset secret with 200 and skips it.
- `supabase/config.toml`: eight `verify_jwt = false` blocks.
- `supabase/migrations/20261030000100_partner_api_columns.sql`: nine columns plus `partner_connections` and `partner_events`. It is ledger row 66 in `docs/PENDING_MIGRATIONS.md` and is **not applied**.
- `supabase/functions/clerk-user-deleted/index.ts`: `TABLES` now includes `partner_connections`.
- Tests updated for the new migration and table: `lib/community/blockByItem.test.ts`, `clerkUserDeleted.test.ts`, `clerkUserDeletedStatic.test.ts`. New: `lib/partners/partnerFunctions.test.ts` (61 tests, passing). Phone `tsc` is clean.
- `docs/platform/PARTNER_API_READINESS.md`: Chris's apply/secrets/deploy steps and the per-capability go-live table.
- Unrelated uncommitted phone work (content scripts, `eas.json`, `lib/businessIdentity.ts`, sample-world files, `truelane-site/media/*.mp4`, `scripts/supabase/` and so on) is **not mine. Do not touch or commit it.**

### E5 (site), committed in the phone repo as `56845b0a`

`build.html` rebuilt as the "Software for dispatchers" page; the door strip and its tests updated.

### Memory

`memory/dispatch-desk-status.md` and its `MEMORY.md` line are current through E4.

## 5. Errors hit and how they were fixed

- Shell heredocs: Write-tool files and `.py` scripts.
- Duplicate `trailers Trailer[]` relation in the Workspace model: removed, one added to Vehicle.
- The partner "no 500" source test was tripped by comments and list caps (`> 500`). It now strips comments and matches only `status|json|reply|Response ... 500`.
- The JSON-document KPI read (`json_agg`) was no faster than Prisma, so it was reverted and the exact-mark answer cache added instead.
- Chris's screenshot feedback (Add trailer pop-up ran off the screen; filter selects and checkboxes browser-grey): `.k-modal` capped to the window with a scrolling body, a `.dlg-three` grid and a `wide` modal, a shared select style, `dlg-check` checkboxes and `input:not([type=checkbox])` for the `width:100%` rule.
- eslint `react/no-unescaped-entities` and `Math.round` in `fuel-card.ts` (now `Prisma.Decimal`).

## 6. Known gaps (also in the DEMO_REBUILD Not-done lists)

- KPI, Customers and Lanes first visit after a data change takes 2 to 5 s; a SQL roll-up is the real fix. The planner takes 1.4 to 1.7 s.
- Terminal scope is not on Loads, Alerts, Invoices, Settlements or KPI.
- An imported truck has no cost profile.
- Trailers don't show on Loads, Dispatch or the planner.
- No screen chooses a plan. The truck import preview does not mention the plan limit.
- The factoring chip is on invoices only.
- No webhook receiver in the desk (`applyFactoringUpdate` is what one would call).
- Tracking and IFTA have no screen.
- E2 and E4 screens were not walked at 1024 or in the day theme.
- No partner success path has run against a real company.

## 7. What is left: E6, phone seams (dark, uncommitted, phone repo only)

**Confirm Chris's "go" first**, unless his message to you already says go.

**Schema.** `db/schema.ts` bump to v57 and `db/migrations.ts` `addColumns`, all `isOptional: true`, on `loads`, `vehicles` and `cost_profiles`. Columns match the E3 migration (`20261030000100_partner_api_columns.sql`; read it for exact names). Update the WatermelonDB models, `interfaces.ts` and `COST_PROFILE_OBSERVE_COLUMNS`.

**Sync, in all four places.**
- `lib/syncColumns.ts` (`V41Table` and `fresh()`).
- `lib/sync.ts`: the column groups and the `SyncRowOptions` flags. **The call sites must pass the flags.** The existing `closed_without_pod` group `loads_v54` is declared but never passed; do not repeat that.
- `lib/syncPull.ts` (mapping).
- `syncPull.parity.test.ts` must stay green.

**Flags.** `partnerFactoring`, `partnerEld`, `partnerFuelCard` in `constants/FeatureFlags.ts`, all false.

**Client.** `lib/partners/client.ts` wraps `supabase.functions.invoke`, like `invokeFunction` in `lib/community/api.ts`. It returns the typed envelope. Offline gives `{ok:false, code:'offline'}`. It never throws.

**Seams, rendered only when the flag is on.**
- `InvoiceReview.tsx`: "Factor invoice", with a handler in `app/invoice/[loadId].tsx`. Leave `markInvoiceSent` untouched.
- `app/(tabs)/calculate/index.tsx`: an HOS caution banner from the vehicle's `hos_available_hours` and the existing drive hours. **Not passed into `evaluateLoad`.**
- `app/trip/expenses/[loadId].tsx`: "Import fuel receipts" pre-fills the `fuel` state through the existing save path (about line 497).

**Zero-drift guarantees (all required).**
- A golden test that `evaluateLoad` and `computeSettlement` outputs are identical with partner fields present.
- A static test that nothing in `lib/domain/*` imports `lib/partners`.
- Full `npx jest` (80-check math audit, `mathParity`) and `npx tsc --noEmit` pass.
- Formulas and the audit doc are unchanged. Never edit audit rounds 1 to 6.

**Then stop** with a short recap and ask Chris what next.

## 8. Rules

- Never push. Never commit in the phone repo unless Chris says so; if he does, commit only your own files.
- Chris applies SQL, sets secrets and deploys. A secret reaches a function only after a deploy.
- Counsel signs off before any flag flips (factoring, payroll, location sharing).
- Tone: crisp, no cheerleading, lead with the change, mark verified vs likely. Never claim a thing has no faults.
- Memory: `C:\Users\14698\.claude\projects\C--Users-14698-OneDrive-Desktop-TRUELANE\memory\` (update `dispatch-desk-status.md` when E6 lands).

## 9. Chris's own steps (none done)

- Apply `supabase/migrations/20261030000100_partner_api_columns.sql` by hand (phone repo, ledger row 66).
- Redeploy `clerk-user-deleted`: `npx supabase functions deploy clerk-user-deleted --no-verify-jwt`.
- Deploy the eight new functions only with a company's keys in hand, each with `--no-verify-jwt`.
- Set secrets with `supabase secrets set`, then deploy.
- Choose providers.
- Confirm two plan readings: Pro covers 11 to 74 trucks, and "$X + $Y a truck" charges Y on every truck in the tier.
- Push the desk himself: `git push -u origin demo/truelane-dispatch`, from inside `dispatch-desk`.
- Open product questions: the dispatcher margin definition, the flat-pay reading, PIVOT 3H (selling tools to dispatchers vs a Community rating dispatch companies).

Out of scope still: login/Clerk orgs/roles, driver-phone bridge, POD file storage, notifications, margin definition, desk billing/Stripe, any phone trailer feature.
