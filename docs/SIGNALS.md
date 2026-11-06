# Signals, notifications and the weekly report

An alert says what needs attention now and is worked out from the loads every time someone opens a page. It is stored nowhere, so it cannot say how long it has been there, who is on it, or when it cleared. A **signal** is an alert that is kept: the same rules, the same words, plus a history. This page covers the stored list, how the desk tells people about signals, the weekly report, and how to run it all from n8n.

## What is kept

One row per alert key (the load and the rule, for example `<load>:NO_TRUCK`), unique per desk. A row never goes away.

| Field | Meaning |
| --- | --- |
| status | `open`, `acknowledged` or `resolved` |
| first seen / last seen | when the rules first raised it, and the last time they still did |
| resolved at | when the rules stopped raising it |
| reopen count | how many times it came back after clearing |
| acknowledged by / at | who said they are on it |
| last level sent | the most severe level a notification has gone out for |

How the stored list follows the rules is one pure function, `diffSignals` in `apps/web/src/lib/signals.ts`:

- **New**: raised and never stored. Stored open, first seen now.
- **Seen**: raised and stored. Last seen moves, the words and level follow the rules. An acknowledged signal whose level gets **worse** (info to warn, warn to block) is open again; one that gets less severe stays as it is.
- **Resolved**: stored, not resolved, no longer raised. Kept, with the time it cleared.
- **Reopened**: raised again after it cleared. Open again, first-seen history kept, the reopen count goes up, the acknowledgement and the "sent" level are forgotten so it is news again.

`syncSignals` (`apps/web/src/server/tl/signals.ts`) applies that for the whole desk in one transaction with the workspace locked, so two syncs at once cannot make the same signal twice. The work is a handful of statements whatever the number of alerts. A page view syncs at most once a minute (`syncSignalsIfStale`); the scheduled run (below) does it too, so the list is never older than a minute when someone looks, and is kept even when nobody does.

## Who sees what

A person limited to some terminals reads only the signals of loads placed in those terminals, plus loads not placed anywhere yet (the same rule as every other list). A signal with no load is whole-desk news and is shown only when no terminal is chosen. A limited person cannot acknowledge a signal outside their terminals by guessing its id: they get the same answer as for one that does not exist.

The **Sent** tab and the **weekly report** are whole-desk by nature, so a person limited to some terminals does not have them. Acknowledging is the dispatch capability and is audited with the load. The screens are `/signals` (Dispatch group, after Alerts) and `/signals/report`; the settings are in Settings, Rules (admin).

## Settings

Stored on the workspace, each optional (blank means the built-in default):

| Setting | Default |
| --- | --- |
| Tell people about | block only (`block`, `warn` or `info`: that level and everything more severe) |
| Weekly report | on, Monday, 7 AM on the carrier's clock |

They only say what goes **when** a channel is set up. With none set up nothing leaves the desk, and the Settings card says so.

## How a notification goes out

A notice is one thing to tell people: a signal at a level, or the weekly report. It carries the words (`subject`, `text`, `html`) and the facts, so a workflow can format it any way it likes.

- A signal is told **once per level it reaches** (`notifyDue`): when it first appears at a level the settings ask for, and again if it gets worse. One that clears and comes back is told again. One that is acknowledged, or has cleared, is not told, and a send still waiting to be retried for it is marked `skipped`.
- Every channel that is set up gets it. The simulator, the signed webhook, Resend and Slack are the four (`apps/web/src/server/notify`). A channel is on only when the server holds everything it needs (the variables are in `docs/ENVIRONMENT.md`); none is ever configured from a form, so an address a person types can never become somewhere the server posts to.
- **Once, by the database.** `notification_log` has one row per notice and channel per desk, unique on `(workspace, "<channel>:<notice key>")`. Every send starts by claiming that row in one statement, so two runs at the same moment cannot both send. A failure is tried again after 1 minute, 5, 30 and 120, then left `failed` (five tries); a refusal that waiting cannot fix (a 4xx) is final at once. A send that dies after the receiver got it can be sent again when its hold runs out (at least once, never lost), and the notice key travels with it so a receiver can drop the repeat.
- A signal is remembered as told (`last_level_sent`) only when every channel is finished with it.
- At most **100 a run**, worst first, so turning this on over a long list does not flood a channel.
- The ledger holds words and counts only: the subject line, the channel, the state, the number of tries and a few words of error such as `HTTP 500` or `timeout`. Never a body, an address or a key. The **Sent** tab on `/signals` lists it.

The **simulator** sends nothing, anywhere. It is on only on the demo desk (sign-in off) or where the operator set `DESK_PARTNER_SANDBOX=on`, so the demo shows the whole path and a person can see what would go out before a real channel is set up.

## The webhook payload (what an n8n Webhook trigger receives)

One `POST`, JSON. The facts a workflow formats from are at the top level:

```json
{
  "kind": "signal",
  "dedupeKey": "signal:<signal id>:<times it returned>:<level>",
  "level": "block",
  "subject": "Block: Pickup is in 5 h and no driver has been sent. (DM-40002)",
  "text": "Block: ...\nWhere: DM-40002, unit 101\nAmount: $1,250\nRule: ...\nOpen: https://.../loads/<id>",
  "html": "<p>...</p>",
  "loadNumber": "DM-40002",
  "unit": "101",
  "dollars": 1250,
  "deskUrl": "https://.../loads/<id>",
  "data": { "signalId": "...", "key": "...", "code": "NO_TRUCK", "title": "...", "detail": "...", "loadId": "...", "firstSeenAt": "2026-11-06T12:00:00.000Z", "reopenCount": 0 }
}
```

- `dollars` is the load's billed or earned figure for the two money rules (`INVOICE_OVERDUE`, `READY_TO_INVOICE`) and `null` for every other signal: it is never guessed. `unit` is the truck's name, or `null`. `deskUrl` is a link to the load (or to `/signals`), or `null` when the desk's address is not known (`NOTIFY_DESK_URL`).
- For the weekly report: `kind` is `weekly_report`, `dedupeKey` is `report:<ISO week>`, `dollars` is the Leak Ledger total, `loadNumber` and `unit` are `null`, and `data.report` holds every figure (the headline, the ledger lines, the data gaps, the signals' counts).
- Headers: `x-desk-event` (`signal` or `weekly_report`), `x-desk-delivery` (the notice key, for dropping a repeat), `x-desk-timestamp` (seconds), and `x-desk-signature: v1=<hex>`, the HMAC-SHA256 in hex of `<timestamp>.<raw body>` with `NOTIFY_WEBHOOK_SECRET`. Check it, and refuse a timestamp more than five minutes old.

## The schedule, from n8n

n8n is the clock. Nothing in the desk needs a Vercel cron.

1. **Schedule workflow.** A Schedule trigger every 5 to 15 minutes, then an HTTP Request node: `POST https://<your desk>/signals/cron` with the header `x-signals-cron: <SIGNALS_CRON_SECRET>` and no body. The answer is counts only (`signals.created/seen/reopened/resolved`, `notified.sent/failed/waiting/skipped`, `reports`, `failed`). Alert on `failed > 0` or `notified.failed > 0` if you like. Without `SIGNALS_CRON_SECRET` set on the server the route answers 404, and a wrong secret is a plain 401.
2. **Notification workflow.** A Webhook trigger (POST, respond immediately with 200). Then a Code or Crypto step that recomputes the HMAC over `<x-desk-timestamp>.<raw body>` and stops if it does not match `x-desk-signature` (turn on "Raw Body" on the trigger to get the exact bytes). Then route on `kind` and `level`: for example a Slack node for `block`, Gmail or Resend for `weekly_report`, an SMS node for `dollars` over a figure. Use `x-desk-delivery` as the key if the workflow could ever run twice for the same send.
3. On the desk's host set `SIGNALS_CRON_SECRET`, `NOTIFY_WEBHOOK_URL` (the Webhook trigger's production URL) and `NOTIFY_WEBHOOK_SECRET`. The desk's Settings, Rules card then says "Going out through: the webhook".

`RESEND_API_KEY` with `NOTIFY_FROM_EMAIL` and `NOTIFY_TO_EMAIL`, or `SLACK_WEBHOOK_URL`, turn on email or Slack straight from the desk, without n8n, whenever they are wanted. `vercel.json` has no cron: add one that calls the same route only if Vercel should be the clock instead.

## The weekly report

One message a week, on the day and hour set (default Monday 7 AM on the carrier's clock), built from figures the desk already works out and adding no sum of its own: the last four weeks' headline (finished loads, gross, per mile, empty miles), the Leak Ledger (total, the lines, trailers waiting right now), Data health (the score and the biggest gaps), and the signals' counts (open by level, acknowledged, new and cleared this week, the oldest open one). It goes to every channel that is set up, once per ISO week: a run that comes late still sends it later that week, and a second run sends nothing more. `/signals/report` is the same report as a sheet to read, print or save as a PDF.

## Applying the migrations

`prisma/migrations/20261204000000_signals` adds `signals`, `notification_log` and four workspace columns; `20261205000000_notification_subject` adds the subject line to the ledger. Neither seeds anything. On the desk's own Supabase, apply both after `20261203000000_imported_history`, then re-run `supabase/lockdown_rls.sql` (the lockdown file is always last and is renamed with each migration: it is now `20261205000001_enable_rls.sql`).
