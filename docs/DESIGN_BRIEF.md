# Dispatch desk: design brief

What the desk looks like and why, written from the rules the Wave A to D rework built to. It is for whoever changes a screen next: read it before adding a component, a colour or a paragraph. The phone app's own rules are in `TRUELANE/docs/reference/DESIGN_PRINCIPLES.md`, `DESIGN_OVERHAUL_MAP.md` and `DESIGN_PLAYBOOK.md`; the desk matches their look and keeps a few deliberate desktop exceptions (section 8).

The history of what was built, wave by wave, with what was and was not verified, is in `docs/DEMO_REBUILD.md`. The plan it followed is `docs/DESK_REWORK_PLAN.md`.

## 1. What the desk is for

A dispatcher looking at a load, a driver or a bill and deciding something. Every screen answers one question and leads with the one figure that answers it. Nothing is there to fill space.

- **Desktop only.** Check at 1440 and 1024 wide. No phone-width work on the desk.
- **Night is the default and the primary look; day is the second.** Both are first-class: anything new is looked at in both. (Night is what a person gets with no cookie; Settings switches.)
- Sample data is invented; the footer says so. Never print a key or token.

## 2. The rules

1. **Status is a dot and a word, never a pill.** Small coloured dot, then the state in uppercase Barlow Condensed (`.tl-chip` renders exactly this; the name is old, the look is not). No fill, no border, no radius. Tones: green = fine or done, orange/gold = needs you, red = wrong or late, blue = information, grey = quiet. A healthy, unremarkable state renders nothing (no "Clear", no "Covers your cost" on every row). One primary state and at most one quiet secondary per row.
2. **One hero per screen.** The single figure the screen exists for is set in Barlow Condensed 600, tabular, 34 to 46 px (`--db-text-3xl` to `--db-text-hero`): the quote verdict, the all-in on a load, a truck's break-even floor, an invoice or statement total, the KPI gross. Gold is for that figure and for the one primary action. Semantic colour (green, orange, red) only on verdicts and deltas.
3. **Rule, don't box.** Sections are a gold Condensed kicker over a hairline with the content open beneath. Lists are ruled rows. Boxes are for decisions: the hero, a form control, a blocking alert, a modal. Surfaces that float over the page are glass (section 3a). The deliberate exceptions are in section 8.
4. **One action per row.** A row in a list has one button at most (Mark paid, Assign, Start statement). The row's name is a link to the page; clicking elsewhere on the row opens it too, but the link is the one tab stop.
5. **Say it once.** A short sentence under the page title, not a paragraph. A hint appears once: a field's default is its placeholder, not also a hint, not also a footer. Working-out text (formulas, "how this is calculated") is folded behind a "How this is worked out" disclosure, never a paragraph under every card.
6. **Don't duplicate another page.** If Customers has the customer scorecard, the KPI page links to it. A dashboard shows what only it can show.
7. **Typed wins; never overwrite silently.** Anything the desk measures or looks up (miles, drive time, fuel price, MC authority, a time zone) is a default the person can type over. A lookup fills only an empty field, or only when the person clicks "Use $x" (and it says "Replace $5.00 with $5.98?" when something is there). The source of a number is shown ("measured on the road", "printed on the rate confirmation").
8. **Customer, not broker.** Dispatchers work with brokers, shippers and direct customers. Every screen says Customer; "broker" appears only where it is the kind (authority status, the MC field's "brokers and carriers", the kind choice). `tests/customer-wording.test.ts` enforces it. Database and code names keep `broker...`; they are not user words.
9. **Filters apply as you change them.** A select or a date applies at once; a search box applies a moment after you stop typing and keeps its focus (`LiveForm`). No Apply button. Filters live in the URL so a page can be shared and the Back button works. A CSV export follows exactly what is on screen.
10. **Documents are paper.** Invoice, pay statement and management report use `DocHead`: the issuer and the document number on the left, the one figure as the hero on the right, a stamp for where it stands (Paid, Overdue 12 days, Finalized). Sheets stay paper-white in both themes because they are printed or saved as PDF.
11. **Empty states are one line.** A sentence and, if useful, a link. No centred icon-and-paragraph blocks. A list with nothing to show says so in words.
12. **Destructive actions can be taken back.** Delete a load with a reason and a 20 second Undo (soft delete). Void a statement with a reason. Every change is written to the audit log in the same transaction.

## 3. Tokens

All colours, sizes and spacing are CSS variables in `src/app/globals.css` (`--db-*`), defined for night and redefined for day under `[data-theme="day"]`. Never write a hex value in a component.

- **Surfaces:** `--db-bg` page, `--db-bg-rail` sidebar and table heads, `--db-bg-card`, `--db-bg-inset`, `--db-bg-input`, `--db-bg-elev-1..3` for raised states.
- **Lines:** `--db-border-soft` (inside a section), `--db-border` (card edge), `--db-border-strong` (controls), `--db-border-lit` (a lit top edge instead of a shadow). There are no drop shadows; the `--db-shadow-*` tokens are one-pixel rings.
- **Text:** `--db-fg`, `--db-fg-mid`, `--db-fg-dim`, `--db-fg-faint` (decoration only, never words that matter). `tests/theme-contrast.test.ts` pins the contrast of every pairing in both themes; add a pairing there when you add one.
- **Accent:** `--db-accent` (fill), `--db-accent-fg` (text on the page; darker in day), `--db-accent-on` (text on the accent), `--db-accent-bg`, `--db-accent-ring` (focus ring).
- **Semantic:** `--db-pos`, `--db-neg`, `--db-warn`, `--db-info` for text; the `-fill` variants for dots, bars and meters; `-bg` for the rare tinted panel.
- **Type:** Barlow for text (`--db-font-sans`), Barlow Condensed for kickers, labels, table heads and hero figures (`--db-font-head`). Scale `--db-text-xs` 11, `sm` 12.5, `base` 14, `md` 15, `lg` 17, `xl` 20, `2xl` 26, `3xl` 34, `hero` 46. Figures are always tabular.
- **Space:** a 4 px scale, `--db-1` to `--db-12`.
- **Radius by role, not by taste:** press 6 (buttons), field 8, tile 10, note 14, card 20. Controls on the desk are squarer than the phone's; do not invent a new radius.
- **Motion:** 110 ms (press), 200 ms, 220 ms, 320 ms (settle), one easing curve. Press scale 0.98. Nothing animates for its own sake.
- **Density:** `--db-row-h` and cell padding switch between Comfortable (40 px rows) and Compact (32 px) from a cookie, set in Settings or on any table toolbar.

### 3a. Glass

Glass is for what floats over other content, not for decoration. One recipe, set by `--db-glass-*` tokens for both themes and applied in the "glass" section at the end of `desk.css`:

- **A wash over a blur** (`backdrop-filter: blur(26px) saturate(1.7)`): what is under it frosts, colour and light come through, text does not. The wash is `--db-glass-bg` for panels that sit beside the page (sidebar, verdict), `--db-glass-bg-strong` where text scrolls under or a lot of text sits on it (header, drawer, dialogs, menus, address suggestions, toasts), `--db-glass-bg-thin` for the verdict, which lets its light show.
- **A lit rim** along the top (`--db-glass-rim`), a hairline all round (`--db-glass-edge`), and a sheen from lit to clear (`--db-glass-sheen`). Inner highlights, not drop shadows: the no-shadow rule stands.
- **Light behind it.** Glass over a flat colour looks like a grey box, so the app has a fixed ambient background (a warm corner, a cool corner, `--db-glow-*`) and the verdict carries a light the colour of its verdict behind the slab (green clears, amber thin, red below cost, gold before it is priced).
- **The bubble.** The current sidebar item and the selected segment sit in a small glass capsule (`--db-bubble-*`), the same device as the phone's tab bar. In the sidebar it is one element that slides to the next item with a small overshoot (measured in `DeskShell`; until it has measured, the item draws its own capsule so the first paint is never bare). No side stripe.
- **Layout.** The sidebar is a floating panel 12 px in from the window's left, top and bottom. The header is a floating pill 12 px from the top and 12 px from the sidebar, as tall as the sidebar's brand row, so their tops and the brand row's bottom line up. A frosted 12 px strip above the header blurs whatever scrolls up behind it.
- **Where it stops.** Not on tables, cards, forms, charts or sheets: those are ruled and opaque. Do not stack glass on glass (a modal's inner panels are open, not glass), do not put a blur under a table.
- **Falls back to solid** where the browser cannot blur (`@supports`) and when the person asks for less transparency (`prefers-reduced-transparency`). Bubble motion stops under reduced motion.
- Text on glass still has to pass contrast: the strong wash exists for that. Do not thin a text-heavy surface to make it glassier.

## 4. Components to reuse

Do not write a new one of these.

| Need | Use |
| --- | --- |
| Page title, one sentence, the page's actions | `PageHead` (`ui.tsx`) |
| A section | `Card` with a title (it is the Section primitive; boxed only by CSS where a decision lives) |
| A figure with a label | `Stat` / the `.tl-stat` strip |
| A state | `StatusChip`, `AssignmentChip`, `VerdictChip` (dot and word) |
| A view or filter switch | `Tabs` (underlined; a dot for "needs you") |
| Two to four exclusive choices | the segmented control (`.tl-seg`, or `.cp-seg` in forms) |
| A table | `DataTable` + `DataTableTools` (search, density, row clicks, sortable headers) |
| A live filter bar | `LiveForm` |
| A date or a date and time | `DateInput` (a box you can type in, and a glass calendar). Never a native `<input type="date">` or `datetime-local`: their pop-up is the browser's grey one and cannot be styled |
| A printed document | `DocHead` inside `<article className="rp">` |
| An address | `AddressInput` (Mapbox suggestions, temporary; stored points come from the permanent endpoint) |
| A dialog | `kit/modal.tsx` (focus is held inside; Escape closes) and `kit/confirm-form.tsx` |
| A message | `kit/toast.tsx` (tone-bordered, pausable) and `kit/states.tsx` (`EmptyState`, `InlineNote`) |
| Charts | `components/desk/kpi/*` inside `ChartFrame` (title and unit, the chart, one caption, a folded formula) |

## 5. Tables

- Ruled rows, no zebra, no nested scroller. State is a dot and a word in a cell, plus the row's `flag` for a row that is wrong (below cost, overdue).
- Sticky leading columns keep the name on screen; `width` is required on them.
- Banded column groups only where the groups mean something (Money, Compliance).
- A column is `sortable` when sorting it answers a question. The header becomes a button, cycles ascending, descending and back to the page's own order, and sets `aria-sort` on the header cell; one column is sorted at a time. Number columns sort by the figure in their text; when the text is not the right key (a date shown as "Oct 24"), the row gives `sort: { column: value }`. A missing value sorts last either way. Do not make a column sortable on a table that is server-paged (the Audit log) or split into month tables (Loads history): sorting one page or one month is misleading.
- Right-align figures (`align: "num"`), left-align words.

## 6. Writing

- Crisp and peer-like. Lead with what changed or what to do. No cheerleading, no "Oops", no exclamation marks.
- Sentence case. Dispatcher words: load, pickup, delivery, deadhead, detention, TONU, rate confirmation, lane, customer. Money to the cent where it is owed (`$1,945.00`), to the dollar where it is summarised (`$5,940`).
- Say how a figure was got when it is not obvious ("Net 21", "on 3,500 mi driven", "measured on the road"), once.
- State what is missing, not that something "failed": "Missing: weight, two times", "Time zone assumed Central".
- Dates are Dallas dates (the fleet runs from Dallas). Say "Dallas days" where a person picks one.

## 7. Accessibility (the baseline, checked in Wave D)

- Every interactive element has an accessible name; icon-only buttons carry `aria-label`.
- One `h1` per page, headings do not skip levels, one `main`, tables have a name (`aria-label`) and `scope` on header cells.
- The first Tab stop on every page is a "Skip to content" link to `<main id="main" tabindex="-1">`, so a keyboard user does not tab through the whole sidebar each time.
- Focus is always visible (the accent ring; `:focus-visible`), never removed. Tab order follows reading order; nothing has a positive `tabindex`. Whole-row click is a convenience; the link in the first cell is the keyboard path.
- Modals hold focus, return it to what opened them, and close on Escape. The menu popovers are `<details>` and work with Enter and Space.
- Colour is never the only signal: every dot has its word, every delta has an arrow and an `aria-label`, every sorted column has an arrow and `aria-sort`.
- Live updates that change a count or a sort announce it in a polite status region.
- Contrast is a test, not an eyeball: `tests/theme-contrast.test.ts` covers both themes.
- Not covered by anything automatic: screen-reader pass with a real reader, and the printed sheets. Say so when a wave claims accessibility.

## 8. The deliberate exceptions

These break the "rule, don't box" rule on purpose; keep them as they are rather than spreading the pattern.

- **KPI charts** sit in boxed frames (`ChartFrame`): a chart is a different kind of thing from a list, and the box says where its axis ends.
- **The planner grid** and **dense data tables** use the full width and a bordered table.
- **Sheets** (`.rp`) are paper-white in night as well as day.
- **Two segmented controls** (`.tl-seg` on toolbars, `.cp-seg` in forms) still exist; they should be one. A change that touches either should converge them rather than add a third.

## 9. Before you ship a screen

1. Does it have one hero and one primary action?
2. Could any paragraph be a folded disclosure, one line, or nothing?
3. Is every status a dot and a word, and does healthy say nothing?
4. Does it repeat something another page owns?
5. Does anything the desk measured or looked up respect "typed wins"?
6. Tab through it with the keyboard only.
7. Look at it in night and day, at 1440 and 1024, with no horizontal overflow.
8. Does it say Customer? (The wording test will tell you.)
9. Is the change in the audit log if it changes data, and can it be undone if it deletes?
10. Gates: `tsc`, `eslint --max-warnings=0`, `vitest run` with `RUN_DB_INTEGRATION=true` run serially, and a production `next build`.
