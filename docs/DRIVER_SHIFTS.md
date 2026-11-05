# Driver shifts, availability, driver codes and terminals

Built locally on `demo/truelane-dispatch`; nothing pushed, nothing applied to production (that is Chris's). Desk only: nothing here is sent to the phone or the bridge (the driver link stays dark).

## What it answers

Before this, the Planner listed drivers with no loads behind a "Show the N with nothing" link and drew them as a bare name. Nothing said whether an idle driver was on shift, off, or out of hours, so a dispatcher could not tell supply from demand, and nothing stopped a 2:00 AM delivery landing on a driver whose shift ends at 1:30 AM.

## The model (`prisma/migrations/20261127000000_driver_shifts`)

| Table / column | What it holds |
|---|---|
| `drivers.code` | The driver's short code. Unique per workspace. |
| `terminals` | The fleet's managed list of yards and branches (`name` unique ignoring case, `city`, `note`, `archived_at`). Seeded from the values already on drivers, trucks and trailers. |
| `driver_schedules` | One row per driver: `week`, seven entries Sunday to Saturday, each `{ start, end }` in minutes for a shift that **starts** that day, or `null` for a day off. A row's existence means "a schedule is set". |
| `driver_shift_exceptions` | One date that differs from the template: `kind` `off` (time off, home time) or `shift` (a different shift that day), `date_key` YYYY-MM-DD, optional `note`. Unique (driver, date). |

The `terminal` text columns on drivers, trucks and trailers stay (about 30 files read them). They now hold a name from the list: a name typed anywhere is matched to the list ignoring case and a new one is added, so the list is always everything in use. Renaming a terminal updates all three columns in one transaction; retiring one is refused while anyone is based there.

This differs from the first sketch (a `DriverShift` row per weekday): the week is one JSON value on `DriverSchedule`, which is one read per driver and cannot hold a half-written week.

## Decisions

- **Unset is not off.** A driver with no schedule renders exactly as before, is never flagged, and is not counted as supply. The Planner header and the Schedules page say how many have none.
- **The clock is the carrier's** (the workspace `timezone`, `activeTz()`), the same rule as money and periods. A shift crossing midnight is `end <= start` (22:00 to 06:00). A per-driver time zone is a proposal, not built.
- **A shift belongs to the day it starts.** Its tail past midnight belongs to that shift: a Friday 3:00 AM delivery is inside Thursday night's shift, never `OFF DUTY` or `BEFORE SHIFT START`. A day with a tail and its own shift shows both. An exception on Thursday replaces Thursday's shift and so its Friday tail; an exception on Friday replaces only Friday's own shift. Held across the 1 November clock change (`blockOf` goes through `centralInstant`).
- **Flag rule (per timed stop of an assigned open load).** The stop's window is compared with the driver's shifts: any overlap is fine. No overlap: no shift touches that day at all is `OFF DUTY`; otherwise the stop is read against the nearer edge, `EXCEEDS SHIFT END` (after) or `BEFORE SHIFT START` (before), a tie going to the end. Drive time between stops is not judged, so a three-day load does not flag every day.
- **Supply (M)** for a day: scheduled drivers on shift that day (own shift or the tail of the night before) with no open load overlapping their shift, terminal-scoped. **Demand (N)**: distinct tray loads with a cell that day.
- **Caution, never a rule.** Nothing blocks assigning. The flag, the Assign picker note and the Quote chip only warn; the quote verdict (`lib/verdict.ts`), the ranking and booking never read a shift.
- **A terminal is a home base, not a fence.** The Assign picker lists every active driver, home-terminal drivers first, each tagged with code and home. The Planner's scope shows that terminal's home drivers and has an "Include drivers based elsewhere" link (with how many loads are held by them).

## Driver codes

First initial of the first name plus the first three letters of the last name, upper case (John Smith is `JSMI`). A second driver who comes to the same code takes a number (`JSMI2`, `JSMI3`); the first keeps the plain code. Accents and punctuation are dropped (`O'Neil` is `ONEI`, `Zoë O'Neil` is `ZONE`), a last name under three letters uses what it has (`Jo Li` is `JLI`), the last name is the last word that is not Jr, Sr, II, III, IV, a one-word name takes its first four letters. Made once at both creation sites (`saveDriver`, and the CSV import across the whole batch and against the fleet), and by the migration for existing drivers in `created_at` order (the oldest John Smith keeps `JSMI`). It does not follow a rename. A driver manager or an admin edits it (letters and digits, two to eight); a code another driver holds is refused, and the unique index holds the line. Shown on the Planner row, Schedules, the Drivers table (own column, searchable), driver detail, the Assign picker and statements. The pure rule is `lib/driver-code.ts`; the SQL in the migration mirrors it, and `tests/integration/driver-shifts.integration.test.ts` runs the migration's own statement against the TypeScript rule.

## Roles

New role `driver_manager` ("Driver manager"): capabilities `read`, `documents`, and the new `roster` (who works where and when: shifts, time off, driver codes, home terminal). Admin gets `roster` through `CAPABILITIES`. Creating, renaming and retiring terminals stays `admin` (Settings, Terminals). Dispatcher, accounting and viewer see schedules read-only. A driver manager cannot dispatch, quote or bill. `Member.role` is a free string, so there is no enum migration; a real login is an admin setting a team member's role to Driver manager. The demo has a fifth button landing on `/schedules`.

## Screens

- **Schedules** (`/schedules`, rail code SC): driver code, home terminal, the week at a glance, time-off count; paged 50, search by name or code, terminal scoped. Edit opens the week, time off and one-day changes, code and home terminal; tick several drivers to apply one week or one home terminal together. Fields are kept with `useDraft`.
- **Conflict warning when a schedule is cut.** Every schedule action looks for the driver's open assigned loads that the new schedule would put outside the shift (and that the old one did not), and returns them instead of saving: "Casey Brooks has 1 load assigned on Friday (DM-40009). Setting to Off Duty will create a shift conflict for dispatch." The form lists them with links and a **Save anyway**; the audit entry then records the conflicting load numbers. The same helper (`conflictsIfChanged`) drives the flag rule, so the preview and the board cannot disagree.
- **Planner**: each day header reads "N need a driver / M on shift"; an empty cell on shift says `ON SHIFT 06:00–18:00 (12h)` (a tail reads `until 06:00 (Thu night)`), a day off is a sunk cell with `OFF DUTY` (and its note); a load outside the shift has a full 1px red outline and a `⚠ EXCEEDS SHIFT END` chip. Per the standing design rule there is no coloured strip down any edge (`tests/planner-shift-style.test.ts` scans for it). The default driver pool is busy drivers plus scheduled on-shift ones; unset or off-all-week drivers stay behind the existing toggle.
- **Quote**: beside the hours-left note each row's driver shows `Shift 06:00–18:00` or `Off duty`, and, once the pickup and delivery are typed, `⚠ Past shift end (6:00 PM)`, `Before shift start` or `Off duty that day`, with the sentence in the tooltip. No appointment typed means no judgement, only the tag. The verdict, ranking and booking are untouched (asserted in the integration test).
- **Assign picker** (and `/drivers/pick`): the same note beside the clash note; ranking unchanged apart from home-terminal-first.
- **Settings, Terminals** (admin): add, rename, retire, with counts of drivers, trucks and trailers. A driver's form picks a home terminal from the list instead of typing one; the driver CSV import reports a terminal that is not on the list instead of creating it.

## Performance

`getPlannerData` reads the schedules and exceptions in two batched queries, not per driver. At the scale database (1,500 drivers, all scheduled, a tenth with time off) the planner took 5 to 8 s the first time it was measured, all of it clock conversions (`centralInstant` is two `Intl` calls, and a fleet asks the same few questions of every driver). `lib/shifts.ts` now keeps the instants of a (date, start, end) block and the date key of an instant (pure functions of their arguments, bounded maps), and the planner is back to 0.8 to 1.1 s, the same as with no schedules (about 1.05 s). The scale suite's own planner test is unchanged.

## Tests

`tests/driver-code.test.ts`, `tests/shifts.test.ts` (shift reading, overnight tail, Friday 3 AM inside Thursday night, the 1 Nov change, the flag rule, conflicts incl. the Casey Brooks Friday case, balance, `quoteShift`), `tests/planner.test.ts` (unset rows identical to before, flags, N/M), `tests/planner-shift-style.test.ts`, `tests/demo-roles.test.ts` (driver manager role walk), `tests/integration/driver-shifts.integration.test.ts` (backfill, both creation paths, codes, terminal list, schedule and conflict hold, force and its audit entry, time off, tenant isolation, planner feed, picker, Quote shift note leaving the verdict alone).

Existing tests edited on purpose, not regressions: `tests/roles.test.ts`, `tests/demo-roles.test.ts`, `tests/screens-follow-role.test.ts` (the code editor is gated on `roster`), `tests/loads-roles.test.ts`, `tests/no-legacy.test.ts` (model list), `tests/forms-keep-fields.test.ts`, and `tests/integration/tl-waveE1.integration.test.ts` (it pinned "the ranking lists only the scoped terminal's drivers", which this reverses on purpose: home drivers lead, everyone is offered).

## Not built (proposals)

Per-driver time zone; sending schedules to the phone; HOS-driven availability from the ELD; blocking (rather than warning) an assignment outside a shift; recurring time-off patterns; letting shifts change the Quote verdict or ranking (they only warn). Production migration `20261127000000_driver_shifts` is Chris's to apply.
