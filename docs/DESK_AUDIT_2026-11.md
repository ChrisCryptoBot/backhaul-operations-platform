# Dispatch desk audit, 2026-11-04

**Question:** is each desk module fully built, from a 1-truck owner to a 50+ truck fleet, against what the finished phone app already does for a dispatcher, and is partner infrastructure real where it should be?
**Measured against:** a small fleet first (1 to 10 trucks, Starter and Growth plans); mid and enterprise gaps are listed and scheduled second.
**Method:** three read-only code audits (desk status and partner seams; phone capability inventory; scale, roles and edge cases) plus spot checks. Nothing was run in the browser for this pass (the live workflow walks are the next step, see section 9). Claims cite files; "verified" means I read the line myself.
**Severity:** **P0** broken or false on screen. **P1** missing for a 1-10 truck fleet. **P2** missing for 10+ trucks. **P3** polish. **UX** is my honest opinion for after the module is complete.

---

## 1. The five things that matter most

1. **There is no link to the driver.** `server/tl/projector.ts` builds the driver-safe `load_summary` but nothing writes it (verified: no `writeDispatch`, no `bridge.external_dispatch` code on the desk). Send only flips `Assignment.status` to `dispatched` (`server/tl/dispatch.ts`). Accept and decline are "Demo controls" a dispatcher clicks for the driver; pickup, delivery and POD are typed in by the dispatcher; Messages are saved on the desk and `Message.deliveredAt` is never written. **The phone half already exists** (parked behind `fleetMode`): `lib/bridgeDispatch.ts` calls `bridge.respond_to_dispatch`, `lib/domain/dispatchInbox.ts` is the driver inbox that never shows a driver the gross. The contract is frozen (`docs/parked/EXTERNAL_DISPATCH_CONTRACT.md` v2.1, `docs/CONVERGENCE_BUILD_PLAN.md`). The desk writer is the missing half. **P0 for the product.**
2. **The load page shelf says things that are not true.** `components/desk/load-view.tsx` (~906-1050) shows "8 of 8 Fleet Verticals Connected" (hardcoded) and static text ("SYNCED", "VERIFIED", "4h 22m drive time", "$1M Auto Liability"). Nothing is connected; Insurance is not even a capability. **P0** (it is a false statement to a customer).
3. **Time is Central only.** `DESK_TZ` / `DISPLAY_TZ = "America/Chicago"` (`lib/zoned.ts`, `lib/desk-format.ts`, also `lib/alerts.ts`, `lib/invoicing.ts`, `lib/kpi-periods.ts`); every time prints " CT" and typed times are read as Central. An Eastern or Pacific carrier gets wrong windows, aging and month boundaries. **P1** (it breaks the first non-Texas customer).
4. **A customer cannot onboard themselves.** Sign-up only stores a `SignupRequest` ("Accounts are not open in this build yet"); workspaces are made by script (`scripts/provision-enterprise.ts`, `add-member.ts`). No first-run checklist, no sample data for a new workspace, no plan picker or billing, and no loads import (so no migration from another TMS). **P1.**
5. **No outbound anything.** No email, SMS, push or webhook sender exists in the desk. Alerts show only when someone opens the desk; overdue invoices, expiring CDL/medical/COI and late pickups notify nobody. **P1.**

Also true and worth knowing: the workflow chain (quote, book, assign, send, accept, pickup, deliver, POD, invoice, factor, paid, settle, payroll, IFTA) is complete on the desk from **quote to payroll** except the driver's own steps; **IFTA has no desk support at all** (a stub seam only).

---

## 2. Workflow chain, step by step (small-fleet view)

| Step | State | Gap |
|---|---|---|
| Quote (verdict, floor, lane benchmark, capacity checks) | Built | Customer terms and MC not prefilled (P1); keyboard walk skipped Quote |
| Book (reason when advised against) | Built | Hard stop only a manager can lift is a proposal, not built |
| Assign (queue, planner, load; ranked fits; clash checks) | Built | One load has one driver (`Assignment.loadId @unique`): no co-driver, relay, slip-seat, mid-trip swap (P2) |
| Send to driver | **Records only** | No transport (section 1.1) |
| Driver accepts or declines | **Demo controls** | Needs `driver_response` read-back |
| Pickup, delivery, waits, seal | Dispatcher types it | Phone has the "I've arrived" tap (`stops.arrived_at`), GPS trail, timeline; none reach the desk |
| POD | Dispatcher uploads per stop; 21-day missing-POD alert | Driver cannot upload; phone's `closed_without_pod` flag and `pod_override` reason never arrive |
| Invoice (terms, revisions, detention, extras) | Built, audited twice | POD pages inside the invoice PDF: check; no emailing (by design Chase opens the user's client) |
| Factor | Packet check and send exist, adapter stub | Funded and paid are manual until a webhook exists |
| Customer pays (partial, write-off, undo) | Built | No bank-feed reconciliation (P2) |
| Settle driver | Built, race-safe | TONU never auto-paid on a statement (decision taken) |
| Payroll | Seam built, adapter stub | `payrollStatus` only ever `sent`; no paid state |
| IFTA | **None** | No store, screen or export. The phone already has the math (`lib/domain/ifta.ts`, `jurisdiction.ts`, `lib/data/jurisdictionBoundaries.ts`) to vendor |

---

## 3. Phone parity matrix (what a dispatcher needs, what the phone does, what the desk does)

Status: **=** parity, **~** partial, **x** missing, **-** not needed on the desk.

| Area | Phone capability (files) | Desk |
|---|---|---|
| Load lifecycle | draft/scheduled/accepted/in_progress/completed/cancelled/TONU (`lib/commitStatus.ts`); accept never blocks; Start Trip checklist (`lib/loadReadiness.ts`) | = (phone `scheduled`/`dispatched` read as accepted/sent) |
| Booking override reasons | relationship, return_load, cash_flow, other (`lib/overrideReasons.ts`, `load_decisions`) | = (`LoadDecision`, booking-with-reason) |
| Cancel, TONU, reopen | reasons, TONU fee, `tonu_driven_miles` | = |
| Delete with undo | `lib/loadDeletion.ts` | = (soft delete, restore) |
| Billing lock | `lib/domain/billingLock.ts` | = (frozen after invoice or statement) |
| Rebook lane | `lib/calculate/rebook.ts` | = ("Quote like this") |
| Multi-stop, roles, route minimum | stop roles, per-stop PU#/DEL#, route minimum gate | = (edit stops built) ; route minimum = |
| Route optimizer (Pro) | `TripRouteOptimizer` | x (P3) |
| Deadhead / empty-home / after-delivery | `returnTo` source of truth, home base per truck | ~ (Quote has empty home and loaded-back; no per-load after-delivery answer on the trip screen) |
| Rate-con import | AI reader, review sheet, pay-terms/detention parsing | = |
| Seal number | at Mark Loaded | = |
| Arrival tap, early-arrival advisory | `stops.arrived_at` | ~ (desk has per-stop arrival entry; the tap never arrives) |
| Detention | frozen terms at accept, claim sheet for the broker | = (+ recovery view, waive) ; claim sheet PDF/timestamps: check (P2) |
| Layover, TONU, lumper extras | `lib/invoiceCharges.ts` | = |
| GPS breadcrumbs, timeline editor | `lib/domain/gpsTrail.ts`, `RecordedTimeline` | x (needs bridge and tracking; P2) |
| Trip scorecard ($/hr, profit/mi) | `lib/domain/tripScorecard.ts` | = (columns and sorts) |
| Itemised expenses, categories | `constants/expenseCategories.ts` | = (itemised costs); receipts as multiple photos: check |
| POD per stop, undo, wrap-up | `PodWrapUp`, `lib/podUndo.ts` | ~ (upload built; driver side missing) |
| Delivery confirmation PDF, invoice PDF with POD pages | `lib/receipt.ts`, `lib/invoice.ts` | ~ (invoice sheet prints; POD pages and delivery confirmation: check) |
| Audit bundle (ledger CSV + receipts + PODs + rate cons) | `lib/domain/auditBundle.ts` | x (CSV exports only; P2) |
| Invoice readiness, terms, revisions | `lib/invoiceReadiness.ts` | = |
| Payment reminders | local notifications +0/+5/+15 (`lib/invoiceReminders.ts`) | x (Chase opens the user's mail/phone and logs it; nothing automatic; P1) |
| "Were you paid?" prompt | `lib/domain/paidPrompt.ts` | x (P3) |
| Aging, slow-pay, broker pay speed, short-pay | `lib/invoiceChase.ts`, `carrierScorecard.ts` | = |
| Factoring | fee % per load, packet to partner (flag off) | ~ (manual steps; stub adapter) |
| Cost profile and floor (layers A/B/C) | `lib/domain/calculators.ts` | = (vendored, audited) ; floor breakdown not shown on the desk (flagged in handoff) |
| Accept-time snapshots | `snapshot_*` columns | = (floor frozen on delivered loads; History verdict chip still reads live profile, P3) |
| Fuel (EIA, surcharge, price pin) | `lib/eia.ts`, `lib/fuelSurcharge.ts` | = |
| HOS rest costing | `lib/domain/hos.ts` | = (hours deficit); ELD hours stub |
| **IFTA** | quarterly miles by state, due dates (`lib/domain/ifta.ts`; flag off, no screen) | **x (P1 for any carrier that runs interstate; reuse the vendored math)** |
| Tax summary, `tax_excluded` switch | `lib/taxSummary.ts`, `lib/domain/taxCounts.ts` | x (known; P2 for an owner, P3 for a dispatcher desk) |
| Maintenance log | `maintenance_events` (does not sync) | x (P2) |
| Compliance dates | CDL, medical, insurance renewal, IFTA due (`compliance_dates`, does not sync) | ~ (CDL/medical block assignment; truck insurance/registration/IFTA-due: x; no expiry alerts; P1) |
| Lanes, last time on lane, market variance | `lib/domain/lane.ts`, `marketVariance.ts` | = (lane benchmark and bands) |
| Customer scorecard, FMCSA lookup | `carrierScorecard.ts`, `lib/fmcsa.ts` | = |
| Analytics / KPIs | `lib/analytics.ts` | = (desk KPI is richer) |
| Alerts and notifications | local notifications, "Needs attention" | ~ (desk rules engine; no delivery) |
| Offline, sync | WatermelonDB, auto-sync | - |
| Plans and billing | Free/Solo/Fleet, RevenueCat, Stripe web | x on the desk (no plan picker, nothing charges; P1 to sell) |
| Community / market feed | server-side, dark, firewalled | - (must never feed a verdict) |
| Fleet dispatch (inbox, accept, write-back) | `lib/bridgeDispatch.ts`, `dispatchInbox.ts` (parked) | **x: the desk writer (section 1.1)** |

Not on the server today, so a desk can never see them without a phone change: `maintenance_events`, `compliance_dates`, `fuel_surcharge_unit`, the dormant `drivers` table, invoice details and remit history (Clerk metadata), trial clock. Flag-off phone features that already have code: IFTA export, factoring submission, ELD/HOS caution, fuel-card import, last-time-on-lane, broker risk lookup, fleet.

Rule from the phone audit that binds the desk: never recompute loaded vs driven miles, TONU income, completion date, accept-time snapshots or the additive fuel surcharge by hand; reuse `lib/domain/loadEconomics.ts`, `evaluateLoad.ts`, `tripScorecard.ts` (already vendored in `src/truelane`).

---

## 4. Partner infrastructure: what exists, what is mock, what is missing

**Real and good:** the contract (`truelane/partners/contract.ts`, vendored, do not hand-edit); one call path (`server/partners/call.ts`: provider, secrets, workspace connection, adapter; a thrown error becomes `upstream_error`); `PartnerConnection` with audited connect/disconnect (`server/partners/connections.ts`); payroll and factoring claim-before-call, stale-claim recovery, idempotency key, audit; `GET /partners/status`. The phone repo has the matching Edge Functions, one `partner-webhook`, `partner_connections`, `partner_events` (all dark, unapplied).

**Missing for any real integration (all P1 before the first partner goes live):**
1. **Per-workspace credentials.** Keys are one global env set; `PartnerConnection` stores no credential or vault reference. A multi-tenant desk needs per-workspace secrets (encrypted at rest, never returned to the browser).
2. **Inbound webhook receiver on the desk.** None (`applyFactoringUpdate` is ready for one). Blocks factoring funded/paid, payroll paid, tracking, ELD events. Signature scheme per company is an assumption until chosen.
3. **Scheduled sync.** No cron. ELD hours, fuel purchases, vetting rechecks all depend on a click, so HOS cautions go stale.
4. **Failure and retry surface.** `lastError` never written; `pending`/`error` never set; no retry, queue or backoff; no "last synced" display.
5. **Connect flow.** Connecting is refused until the server holds the company's keys; no OAuth, no test-connection button.
6. **Partner plan gating.** Plans limit trucks, seats, storage only.

| Vertical | Real now | Mock or missing |
|---|---|---|
| Factoring | status columns, packet check (invoice required; rate con and POD unless "send anyway"), manual steps, `FactorPanel` on `/invoices/[id]` | adapter, webhook, funded amount and fee fields, visible failure, refresh. The load-page card counts any two documents as "packet ready" |
| ELD / telematics | `eldProvider`, `eldVehicleId`, `hosAvailableHours`, `hosSyncedAt`; manual "Sync hours"; HOS caution on Quote (never changes the verdict) | adapter; no UI to link a tractor to an ELD id; no schedule; Drivers page ignores hours |
| Fuel cards | provider and account on the cost profile; "Import from fuel card" fills an empty fuel box | adapter; no stored transactions, so no reconciliation or per-state gallons for IFTA |
| Load tracking | `shareLoadLocation` (opt-in required) | **no schema, UI, action, share link, ETA storage**; the card is cosmetic |
| Payroll | strongest seam; `/payroll` batch of up to 200; claim, idempotency, hand-paid block | adapter; no paid state; gross pay only, no taxes or deductions |
| Carrier vetting | driver `carrierMc/Dot`, `vetStatus`, `coiExpiresAt`; manual "Check insurance" | adapter; no recheck schedule; **no COI-expiry alert**; no customer-level vetting |
| IFTA | `calculateIfta` stub | **everything**: state-by-state miles store, fuel by state, quarter screen, CSV |
| Insurance | nothing | **not a capability**; policy and COI records, expiry alerts, certificate requests |

Counsel is needed before flags flip for factoring and payroll (money) and tracking (location, opt-in per load).

---

## 5. Scale, tenancy, roles (small fleet fine; enterprise blocked)

**Done well:** paging with `skip/take` on trucks, drivers, trailers, settlements, invoices, audit and History; exports page at 1,000 rows with a 25,000 cap; trigram search indexes; claim-based concurrency (`server/tl/claim.ts`); plan limits enforced inside the writing transaction (`tests/plan-guard.test.ts`).

**Unbounded or risky (P2 unless noted):**
- `listBoardRows` (`server/tl/queries.ts:104`) reads every open load with includes and no `take` (verified); feeds `/dispatch`, `/loads`, lane detail.
- `getAlerts` reads all open loads; the uninvoiced and delivered sets are capped at 500, which hides older ones silently (P1: a wrong silence).
- `fitQuote` reads all trucks with drivers and costs per quote; `rankDrivers`, planner read all drivers; `listCustomerRecords` and the Customers page read all customers; `listOpenPickups` reads all drafts; `analyticsFor` reads every load (nothing calls it today; a trap).
- `dataMark` (`server/tl/answer-cache.ts:9`) runs `max(updated_at)` over `stops`, `assignments` and `cost_profiles` **with no workspace filter** (verified): a cross-tenant table scan on every cached read, and one tenant's writes invalidate every tenant's cache. The cache is an in-process `Map`, so serverless instances do not share it. **P1 before a second real customer.**
- `lockWorkspace` (`for update` on the workspace row) serialises all assignments, imports and plan-limited writes for one tenant.
- Missing indexes: Customer name lookups, Stop time windows, Driver name and phone search.

**Tenancy and roles:**
- One user belongs to one workspace (`Member.clerkUserId` unique); no switcher, no roll-up across workspaces (P2).
- Four fixed roles and ten capabilities; one grant ("Can also bill"). The UI hides few actions (about five `may()` checks), so a viewer or accountant sees buttons the server refuses (P1: that reads as a bug).
- Terminal is free text on trucks and drivers; the scope is a cookie anyone can change, a view filter and not a permission; no Terminal table, no manager, no timezone per terminal (P2). Alerts and KPI ignore it.
- No approvals (rate change, write-off, pay override, double-book override need only a typed reason); no "my loads" view; no per-role field hiding (everyone with `read` sees margins and driver pay) (P2).
- Platform admin is an env var (`DESK_ADMIN_EMAILS`). Sign-in has never run against real Clerk (`docs/AUTH.md`).
- Seats: Starter has one, so a spouse or bookkeeper forces Growth (a pricing call, flagged as a proposal in the code).

---

## 6. Edge cases (small fleet), with status

| Case | Status |
|---|---|
| Two dispatchers race on one load, double-submit | Handled (compare-and-set, `LoadMoved`) |
| Driver or truck double-booked | Handled (workspace-locked recheck, override reason) |
| Partial and short pay, write-off, undo | Handled |
| Edit after invoice or statement | Blocked by design; invoice must be voided first |
| Cancel, TONU, reschedule, reopen, delete, restore | Handled |
| Detention, waive, recovery, frozen terms | Handled |
| Co-driver, team, relay, slip-seat, mid-trip driver change | **Not possible** (`Assignment.loadId` unique; unassign refuses once started) (P2; P1 for a team-driver fleet) |
| Drop-and-hook, per-stop trailer | Not modelled (`trailer_hooked/unhooked` only) (P2) |
| Reefer (set temperature, continuous vs cycle, reefer fuel and hours) | Not modelled; `trailerType` is free text (P1 for a reefer fleet) |
| Hazmat/tanker endorsement, TWIC, truck insurance or registration expiry | Not checked (`driverBlocker` checks CDL and medical only) (P1) |
| Currency other than USD (Canada, Mexico lanes) | Not modelled (no currency column) (P2) |
| Customer credit limit, disputes and deductions | Missing (P2) |
| Duplicate customers (spelling) | Loads match by name, not id (P1) |
| Duplicate load, template, recurring load | Missing (P1: a small fleet runs the same lanes weekly) |
| Customer or driver merge or delete | Missing (P1) |
| Bulk invoice, mark paid, assign, deactivate | Missing (P2; P1 at 10 trucks) |
| Load, history, customer and opening-balance import | Missing; only trucks, drivers, trailers import (P1 for migration) |
| Invoice number uniqueness | Checked in the app, no database unique constraint (P1) |
| Stale comments saying "the desk cannot yet edit a stop" (`lib/quote.ts:483`, `server/tl/quote.ts:866`) | Wrong; `server/tl/edit.ts` edits stops (P3) |
| "SAMPLE DATA ONLY" in the shell (`desk-shell.tsx:191`), KPI report, page metadata | Must be gated for a real customer (P0 the day one onboards) |
| Retention and purge of audit and messages | No policy (P2) |
| Reschedule or cancel of a load already sent to a driver | Desk state changes; the driver is never told (follows from 1.1) |

---

## 7. Module ledger (what to do, in what order)

Order of work is the **spine first**: it is where the product stops being real.

| Order | Module | Complete for 1-10 trucks? | Blocking gaps | Later (P2) |
|---|---|---|---|---|
| 1 | **Loads, drawer, page** | Mostly | Driver link (execution entered by hand); false shelf (section 1.2); Demo controls; dispatcher-typed arrival/POD; reschedule/cancel not delivered to driver; duplicate/template; stale-silence in alerts | trailer shown on board; team/relay |
| 1 | **Dispatch queue** | Mostly | "Sent, waiting" rows have no action (resend, reassign, call); accepted-not-started past pickup is not flagged | drag-reassign |
| 2 | **Messages** | **No** | Saved on the desk only; no delivery, no inbound; no read receipt | attachments policy |
| 2 | **Drivers** | Mostly | Desk Driver to phone user identity (needed for the bridge); expiry alerts (CDL, medical, COI) never notify; endorsements | HOS use; scorecard depth |
| 3 | **Partner backbone** (Settings, Integrations) | **No** | Credentials, webhook, sync, failure/retry, connect flow, honest shelf | plan gating; per-capability counsel gate |
| 3 | **IFTA, Tracking, Insurance** | **No** | No store/screen/capability | exports to filing services |
| 4 | **Quote** | Yes | Customer terms/MC prefill; keyboard walk | quote to rate-con compare; saved lane presets |
| 4 | **Rate confirmations** | Yes | Duplicate guard review; no stated grade | outbound to customer |
| 4 | **Invoices, Settlements, Payroll** | Yes (strongest) | Invoice-number unique constraint; hand-typed factoring until webhook; payroll has no paid state | tax-exclude and tax screens; bank feed; reminders by email |
| 5 | **Trucks, Trailers** | Mostly | ELD link UI; fuel-card transactions; truck insurance/registration/IFTA-due dates; trailers on Loads/Dispatch/Planner; reefer fields | maintenance log |
| 5 | **Customers, Lanes** | Mostly | id-based matching; merge; credit limit | disputes; vetting at customer level |
| 5 | **Planner, Alerts and Rules** | Mostly | Alerts/KPI ignore terminal; silent 500 cap; no notification delivery; COI and ELD-stale rules | rule editor |
| 6 | **KPI, Audit, Settings** | Yes | Settings: plan picker; timezone setting; "Demo" labels | saved views, scheduled exports |
| 0 | **Onboarding and tenancy** | **No** | Self-serve sign-up, first-run checklist, loads import, workspace timezone, role-aware UI (hide what the server refuses) | multi-workspace users, SSO |

---

## 8. UX opinions, per module (honest; build after the module passes its audit)

- **Loads / drawer:** the drawer is now the best surface in the product. Next: make the dispatcher's day visible, not the load's data. A top strip of "needs you now" (unsent, no answer, late, missing POD) above the board, one action per row (the Dispatch queue idea, folded into Loads). Keep J/K and add "next needing me".
- **Dispatch queue:** collapse into Loads as a saved view; two surfaces for the same job is the most common source of "where do I look". Rows need verbs (Resend, Call, Reassign).
- **Quote:** the verdict ticket is right. Reduce the left form to the fields that move the verdict (offer, miles, truck, fuel, market) and fold the rest; show "what would make this an Accept" (the offer needed) as a single line under the ruler.
- **Messages:** one thread per driver is right; add load chips as first-class (already) and quick replies; show delivered/read only once the bridge exists (never imply it before).
- **Planner:** week grid is good for 3 to 15 trucks; add a day mode with a time ruler for dispatchers who think in hours, and a "no driver / double-booked" lane across the top.
- **Invoices / Settlements:** one "money inbox" ordering (ready to invoice, out, late, short, ready to settle) with the next action per row; the aging strip stays. Bulk select once bulk exists.
- **Fleet pages:** a health column (what is missing to make this truck judgeable: mpg, fuel, cost profile, ELD link, insurance date). The desk already says "Can't judge yet"; make that discoverable from the truck list.
- **Customers / Lanes:** one customer page with pay speed, short-pay, lanes, loads, FMCSA authority, and notes; the Lanes page as a market view with your rate vs your own history.
- **KPI:** one hero (Left Over this period) and three drivers of it; charts are fine as the desktop exception; kill any number that has no action.
- **Settings:** an Integrations page that tells the truth per partner (Not connected / Connect / Connected, last sync, last error) is a UX feature as much as an infra one.
- **System-wide:** command line with module codes (QT, LD, DQ + Enter) and j/k row movement are cheap and fit this audience (both are proposals from the redesign, not built); an "as of 10:42" stamp on priced quotes; empty states that say the next step, not "nothing here".

---

## 9. Recommended program (dependencies in order)

**Wave 0, truth pass (days, no new infrastructure):** shelf derived from `PartnerConnection` and real data, "Not connected" design per vertical; gate every "sample data" string behind the demo flag; label Demo controls; fix the cache's cross-tenant `dataMark`; role-aware UI (hide or disable what the server refuses); invoice-number unique constraint; remove the 500 silent cap (page it or say "500+"); workspace timezone setting.

**Wave 1, the driver link (the spine):** `docs/DRIVER_LINK_DESIGN.md` first, then the desk writer against the frozen contract: `writeDispatch` with `assignment_version` compare-and-set, re-offer (in place) and reassign (old row `reassigned`, new row), cancel; a reader that derives board state from `status` + `driver_response.state`; Messages delivery and inbound on the same rail; POD refs and arrival from `driver_response` (replacing dispatcher-typed entries when a driver is connected); Demo controls remain for workspaces with no connected driver. Everything behind a workspace flag until the phone half ships. Needs from Chris: Supabase service-role handling for the desk, the Clerk org to workspace mapping, and the desk Driver to Clerk user mapping.

**Wave 2, partner backbone:** credential store, connect/test UI, webhook receiver, sync runner with retry and a visible failure state, plan gating. Then IFTA (vendor the phone's math; state miles store; quarter screen; CSV), Tracking (opt-in per load; share link), Insurance (capability; policy and COI records; expiry alerts), COI and ELD-stale rules. Counsel before flags flip for money-moving and location-sharing.

**Wave 3, small-fleet completeness (P1 list):** onboarding and sign-up path, loads import, customer ids and merge, duplicate/template/recurring load, delete or merge customer and driver, notifications (email first), compliance dates beyond CDL/medical, reefer fields, accepted-not-started and sent-no-answer rules, quote prefill, plan picker.

**Wave 4, mid and enterprise (P2):** terminal-scoped roles and permissions, approvals and manager override, bulk operations, co-driver and relay, per-terminal timezone, currency, board paging and the unbounded reads, API and webhooks out, multi-workspace users.

**Wave 5, UX per module (section 8),** one module at a time, after it passes this audit.

**Before any wave starts, the live walk (still to do):** drive every flow end to end on the demo DB at 1440 and 1024, night and day, as viewer and dispatcher, recording each break in this document. This audit is from code; the walk will catch what code reading cannot.

---

## 10. Decisions needed from Chris

1. Spine first (Waves 0 and 1) before anything else? (recommended)
2. The driver link: Supabase service-role approach for the desk, Clerk org to workspace mapping, desk Driver to phone user mapping. The phone half is already written and parked; confirm it may be un-parked when the desk writer is ready.
3. First partner to make real (factoring, ELD or fuel card) so the backbone is proven against one real company, not all seven stubs.
4. Percent driver pay, destructive money actions and the Reject hard stop were decided earlier; unchanged.
5. Seats on Starter (one seat forces a spouse or bookkeeper to Growth): a pricing call.
