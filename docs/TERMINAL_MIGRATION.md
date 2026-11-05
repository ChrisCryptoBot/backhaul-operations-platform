# Terminal redesign: migration notes

The desk moves screen by screen from the old classes (`tl-*`, `cp-*`, `qt-*`, `dr-*`) and `--db-*` tokens to `src/app/terminal.css` (`t-*`, `vc-*`, `vm`). Handoff: `docs/design-handoff/` (reference, not production code).

Transitional files, deleted when nothing references them: `src/app/globals.css` (the `--db-*` names as aliases of terminal tokens), `src/app/legacy-flat.css`, `(desk)/desk.css`, `components/desk/cockpit.css`, `quote-terminal.css`, `splash.css` chrome.

## Decisions that differ from the handoff
- Day theme ground is the parchment `#f5f2eb` (handoff: `#fffefb`). Tested in `tests/theme-contrast.test.ts`.
- The open row, current rail item and primary button are an amber bar (`--bar`) with black ink (`--on-bar`) in both themes (handoff used the gold text colour as a fill; in day that fails contrast).
- Command prompt box: 1px `--prompt` (`#1f2937`) border in both themes. On night black it is about 1.4:1 as a border; the 2px gold focus ring keeps it findable.
- `TRUELANE ▸ DESK` keeps a 0.5px chromatic fringe (off in print).
- Night `--line-hi` is `#666` (handoff `#565656` was 2.7:1 on the panel).
- Density is `dense` (24px, default) or `comfortable` (30px); an old `compact` cookie reads as dense.
- The current load drawer is kept (tabs 1-4, J/K scrub, `\`, `?`, deck resizer, document viewer); the handoff drawer has none of these.

## Load drawer: the contract that must survive the re-skin
- Mount: parallel slot `@drawer` with intercepting route `(.)loads/[id]` renders `LoadView variant="drawer"`; `loads/[id]` renders `variant="page"`. "Open full page" stays a plain `<a href>` (not `next/link`). Close = `router.replace(underlay.current)`.
- Scrub reads the board: `table.dt tbody tr[data-href]` (`data-table.tsx`). Keep that markup contract or "x / n" and J/K vanish.
- Header: title + copy-number button, customer/MC/phone line, chips (status, verdict, assignment), `x / n` scrub with prev/next (K/J, arrows), expand `\`, shortcuts `?` (modal lists J/K, 1-4, `\`, arrows, drag/double-click deck, Esc), close (focus target on open, focus returns to opener, Tab trapped, Esc closes).
- Deck (pinned, resizable by drag / double-click): route ribbon with driver telemetry; metrics (Per Mile Every Mile or TONU fee, Per Loaded Mile, Your Floor); five gates (weight, trailer, driver, papers, margin); read-only note; alerts; cancelled/TONU banner.
- Tabs (keys 1-4, persisted in sessionStorage `tl_cockpit_tab`): Route & Stops (stops table + Edit details, miles/PO/terms/specs/notes, Edit billing details, dock waiting & detention + waive, driver & HOS assignment + remove, trailer, trip entry, driver cab sheet); Economics & Margin (margin ledger, net, count-every-mile bars); Documents & Proof (split viewer: arrows, rotate, zoom, expand/download/new tab, carousel, packet list with upload/remove/preview); Partners & History (shelf of eight verticals, invoice details, booking decision, load progress, activity trail, disruptions: reschedule / TONU / cancel / delete / quote like this).
- Foot (role-gated): send / send anyway / demo accept-decline; create or view invoice; take the pickup back / delivery back / reopen; mark paid or record a payment; take the invoice back; undo payment; Open full page. `ReadOnlyGate` fieldset keeps links clickable.
- Tests that pin it: `forms-keep-fields.test.ts` (disruption, delete-load, load-actions Mark paid reset, submit-outcome files), `trip-linehaul.test.ts` (`paidLinehaul: numOrNull(` in `load-view.tsx`), `quote-bar.test.ts` (the `.dr` selector in the glass list; revisit with the glass pass).
