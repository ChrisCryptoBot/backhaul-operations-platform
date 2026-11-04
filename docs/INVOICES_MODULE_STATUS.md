# Invoices, Settlements and Payroll: where they stand (2026-10-31)

A graded audit of the desk's Invoices, Settlements and Payroll modules found a C+ (~68/100: factoring stranded after undoing a payment, statements vulnerable to save/finalize/discard races and post-payout voids, payroll double-send window, linear roles unable to separate dispatch from billing, and terminal-scope gaps). Five phases were built locally and are **not committed**. This page is the one place that says what changed, what Chris has to do, and what is open.

## Decisions taken
- **Four roles replace the three linear ones (`viewer`, `dispatcher`, `accounting`, `admin`)**, and **"Owner" is renamed "Admin" everywhere** (database check constraint, stored member/invite rows, `src/lib/roles.ts`, Settings team screen, tests). Capabilities (`read`, `quote`, `dispatch`, `documents`, `figures`, `billing_details`, `bill`, `payout`, `writeoff`, `admin`) replace `roleAtLeast`.
- **Billing and payroll belong to Accounting and Admin.** A dispatcher is read-only on money screens unless an admin grants them `"bill"` ("Can also bill" on Settings → Team, audited; gives `billing_details`, `bill` and `payout`). Dispatchers always keep Quote, documents and trip figures.
- **Destructive money actions stay Admin only**: writing off an invoice shortfall and voiding a finalized driver statement require `writeoff` (Admin only, regardless of grants).
- **Accounting can edit a load's billing details** (customer, MC, contact, PO, terms before invoicing, revenue note) and trip figures/documents, without dispatch controls.
- **Percent driver pay stays on the agreed rate + fuel surcharge.** When a customer closes an invoice short (or with a write-off), unsettled lists and statements flag the load (`paid_short`).
- **A TONU is never paid automatically on a statement.** Unsettled lists and the load view state that it is on no statement so any driver share is added deliberately as an adjustment.
- **Voided invoices re-issue under a revision number** (`INV-1234` → `INV-1234-2` → `INV-1234-3`), and taking an invoice back restores the load's prior pay terms.

## What was built
| Phase | Result |
|---|---|
| 1. Roles & integrity | 4-role capability matrix + audited `"bill"` grant; atomic statement counter (`nextSettlementNumber`), duplicate-draft guard, compare-and-set on `saveDraft` / `finalizeSettlement` (with `confirmedTotal` check) / `discardSettlement` / `voidSettlement`; `markSettlementPaid` (`paidAt`, `paidMethod`) blocking both void and payroll send; settled-load miles guard in `saveExpenses`/`correctTrip`; payroll `<= 0` refusal, `idempotencyKey`, and stale-claim recovery; factoring `undoPaid` (`paid` → `funded`), full-pay auto-close, voiding `rejected` invoices, and payment-vs-void transaction claim; revision invoice numbers, `0` = Due on receipt, reserved extra-charge label check, over-pay confirmation. |
| 2. One money view | Single Dallas-calendar aging aggregate (`server/tl/aging.ts`) shared by shell and Invoices with 5 aging buckets summing to Outstanding; `billedOf` for legacy invoices; `moneyState` shared across list, sheet, load view and CSV; reminder text chasing remaining balance; `paid_short` and 120-day TONU flags on Settlements; real `driveHoursFor` hourly pay estimate. |
| 3. Phone parity | Terms chips (`Net 15`, `Net 30`, `Net 45`, `Due on receipt`); `ChaseActions` (`mailto:` / `tel:` + audited `"last chased"` memory on list and sheet); customer pay-history banner on search; audited `waiveDetention` clearing both the recovery card and `DETENTION_UNBILLED`; payment method stored per payment; cross-list search, full-list sorts (`Customer`, `Due`, `Paid`, `Amount`/`Owed` by remaining balance), per-list CSV links, `settlements` and `settlement-lines` CSV exports, PDF filenames matching invoice/statement numbers, printable draft statements, and driver statement history on `/drivers/[id]`. |
| 4. Screens, scope & perf | `ReadOnlyBanner` and `ReadOnlyGate` across Invoices, Invoice sheet, Load view, Settlements, Statement editor/sheet, Driver page and Payroll; `try/finally` + `tried()` error handling and `<form>` Enter submission across dialogs; terminal scope enforced on `getInvoice`, `getSettlement`, `getDetentionRecovery`, `listPayroll` and CSV exports, with `"N hidden by the <terminal> terminal filter"` notices; Voided statements pager; segment `loading.tsx` and `error.tsx` boundaries; light scalar reads for Out/Paid invoices, batched single-query draft resolution in `listSettlements`, and cross-page `readyIds` (up to 200) in `listPayroll`. |
| 5. Tests, scale & handoff | Integration suites (`tl-invoices-integrity`, `tl-invoices-money`, `tl-invoices-readiness`, `auth.integration`) covering statement/invoice/factoring/payroll races, detention waive + alert invalidation, chase memory, terminal scope, exact `maxRows` export cut flags, and balance sorting (which caught and fixed Out `Owed` sorting by billed total instead of remaining balance); `demo_scale` budgets in `tests/perf/scale.perf.test.ts`; live route verification. |

## For Chris
1. **Production migrations** (applied locally to `demo` and `demo_scale` only):
   - `20261119000000_accounting_role` — renames `owner` to `admin` on `members` and `workspace_invites`, adds `accounting` role, adds `grants text[]` check-constrained to `bill`, and adds `next_settlement_number` on `workspaces`.
   - `20261119000100_statement_paid_and_indexes` — adds `paid_at` and `paid_method` on `settlements`, plus composite indexes for invoice and statement paging/aging.
   Run `prisma migrate deploy` before deploying the new web build.
2. **Resolved from Loads handoff**: open questions #2 (percent driver pay on short-paid loads) and #3 (role separation & Admin-only write-offs/statement voids) in `docs/LOADS_MODULE_STATUS.md` are now settled and implemented.
3. **Partner connections**: Factoring status steps and direct payouts work standalone today; live factor webhooks and live payroll transmission activate per workspace once credentials are connected under Settings → Connections.

## Not done
- Tax-exclude switch and tax reporting screens.
- Sending reminder emails directly through an SMTP/API integration (by design, Chase opens the user's own email/phone client with pre-filled balance reminder text and records `"last chased"` in the audit trail).
- Automatic bank-feed or payroll-webhook reconciliation after payout.
