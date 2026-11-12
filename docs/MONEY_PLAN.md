# Money modules: hardening and partner plug-and-play (plan approved 2026-11-12)

## Context
Chris wants the Desk's money side (Invoices, Settlements, Payroll, Fuel, IFTA, Leak ledger, Data health, Why it moved, KPI) robust, complete end to end, and ready so that the day a factoring company, accounting system, fuel card, payroll or ELD partner hands over API access, it plugs in and the Desk gets full value from it. This is the pitch to partners and to carriers, so it has to hold up under a real company's data.

Decisions taken with Chris (2026-11-12):
- **A real Invoice record** replaces "invoice fields on the load" (multi-load invoices, credit memos, clean partner sync).
- **Factoring is the first partner made fully plug-and-play.**
- **Accounting sync, QuickBooks Online first**, becomes a new partner capability.
- **Full plan, built in waves**, tests after each wave.

## What exists today (verified in code)
- **Partner backbone is strong** (`docs/PARTNER_BACKBONE.md`): sealed per-fleet keys (AES-256-GCM, rotation), connection health with backoff, signed inbound webhooks with event-id dedupe (`partner_events`), cron sync, a three-layer adapter design (client / normalizer / adapter, `server/partners/adapters/types.ts`), and a sandbox simulator per shelf (`sandbox_` keys). Seven capabilities from the vendored phone contract: factoring, eld, fuel_card, tracking, vetting, payroll, ifta. No live endpoint anywhere (by design).
- **Invoices**: fields on `Load` (`invoiceNumber`, `invoiceLines` JSON, `invoicedAmount`, `invoicedAt`, `paidAt`, `paidAmount`, `writeOffAmount`, `factoringStatus`, ...) plus `LoadPayment` rows (amount, date, method). Flow in `server/tl/invoicing.ts` (`invoiceLoad`, `markLoadPaid`, `voidInvoice` with revision numbers, `undoPaid`, `recordChase`), readiness and validation in `lib/invoicing.ts`, aging in `server/tl/aging.ts`, one gross in `lib/load-gross.ts`, `lib/billed.ts`, `lib/money-state.ts`. Print sheet at `invoices/[id]`. 44 source files read the load's invoice fields.
- **Settlements**: `Settlement` with `lines`/`adjustments`/`fuel` as JSON, compare-and-set guards, atomic numbering, fuel deduction (`server/tl/settlement.ts`, `lib/settlement.ts`).
- **Payroll**: finalized statements sent as a batch (`server/partners/payroll.ts`, Gusto-shaped), keyed by statement, paid by webhook.
- **Fuel**: `fuel_transactions` store, dedupe by provider and external id, link to load/statement (`server/partners/fuel-store.ts`, WEX-shaped adapter).
- **IFTA**: `calculateIfta` sends completed loads' **loaded miles** with an mpg estimate to a ProMiles-shaped adapter; stores miles and gallons by state (`ifta_lines`).
- **Analytics**: Leak ledger, Data health, Why it moved, KPI are built and documented (`docs/LEAK_LEDGER.md`, `DATA_HEALTH.md`, `WHY_IT_MOVED.md`).
- Roles: four roles and capabilities (`lib/roles.ts`), audit log (`AuditEvent`, `recordAudit`), money as `Decimal(12,2)`.

## Research: what the partners' systems actually do
- **Factoring (TriumphPay, RTS, OTR and others)**: most carrier-side integrations are **batch files, not a REST API**: an invoice CSV ("schedule of accounts") plus one combined PDF packet per invoice (invoice, rate con, signed POD, BOL), sent by FTP/SFTP or email, every few minutes; status comes back through the factor's portal or a returned file. Some (TriumphPay for brokers) also have API/portal flows. Economics a carrier must track: advance %, fee, reserve held and released, recourse chargebacks. [Alvys](https://docs.alvys.com/help/integrations/triumph-business-capital-factoring-integration), [TAI](https://learn.tai-software.com/knowledge/triumph-pay), [Rose Rocket](https://www.roserocket.com/integrations/triumphpay)
- **ELD (Motive)**: `v1/ifta/trips` (per-trip miles by jurisdiction, calibrated odometers), `v1/ifta/summary` (miles by state per vehicle), `v1/fuel_purchases` (type `ifta`). OAuth bearer. [Motive IFTA trips](https://developer.gomotive.com/reference/fetch-a-list-of-companys-ifta-trip-reports), [fuel purchases](https://developer-docs.gomotive.com/reference/fetch-all-the-fuel-purchases-of-your-company)
- **IFTA tax rates**: IFTA, Inc. publishes the quarterly rate matrix (rates and surcharges per jurisdiction; provisional until final). [iftach.org matrix](https://www.iftach.org/taxmatrix4/)
- **Fuel cards (AtoB, WEX)**: AtoB has a partner API with Standard-Webhooks HMAC events and a sandbox; transactions post after settlement (not pending or declined). [AtoB docs](https://docs.atob.com/), [Fleetio + AtoB](https://help.fleetio.com//fuel/atob-fuel-card-integration)
- **Accounting (QuickBooks Online)**: entities Customer, Invoice (needs CustomerRef plus lines), Payment (customer receipts), Vendor, Bill and BillPayment (driver pay, fuel, factoring fees); change webhooks; check for existing records before creating. [Intuit request format](https://developer.intuit.com/app/developer/qbo/docs/get-started/create-a-request)
- **Payroll (Gusto Embedded, Check)**: contractor payments (direct deposit, check), 1099 onboarding and year-end filing; Check is the more white-label option. [Gusto contractor payments](https://docs.gusto.com/embedded-payroll/docs/process-contractor-payments)

## What each money module should do, and what is missing
Sizes: **S** = under a day, **M** = 1 to 3 days, **L** = a week or more.

### Invoices (target: an accounts-receivable system a factor and an accountant trust)
| Gap | Size |
|---|---|
| Real `Invoice` + `InvoiceLine` + `InvoicePayment` records, multi-load invoices, backfill from loads, one write path | L |
| Credit memos and adjustments (not only void and reissue) | M |
| Payment references (check or ACH number, remittance note, payer), partial payments linked to an invoice, unapplied cash | M |
| Short-pay reason codes (quick-pay fee, factor fee, deduction, damage) instead of free text only | S |
| Invoice PDF file generated server side (today: browser print), needed for factoring packets and email | M |
| Invoice delivery by email from the Desk (optional; today mailto only) | M |
| Customer credit fields (credit limit, broker credit score, days to pay), warn before booking | M |
| Accessorial catalog (detention, lumper, layover, TONU, stop-off) so lines are typed, not free labels | S |

### Factoring (first plug-and-play partner)
| Gap | Size |
|---|---|
| Two transports behind one adapter: **API** (exists, Triumph-shaped) and **batch** (schedule-of-accounts CSV + combined PDF packet per invoice, delivered by SFTP or email) | L |
| Packet builder: one PDF per invoice, in the factor's required order, from `LoadDocument` (rate con, POD, BOL), with missing-document blocking | M |
| Factoring economics per invoice: advance %, fee, reserve held/released, recourse and chargebacks, net funded | M |
| Status from returned files or portal exports (import a factor's status CSV), not only webhooks | M |
| Notice of assignment: invoice remit-to switches to the factor when an invoice is factored | S |
| Reconciliation view: submitted vs funded vs paid by the broker vs reserve released | M |

### Accounting sync (new capability, QuickBooks Online first)
| Gap | Size |
|---|---|
| New `accounting` capability (needs the phone repo's `contract.ts` changed and re-vendored) | S |
| OAuth connect flow (Intuit uses OAuth 2 with refresh tokens; today's backbone stores static keys) | M |
| External-id map table (desk record to partner record) used by every sync, with sync cursors | M |
| Push: customers, invoices, payments, credit memos; statements as Bills to the driver as vendor; fuel and factoring fees as Bills or expenses; account mapping screen | L |
| Pull: payments recorded in QuickBooks flow back, by change webhook plus a nightly poll | M |
| Journal CSV export as the fallback for any other accounting system | S |

### Settlements and Payroll
| Gap | Size |
|---|---|
| Normalized statement lines (today JSON) so payroll, accounting and reports read typed rows | M |
| Recurring deductions (truck lease, insurance, ELD, escrow) with balances, and advances repaid over time | M |
| Escrow account per owner-operator with balance and release | M |
| Driver tax profile (W-2 vs 1099, TIN collected and verified) and year-end 1099 totals | M |
| Payroll status poll and reconciliation (the backbone notes missed webhooks are not caught) | M |
| Driver-facing statement PDF and delivery | S |

### Fuel
| Gap | Size |
|---|---|
| Fuel by state (purchase jurisdiction) stored for IFTA tax-paid credit | S |
| Pending vs settled vs declined purchases (store only settled; mark voids) | S |
| Fraud and exception flags: purchase far from the truck's position, over tank capacity, off-route, after hours | M |
| Reefer and DEF fuel kept separate (not IFTA-taxable motor fuel) | S |
| Fuel CSV import for fleets with no card API | S |

### IFTA (today's numbers are not usable for a filing)
| Gap | Size |
|---|---|
| **Uses loaded miles only; IFTA needs every mile driven, empty miles included.** Switch the source to ELD jurisdiction miles (Motive `ifta/summary`) and fall back to routed all-miles | M |
| Gallons estimated by mpg instead of purchased gallons by state | S |
| Quarterly tax-rate matrix (stored per quarter, provisional vs final) and the return: taxable gallons, tax paid, net due or credit per state | M |
| Per-vehicle detail and audit trail (odometers, trips) for an audit | M |
| Filing deadlines and reminders | S |

### Leak ledger, Data health, Why it moved, KPI
| Gap | Size |
|---|---|
| Money-integrity checks in Data health: invoice total equals its lines, payments not over invoice, settled loads not voided, fuel not deducted twice, QuickBooks/factor mismatch | M |
| Leak ledger lines from partner data: factoring fees, chargebacks, fuel discount missed, IFTA overpaid | M |
| KPI and Why it moved read cash (funded, paid) as well as gross; cash-flow view (days to cash) | M |

### Cross-cutting partner readiness
| Gap | Size |
|---|---|
| Outbound webhooks and a read API for partners (scoped API keys, signed events: invoice.created, payment.applied, statement.finalized) | L |
| Reconciliation queue and dead-letter table for failed partner events, with a retry screen | M |
| OAuth credential type in the backbone (token, refresh, expiry), beside static keys | M |
| Partner showcase: a demo fleet with every simulator on, a guided page that shows each integration's data flowing | M |
| Plan gating of partner features; counsel review before money-moving capabilities | S (plus external) |

## Logic gaps and holes to resolve (documented, not all solved now)
1. IFTA uses loaded miles and estimated gallons: understates taxable miles. Any figure shown today must be labelled "estimate".
2. One invoice per load: a broker's consolidated invoice or a partial re-bill cannot be represented.
3. Load fields and the new Invoice record will coexist during migration: a single write path and a parity test are needed so they never disagree.
4. A factored invoice's payer is the broker but the cash comes from the factor (advance), then the reserve later. Today "paid" is one event; it must split into funded, broker paid, reserve released.
5. Recourse: a broker that never pays makes the factor charge the advance back. No representation today.
6. Short pays: whether a factor fee or quick-pay fee is revenue loss or expense changes KPI and Why it moved. Decide one rule.
7. Percent driver pay on a short-paid or factored load (settled 2026-10-31 for short pay: agreed rate). Confirm it holds for factored loads.
8. Statement lines are JSON: reports and the accounting push can drift from what the driver saw unless lines are frozen as rows at finalize.
9. Fuel bought on a truck while no load is assigned: which statement and which IFTA trip it belongs to.
10. Time zone of money days: aging and statements use the workspace zone; partners report in UTC or their own zone. Normalize at the adapter.
11. Duplicate records across systems: an invoice entered in QuickBooks by a bookkeeper before the Desk syncs. Needs match-before-create.
12. Missed webhooks for factoring and payroll are never reconciled (no poll). Needs the poll or a status file per partner.
13. Insurance and tolls are not capabilities in the contract. Adding either needs the phone repo contract changed.
14. Money-moving capabilities (factoring submit, payroll pay) need counsel review and per-workspace switch before live use.
15. Canada (CAD, GST/HST, IFTA in provinces) is not handled: currency is USD only.
16. Imported TMS history (Leak Read) can be invoiced or paid with **no invoice number** (the file had none). Those loads keep only their projected fields and get no Invoice record yet: a record needs a number. Decide: generate `IMP-<load>` numbers, or a separate `imported` kind that never reaches a partner.

## Rules settled in review (2026-11-12)
- **A. Multi-load projection.** A load's projected `invoicedAmount` is the sum of the `InvoiceLine` rows that name that load, nothing else. A line that names no load (an invoice-level discount, fee or credit) stays on the `Invoice` only and never enters a load's gross. Money received is shared across the loads in line order (first load first, the last load takes any remainder), so the loads always add up to the invoice. Pure rule: `projectToLoads` in `src/lib/invoice-records.ts`.
- **B. Packet size budget.** The packet builder normalizes every image (longest side 1600 px, JPEG quality 75) before it becomes a PDF page, stitches pages with `pdf-lib` one document at a time, and refuses a packet over 15 MB. An invoice cannot move to `submitted` without a rate confirmation, a signed POD and a BOL (or the factor's own required list).
- **C. Notice of assignment.** Moving an invoice to factored re-renders its PDF with the factor's remit-to, lockbox and NOA wording, and marks any copy sent before as "Superseded: factored, remit-to changed". The superseded copy is kept, not deleted.
- **D. QuickBooks item mapping.** Every QBO invoice line needs an `ItemRef` tied to an income account. Default map, editable per workspace: `linehaul` to Freight Income, `fuel_surcharge` to Fuel Surcharge Income, `detention` / `lumper` / `layover` / `stop_off` / `tonu` to Accessorial Income. A sync with an unmapped kind stops before calling QBO. Customers are matched by normalized `DisplayName` / `CompanyName` before one is created.
- **E. Driver pay by classification.** A 1099 owner-operator's statement goes to QBO as a `Bill` to the driver as a `Vendor` (Driver Pay expense), settled by a `BillPayment`. A W-2 company driver's pay never becomes an AP bill: it goes only through payroll (Gusto / Check), so taxes and withholding are not counted twice.
- **F. Credit memos.** A credit memo is its own invoice (`kind = credit_memo`, negative total, `credit_of_id` set). It never lowers the original load's `invoicedAmount`: the original stays invoiced for audit and tax. Applied to its invoice it lands as a payment row with `source = credit` (method `credit`), so the balance, aging and the load's projected amount received all fall by it; a credit that covers the rest closes the invoice. A partial credit keeps the invoice open. Undoing a payment never removes a credit: the memo is voided instead.
- **G. Multi-load invoices.** Every load on one invoice must bill the same customer (same normalized bill-to name and MC) and be ready to invoice on its own. Each load keeps its own lines (rule A) and its PO/reference on its lines; the invoice number follows the usual sequence.
- **H. Invoice PDF.** Made on the server as bytes (`Uint8Array`), never through a disk file, so Wave 2's packet builder stitches it with the rate con and POD directly. The notice-of-assignment block prints only when `factoringStatus` is not `none`.
- **I. Screens read the record, and keep gap 16.** When `/invoices` and the load drawer move from the load's fields to the record, loads with invoice fields and no record (imported history with no number) are still listed, read from the load as before.
- **Test governance.** Each new Prisma model is added to the pinned list in `tests/no-legacy.test.ts` in the same commit, and every migration is re-exported with `npm run db:export-supabase` (it rewrites `supabase/mark-applied.*`, `apply-all.sql`, `verify.sql` and renumbers the RLS lockdown). Wave 3's `accounting` capability changes the phone repo's contract first, then `node apps/web/scripts/vendor-truelane.mjs`.

## Build waves (each wave: migration local only, tests, browser check on the 3101 dev server, then the 3100 production demo)
**Wave 0: baseline.** The dispatch-desk tree has about 130 uncommitted files (relay work, UI elevation, deck). Chris decides to commit them before any migration. Then add `docs/MONEY_PLAN.md` from this plan.

**Wave 1: Invoice record (L).** Prisma models `Invoice`, `InvoiceLine` (typed kind: linehaul, fuel_surcharge, detention, lumper, layover, tonu, other), `InvoicePayment` (reference, method, payer, applied amount), `InvoiceLoad` join for multi-load; migration with a backfill from load fields and `LoadPayment`. `server/tl/invoicing.ts` becomes the single write path and keeps the load's invoice fields updated as a projection until every reader moves. Credit memo and adjustments. Server-side invoice PDF. Readers migrate in batches (Invoices pages, aging, exports, KPI, leaks, data health). Parity test: every load's projected fields equal its Invoice.

**Wave 2: Factoring plug-and-play (L).** Adapter gets a transport choice: `api` (existing Triumph-shaped) or `batch` (CSV schedule plus PDF packet, delivered by SFTP or email; the factor's status file imported back). Packet builder from `LoadDocument`. Factoring economics on the invoice (advance, fee, reserve, chargeback). Notice of assignment on the invoice PDF. Reconciliation view. Simulator for the batch route.

**Wave 3: Accounting, QuickBooks Online (L).** `accounting` capability (phone repo contract change, re-vendor), OAuth credential type, external-id map and sync cursors, account mapping screen, push and pull with match-before-create, journal CSV fallback. Sandbox simulator.

**Wave 4: Settlements and Payroll (M to L).** Statement lines as rows frozen at finalize, recurring deductions and escrow, advances, driver tax profile and 1099 totals, payroll status poll, statement PDF.

**Wave 5: Fuel and IFTA (M to L).** All-miles source (ELD jurisdiction miles from a Motive-shaped adapter, routed all-miles fallback), purchased gallons by state, quarterly rate matrix store and import, the return with net due or credit, per-vehicle audit detail, fuel exception flags, reefer and DEF separate, fuel CSV import.

**Wave 6: Analytics and integrity (M).** Data health money-integrity checks, leak lines from partner data, KPI and Why it moved on cash.

**Wave 7: Partner surface (L).** Outbound signed webhooks and a scoped read API, dead-letter and retry screen, partner showcase demo page, plan gating, partner onboarding doc update (`docs/PARTNER_INTEGRATION_SPEC.md`).

## Critical files
- `dispatch-desk/prisma/schema.prisma` and new migrations (local only; production migrations stay Chris's).
- `apps/web/src/server/tl/invoicing.ts`, `lib/invoicing.ts`, `lib/billed.ts`, `lib/money-state.ts`, `server/tl/aging.ts`, `server/tl/exports.ts`.
- `apps/web/src/server/partners/` (`factoring.ts`, `payroll.ts`, `fuel-store.ts`, `ifta.ts`, `call.ts`, `credentials*.ts`, `webhook*.ts`, `sync*.ts`, `adapters/*`).
- `apps/web/src/server/tl/settlement.ts`, `lib/settlement.ts`.
- Pages under `apps/web/src/app/(desk)/{invoices,settlements,payroll,fuel,ifta,leaks,data-health,kpi}`.
- Phone repo `supabase/functions/_shared/partners/contract.ts` (new `accounting` capability), re-vendored by `scripts/vendor-truelane.mjs`.

## Reuse, do not rebuild
Adapter layers and simulators (`adapters/types.ts`, `sandbox.ts`), sealed credentials, connection health and backoff, webhook verify and dedupe (`partner_events`), `recordAudit`, compare-and-set patterns from settlements, `grossOf`, `moneyState`, `agingSummary`, `buildExport`, `LoadDocument` storage, the `useDraft` form rule, role capabilities in `lib/roles.ts`.

## Verification
- Unit tests per wave (money math to the cent, state transitions, parity of load projection vs Invoice, packet completeness, IFTA return math against a hand-worked quarter).
- Integration suites against the Docker demo database (`RUN_DB_INTEGRATION=true`), extending `tl-invoices-*`, `settlement-fuel`, `partner-*`.
- Each simulator exercised end to end: submit, webhook or status file back, ledger updated, audit written, retry on failure.
- Gates: `tsc`, `eslint --max-warnings=0`, `vitest run`, production `next build`.
- Browser check of every changed screen on 3101, then rebuild and re-warm the 3100 demo.
- A written reconciliation check per wave: totals on screen equal the exports and the partner payloads.
