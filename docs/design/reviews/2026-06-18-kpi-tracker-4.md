# Review — KPI TRACKER (4).zip (2026-06-18)

**Verdict: accept and implement, in the package's 3 waves.** This is a strong, constraint-aware
handoff — it kept density sacred, kept the orange brand (blue as a one-attribute alt), fixed two
real accessibility bugs, and shipped exact `--db-*` mappings + a lowest-risk-first rollout.

## What's genuinely good
- **Real AA fixes, not just aesthetics:** light `--db-fg` `#404041 → #2c2620` (4.0:1 → 13.4:1)
  and `--db-accent-on` to fix white-on-orange button text (~2:1 → 8.4:1). Both are legit bugs.
- **Density respected:** row height tokenized (`--db-row-h`) with a comfortable(30)↔compact(26)
  toggle; comfortable is no taller than today. Tabular numerals on all money/mileage.
- **Board hardening:** sticky leading columns (ref/status/broker) + banded column groups +
  instant-read Floor-RPM coloring — the right priorities for a 30-column board.
- **Token discipline:** every change is a `--db-*` variable; accent is a `[data-accent]` swap;
  density is `[data-density]`. Fully reversible, fits our plain-CSS/no-Tailwind stack.

## Scrutiny / things I'm holding back on
- **Dark surface shift (warm-brown → cool near-black)** is the most opinionated change. It's
  tokenized and the app currently defaults to **light**, so it's low-risk to land now and trivial
  to revert. Keeping it.
- **13px base font** (`--db-text-base`) vs today's 14px: I'm adding the token but NOT changing
  `.db-root` font-size in Wave 1 (would be a global visual shift) — that gets consumed in Wave 2
  alongside the density work.
- **New mono stack** (JetBrains/IBM Plex Mono) isn't loaded as a webfont — falls back to
  `ui-monospace` (today's effective value). Leaving the existing font tokens to avoid a
  font-loading surprise.
- Existing tokens the drop didn't redeclare (`--db-avatar-*`, `--db-scrollbar-*`, `--db-overlay`,
  `--db-muted-*`, `--db-cool-fg`, `--db-accent-hover`, etc.) are **preserved** — I'm layering the
  new tokens additively, not replacing the block.

## Rollout (per IMPLEMENTATION.md)
- **Wave 1 (CSS-only):** add new tokens; light `--db-fg` fix; `--db-accent-on` on primary
  buttons; tabular numerals. No structural change. ← doing now.
- **Wave 2 (CSS + light TSX):** density toggle, sticky leading columns, banded column groups.
- **Wave 3 (TSX):** collapsible sidebar + slim header shell; reparent screens; sign-in split.
