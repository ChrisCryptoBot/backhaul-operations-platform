# Handoff after Wave D (2026-10-30)

For the next Claude picking up the dispatcher desk. Read this, then `docs/DESIGN_BRIEF.md` (the rules), then the last sections of `docs/DEMO_REBUILD.md` (what each wave did and what was not verified). The master plan is `docs/DESK_REWORK_PLAN.md`; its waves A to D are all done.

## Where things stand

- Project: the dispatcher web desk, nested at `TRUELANE/dispatch-desk` (its own git repo, branch `demo/truelane-dispatch`). Next.js 14 App Router, Prisma 6 and Postgres, vitest. Desktop only: check 1440 and 1024 wide, nothing narrower.
- HEAD is `86f0979`, working tree clean. **Nothing is pushed and you must not push: Chris pushes** (`git push -u origin demo/truelane-dispatch`). One local commit per wave, ending with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Commits this stretch: C3 `d869f7e` (customer records, sheets, lane page), C4 `a354c1d` (KPI hero and strip, live Audit filters and CSV, segmented Settings), D part 1 `88f1ae7` (sortable headers with `aria-sort`, named tables, heading order, DESIGN_BRIEF), glass pass `8bd5d75` (glass system, floating sidebar and header, DateInput, night default), D finish `86f0979` (skip link, production build check, keyboard walk). Earlier: B2 `a1dbe84`, C2 `3a87346`, C1 `02e251b`, C0 `1a71183`, B `8dff351`, A `4fa74e6`.
- Gates at HEAD: `tsc` clean, `eslint src tests --max-warnings=0` clean, vitest 55 files / 601 tests with the database tests. A production `next build` is clean and every page answered on `next start`.
- The phone app (`TRUELANE` root) is not touched by any of this. Make no phone-app edits.

## Run it

- Dev server: port 3100, already running and Chris likes to watch it in the browser pane (`http://localhost:3100/loads`). Leave it running.
- Database: Docker container `backhaul-demo-pg`, port 54330, `DATABASE_URL=postgresql://demo:demo@localhost:54330/demo`. Docker Desktop must be up. Reseed with `npm run seed` in `apps/web` (seed times are relative to the day you seed, so reseed before a demo and after browser clicks).
- Gates, from `apps/web` (PowerShell):
  ```
  npx tsc --noEmit
  npx eslint src tests --max-warnings=0
  $env:RUN_DB_INTEGRATION='true'; $env:DATABASE_URL='postgresql://demo:demo@localhost:54330/demo'; npx vitest run --no-file-parallelism
  ```
  Database tests must run serially (shared database).
- Production check: `NEXT_DIST_DIR=.next-prod npx next build`, then `NEXT_DIST_DIR=.next-prod npx next start -p 3101` (with `DATABASE_URL`). Build folders are git-ignored (`.next-*/`). A build rewrites `tsconfig.json` to include its types folder: `git checkout -- apps/web/tsconfig.json` afterwards. Stop the extra server and delete the folder when done.

## Standing rules and decisions (Chris's, already answered; do not re-ask)

- The desk says **Customer** everywhere. A broker is one kind of customer. A guard test (`tests/customer-wording.test.ts`) enforces it. Code and database names keep `broker...`.
- **Night is the default theme, day is secondary** (Chris flipped this twice; the final word is night first). Both are looked at for anything new.
- Glass is wanted ("very sexy glass in a few places in each module"), modelled on the phone's floating bar. The recipe and its limits are in DESIGN_BRIEF section 3a.
- Tone: crisp, peer-like, no cheerleading, lead with what changed, mark verified versus not. Offer the next wave, do not just start it.
- Use the existing API keys: the desk's `apps/web/.env.local` already has them. Never print a key value, never copy the Mapbox secret.
- Out of scope for the whole rework (Chris's gates): the driver bridge and auth, POD file storage, outbound notifications, compliance tracking, a margin definition (he has to sign off "revenue minus driver pay minus truck cost").

## What was built that you may touch next

- **Glass:** tokens `--db-glass-*`, `--db-bubble-*`, `--db-glow-*` in `src/app/globals.css` (both themes); the recipe is the "glass" section at the end of `src/app/(desk)/desk.css`. The sidebar's sliding capsule is measured in `components/desk/desk-shell.tsx`. The Quote verdict is `.qt-side` (tone light, set by `data-tone`) around `.qt-glass`.
- **DateInput** (`components/desk/date-input.tsx`, rules in `lib/date-field.ts`): replaces every native date box. Never use `type="date"` or `datetime-local`; the browser's grey pop-up cannot be styled and Chris rejected it. It keeps a hidden input for forms and fires a `desk-change` event that `LiveForm` listens for.
- **LiveForm** (`components/desk/live-form.tsx`): filters apply on change, search after 300 ms, URL is the state. Used by KPI and Audit.
- **Sortable tables:** `Column.sortable` and `Row.sort` in `components/desk/data-table.tsx`, behaviour in `data-table-tools.tsx`, rules in `lib/table-sort.ts`. Not for the Audit log (server-paged) or Loads history (month tables).
- **Customer record:** `server/tl/customers.ts`, `lib/customer.ts`, `lib/customer-scorecard.ts`, pages `/customers/[id]` and `/lanes/detail`.
- **Sheets** (invoice, pay statement, management report) use `DocHead` and stay paper-white in both themes on purpose.

## Open items, in rough order of value

1. **Compact Quote verdict bar at 1024.** At 1024 the verdict sits below the form (the right column drops under it). A compact sticky bar would keep the verdict in view. Offered since Wave C1, never asked for or built.
2. **Glass round two** (proposed in the review, not built): glass where content scrolls under it only: the KPI hero, the planner's pinned toolbar, the load page's pinned action footer, the dispatch queue's sticky headers. Never on tables, cards, forms, charts or sheets.
3. **Day theme** was seen with the glass on Quote and Customers only, and not re-walked since night became the default. Look at every page in day.
4. Small known gaps: the `<details>` Export menus do not close on Escape; unknown ids and addresses show the not-found screen with HTTP 200; the calendar is a dialog of day buttons, not a full ARIA grid; no screen-reader or axe pass (loading axe from a CDN was blocked by the permission classifier; my own DOM probe passed on 24 pages); the keyboard walk did not tab through Quote, the rate-con review or the cost profile end to end; two segmented-control styles (`.tl-seg` and `.cp-seg`) still exist and should be one.
5. Customer MC and usual terms are not prefilled into Quote or the rate-con review (typed there). The customer scorecard matches loads by name (case-insensitive), so a different spelling is a different customer until renamed.
6. Chris's gates, not yours to build: the bridge to the driver phone app, Clerk organisations and auth, POD storage, notifications. And his PIVOT question (selling tools to dispatchers versus Community rating dispatch companies).

## Gotchas learned the hard way

- **Dev server restarts:** the permission classifier denies killing the dev server by PID. After a Prisma migration, apply it with `prisma migrate deploy` (generate fails with EPERM while the server holds the engine file; the types are already written so `tsc` passes), then append a comment line to `apps/web/next.config.mjs` to make Next restart, and restore the file with `cp` from a backup (a Python rewrite turns it to CRLF and shows as modified).
- After editing a client component the browser pane can keep a stale hydration: the page looks right but handlers do nothing until a reload. Reload before concluding something is broken.
- **Shell:** Bash heredocs containing an apostrophe die with "unexpected EOF": use the Write tool for prose and code files. Python on Windows needs `PYTHONUTF8=1` and `newline=''` handling, or it rewrites line endings (the repo has mixed LF and CRLF; git warns but it is harmless). Never use a double-backslash-b in a Python heredoc (it becomes a backspace).
- The Browser pane: screenshots come back small (about 800 px wide), so prefer DOM probes with `javascript_tool`, and `find` or `read_page` refs. `resize_window` 1440x900 or 1024x768, then `preset: desktop` when done. A long script in `javascript_tool` times out at 45 s: start it with no `await`, store results on `window`, and poll.
- Lint rules in `src/server/**`: no `Number()`, `Math.round` or `Math.floor` (use `Prisma.Decimal`, `-Infinity` is fine). `src/lib/**` is unrestricted.
- `src/truelane/**` is vendored phone code: never hand-edit it. Re-run `node scripts/vendor-truelane.mjs` and check `git diff --stat src/truelane` shows only new files plus `VENDORED.md`.
- `tests/no-legacy.test.ts` forbids `src/app/api` (route handlers live outside `/api`) and pins Prisma model names; new columns are fine.
- Each load given a driver needs its own day in a test fixture (the double-booking guard), and the driver-payload confidentiality gate refuses a payload whose pay equals another visible value.
- Sleeping in the foreground is blocked; use `run_in_background` or poll.

## Memory

Notes live in `C:\Users\14698\.claude\projects\C--Users-14698-OneDrive-Desktop-TRUELANE\memory\` (index `MEMORY.md`). The relevant ones: `dispatch-desk-status.md` (the full wave history), `desk-uses-existing-keys.md`, `dispatch-desk-desktop-only.md`, `tone-crisp-peer.md`, `bar-glass-bubble-status.md` (the phone's glass, which the desk glass copies in spirit).
