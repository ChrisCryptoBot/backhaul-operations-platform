# Claude Design prompts

Copy-paste these into Claude Design. Attach the codebase (repo zip, or at least
`apps/web/src/app/board.css`, `globals.css`, `components/board/board-shell.tsx`, and the
screens under `apps/web/src/app/`) plus screenshots of the live Daily Board in **dark and
light**. Start with Prompt 1; then use the follow-ups to go deeper.

---

## Prompt 1 — Primary creative brief (start here)

> **Role.** You are a senior product designer for dense, data-heavy operational SaaS — your
> references are tools like Linear, Ramp, Vercel's dashboard, and modern TMS/logistics
> software. You are leading a visual redesign and I want you to take the creative lead.
>
> **Product.** "Drop Bucket" (wordmark: **BACKHAUL BUCKET**) is a freight **backhaul
> operations** platform for an Northbridge Furniture backhaul coordinator in the US Northeast. The
> daily users are a coordinator and dispatchers who live in this tool all shift; it replaces
> Excel trackers. The codebase is attached.
>
> **Key screens.**
> - **Daily Load Board** (primary, ~90% of usage): a dense, spreadsheet-like table of loads
>   grouped into drop-lot sections, ~30+ columns (ref#, status, scale-before/after, broker,
>   MG/TMW flags, driver, truck/trailer, commodity, equipment, shipper, pickup city/window,
>   receiver, delivery city/date, POD, line-haul, FSC, TONU, all-in revenue, loaded/deadhead/
>   total/negotiable miles, loaded & floor RPM). Rows drag-drop between sections. Information
>   density and at-a-glance scannability are the whole point.
> - **KPI Dashboard:** metric cards, a lane-performance table, trend charts.
> - **Rate-confirmation review** and **manual entry** forms.
> - **Settings** (admin) and **Reference data** management (brokers/lanes/drop-lots).
> - A docked **conversational copilot chat panel** on the board.
> - **Sign-in** (Clerk).
>
> **Current design system — evolve it, don't discard it.** It's tokenized as CSS custom
> properties named `--db-*`, with a warm-paper **light** theme and a **dark** theme:
> - Accent: Cloudflare orange `#f48120`. Elevation: `--db-bg`, `--db-bg-elev-1..3`. Text:
>   `--db-fg / -mid / -dim / -faint`. Semantics: `--db-pos` (green), `--db-neg` (red),
>   `--db-warn` (amber), `--db-info`, `--db-pod`; plus status-pill and RPM colors.
> - Type: Inter / Geist Sans for UI, a mono stack for IDs and money/mileage.
> - Layout today: a **top horizontal nav** (brand + Daily Board / KPI Dashboard / Settings /
>   Lanes / Brokers / Drop lots / Audit) with a right-aligned region/date/avatar cluster.
>   **There is no left sidebar yet.**
>
> **Creative brief — you lead.** Make it materially more refined, modern, and "premium
> operations tool" without losing density. Explore at least:
> - A left **sidebar** navigation vs the current top nav — collapsible; decide what lives in
>   the sidebar vs a slim top header (region/date/board context/user).
> - **Header/topbar** restructure: brand, region + board-date switchers, user.
> - **Spacing & rhythm:** a consistent spacing scale; tighten and clarify the board without
>   inflating row height.
> - **Typography:** type scale, weights, and tabular/numeric alignment for money & mileage.
> - **Color:** refine the palette and semantic system; keep the orange accent unless you make a
>   compelling case; deliver both themes; status/RPM coloring that reads instantly.
> - **The data table:** column grouping, sticky header + sticky first columns, section/zebra
>   treatment, status pills, attention/severity cues, and an optional density toggle.
> - **Component polish:** buttons, inputs, selects, pills, cards, drawers/modals, the copilot
>   chat panel, and empty/loading/error states.
> - Anything else you spot.
>
> **Hard constraints (non-negotiable).**
> 1. It stays a **high-density** operational tool — never trade information density for
>    marketing whitespace. The coordinator must see *more*, legibly, not less.
> 2. **WCAG AA** contrast in both themes.
> 3. Must be implementable as **CSS custom properties mapping to the existing `--db-*` tokens**
>    (add new tokens freely, but specify them). Stack is **Next.js 14 App Router + plain CSS** —
>    no Tailwind, no component-library lock-in.
> 4. **Dark-first**, with a fully working light theme.
> 5. Preserve **keyboard accessibility** (the board is keyboard-navigable today).
>
> **Deliverables — package as a downloadable .zip with this structure:**
> - `/mockups` — high-fidelity mockups (PNG or SVG) of: Daily Load Board (dark **and** light),
>   KPI Dashboard, one Reference screen, sign-in, and the board with the copilot panel open.
>   Include sidebar **collapsed** and **expanded** states.
> - `/tokens/tokens.css` — the full proposed `--db-*` custom-property set for both `:root`
>   (light) and `:root[data-theme="dark"]` (dark).
> - `/components` — specs/redlines for sidebar, header, table row, pills, buttons, inputs,
>   drawer, and chat panel (states + spacing + type).
> - `RATIONALE.md` — the design thinking; what changed vs today and why.
> - `IMPLEMENTATION.md` — a mapping from your tokens/components back to the existing `--db-*`
>   variables and the files that hold them (`board.css`, `globals.css`, `board-shell.tsx`) so a
>   developer can wire it in incrementally.
>
> Begin with the overall direction + the sidebar/header/layout system and the token palette,
> then the Daily Board, then the remaining screens.

---

## Prompt 2 — Daily Load Board deep-dive

> Focus only on the **Daily Load Board** now. It's a ~30-column, multi-section table that a
> coordinator scans all day. Show: the full table with sticky header and sticky leading columns
> (ref#/status/broker), drop-lot section headers, a single highly-resolved row with realistic
> data, status pills, attention/severity treatment, the money/mileage columns with tabular
> numerals and positive/negative/warn coloring, and a **comfortable vs compact density**
> comparison. Propose how to group the 30+ columns visually (primary vs secondary vs
> financial) and how horizontal scroll / column pinning should behave. Keep it dense — optimize
> for scannability and error-spotting, not whitespace. Deliver mockups (dark + light) plus the
> row/cell/pill specs.

## Prompt 3 — Sidebar + header system

> Design the **navigation shell**: a collapsible left **sidebar** (primary nav: Daily Board,
> KPI Dashboard, Reference [Brokers/Lanes/Drop-lots], Review, Settings, Audit) and a slim **top
> header** (brand, region switcher, board-date picker, user/avatar, and the "Ask copilot"
> entry). Show expanded and collapsed sidebar, active/hover states, and how the header adapts.
> Specify exact widths, spacing, type, and the `--db-*` tokens used. Keep the content area
> maximally wide for the board.

## Prompt 4 — Copilot chat panel

> Redesign the docked **copilot chat panel** that lives on the board (users edit loads and
> reference data by chat). Show: collapsed launcher, expanded panel, a user turn, an assistant
> turn, a **confirmation card** for a risky/financial change (before/after style), an action
> log/applied-changes indicator, and loading + error states. It must coexist with the dense
> board (dock or overlay — your call). Deliver mockups (dark + light) + component spec.

## Prompt 5 — Token + dev handoff (do last)

> Produce the final **`tokens.css`** only: every `--db-*` custom property for `:root` (light)
> and `:root[data-theme="dark"]` (dark), including any new tokens your redesign introduced,
> with brief comments grouping them (background/elevation, border, text, accent, semantic,
> status, chart, scrollbar, type, spacing scale, radius, shadow). Then an **`IMPLEMENTATION.md`**
> that maps each component change to the existing files (`apps/web/src/app/board.css`,
> `globals.css`, `apps/web/src/components/board/board-shell.tsx`) and lists the changes in
> recommended implementation order (lowest-risk first).

---

## Tips for best output
- Attach **screenshots of the live board in both themes** — Claude Design designs far better
  against the real thing than from description alone.
- Ask for **SVG** where possible (crisper, and easier to extract exact colors/spacing).
- If a drop is too sweeping to ship safely, that's fine — Claude Code will stage it as tokens +
  incremental component changes rather than a big-bang rewrite.
