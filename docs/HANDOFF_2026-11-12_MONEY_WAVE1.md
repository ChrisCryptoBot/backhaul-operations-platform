# Handoff: money modules, Wave 1 finish and Wave 2 start (2026-11-12)

Read this first, then `docs/MONEY_PLAN.md` (the approved plan: 7 waves, gap tables, logic gaps 1-16, review rules A-I). This page says exactly where the work stands and what to do next.

## Where it stands

| What | State |
|---|---|
| Baseline (relay, leak intake, UI elevation, vendored libs, plan doc) | Committed, 6 local commits `7fbec3f..c988f7a` |
| Wave 1 part 1: invoice records, credit memos, multi-load invoices | Committed `7afbb58` |
| Server-side invoice PDF + `pdf-lib` 1.17.1 | Committed `2d44172` (this handoff: `d278abb`) |
| Wave 1 UI: multi-load button, credit memo button, Invoices screens on the record | **Not started** |
| Waves 2-7 | Not started |

Nothing is pushed. Branch `demo/truelane-dispatch` (dispatch-desk has its own git). **Push and production migrations are Chris's.** Commit only when Chris says (he usually says "commit it" per milestone).

### The PDF commit (`2d44172`) holds
- `apps/web/package.json`, `package-lock.json` (`pdf-lib` 1.17.1, exact)
- `apps/web/src/lib/invoice-pdf.ts` (pure: data in, `Uint8Array` out; US Letter; NOA box; `pdfSafe` for WinAnsi)
- `apps/web/src/server/tl/invoice-pdf.ts` (`invoicePdfData`, `invoicePdf`: from the record, gap-16 fallback to `getInvoice`)
- `apps/web/src/app/(desk)/invoices/[id]/pdf/route.ts` (`GET /invoices/<loadId>/pdf`, guard `read`, terminal scope)
- `apps/web/src/app/(desk)/invoices/[id]/page.tsx` (PDF button beside Print)
- `apps/web/tests/invoice-pdf.test.ts` (5 tests)


**Leave out** the ~40 files under `apps/web/src/truelane/` that show a one-line change each: not ours (a re-vendor stamp from elsewhere). Also leave out `scratch/`, `apps/scratch/` and `docs/Dispatch desk terminal redesign.zip`.

## What Wave 1 built (so you do not rebuild it)

- **Tables** (migration `20261210000000_invoice_records`): `invoices` (kind invoice | credit_memo, status open | paid | void, bill-to snapshot, terms, total, paid_total, write-off amount/reason/code, credit_of_id, factoring status/reference), `invoice_lines` (typed kind, optional load_id), `invoice_loads` (join), `invoice_payments` (reference, payer, note, source desk | factor | accounting | import | credit | legacy, external_id unique per source). Backfilled from every load's invoice fields.
- **Migration `20261211000000_invoice_multi_load`**: drops the one-number-per-load index on `loads` (uniqueness lives on `invoices`).
- **The load keeps a projection** of its invoice (`invoice_number`, `invoiced_amount`, `paid_amount`, `payment_status`, factoring fields), written in the same transaction as the record. 44 reader files still read the load and are unchanged.
- **One write path**: `src/server/tl/invoicing.ts` (`invoiceLoad`, `markLoadPaid` (+ reference, payer, shortCode), `voidInvoice`, `undoPaid`, `issueCreditMemo`, `voidCreditMemo`, `invoiceLoads` (multi-load), `payInvoiceRecord`, private `voidSharedInvoice`, `sharedInvoiceOf`). `src/server/partners/factoring.ts` mirrors factoring status onto the record.
- **Helpers**: `src/server/tl/invoice-records.ts` (tx helpers: `openInvoiceOf`, `createInvoiceRecord`, `addInvoicePayment`, `closeInvoiceRecord`, `removeLastInvoicePayment`, `voidInvoiceRecord`, `setInvoiceFactoring`, `projectionOf`, `ensureInvoiceRecords` for bulk writers: importer and seeds). Pure rules: `src/lib/invoice-records.ts` (`lineKindOf`, `SHORT_CODES`, `balanceOf`, `invoiceStateLabel`, `projectToLoads`).
- **Rules in force** (MONEY_PLAN.md): A projection from linked lines only, payments shared first load first; F credit memo = own record + payment row `source=credit`, original `invoicedAmount` untouched, undo refuses a credit; G multi-load needs same normalized customer name + MC; H PDF as bytes; numbers held by any invoice record are never offered again.
- **Payment dialog** (`components/desk/load-actions.tsx`) already asks Reference, Paid by, and a short-pay code on write-off; `paidAction` in `app/(desk)/actions.ts` passes them.
- **Not yet allowed on a shared (multi-load) invoice**: undoing a payment, issuing a credit. Both return a clear refusal. Build them on the invoice page later.

## Next steps (in order)

### 1. (Done) The PDF work is committed

### 2. "Invoice these loads together" (rule G)
- Where: the Invoices screen's ready-to-invoice list (`app/(desk)/invoices/page.tsx`; rows come from `server/tl/queries.ts`). Add row checkboxes, and a bar when 2+ are checked: "N loads selected · $total · Customer".
- Guard: disable the button unless every checked row has the same normalized customer name and MC (same rule as `customerKey` in `invoicing.ts`); say why on hover.
- Action: a server action calling `invoiceLoads(loadIds, { number, terms })` (requires `bill` capability, as `invoiceAction` does), then go to `/invoices/<first load id>`. Keep the dialog's typed fields with `useDraft` (rule in memory: every form keeps its fields; add it to `tests/forms-keep-fields.test.ts`).
- The invoice sheet (`invoices/[id]/page.tsx`, data from `getInvoice` today) shows one load; for a multi-load invoice show all loads and lines (read the record).

### 3. Credit memo button
- Where: the invoice sheet beside Record payment and PDF; only when the invoice is open and has a record.
- Dialog: amount (default and maximum = balance), reason code (customer discount, freight claim, billing dispute, other) plus notes (min 3 chars), optional line label. Server action -> `issueCreditMemo`. Show the credit memos under the invoice with Void (`voidCreditMemo`, admin `writeoff` capability like write-offs).
- Audit actions `credit_memo_issued` / `credit_memo_voided` already exist in `lib/audit-diff.ts`.

### 4. Invoices screens read the record (rule I, keep gap 16)
- List and aging read `invoices` (with lines, loads, payments); then add loads with invoice fields and **no record** (imported history, no number) tagged "Imported".
- Keep `server/tl/aging.ts` totals equal to the list (there is a test pinning that: `tl-invoices-money`).
- Do not delete the load projection yet: other modules (KPI, leaks, data health, exports, settlements) still read it.

### 5. Wave 2 (factoring plug-and-play), per MONEY_PLAN.md
- Store the factor's remit-to on the factoring connection: remit name, address, lockbox bank, routing, account, statutory NOA text; `buildInvoicePdf` reads it (`factoring.remitTo` is null today: the PDF says "ask the factor").
- Batch transport (schedule-of-accounts CSV + one stitched PDF packet per invoice, SFTP or email) beside the existing API adapter (`server/partners/adapters/triumphpay.ts`). Packet: images normalized (longest side 1600 px, JPEG q75), pages stitched with `pdf-lib`, packet <= 15 MB, gate: rate con + signed POD + BOL (rule B).
- Factoring economics on the record: advance %, fee, reserve held/released, recourse chargeback. NOA re-render and "Superseded" mark (rule C).
- Multi-load factoring: `factorInvoice` is still per load; move it to the invoice record.

## How to run and check

- Dev server for your own checks: `preview_start` name `desk-demo-3101` (port 3101). Port 3100 is Chris's (sometimes a `next dev`, sometimes the production demo from `start-demo-prod.ps1`).
- Demo login: `/sign-in`, the "Demo as Admin" button.
- Database: Docker container `backhaul-demo-pg`, `postgresql://demo:demo@localhost:54330/demo` and `/demo_scale` (3,704 invoices, for scale checks).
- New migration: write SQL by hand in `prisma/migrations/<ts>_<name>/migration.sql`, then `DATABASE_URL=... npx prisma migrate deploy --schema ../../prisma/schema.prisma` (from `apps/web`) for both `demo` and `demo_scale`, then `npm run db:export-supabase` from `dispatch-desk` (rewrites `supabase/` and renumbers the RLS lockdown), and add any new Prisma model to the pinned list in `tests/no-legacy.test.ts`.
- `npx prisma generate` may fail renaming the engine DLL when any Next server holds it; the TypeScript client is still written (same engine version), so `tsc` works. Do not kill other sessions' servers.
- Gates: `npx tsc --noEmit -p .`, `npx eslint --max-warnings=0 <files>` (lint bans `Math.round` and `Number(...)` parsing in money code: use Decimal / `Number.parseInt` after a regex), `npx vitest run`, and integration: `DATABASE_URL=... RUN_DB_INTEGRATION=true npx vitest run tests/integration/<file>`.
- Key suites: `tests/integration/invoice-records.integration.test.ts` (15 tests, parity query over every invoice: run on demo and demo_scale), `tl-invoices-*`, `tl-audit`, `partner-*`, `settlement-fuel`, `load-import`, `leaks`, `data-health`.
- Known unrelated failure: `tests/rate-con-miles.test.ts` (one test, `prisma.region.findMany` in the measure route). Not from this work.
- Tooling gotcha: a long inline Python heredoc in Bash can trip Claude Code's rm-safety parser; write the script to the scratchpad and run it with `python <file>`.

## Prompt to give the next session

> You are continuing the TrueLane dispatch desk money-modules work in `C:\Users\14698\OneDrive\Desktop\TRUELANE\dispatch-desk`. Read `docs/HANDOFF_2026-11-12_MONEY_WAVE1.md` and `docs/MONEY_PLAN.md` first. Wave 1 part 1 (`7afbb58`) and the server-side invoice PDF (`2d44172`) are committed. Ask Chris before committing anything and never push. Next: (2) "Invoice these loads together" on the ready-to-invoice list, (3) the credit memo button and memo list on the invoice sheet, (4) move the Invoices list and sheet to read the invoice record while keeping imported invoices with no number (gap 16), then Wave 2 (factoring: remit-to on the connection, batch CSV + PDF packet transport, factoring economics, NOA re-render). Keep the single write path in `src/server/tl/invoicing.ts`, keep the load projection, and check each change in the browser on your own dev server (`desk-demo-3101`) plus the integration suites on `demo` and `demo_scale`.
