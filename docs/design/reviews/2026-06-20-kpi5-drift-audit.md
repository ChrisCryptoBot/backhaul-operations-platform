# KPI TRACKER (5) — Drift Audit & Triage Checklist

Date: 2026-06-20. Compares the design package `DESIGN/KPI TRACKER (5).zip` against the live
`apps/web` implementation. **Mark each row:** `[K]` keep-as-is (accept the divergence) · `[I]` implement to
match design · `[S]` skip/defer. High-severity rows are the ones that change how dark/dense the app *feels*.

Legend: **DRIFT** = design intent not yet built · **DIVERGENCE** = live deliberately differs (a prior
product decision — usually you'll keep these). Sev = high/med/low.

---

## 0. The big decisions (read these first — they cascade)

| # | Decision | Today (live) | Design wants | Sev |
|---|---|---|---|---|
| **BIG-1** | **Default theme** | **Light-first** (first load = light) | **Dark-first** (`<html data-theme="dark">`) | high |
| **BIG-2** | **Board header** | Two bars: 48px header + separate 56px sub-head w/ day-totals | ONE 48px header that absorbs title + day-totals | high |
| **BIG-3** | **Board toolbar** | No toolbar row at all (CSS exists, never rendered) | 44px toolbar: search + filter chips + lot-jump chips + density toggle | high |
| **BIG-4** | **Sticky leading columns** | Only REF# pins; STATUS + BROKER scroll away | ref·status·broker all pin (left 0/90/190) | high |
| **BIG-5** | **Floor-RPM coloring + below-floor dot** | NBY column, untinted; no attention dot | RPM health tint (strong/thin/below) + leading dot + tinted row | high |
| **BIG-6** | **Copilot** | Floating, draggable FAB window (400px) | Docked 360px column, always present | high (likely intentional) |
| **BIG-7** | **Sign-in (prod)** | Clerk widget; designed card only shows in dev-bypass | Hand-built split card for real users | high (Clerk constraint) |
| **BIG-8** | **PermissionDenied surface** | Missing entirely (settings/audit have no denied branch) | Styled lock surface for non-admins | high |
| **BIG-9** | **Floor RPM → NBY rename** | NBY everywhere (board, dashboard, drawer) | Design still says "Floor RPM" | med (intentional) |
| **BIG-10** | **FSC parked → TONU** | TONU columns; FSC dormant | Design shows FSC | med (intentional) |

---

## 1. Tokens & theme  (`board.css` token block, `theme.tsx`, `layout.tsx`)

- [ ] **T1 · DRIFT · high** — Default theme is light; design is dark-first. Fix: default to `"dark"` when no saved theme + set `<html data-theme="dark">`.
- [ ] **T2 · DRIFT · med** — `data-accent` never set on `<html>`, so the blue-alt branches (which exist) are unreachable. Fix: set `data-accent="orange"` default + a toggle.
- [ ] **T5 · DRIFT · low** — Legacy warm-brown tokens left un-cooled in dark: `--db-accent-hover`, `--db-avatar-*`, `--db-scrollbar-thumb`, legacy `--db-info-*`/`--db-pod-*`/`--db-muted-*`. Fix: recolor toward cool palette (optional).
- [ ] **T8–T21 · DRIFT · low (batch)** — ~13 light-theme hex values are 1–2 steps off canonical paper/border/fg/semantic (`--db-bg`, `-bg-elev-1/3`, `-rail`, `-border-soft/-strong`, `-fg-mid/-dim/-faint`, `-accent-fg/-bg`, `-pos-bg/-neg-bg`, `-warn`, `-warn-bg`). Most-visible: **T13** `--db-border-strong` (#bea88f→#c5b39b), **T20** `--db-neg`/`--db-warn`. Fix: align hexes to `tokens.css`.
- [ ] **T22 · DRIFT · med** — `--db-info` semantic token missing; live `--db-info-*` are legacy purple, design wants blue (`#1f5bbf`/`#7eb6ff`). Fix: add/reconcile info tokens.
- [ ] **T28 · DRIFT · med (verify)** — `--db-accent-on` token is present & correct, but confirm `.primary`/filled buttons actually consume it instead of hardcoded `#fff`.
- [ ] **T29 · DIVERGENCE · low** — `[data-density="compact"]` scoped to `.db-root` (board-only) not `:root` (app-wide). Keep if board-only density is intended.
- ✅ Already matched (no drift): cool near-black dark surfaces `#0a0a0f` **are active** (re-declared, last-wins); `--db-fg` light fix `#2c2620` applied; full status-pill token set, rpm token set, type/spacing/layout/radii/shadow scales, blue-accent CSS branches — all present.

## 2. Shell — sidebar / header / toolbar / copilot  (`app-sidebar.tsx`, `board-shell.tsx`, `copilot-panel.tsx`)

### Sidebar
- [ ] **S1 · DRIFT · med** — Missing "Rate Cons" Operations item; System order is Settings→Audit (design: Audit→Settings).
- [ ] **S2 · DRIFT · high** — Nav **count pills** (`db-side-count`, incl. `.alert` warn variant) not implemented at all. Fix: render counts per item + CSS.
- [ ] **S3 · DRIFT · med** — Persistent 28×28 accent brand tile (`db-side-mark`) missing; live monogram only shows when collapsed.
- [ ] **S4 · DIVERGENCE · low** — Wordmark "Backhaul / Co-Pilot" centered vs design "DROP BUCKET / BACKHAUL OPS" left-aligned mono. (Rebrand — confirm.)
- [ ] **S5 · DRIFT · med** — Nav item sizing inflated: pad 9/10 (design 7/10), icon 22 (18), font lg/600 (base/500), plus a global `zoom:1.25` on `.db-sidebar`. Fix: match spec, drop zoom.
- [ ] **S6 · DRIFT · low** — Group labels: live text-sm/700/0.1em vs design text-3xs/600/0.12em.
- [ ] **S8/S9 · DIVERGENCE · low** — Foot row shows region (not user "Chris McDaniel / Coordinator"), flat avatar (no gradient), inflated type.
- [ ] **S10 · DRIFT · low** — Collapse uses text glyph `«`; design uses rotating chevron SVG.

### Header
- [ ] **S12 · DRIFT · high** — Day-totals strip lives in a separate 56px bar; design folds it into the 48px header (see BIG-2). Costs a row of board height.
- [ ] **S13 · DRIFT · med** — Board header has no title/crumb (they sit in the sub-head bar).
- [ ] **S14 · DRIFT · med** — Search is in the header; design puts it in the board toolbar.
- [ ] **S15 · DRIFT · med** — Day-totals styling: no fixed 32px height, no `tabular-nums`, accent stat uses `--db-cool-fg` not `--db-accent-fg`.
- [ ] **S16 · DRIFT · med** — No region **accent pill** (`db-h-region`); region is only a plain select.
- [ ] **S17 · DIVERGENCE · low** — Date button uses `db-datepicker` (slightly smaller) vs design `db-h-date`.
- [ ] **S19 · DIVERGENCE · low** — Extra header sign-out button (design has none).

### Board toolbar (entire row missing — see BIG-3)
- [ ] **S20 · DRIFT · high** — No `db-toolbar` row rendered on the board.
- [ ] **S21 · DRIFT · high** — Filter chips (`db-tb-chip`) missing; CSS not even present.
- [ ] **S22 · DRIFT · high** — Lot-jump chips (`db-tb-lot`) CSS exists but no JSX renders them; design's `.over` neg variant absent.
- [ ] **S23 · DRIFT · med** — Density segmented control (`db-seg`) CSS exists but never rendered; density hard-coded comfortable.
- [ ] **S24/S25 · DRIFT · low** — Search width 240 vs 220, more boxed; separator spacing off.

### Copilot dock
- [ ] **S26/S27/S28 · DIVERGENCE · high** — Floating draggable FAB window (400px) vs docked 360px column. (Likely an intentional product call — confirm.)
- [ ] **S30 · DRIFT · med** — Bubbles: live radius `r-md`, no asymmetric corner, user bubble is tint not solid accent, role label on both roles. Design: `r-lg` + 3px inner corner, solid-accent user bubble, label on bot only.
- [ ] **S31 · DRIFT · med** — Result card is generic confirm card; design has structured `db-cop-card-head`/`-row` result (ref + status pill + lane + floor RPM + target).
- [ ] **S32 · DRIFT · med** — Suggestion chips (`db-cop-suggest`) missing (CSS absent).
- [ ] **S33 · DRIFT · low** — Single-line input vs design's autosizing textarea in a rounded container.
- [ ] **S34 · DRIFT · low** — Footer hint line ("Reads live board data · actions require confirmation") missing.
- [ ] **S29/S36 · DRIFT · low** — Copilot sub-text drops region/CDC; mark uses `--db-accent-fg` not `--db-accent`.

## 3. Daily board table  (`board-shell.tsx`, `status-pill.tsx`)

### Column groups
- [ ] **B1/B2 · DIVERGENCE · med** — Live has 6 bands (Load/Driver&Equip/Pickup/Delivery/Financial/Miles&RPM, 32 cols) vs design 5 (LOAD/PICKUP/DELIVERY/EQUIPMENT/FINANCIAL, 19 cols). Richer schema — confirm or reconcile.
- [ ] **B3 · DRIFT · med** — Primary band header not sticky (`stick stick-ref stick-last` missing) so it scrolls with the financial columns.

### Sticky columns (see BIG-4)
- [ ] **B4 · DRIFT · high** — STATUS column not pinned (`stick stick-status` missing).
- [ ] **B5 · DRIFT · high** — BROKER column not pinned (`stick stick-broker stick-last` missing).
- [ ] **B6 · DRIFT · high** — `.stick-status`/`.stick-broker` CSS offset rules absent.
- [ ] **B7 · DRIFT · med** — `.stick-ref` width 140 conflicts with design 90/190 offset set.
- [ ] **B8 · DRIFT · low** — Seam pseudo-element `right:0` vs design `-1px`.

### Coloring (see BIG-5)
- [ ] **B9 · DRIFT · high** — No Floor-RPM column to tint (nearest is untinted NBY).
- [ ] **B10 · DRIFT · high** — `rpm-strong`/`rpm-thin` classes never emitted; CSS for them absent (only `.rpm-below` defined).
- [ ] **B11 · DRIFT · med** — Below-floor row tint absent (rows tint only via attentionSeverity).
- [ ] **B12 · DRIFT · high** — Leading attention dot (`db-flag-dot`) styled but never rendered.
- [ ] **B13 · DIVERGENCE · low** — Live adds Empty% threshold tinting (not in design) — keep.

### Status pill
- [ ] **B14 · DRIFT · med** — `.db-pill` lacks mono, weight 600, 0.06em uppercase, and the 5px leading dot.
- [ ] **B15 · DRIFT · med** — Pills use generic tokens, not the defined `--db-status-{x}-{fg,bg}` pairs.

### Drop-lot section row
- [ ] **B16 · DRIFT · med** — Capacity shows only `n`, not `n/cap`; `.over`/`.full` states never applied.
- [ ] **B17 · DRIFT · med** — Drop-hook flag tag (`db-tag warn`) not rendered in section row.
- [ ] **B18 · DRIFT · low** — Section label sticky `left:8` vs design `14`; class renamed.
- [ ] **B20 · DRIFT · low** — Empty-lot copy differs + not wrapped in sticky span.

### Misc
- [ ] **B23 · DRIFT · med** — No density toggle (root hard-coded comfortable; compact tokens unused). (Same as S23.)
- [ ] **B25 · DRIFT · med** — Lot-jump chips not rendered (anchors `#sec-{id}` exist, nothing links). (Same as S22.)
- [ ] **B26 · DRIFT · low** — Toolbar filter chips (status/broker/below-floor) missing. (Same as S21.)
- [ ] **B27 · DRIFT · low** — Day-totals strip lacks a Floor-RPM accent stat.
- ✅ Matched: zebra striping, tabular-nums on `.num` cells, section code chip.

## 4. KPI Dashboard  (`kpi-dashboard.tsx`)  — redesigned in an earlier wave; mostly divergences
- [ ] **D2 · DRIFT · low** — `.db-kpi-label` 11px vs design 10.5px.
- [ ] **D3 · DRIFT · low** — Delta bg uses `-bg-soft` tokens vs design `--db-pos-bg`/`--db-neg-bg`.
- [ ] **D11 · DRIFT · med** — Chart tooltip hardcodes `#ffffff`/`#111111` — **breaks in dark mode**. Fix: use tokens.
- [ ] **D12/D16/D18 · DIVERGENCE · med** — Trend/lane "Floor RPM" renamed to "NBY" (BIG-9).
- [ ] **D14/D15 · DIVERGENCE · med** — Lanes table adds Driver Type + Lane Note, swaps FSC→TONU (BIG-10).
- [ ] **D8 · DIVERGENCE · med** — Trend chart is Recharts, not the design's hand-rolled SVG sparkline (`.db-trend-svg` CSS now dead).
- [ ] **D13 · DRIFT · low** — Trend table "Tender%" column is hardcoded `—` (no data wired).
- [ ] **D20 · DRIFT · med** — Rule severity enum: live INFO/WARN/ACTION_REQUIRED vs design BLOCK/WARN/INFO (`.db-rule-sev.block` may be dead).
- [ ] **D5/D6/D7/D10/D21/D28 · DIVERGENCE · med (batch)** — Live-only surfaces the design never had: region+comparison selects, filter row, trend-deltas `<details>`, 6-card detailed-trends gallery, acknowledgeable alerts card, week-picker/IB-entry/new-rule modals. Confirm keep.
- [ ] **D25 · DRIFT · low** — Mgmt footer "Generated live · Drop Bucket" vs design timestamped/versioned stamp.
- [ ] **D27 · DIVERGENCE · low** — `.db-tabs` fixed-height scroll vs design free-flow.

## 5. Load detail drawer  (`load-detail-drawer.tsx`)  — earlier wave; mix
- [ ] **W14 · DRIFT/DIVERGENCE · high** — RPM trio is Loaded/**NBY**/**Empty%**; design is Loaded/**Floor RPM**/**All-in $**. Live duplicates Empty% (also in KV grid).
- [ ] **W15 · DRIFT · med** — Remove the duplicate Empty% card; design's 3rd card is All-in money.
- [ ] **W1 · DRIFT · med** — Eyebrow 11px vs design 9.5px.
- [ ] **W2 · DRIFT · low** — Title missing weight 500 + 0.02em letter-spacing.
- [ ] **W4 · DRIFT · med** — Meta row drops "Booked {time}", shows Route instead.
- [ ] **W7 · DRIFT · med** — Timeline shows no per-stage times (`.db-tl-time` unused).
- [ ] **W11/W12 · DRIFT · low** — Timeline step/bar min-widths 52/10 vs design 56/12.
- [ ] **W13 · DRIFT · med** — Financials section missing the "vs target +$…" kicker.
- [ ] **W22/W23/W24 · DRIFT · low** — Rate-con: thumb 22×26 vs 28×32; no pages/KB sub-text; "Open ↗" text vs link icon.
- [ ] **W3/W16/W17/W19/W20/W21/W25 · DIVERGENCE (batch)** — Live-only: Edit toggle + edit forms, DH alert banner, 14-field ops grid (vs 8), attention/coordinator notes, Legs section, rate-con preview iframe. Confirm keep.
- ✅ Matched: drawer width 460 (clamped), KV grid gaps, current-dot ring token, a11y hardening.

## 6. Reference managers  (lanes / brokers / drop-lots)  — supposedly already on this package

### Lanes
- [ ] **L1 · DRIFT · low** — KPI note uses Info icon; design uses a spark/sparkle icon (no spark icon exists in the set).
- [ ] **L2 · DRIFT · low** — Edit-modal hint drops "last changed {date} by {actor}" attribution.
- [ ] **L3 · DRIFT · low** — Origin/dest state inputs `maxLength=40` vs design `2`.
- [ ] **L4/L5 · DIVERGENCE · low** — Extra "Back to board" link; rows add `.odd` zebra (design lane rows have none).

### Brokers
- [ ] **BR1 · DRIFT · med** — Edit footer is "Remove broker | Close" with Save moved inline; design wants footer "Remove broker | Cancel | **Save broker**".
- [ ] **BR3 · DRIFT · med** — Contacts header missing the "+ Add contact" `db-btn sm` button.
- [ ] **BR2/BR6 · DRIFT · low** — Contacts title uses `db-set-eyebrow` not `db-drawer-section-title`; status select uses `db-input` not `db-select`.

### Drop lots
- [ ] **DL1 · DRIFT · med** — Order cell missing the grip handle (`.db-ord .grip` CSS unused) — drag affordance gone.
- [ ] **DL2/DL3 · DRIFT · med** — Slip-seat / drop-hook flag chips missing their seat/hook icons (icons don't exist in set).
- [ ] **DL4 · DIVERGENCE · med** — Flags are inline toggle buttons + show "No drop-hook" off-chip; design uses static chips, no off-state. Confirm.
- [ ] **DL5/DL6 · DRIFT · med** — Over-cap red fill is dead: denominator auto-expands + pct clamped to 100; `.db-cap-fill.over` CSS missing.

### Shared reference scaffold
- [ ] **R1 · DRIFT · med** — Sub-tabs show no per-section count badges (`db-side-count`) the design has.
- [ ] **R2/R5/R6 · DIVERGENCE · low** — Class-name divergences: `db-modal-overlay` vs `db-modal-backdrop`, `db-btn-ghost` vs `ghost`, `db-uistate` vs `db-empty-state`. Self-consistent in live.
- [ ] **R3 · DRIFT · low (verify)** — Confirm default modal width matches design 520px (wrapper comment cites 460).

## 7. Settings / Audit / Sign-in / UI-kit

### Settings
- [ ] **SET1 · DRIFT · high** — No permission-denied branch (page should show a styled lock for non-admins). Depends on K12.
- [ ] **SET4 · DRIFT · med** — Thresholds chip is gear + "Board colors"; design is sliders icon + region label.
- [ ] **SET3/SET6/SET7/SET8/SET9 · DRIFT · low** — `.db-set-status .mono` size rule missing; key-icon offset 24 vs 30px pad; hints below field vs inline on label; save meta drops "by {actor}".
- [ ] **SET2/SET5/SET11 · DIVERGENCE · low** — `db-input` selects, a "No key" state, and a "Back to board" link (live enhancements).

### Audit
- [ ] **AU1 · DRIFT · high** — No permission-denied branch. Depends on K12.
- [ ] **AU2 · DRIFT · med** — Append-only chip uses Clipboard icon; design uses a history icon.
- [ ] **AU3 · DRIFT · med** — Count line shows "more available" not "of 1,284" grand total.
- [ ] **AU4/AU5/AU6/AU9 · DRIFT · low** — `db-input` selects; search pad 24 vs 28; "Clear filters" solid vs ghost; reason max-width 220 vs 200.
- [ ] **AU7/AU8/AU10 · DIVERGENCE · low** — True-empty variant, zebra striping, dynamic diff-tinting (live enhancements/approximations).

### Sign-in
- [ ] **SI11 · DRIFT/constraint · high** — Production renders Clerk's widget; the designed split card only appears in dev-bypass (BIG-7). Real users never see the designed body.
- [ ] **SI1 · DRIFT · med** — Live uses a separate `db-auth-*` namespace (mixed with `db-signin-*` inner) instead of the design's `db-signin-*` shell.
- [ ] **SI2 · DRIFT · med** — Brand panel is a capped 420px rail, not the design's 50/50 split.
- [ ] **SI8 · DRIFT · med** — Auth card is a bordered surface; design's is a borderless 340px stack.
- [ ] **SI3 · DIVERGENCE · med** — Wordmark "Backhaul / BUCKET·NORTHEAST" vs design "DROP BUCKET / BACKHAUL OPS·NORTHEAST".
- [ ] **SI4/SI5/SI6/SI7/SI9/SI10/SI12 · DRIFT · low (batch)** — Mark glyph/size/radius, decorative wash direction/opacity, wordmark tracking, SSO-vs-email control order, OR casing, footer copy.

### UI-kit / primitives
- [ ] **K12 · DRIFT · high** — `PermissionDenied` component + `.db-denied`/`.db-denied-meta` CSS absent entirely (drives SET1/AU1).
- [ ] **K15 · DRIFT · med** — `UndoToast` is bottom-right `db-undo-toast`, no success check, plain link — design is bottom-center `db-toast` with check + accent undo pill.
- [ ] **K17 · DRIFT · med** — Missing sliders + history icons; live substitutes gear/clipboard (drives SET4/AU2).
- [ ] **K1/K2/K3/K5/K6 · DRIFT · low-med (batch)** — Modal: overlay `db-modal-overlay` fixed/no-blur vs design `db-modal-backdrop` absolute/blur; plain-title header is bold-700 + close only with eyebrow vs design's lighter always-flex head w/ close; hard-coded radius/shadow vs tokens; footer lacks rail bg; body is flex-gap vs plain scroll.
- [ ] **K11 · DRIFT · med** — EmptyState reuses `db-uistate` namespace, not design's `db-empty-state` (padding 48 vs 56, copy max-width none vs 360).
- [ ] **K7/K8/K9/K10 · DRIFT · low** — ConfirmDialog: textarea vs single input, drops "Recorded in the audit trail." hint, title in header vs inline-next-to-icon, danger class vs inline style.
- [ ] **K13/K14/K16 · DIVERGENCE · low** — `role="switch"`/`aria-checked` (better a11y), labeled span, Esc/autofocus/busy-lock (live enhancements).

---

## How to read the totals
- **High-severity DRIFT (genuinely missing design intent):** BIG-1..5, BIG-8, S2, S12, S20–S22, B4–B6, B9/B10/B12, K12 (+SET1/AU1).
- **High-severity DIVERGENCE (deliberate — you'll probably keep):** BIG-6 (floating copilot), BIG-7 (Clerk), BIG-9 (NBY), BIG-10 (FSC→TONU), W14.
- **Everything else** is med/low polish — token nudges, icon swaps, spacing, class renames.
