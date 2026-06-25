# Design refresh workflow

This folder coordinates a Claude Design–led visual refresh of Drop Bucket. Claude Design
takes the creative lead; Claude Code (the dev agent) reviews each drop, scrutinizes it against
the constraints below, and implements what wins.

## How it works
1. Open [`PROMPTS.md`](PROMPTS.md). Paste the **primary prompt** into Claude Design and attach
   the codebase (zip of the repo, or at minimum `apps/web/src/app/board.css`, `globals.css`,
   and `apps/web/src/components/board/board-shell.tsx`) plus screenshots of the live board in
   dark and light. Then use the follow-up prompts to go deeper per area.
2. Export Claude Design's result as a **zip** and drop it into [`incoming/`](incoming/).
   (Zips are git-ignored — they're working artifacts, not committed.)
3. Tell Claude Code: *"review the latest design drop."* It will unzip, scrutinize against the
   constraints, write a critique in [`reviews/`](reviews/), and implement the parts that hold up
   — incrementally, keeping `tsc`/`eslint`/`vitest` green.

## What Claude Code holds the line on (regardless of creative direction)
- **Density is sacred.** This is a high-information operational board, not a marketing site.
  More legible information per screen, not more whitespace.
- **Implementable as CSS custom properties** mapping to the existing `--db-*` tokens. Stack is
  Next.js 14 App Router + plain CSS — no Tailwind, no component-library lock-in.
- **Both themes** (warm-paper light + dark) and **WCAG AA** contrast.
- **Keyboard accessibility** preserved (the board has keyboard nav today).

## Current system at a glance (what Claude Design is evolving)
- **Accent:** Cloudflare orange `#f48120`. **Type:** Inter / Geist Sans (UI), mono for IDs/money.
- **Tokens:** `--db-bg`, `--db-bg-elev-1..3`, `--db-border*`, `--db-fg/-mid/-dim/-faint`,
  semantics `--db-pos` / `--db-neg` / `--db-warn` / `--db-info` / `--db-pod`, status + RPM colors.
  Defined in `apps/web/src/app/board.css` (`:root` light, `:root[data-theme="dark"]` dark).
- **Layout:** top horizontal nav (`db-topnav`) with brand "BACKHAUL BUCKET", primary links, and a
  right cluster (region/date/avatar). **No left sidebar yet.**
- **Key screens:** Daily Load Board (dense ~30-column table grouped by drop-lot, drag-drop),
  KPI Dashboard (cards + lane table + charts), rate-con review / manual entry, Settings,
  Reference data (brokers/lanes/drop-lots), the copilot chat panel, Clerk sign-in.
