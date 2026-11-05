# Dispatch desk audit, 2026-11 (revision 3, 2026-11-05)

**Question:** is the desk fully built, from a 1-truck owner to a 50+ truck fleet, against what the finished owner-operator phone app does for a dispatcher, and is partner infrastructure real where it should be?
**Status of this document:** audit only. **No application code changes until Chris approves it.** Revision 2 replaces the 2026-11-04 text: it is restructured into the four parts requested and brought up to date with what was built locally since (truth pass, driver link desk half, workspace time zone, partner backbone; none pushed).
**Evidence:** code reading, no live browser walk (the walk is still the next step, section 8). **V** = I read the line in this pass. **R** = from the 2026-11-04 code reading and not re-read. Where this revision found an older claim now false, it says so.
**Severity:** P0 broken or false on screen. P1 missing for a 1-10 truck fleet. P2 missing for 10+ trucks. P3 polish. **Effort:** S under a day, M a few days, L a week or more.

---

## 0. What changed since the first audit (so nothing is proposed twice)

| Item from the first audit | Now |
|---|---|
| Load page shelf said "8 of 8 Connected", "$1M Auto Liability" | **Fixed** (V: the string is gone from `load-view.tsx`); the shelf reads real connection state |
| Central-only time | **Fixed** locally: workspace `timezone` (ET/CT/MT/MST/PT/AKT/HST), carrier clock vs display clock vs stop-local clock (`lib/tz.ts`, `lib/zoned.ts`, `server/tl/zone.ts`). Board, Planner and the due list now also show the dock's clock with the carrier's in brackets (built locally, Wave 1; `stopClock`, `BoardRow.pickupZone`). The Dispatch queue rows too. KPI periods, the quote report, statement periods, the offered presets and the statement a delivery lands on now count on the workspace's stored zone, not the display cookie (built locally, Wave 1; tests/money-follows-workspace-zone.test.ts). Still carrier-clock only: typed times and export dates (`exports.ts` reads the display zone) |
| No driver link | **Desk half built, dark**: `server/bridge/{core,transport,outbox,service,retry}.ts`, `Assignment.bridgeDispatchId/bridgeExecutionVersion/bridgeSyncedAt/bridgeError`, `POST /bridge/cron`, `docs/DRIVER_LINK_DESIGN.md`. Switched on per fleet by `workspaces.bridge_org_id` + `drivers.phone_user_id` + three env names. Nothing live until Chris supplies them |
| Per-workspace partner credentials, webhook, sync, failure surface | **Built** (`server/partners/{credentials*,health,webhook*,sync}.ts`, Settings, Integrations; `docs/PARTNER_BACKBONE.md`). **No live company adapter exists** |
| `dataMark` cross-tenant scan | **Fixed** (V: `server/tl/answer-cache.ts` now filters every subquery by workspace) |
| "SAMPLE DATA ONLY" in the shell | Gated (V: `desk-shell.tsx:204` shows it only when `demoLogin`). KPI report and page metadata strings: R, recheck |

Still true and unchanged: no outbound email/SMS/push; no self-serve sign-up; IFTA, tracking and insurance have no store or screen; one driver per load.

---

## 1. Phone-to-desk parity matrix

Status: **Parity**, **Partial**, **Missing**, **n/a** (not a desk job). Phone sources are in the phone repo (`TRUELANE/`).

### 1.1 Quote to booking

| Capability | Mobile source | Desk status | Fix |
|---|---|---|---|
| Verdict: cost floor, take/think/reject, lane benchmark | `lib/domain/calculators.ts`, `evaluateLoad.ts` (vendored as `src/truelane`, with `src/lib/verdict.ts` as the skin's adapter; never edited) | Parity (V: audited rules reused, ruler floor fixed) | n/a |
| Deadhead (pickup, empty-home, after-delivery) | `returnTo` source of truth, home base per truck | Partial: Quote has empty-home and loaded-back; no per-load after-delivery answer on the trip screen | M |
| HOS feasibility | `lib/domain/hos.ts` | Partial: hours deficit costed; ELD hours are a stub, so a live HOS caution is never fresh | M (needs an ELD adapter) |
| Customer terms, MC, factoring-fee prefill | `carrierScorecard.ts`, `lib/fmcsa.ts`, factoring fee per load | **Missing** on Quote (FMCSA lookup exists elsewhere) | M |
| Booking override reason | `lib/overrideReasons.ts`, `load_decisions` | Parity (`LoadDecision`) | n/a |
| Manager-only lift of a Reject | n/a on phone | Missing (needs approvals, section 5) | M |
| Rate-con import (AI reader, review) | `rate-con` flow | Parity (`server/ratecon/*`) | n/a |
| Rebook lane | `lib/calculate/rebook.ts` | Parity ("Quote like this") | n/a |

### 1.2 Load lifecycle and execution

| Capability | Mobile source | Desk status | Fix |
|---|---|---|---|
| Statuses draft/scheduled/accepted/in_progress/completed/cancelled/TONU | `lib/commitStatus.ts` | Parity (`deskStatusOf` maps phone `scheduled`/`dispatched`; `lib/load-state.ts` keeps load and assignment in agreement) | n/a |
| Start Trip checklist, seal at Mark Loaded | `lib/loadReadiness.ts` | Parity (`server/tl/execution.ts` `startTrip`) | n/a |
| Arrival tap, early-arrival advisory | `stops.arrived_at` | Partial: dispatcher types arrival; the driver's tap never arrives until the bridge is on | M (bridge reader exists) |
| GPS breadcrumbs, timeline editor | `lib/domain/gpsTrail.ts`, `RecordedTimeline` | **Missing** (needs tracking/ELD) | L |
| POD per stop, undo, wrap-up | `PodWrapUp`, `lib/podUndo.ts` | Partial: dispatcher uploads; driver upload and `closed_without_pod` flag not received | M |
| Cancel, TONU, reschedule, reopen | `lib/commitStatus.ts`, `tonu_driven_miles` | Parity (`server/tl/disruptions.ts`: `cancelLoad`, `recordTonu`, `rescheduleLoad`, `reopenCancelled`; TONU fee capped by `MAX_TONU_FEE`) | n/a |
| Delete with undo, billing lock | `lib/loadDeletion.ts`, `billingLock.ts` | Parity | n/a |
| Detention, layover, lumper extras | `lib/invoiceCharges.ts` | Parity (`server/tl/detention.ts`: frozen terms, waive, 90-day recovery view) | n/a |
| Multi-stop, per-stop PU#/DEL#, route minimum | stop roles | Parity (`server/tl/edit.ts`) | n/a |
| Route optimizer | `TripRouteOptimizer` | Missing (P3) | L |

### 1.3 Money

| Capability | Mobile source | Desk status | Fix |
|---|---|---|---|
| Invoice readiness, revisions, PDF with POD pages | `lib/invoiceReadiness.ts`, `lib/invoice.ts` | Parity; POD pages in PDF R (recheck) | S |
| Aging, slow-pay, short-pay, broker pay speed | `lib/invoiceChase.ts`, `carrierScorecard.ts` | Parity | n/a |
| Payment reminders | `lib/invoiceReminders.ts` (local notifications) | **Missing**: nothing is delivered; Chase opens the user's client | M (needs a sender) |
| Factoring submission | flag-off | Partial: packet check, manual steps; no adapter | M |
| Tax exclude, tax summary | `lib/taxSummary.ts`, `taxCounts.ts` | Missing (P2/P3 for a dispatch desk) | M |
| Driver settlement | n/a (desk-only) | Built, race-safe; adjustments are typed lines, not a ledger (V: `Settlement.adjustments` JSON) | M |

### 1.4 Fleet, compliance, driver link

| Capability | Mobile source | Desk status | Fix |
|---|---|---|---|
| Compliance dates (CDL, medical, insurance, IFTA-due) | `compliance_dates` (does not sync) | Partial: CDL/medical block assignment; truck insurance, registration, IFTA-due, COI have no alert | M |
| Maintenance log | `maintenance_events` (does not sync) | Missing (P2) | M |
| IFTA quarterly miles by state | `lib/domain/ifta.ts`, `jurisdiction.ts`, `lib/data/jurisdictionBoundaries.ts` (flag off) | **Missing**: stub seam only | L |
| Audit bundle (ledger + receipts + PODs) | `lib/domain/auditBundle.ts` | Missing (CSV exports only) | M |
| Fleet dispatch (inbox, respond, write-back) | `lib/bridgeDispatch.ts`, `dispatchInbox.ts` (parked) | **Desk half built, dark; phone half parked** | switch-on is config + phone flag |
| Plans and billing | Free/Solo/Fleet, RevenueCat, Stripe web | Missing on the desk (no picker, nothing charges) | L |

Rule that binds the desk: never recompute loaded vs driven miles, TONU income, completion date, accept-time snapshots or the additive fuel surcharge by hand; reuse the vendored `loadEconomics`, `evaluateLoad`, `tripScorecard`. Not on the server today (so a desk can never see them without a phone change): `maintenance_events`, `compliance_dates`, the dormant `drivers` table, invoice remit history.

---

## 2. Broken workflow chains

### 2.1 The state machine as the desk actually has it

The desk has **five load statuses** (`draft`, `accepted`, `in_progress`, `completed`, `cancelled`) and **six assignment statuses** (`draft`, `dispatched`, `accepted`, `declined`, `in_progress`, `completed`; V `server/tl/dispatch.ts:26`). "At Pickup", "Loaded", "In Transit", "At Delivery" and "POD Uploaded" are **not states**: they are stop arrival/departure times, a seal number and an attached document. "Paid" belongs to the invoice, "Settled" to a `SettlementLoad` row. The twelve-state ladder in the brief therefore maps like this:

| Brief state | Desk representation | Moves by | Breaks today |
|---|---|---|---|
| Draft / Booked | load `draft` after Book (a quote is not a load) | dispatcher | none |
| Assigned | `Assignment` `draft` | dispatcher (`assignDriver`) | one driver per load (`loadId @unique`) |
| Dispatched | assignment `dispatched` | dispatcher "Send" (`dispatchLoad`) | **records only**: reaches a driver only when the bridge is on (dark) |
| Accepted | assignment + load `accepted` | **driver** (bridge reader) or dispatcher via Demo controls | no driver app yet; bridge reader built, unproven live |
| At Pickup, Loaded, In Transit | stop times, seal, `in_progress` | dispatcher types; driver tap/GPS **never arrive** | execution entered by hand; phone `in_progress` is applied by the bridge reader when on |
| At Delivery, Delivered | stop times; `completed` | dispatcher `completeTrip` | bridge flags `completed`, **does not force it** (by design: desk needs times, proof, costs) |
| POD Uploaded | document on a stop | dispatcher; driver upload not received | 21-day missing-POD alert is the only guard |
| Invoiced | invoice number + revision | dispatcher | invoice-number uniqueness only app-checked (R) |
| Paid | invoice paid/partial/short/write-off | dispatcher; factoring funded/paid manual until a webhook has an adapter | webhook exists (V), no company sends yet |
| Settled | `SettlementLoad` (unique per load) | dispatcher | TONU never auto-paid on a statement (decision taken) |

### 2.2 The end-to-end chain

| Step | State today | Exact break |
|---|---|---|
| Quote, book, assign | Built | customer terms/MC not prefilled; no manager lift of Reject |
| Send to driver | Built desk-side, **dark** | needs `BRIDGE_SUPABASE_URL/SERVICE_KEY`, `BRIDGE_CRON_SECRET`, fleet `bridge_org_id`, driver `phone_user_id`, phone `bridgeDispatch` flag |
| Driver accepts/declines | Demo controls until linked | no company-driver app yet |
| Pickup/delivery/arrival | Dispatcher types | tap/GPS not received; board and Planner now show the dock's clock beside the carrier's |
| POD | Dispatcher uploads | driver upload and `closed_without_pod` not received |
| Messages | Saved on the desk; `deliveredAt` written only when the bridge delivers (messages over the bridge is a listed follow-up) | no delivery or inbound today |
| Reschedule/cancel/edit after Send | Cancel and TONU send a `cancel` row, unassign of a sent load too, a reschedule re-sends the load for confirmation (`dispatch`), an edit sends `update` or `dispatch` (V: `disruptions.ts:57,89,143`, `edit.ts:222`, `dispatch.ts:260`) | none on the desk side; proven only once a driver is linked |
| Invoice, factor, customer pays | Built | factoring funded/paid manual; no company adapter |
| Settle, payroll | Built | `payrollStatus` only reaches `sent`; no paid state; gross pay only |
| IFTA | **None** | no state-miles store, screen or export |
| Anything that needs an outbound message | **None** | no email/SMS/push sender: overdue invoices, expiring CDL/medical/COI, late pickups notify nobody |

### 2.3 Company-driver bridge, web half: checklist

| Piece | Status |
|---|---|
| Outbox queue (assign, route revision, cancel) | Built: transactional outbox, flusher, retry/backoff (`server/bridge/outbox.ts`, `retry.ts`). Table `bridge_outbox` (V: `prisma/schema.prisma`, migration `20261120000000`) |
| Watermark reader for driver status | Built: two version counters, out-of-order and stale answers ignored, answers for cancelled/reassigned flagged not applied (`core.ts`). Phone states: accepted, declined, in_progress, completed. **Arrived / Loaded / Delivered as separate driver states are not in the frozen contract** (see decision 6) |
| POD / document ingestion from the driver | **Missing** (desk uploads exist; bridge ingestion of driver files is not built) |
| Driver messaging with `deliveredAt` | Missing over the bridge (listed follow-up) |
| "Answer for them" when the driver is out of coverage | **Built as the Demo controls** (`recordDriverResponse`, V `dispatch.ts:367`); they must be relabelled "Answer for the driver" and kept for linked drivers too, with an audit line saying who answered |
| Secrets/privacy | Built: driver-safe `load_summary` projection with the confidentiality test; secrets by name only |

---

## 3. Edge-case failure matrix

| Case | Today | Sev | Effort |
|---|---|---|---|
| Two dispatchers race on one load; double-submit | Handled (compare-and-set, `LoadMoved`) | - | - |
| Driver or truck double-booked | Handled (workspace-locked recheck, override reason) | - | - |
| Cancel | Handled (`cancelLoad`, reason required); sends a cancel row to a linked driver | - | - |
| TONU | Handled: fee recorded (cap 100,000), billable as an extra, never auto-paid on a statement. Truck "released": a cancelled load frees the truck by time window, there is no separate availability flag | - | - |
| Reschedule | Handled; a linked driver is re-sent the load and must confirm again (corrected in revision 3: revision 2 said the driver was not told) | - | - |
| Reopen cancelled/delivered, delete, restore | Handled | - | - |
| Detention | Handled: frozen terms, grace minutes per workspace, waive with reason, recovery view. Customer-billable vs driver-payable split: billable yes; **driver detention pay is not separate** (pay follows assignment pay kind) | P2 | M |
| Layover, lumper | Handled as extras (billable); not a driver-pay line | P2 | M |
| Mid-trip breakdown, replacement truck, pay and miles split between two drivers | **Not possible**: `Assignment.loadId` is unique and unassign refuses once started (V `dispatch.ts:246-250`). A breakdown today means cancel/TONU the load or fake it with notes | **P1 for team/relay fleets**, P2 otherwise | L |
| Co-driver, team, relay, slip-seat | Not possible (same constraint) | P1/P2 | L |
| Trailer swap | Trailer registry exists with a trailer on the load (V schema); hook/unhook per stop is not modelled; swap mid-load not modelled | P2 | M |
| Equipment mismatch (53' dry van vs reefer vs box) | `trailerType` is free text on the load; the trailer registry has a free-text `type`; **no check that the trailer matches what the load needs** | P1 | M |
| Reefer: set temp, continuous vs cycle, reefer fuel/hours, temp log | Not modelled | P1 for a reefer fleet | M |
| Box-truck restrictions (weight, length, hazmat) | Fit checks cover size/weight where entered (R); hazmat/tanker/TWIC not checked | P1 | M |
| Driver compliance | CDL and medical block assignment; endorsement, truck insurance, registration, COI expiry do not | P1 | M |
| State-by-state tax (IFTA) | **No store, screen or export** | P1 interstate | L |
| Currency other than USD | Not modelled | P2 | L |
| Customer credit limit, disputes, deductions | Missing | P2 | M |
| Customers matched by name spelling, not id | Open | P1 | M |
| Duplicate load / template / recurring load | Missing | P1 | M |
| Customer or driver merge/delete | Missing | P1 | M |
| Bulk invoice, mark paid, assign, deactivate | Missing | P2 (P1 at ~10 trucks) | M |
| Load / history / customer import | Missing (trucks, drivers, trailers import only) | P1 for migration | L |
| Invoice number uniqueness | App check only (R) | P1 | S |
| Alerts hide older unbilled deliveries | Cap 500 newest (V `alerts.ts:18`); the Alerts screen now says when the cap was reached (built locally, Wave 1) | P1 | S (a true paged read is still open) |
| Accepted-but-never-started past pickup; sent-no-answer | **Flagged already** (V `lib/alerts.ts`: `LATE_TO_PICKUP`, `SENT_NO_ANSWER`; revision 2 was wrong). "Sent, waiting" rows now have a Change driver action (built locally, Wave 1); resend and call are not built (a resend is the bridge retry on the load) | - | - |
| Stale comments saying the desk cannot edit a stop (`lib/quote.ts`, `server/tl/quote.ts`) | Wrong | P3 | S |
| Retention/purge of audit and messages | No policy | P2 | M |

---

## 4. The eight partner shelves

Backbone now built and shared by all of them (V): per-fleet sealed credentials (`DESK_CREDENTIAL_KEY`, AES-256-GCM, only last four characters ever shown), connection states `pending/connected/error/revoked` written, failure counter and backoff 5/15/60 minutes then six hours, signed raw-body inbound webhook with a private per-fleet URL and once-only event record, a cron route (`PARTNER_CRON_SECRET`) running ELD hours every 15 minutes and carrier checks daily, Settings, Integrations panel, call path with claim-before-call and audit. **None of the eight has a live company adapter**; the panel says so. Contract has seven capabilities (`truelane/partners/contract.ts`); insurance is the eighth and is not one.

| # | Vertical | Real now | Missing | Sev / effort |
|---|---|---|---|---|
| 1 | **Factoring** | status columns, packet check, manual steps, factoring status on webhook funding events (`factoringStatusOf`), `FactorPanel`; idempotent webhook record | NOA/schedule/payment event shapes per company; funded amount and fee fields; idempotent payment recording against the invoice; visible failure; adapter | P1 / M (after a company is chosen) |
| 2 | **ELD / telematics** | `eldProvider`, `eldVehicleId`, `hosAvailableHours`, `hosSyncedAt`; scheduled sync; HOS caution on Quote (never moves the verdict) | adapter; UI to link a tractor to an ELD id; Drive/Shift/Cycle clocks (only available hours today); GPS breadcrumb store | P1 / M |
| 3 | **Fuel cards** | provider/account on cost profile; "Import from fuel card" fills an empty fuel box | transaction store (gallons, location, total, discount/gal); settlement deduction; per-state gallons for IFTA; adapter | P1 / M |
| 4 | **Load tracking** | `shareLoadLocation` opt-in flag | schema, share link, ETA/milestone storage, geofence events, adapter; counsel (location sharing) | P2 / L |
| 5 | **Payroll / settlements** | strongest seam: `/payroll` batch up to 200, claim, idempotency, hand-paid block; settlements race-safe with typed adjustments | adapter; paid state; **deduction ledger** (fuel advances, insurance, lease) beyond typed lines; 1099 percent is built, **W2 cents-per-mile is not** (R: confirm) | P1 / M |
| 6 | **Vetting** | driver `carrierMc/Dot`, `vetStatus`, `coiExpiresAt`, manual check; scheduled recheck now runs daily | adapter; **COI-expiry alert rule**; safety score and authority verification fields; customer-level vetting | P1 / M |
| 7 | **IFTA** | `calculateIfta` stub; phone math exists (`ifta.ts`, `jurisdiction.ts`, boundaries) to vendor | state-miles store from routes/GPS, fuel by state, quarter screen, CSV; due-date alert | P1 interstate / L |
| 8 | **Insurance** | nothing (not a capability) | capability, policy and coverage records ($1M auto / $100k cargo as editable minimums, not hardcoded), COI expiry alerts, certificate-request hook | P1 / M |

Counsel is needed before flags flip for factoring and payroll (money) and tracking (location).

---

## 5. Scale, tenancy, roles (small fleet fine; 50+ trucks blocked in places)

**Done well (V):** paging with `skip/take` on trucks, drivers, trailers, settlements, invoices, audit, History; exports page at 1,000 rows with a 25,000 cap; trigram indexes; claim-based concurrency; plan limits inside the writing transaction; **scale tests at 1,500 trucks / 9,000-row exports pass** (`tests/perf`, 9 of 9 on `demo_scale`; one timing flake seen once when run straight after a build); `dataMark` is per workspace.

| Area | Gap | Sev / effort |
|---|---|---|
| Open board | `listBoardRows` reads every open load with includes, no `take` (V `queries.ts:105`); History is paged, so only huge open boards hurt | P2 / M |
| Alerts | 500 cap: the screen now says so; a paged read is open | P2 / M |
| Reads of all rows | `fitQuote`, `rankDrivers`, planner, Customers page, open pickups, `analyticsFor` (unused, a trap) | P2 / M |
| Cache | in-process `Map`; serverless instances do not share it | P2 / M |
| Workspace lock | `lockWorkspace` serialises assignments, imports, plan-limited writes for one tenant | P2 / M |
| Indexes | Customer name, Stop time windows, Driver name/phone search | P2 / S |
| Multi-terminal | `terminal` is free text on trucks and drivers; the scope is a cookie and a view filter, **not a permission**; Alerts and KPI ignore it in places; no Terminal table, manager or time zone per terminal | P2 / L |
| RBAC | four fixed roles, ten capabilities, one grant ("Can also bill"); screens now switch off the controls a role cannot use (`CanGate`, Wave 1, local); no Safety-manager or Executive-viewer role; margins and driver pay visible to all with `read` | P1 (hide refused buttons) / P2 (roles) / M |
| Approvals / overrides | rate change, write-off, pay override, double-book override need only a typed reason; no manager gate on Reject | P2 / L |
| Bulk ops | none beyond imports | P2 / M |
| Multi-workspace users | one user, one workspace; no switcher | P2 / L |
| Sign-in | Clerk built, never run live (`docs/AUTH.md`); no self-serve sign-up, onboarding checklist, plan picker | P1 / L |
| Seats | Starter has one seat (pricing call) | decision |

---

## 6. Prioritized action plan

Status marks: **done (local)** built and tested, unpushed; **open**. Production migrations (`20261120000000`, `20261121000000`, `20261122000000`) are Chris's.

**Wave 1 (P0): dispatch spine and driver link completion**
1. Switch the link on end to end for one test fleet (inputs in section 7) and prove it against the phone's parked half. *Open: needs Chris's inputs and an un-park of the phone flag.*
2. Relabel Demo controls as "Answer for the driver" (kept for linked drivers); audit who answered. *Done (local): the control is labelled for both cases, and the audit line reads "answered for them by the dispatcher" or "on their phone".*
3. Close the lifecycle breaks: apply driver arrival/POD/`closed_without_pod`; Messages over the bridge with `deliveredAt`; `replaced_by_dispatch_id`. Reschedule push and the stuck-load alerts already existed (corrected). *Open, M; each needs a contract decision (section 7, 6).*
4. Remove silent wrong answers: alerts cap (*done, local*), board and Planner stop-local time (*done, local*), role-aware buttons (*done, local: the load page, Dispatch queue, Drivers, Trucks, Trailers, Customers, Rate confirmations, Messages and the three imports switch off what a role cannot use; not walked as a viewer in a browser, since the demo desk is always an admin*). *Open: Settlements/Invoices/Payroll already had their own gates; export dates still on the display zone.*
5. Done (local): honest shelf, demo labels, workspace time zone, dataMark, bridge desk half.

**Wave 2 (P1): partner backbone adapters and inbound webhooks**
1. Pick the first company (decision 3) and make one adapter real end to end: signature header and event shape, idempotent apply, failure surface. *Backbone done (local); adapters open.*
2. Per vertical, in order of value: factoring funded/paid/fee; ELD tractor link + clocks; fuel transactions; vetting COI-expiry alert; insurance capability. *Open.*
3. Counsel before flags flip for money and location.

**Wave 3 (P2): financial edge cases, settlements, IFTA**
1. IFTA store (vendor the phone math), quarter screen, CSV, fuel by state. *Open, L.*
2. Deduction ledger and fuel-card deduction on settlements; payroll paid state; W2 per-mile. *Open, M.*
3. Driver-pay lines for detention/layover; customer disputes/credit limit; tax-exclude; bank-feed reconciliation. *Open.*
4. Mid-trip breakdown and team/relay: replace the one-driver-per-load constraint with ordered legs, pay and miles split per leg. *Open, L (a design doc first).*
5. Reefer and equipment fit: trailer type enum, temperature fields, load-vs-trailer check. *Open, M.*

**Wave 4 (P3): enterprise scaling**
Terminal as a permission (table, manager, per-terminal zone), extra roles (Safety, Billing, Executive viewer), approvals with manager override of Reject, bulk operations, board paging, multi-workspace users, cache that survives serverless, plan picker and billing, onboarding/self-serve, outbound notifications (email first). *Open.*

**Also open from the redesign:** old CSS removal (`desk.css`, `cockpit.css`, `quote-terminal.css`, legacy aliases), `▼` flag column, print/PDF check, viewer-role and day-theme and 1024 screenshot sweeps.

---

## 7. Decisions and inputs needed from Chris

1. Approve this document (no code changes before that).
2. To switch the driver link on: Supabase URL, service key, `BRIDGE_CRON_SECRET`, a test fleet's Clerk organization id and each driver's phone user id, and permission to un-park the phone flag `bridgeDispatch`.
3. Which partner goes live first (factoring, ELD or fuel card) so the backbone is proven against one real company.
4. Set `DESK_CREDENTIAL_KEY` and `PARTNER_CRON_SECRET` on the host; apply the three production migrations.
5. Counsel timing for factoring, payroll and tracking.
6. Driver states: the frozen contract has accepted / declined / in_progress / completed. Do you want finer driver milestones (arrived, loaded, delivered) added to the contract before the company-driver app is built? That is a contract change on both sides.
7. Mid-trip breakdown / team: is a fleet that needs it (P1) in the first customers? That decides whether the multi-leg assignment moves up to Wave 1.
8. Seats on Starter (pricing); percent driver pay, destructive money actions and the Reject hard stop were decided earlier and are unchanged.

---

## 8. Not yet done in this audit

- The live workflow walk (every flow end to end on the demo database at 1440 and 1024, night and day, viewer and dispatcher). This revision is from code; the walk will catch what reading cannot.
- Rows marked **R** were not re-read in this pass.
- UX opinions per module were given in revision 1 and are held until the module passes this audit (Wave 5).
