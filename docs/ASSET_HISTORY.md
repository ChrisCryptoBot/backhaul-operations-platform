# Asset history: where a truck or trailer has been, and what was said about it

Built 2026-11-05. A truck's or trailer's page has a **History** tab (key 2): a check-call form on top, then everything the desk knows about the unit, a day at a time, newest first, over 7, 30 or 90 days.

## What is in it, and where each line comes from

| Line | Source | Kept | Notes |
|---|---|---|---|
| **Stopped** (tractor) | `unit_stays`, written as the ELD is read (`server/tl/stays.ts`, rules in `lib/stays.ts`) | 13 months (`STAY_KEEP_DAYS`, purged by the partner cron) | A stay opens when a fix shows the tractor standing, grows while later fixes put it within a quarter mile, and closes when one shows it elsewhere or moving. Under 20 minutes is dropped when it closes (a red light). The duration runs from the first fix there to the last fix there, never to the fix that showed it gone, so it can only understate. |
| **Call** (check call) | `check_calls`, typed by a dispatcher | until removed (a business record, never purged) | Where the driver said they were, expected arrival, on time / running late / issue, who spoke, a note, optionally tied to one of the unit's open loads. The call time and arrival are typed on the carrier's clock (the workspace zone); blank means now; a call can be back-dated up to 366 days, never future-dated. A mistaken call can be removed; the audit trail keeps what it said. |
| **Arrived** | `stops.arrived_at` on the unit's loads | with the load | Facility, pickup or delivery, load, and who drove it (the load's assignment). |
| **Load** | the unit's loads in the window that reached no stop | with the load | So a booked load still shows where the unit was assigned. |
| **Hooked / Dropped** (trailer) | `trailer_moves`, written when a trailer is hooked or dropped (`hookTrailer`) | until the trailer is deleted | With the tractor's position at that moment, who did it, and how long a dropped trailer then sat. On a tractor's page the same rows read "Hooked T-101". |
| **Stopped (with Unit N)** (trailer) | the hooking tractor's stays during each hook | as stays | A hooked trailer stood where its tractor stood. |

Places are named from the stops of the fleet's own loads (a facility within 300 metres while standing, the same rule as `docs/TELEMATICS_RADAR.md` / `lib/whereabouts.ts`) and the offline gazetteer. No map provider is called.

## What it does not have, said plainly

- **History starts when each source started being written.** Stays and hooks begin the first time the ELD is read / a trailer is hooked after the migration; nothing is back-filled. The tab says so when a window is empty. Raw position fixes (`vehicle_pings`) are still only kept a week; stays are what lasts.
- **A trailer has no position of its own while hooked.** Its trail is the tractor's, joined by the hook and drop times. A trailer hooked before the migration has no hook row, so its earlier tractor is not shown.
- **Which driver was in the truck** is only the driver on each load (the assignment), not a shift-by-shift log.
- Check calls are typed, not automated: nothing calls the driver, and no inbound call or message is parsed.

## Rules held

Display only: money, quote, KPI, leak and verdict code never import any of it (`tests/whereabouts-firewall.test.ts`). Dispatch capability to log or remove a call (`logCheckCallAction`, `removeCheckCallAction` in `tests/loads-roles.test.ts`). Every call logged or removed is an audit event (`check_call`, `check_call_removed`). The form keeps what was typed until it is logged (`useDraft`).

## Production

Migration `prisma/migrations/20261201000000_asset_history` (three new tables, nothing existing changed) is **Chris's to apply**; `supabase/` was regenerated with `npm run db:export-supabase`, and the RLS lockdown file was renamed again (it is always last), so **re-run `lockdown_rls.sql`** to cover the new tables, and tell me if the earlier lockdown was already applied.

## Tests

`tests/asset-history.test.ts` (stay rules, the list, ordering), `tests/integration/asset-history.integration.test.ts` (stays written from fixes, validation, audit, removal, hooks and drops on both pages, tenancy, retention), `tests/whereabouts-firewall.test.ts`.
