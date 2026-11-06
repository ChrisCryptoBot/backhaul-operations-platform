# Signals

An alert says what needs attention now and is worked out from the loads every time someone opens a page. It is stored nowhere, so it cannot say how long it has been there, who is on it, or when it cleared. A **signal** is an alert that is kept: the same rules, the same words, plus a history.

This page covers the stored list (built) and what the desk tells people (the outbound half, see "Not built yet").

## What is kept

One row per alert key (the load and the rule, for example `<load>:NO_TRUCK`), unique per desk. A row never goes away.

| Field | Meaning |
| --- | --- |
| status | `open`, `acknowledged` or `resolved` |
| first seen / last seen | when the rules first raised it, and the last time they still did |
| resolved at | when the rules stopped raising it |
| reopen count | how many times it came back after clearing |
| acknowledged by / at | who said they are on it |
| last level sent | the most severe level a notification has gone out for (used by the outbound half) |

How the stored list follows the rules is one pure function, `diffSignals` in `apps/web/src/lib/signals.ts`:

- **New**: raised and never stored. Stored open, first seen now.
- **Seen**: raised and stored. Last seen moves, the words and level follow the rules. An acknowledged signal whose level gets **worse** (info to warn, warn to block) is open again; one that gets less severe stays as it is.
- **Resolved**: stored, not resolved, no longer raised. Kept, with the time it cleared.
- **Reopened**: raised again after it cleared. Open again, first-seen history kept, the reopen count goes up, the acknowledgement and the "sent" level are forgotten so it is news again.

`syncSignals` (`apps/web/src/server/tl/signals.ts`) applies that for the whole desk in one transaction with the workspace locked, so two syncs at once cannot make the same signal twice. The work is a handful of statements whatever the number of alerts. A page view syncs at most once a minute (`syncSignalsIfStale`); the scheduled run (below) does it too, so the list is never older than a minute when someone looks, and is kept even when nobody does.

## Who sees what

A person limited to some terminals reads only the signals of loads placed in those terminals, plus loads not placed anywhere yet (the same rule as every other list). A signal with no load is whole-desk news and is shown only when no terminal is chosen. A limited person cannot acknowledge a signal outside their terminals by guessing its id: they get the same answer as for one that does not exist.

Acknowledging is the dispatch capability and is audited with the load. The screen is `/signals` (Dispatch group, after Alerts); the settings are in Settings, Rules (admin).

## Settings

Stored on the workspace, each optional (blank means the built-in default):

| Setting | Default |
| --- | --- |
| Tell people about | block only (`block`, `warn` or `info`: that level and everything more severe) |
| Weekly report | on, Monday, 7 AM on the carrier's clock |

They only say what goes **when** a channel is set up. With none set up nothing leaves the desk, and the Settings card says so.

## Applying the migration

`prisma/migrations/20261204000000_signals` adds `signals`, `notification_log` and four workspace columns, and seeds nothing. On the desk's own Supabase, apply it after `20261203000000_imported_history`, then re-run `supabase/lockdown_rls.sql` (the lockdown file is always last and is renamed with each migration: it is now `20261204000001_enable_rls.sql`).

## Not built yet

Sending, the scheduled run and the weekly report are the next piece. Nothing in this page's built half sends anything.
