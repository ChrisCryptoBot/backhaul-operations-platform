# INTEGRATION.md: the terminal redesign of the dispatch desk

Scope: `dispatch-desk/apps/web` only. Nothing under `src/truelane/`, `src/lib/verdict.ts`, the mobile app or the marketing site is touched or needs to be.

## 0. What is in this export

| File | What it is |
|---|---|
| `terminal.css` | The whole shared system: tokens (night, day), density, resets, every primitive. One file, plain CSS. Replaces the token block of `globals.css` and the chrome of `desk.css`, `cockpit.css`, `quote-terminal.css`, `splash.css`. |
| `desk-data.js` | Fixture only (invented, seed-shaped). Also a straight port of `lib/verdict.ts` (`verdictState`, `sentenceOf`, `rulerOf`, `groundOf`, `readVerdict`). **Do not ship it**: use the real `lib/verdict.ts`. `bandOf` in it stands in for the audited rules. |
| `Desk.dc.html` | The shell and router (command line, ticker, rail, status line) with Tweaks: theme, density, frame (fill, 1440, 1024), role (dispatcher, accounting, admin, viewer), state (normal, loading, empty, error). |
| `Quote`, `Loads`, `LoadDetail` (drawer and page), `Dispatch`, `Messages`, `Planner`, `Alerts`, `RateCons`, `Fleet` (trucks, drivers, trailers), `Market` (customers, lanes), `Money` (invoices, settlements, payroll, printed sheets), `Kpi` (dashboard, quote decisions, management report), `Audit`, `Settings`, `Public`, `States`, `System`, `VerdictCard` `.dc.html` | One screen group each. Open `Desk.dc.html` and use the rail. |
| `RECONCILE.md` | Answer to "how do we reconcile". |

The `.dc.html` files are the visual and structural reference with real data shapes; the build is Next.js server components plus `terminal.css`. They use the sheet's class names (`t-*`, `vc-*`, `vm`), so the markup carries over nearly 1:1. `Quote.dc.html` draws its own ticket; in the build it is `VerdictCard` plus the counter-offer and action slots.

## 1. Screens: what each replaces

| Screen (module) | Replaces / changes | Maps to existing components | New |
|---|---|---|---|
| Shell | `(desk)/layout.tsx`, `desk-shell.tsx`, `splash.css` chrome | `GlobalSearch` becomes the command line; `TerminalScope` is the select beside it; `ShellData.totals` feeds the ticker; `NAV` keeps its hrefs and pills and gains a two-letter `code`; the sample-data note, role and plan move to the status line; Talk to a person and Sign out sit on the command bar; `[` still collapses the rail (to codes) | `.t-app` grid, `.t-tick`, `.t-status` |
| Quote a load | `quote-desk.tsx` (layout and class names only), `quote-terminal.css`, `verdict-card.tsx` skin | Entry panels = the same fields and `useDraft`; `FitRow` table = the matrix; `VerdictHead`, `VerdictRuler`, `VerdictTag` redrawn; `CounterOfferAssistant`, Modal x4 (book with reason, pass, paste, shortcuts) kept | Fixed explain strip replaces `useExplain` hover tooltips (same text) |
| Loads (open, history, deleted) | `loads/page.tsx` markup, `data-table.tsx` styles, `ui.tsx` `StatusChip` | `COLUMNS`, `HISTORY_COLUMNS`, `DELETED_COLUMNS`, `Tabs`, `DataTableTools`, `Pager`, `moneyState`, `NewLoad`, `RestoreLoadButton`, `AlertDot` | Verdict column draws the four states (see 3) |
| Load drawer and load page | `load-view.tsx`, `load-cockpit.tsx`, `cockpit.css`, `drawer-frame.tsx` | Panels: Route (ribbon), Verdict, Margin ledger, Stops, Driver and truck, Trip entry, Documents, Billing, Alerts, Where it is (`deriveTimeline`), History; action foot = `load-actions`, `disruption-dialogs`, `delete-load` | Drawer is a flat right panel, no blur. Same body in both variants |
| Dispatch queue | `dispatch/page.tsx`, `.dq-*` | `Signal`, `AlertList`, `AssignButton` / `assign-modal`, "Show more" paging | Three columns on 1px rules |
| Messages | `components/desk/messages/*` | Thread list, composer, load chips, attachments | "Saved, not delivered" kept as is |
| Planner | `planner-parts.tsx` | `lib/planner.ts` geometry | Overlap and no-driver marks reuse the alert rules |
| Alerts, Rules | `alert-bits.tsx`, `settings/rules/` | `RULES` catalogue, `deriveAlerts` | Rules is a tab here; keep `settings/rules/` as the route |
| Rate confirmations | `rate-con-intake.tsx` | `rate-con-checks`, `rate-con-to-quote` | Document and draft side by side |
| Drivers, Trucks, Trailers, imports | `fleet-forms.tsx`, `trailer-forms.tsx`, `import-panel.tsx`, `plan-limit.tsx` | `DataTable` with sortable columns, `truck-picker`, `driver-picker`, `UnitUse` | Detail pages: one summary panel, one inputs panel |
| Customers, Lanes | `customer-form.tsx`, `customer-authority.tsx` | `customer-scorecard.ts`, `useAuthorityLookup` | None |
| Invoices, Settlements, Payroll | `settlement-forms.tsx`, `billing-details-dialog.tsx`, `doc-head.tsx` | `moneyState`, `DocHead`, `.rp` sheets | Sheets keep `.rp` semantics and paper-white in both themes |
| KPI, quote decisions, management report | `components/desk/kpi/*` | `ChartFrame` content, `kpi-view.ts`, `kpi-periods.ts` | Charts are flat CSS bars here; keep the SVG charts, restyle only |
| Audit log | `audit-diff-button.tsx` | `audit-diff.ts`, `audit-range.ts` | None |
| Settings | `company-form.tsx`, `team-card.tsx`, `thresholds-form.tsx`, `partner-actions.tsx` | `ROLES`, `CARD_LINES`, `LANE_MIN_LOADS`, `LANE_DAYS` | Appearance applies theme and density live |
| Public pages | `(public)/*`, `public.css` | `request-form`, `trucks-step`, `contact-card`, `PLANS` | Public pages have no shell; `Public.dc.html` shows them inside it for review only |
| States, System | none (review pages) | `loading.tsx`, `error.tsx`, `not-found`, `kit/states.tsx`, `kit/toast.tsx`, `kit/modal.tsx`, `kit/confirm-form.tsx`, `date-input.tsx`, `address-input.tsx` | Do not ship as routes |

States covered: night and day; 1440 and 1024 (Frame tweak); the four roles (a viewer sees the banner and no action buttons); read-only passed quote; plan full; empty, loading, error, not found, booked-or-discarded-since-opened; 3 rows, 50 and 1,512 (Fleet, Dispatch); every money state (`States` panel 15); dialogs, toasts with Undo, date picker, address suggestions, search; printed sheets (invoice, statement, management report).

## 2. Old to new

Tokens (`globals.css` `--db-*` to `terminal.css`):

| Old | New |
|---|---|
| `--db-bg`, `--db-bg-rail` | `--bg`, `--panel` |
| `--db-bg-card`, `--db-bg-elev-1..3` | `--panel`, `--head`, `--hover` |
| `--db-bg-inset`, `--db-bg-input` | `--sunk` |
| `--db-border-soft`, `--db-border`, `--db-border-strong`, `--db-border-lit` | `--line`, `--line-hi` (lit edge dropped) |
| `--db-fg`, `-mid`, `-dim`, `-faint` | `--ink`, `--mid`, `--dim`, `--faint` |
| `--db-accent`, `--db-accent-fg`, `--db-accent-on`, `--db-accent-ring` | `--label`, `--label-hi`, `--on-label`, focus ring uses `--label-hi` |
| `--db-pos/neg/warn`, `-fill` | `--pos/neg/warn`, `--pos-fill/neg-fill/warn-fill` |
| `--db-info` | `--typed` (typed-by-a-person ink) |
| `--db-glass-*`, `--db-bubble-*`, `--db-glow-*`, `--db-shadow-*`, `--db-scrim` | dropped, except `--scrim` |
| `--db-r-*` | dropped (radius 0) |
| `--db-text-*` | 11, 12, 13, 14, 20, 34, 46 px (see `System`) |
| `--db-row-h`, `data-density` | `--rh` 24 / 30px, `data-density="dense|comfortable"` |
| `--db-font-sans`, `--db-font-head` | `--sans` (IBM Plex Sans), `--mono` (IBM Plex Mono) |

Classes: `.tl-app` `.t-app`, `.tl-side` `.t-rail`, `.tl-header` `.t-cmd` + `.t-tick`, `.tl-card` `.t-pn` (+ `.t-ph` header), `.tl-btn` `.t-btn` (`.primary` `.pri`, `.sm`), `.tl-chip` `.t-st`, `.tl-table` `.t-tbl`, `.tl-seg` and `.cp-seg` both `.t-seg` (the two are now one), `.tl-tab` `.t-tabs`, `.tl-field`/`.th-field` `.t-fld` + `.t-in`, `.tl-note` `.t-note`, `.tl-kv` `.t-kv`, `.vc-*` kept and restyled, `VerdictMark` `.vm`, `.rp` sheets `.t-doc` (same paper rules), `.dq-*` `.t-pn` list rows. Fonts: replace Barlow with IBM Plex Mono and Plex Sans (`next/font`).

## 3. Needs data or behaviour the code does not have today (flagged, not invented)

- **Four-state verdict on the board, Dispatch and load page.** `BoardRow.verdict` is accept / caution / reject. The design draws `readVerdict`'s four states, which need the market band and gate (and the lane stand-in) per row. Same gap `VERDICT_CARD.md` lists under "Not done yet". Until then, map accept to take, caution to think, reject to reject, and no truck to unjudged.
- **Ruler ticks.** The $0.25 ticks need the ruler's scale. `rulerOf` does not return it; derive it as `(offer.at - floor.at) / (offer.value - floor.value)` (when they differ), so `verdict.ts` stays untouched.
- **Floor breakdown.** The truck page lists cost-profile *inputs* only. The itemised floor is the audited math's and is not shown or recomputed.
- **Provenance ink on the load page ledger.** Blue (typed) is exact on Quote (`manual`, `quoteExtras`). The ledger on a saved load only knows linehaul as typed; other lines are shown as estimates or actuals by status. More needs the source stored.
- **Messages delivery** to the phone (not built; the screen says saved, not delivered). **Hard stop on Reject** (not built). **Verdict against what happened** (not built; stated on Quote decisions).
- **Invoices strip** (ready, out, overdue, paid in 30 days), **KPI "Below cost, taken"** (Rejects booked with a reason, from `LoadDecision.details`), **Audit "Export CSV"**, **Planner prev / next / today**: shown by the design; confirm each exists or add as a small query. Not assumed.
- **Reason lists** (`OVERRIDE_REASONS`, `PASS_REASONS`, cancel reasons), the last four alert-rule wordings, `HISTORY_FILTERS`, and the customer authority messages are placeholders in the screens. Use the code's.
- **Sign-in form** is the provider's; only the frame and words are the desk's.
- **Fixture.** Floors, bands, lane stand-ins and every figure are invented to be consistent, not computed by `src/truelane`. Check the screens against the real engine, not these numbers.

## 4. Proposals (behaviour or content; none are in the visual work above unless marked)

1. **Command line with codes**: typing `QT`, `LD`, `DQ` and Enter opens the module. Drawn here; today's global search is a search box. Needs a small key handler.
2. **Counter-offer labels**: either relabel "+10% / +15%" to "+$0.25 / +$0.50 a mile margin" (done here, copy only) or change the sums to the percentages. The sums are untouched.
3. **Persistent explain strip** instead of hover tooltips: same text, always visible on focus or hover. Drawn here; a UI change, no data.
4. **Planner**: the design draws overlaps from the data. A drag-to-reassign or any write on the planner is not proposed.
5. **Dropping day** is not proposed. If wanted, delete the `[data-theme="day"]` block.
6. **Fleet-size preview** and **plan preview** switches on Fleet and Dispatch are review aids only; do not ship.
7. **Sentence case** is kept for sentences; labels are caps by CSS (`text-transform`), so the source stays sentence case and tests (`customer-wording`) are unaffected.

## 5. Order I would build in

1. `terminal.css` + fonts + shell. 2. `VerdictCard` skin (one place, all surfaces). 3. Quote. 4. Loads board and drawer. 5. Dispatch. 6. The rest by module; each is a re-skin of an existing component, not a rewrite. Run the gates: `tsc`, `eslint --max-warnings=0`, `vitest` (add the new ink pairings to `tests/theme-contrast.test.ts`: `--typed` and `--label` on `--panel` in both themes), production `next build`.

Not verified: a screen-reader pass; the printed sheets on real paper; contrast numbers (computed by eye, not by the test); side-by-side against the running current desk (it was not run).
