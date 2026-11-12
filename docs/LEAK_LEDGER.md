# Leak ledger (Phase B1), built 2026-11-05; imported history and the Leak Read intake added 2026-11-06

One dollar figure per leak, by week and for a period, with the loads behind each line. Page `/leaks`, files `/export/leaks`, `/export/leaks-weeks`, `/export/leaks-items`, and a one-line headline on `/kpi`. For the billing office only: the `bill` capability (an admin, accounting, or a dispatcher an admin has allowed to bill). The KPI page itself has no role gate, so the ledger asks for `bill` on its own.

## Two bases, never mixed

A load **booked on the desk** carries the cost floor and the detention terms frozen on it when it was accepted. A load **imported from a carrier's TMS export** (`docs/LOAD_IMPORT.md`) carries neither, and today's cost profile is not what the truck cost on the day. So the carrier gives the missing figures once, at the **Leak Read intake** (`/leaks/intake`, below), and the ledger prices imported loads from them.

Every dollar the intake prices lands on a **line of its own**, whose name and basis say so: "Empty-mile cost, imported loads (intake floor, not frozen at booking)". No intake dollar is ever added into a line that rests on a frozen figure, so the two cannot be mixed silently. The total adds the counted lines of both bases (they are all real money and each says what it rests on), and the screen states beside it how much of the total is the intake's. A frozen floor on a load always wins, even on an imported load; the intake never speaks for a load booked on the desk that happens to lack a floor (that load stays counted and unpriced, as before).

## The lines, and what each is worked out on

| Leak | Group | Basis | Unpriced when |
|---|---|---|---|
| Detention not billed | owed and not billed | wait past the free time at the truck's detention rate (frozen on the load at booking, else the truck's), less what the invoice's Detention line carried; as of now | the truck has no detention rate (counted, not priced) |
| **Detention not billed, imported loads** (intake terms, not frozen at booking) | owed and not billed | the wait between a stop's arrival and departure **from the imported file** (free time starting at the later of the arrival and the appointment, if the file has one), past the free time at the customer's detention terms from the intake, else the fleet's; less what the file's invoice carried above the rate and fuel surcharge | the intake gives no detention rate for the customer or the fleet (counted, not priced) |
| TONU fees not invoiced | owed and not billed | a TONU load's fee with no invoice yet, by the week the TONU was recorded | never |
| Detention waived | given up on purpose | detention a person marked as not billed (audit `detention_waived`, reason kept), by the week the load finished | never |
| **Detention waived, imported loads** (intake terms, not frozen at booking) | given up on purpose | the same, on an imported load, worked out at the intake terms | never |
| Trailer dwell waived or lowered | given up on purpose | the drop from "Owed" before to after on audit `dwell_waived` / `dwell_adjusted`; history starts when those events began being written | never |
| Empty-mile cost | burned running empty | empty miles (before pickup and after delivery, the KPI's own `deadheadMilesOf`) times the load's frozen `snapshotBaseFloorRpm`, before fuel | the load has no frozen floor (miles counted and shown, dollars left out) |
| **Empty-mile cost, imported loads** (intake floor, not frozen at booking) | burned running empty | the same empty miles times the cost a mile from the intake: the truck's own figure when the carrier gave one, else the fleet's. Before fuel | the intake has no figure for the truck and no fleet figure (miles counted and shown, dollars left out) |
| Paid under the floor | lens, **not added** | `floor x driven miles - (gross - fuel, tolls, other costs)` when positive; its empty miles are already inside it | no floor or no miles driven (not judged) |
| **Paid under the floor, imported loads** (intake floor, not frozen at booking) | lens, **not added** | `intake cost a mile x driven miles - gross` when positive. A file carries no fuel, tolls or other costs, so nothing comes off the pay and the shortfall can only be understated | no intake figure (not judged) |

The headline total adds the counted lines. The lens lines are shown beside them and never summed, because they contain the empty miles. Dwell **owed right now** on dropped trailers past their free time is shown apart ("Sitting right now"): it has no date until it is billed or given up, so it is not in the weeks.

Wording rules held: every line prints its basis; unpriced items are counted and listed apart from the dollars; nothing is estimated from a market rate; money adds in whole cents. An intake line with nothing behind it is left off the screen (a desk with no imported loads never sees one) but is in the files with its basis.

## The Leak Read intake

`/leaks/intake` (the `bill` capability; action `saveLeakIntakeAction`; audit `leak_intake_saved` with the figures before and after). One document on the workspace (`workspaces.leak_intake`, migration `20261207000000_leak_intake`; pure rules in `lib/leak-intake.ts`, stored by `server/tl/leak-intake.ts`):

| Figure | Meaning | Limits |
|---|---|---|
| Fleet cost a mile | dollars a mile to run, **before fuel**: the same meaning as a truck's break-even floor on its Cost profile | $0.01 to $20 |
| Truck's own cost a mile (optional, per truck name) | wins over the fleet figure for loads on that truck (name matched without regard to case or spacing) | 500 trucks |
| Fleet detention rate and free time | dollars an hour billed, and the minutes at each stop that are free | $1 to $500; 0 to 1,440 minutes |
| Customer's own rate and/or free time (optional, per customer name) | wins, figure by figure, over the fleet's for that customer's loads | 1,000 customers |

Which figure prices a load (`floorFor`, `termsFor`): the **truck's** intake figure, else the **fleet's**, else none. The **customer's** rate, else the fleet's rate, else none. The customer's free time, else the fleet's, else (free time only) the desk's own free-time setting in Settings; a line that used it says so. There is no fallback for a rate or a cost a mile: with none the load is counted and **not priced**. The cost profile on the desk today is never read for an imported load (not its floor, not its detention rate): it is not what the truck cost on the day. Nothing is taken from a market rate. Each item carries a note in words saying which figure priced it ("$2.00 a mile, Unit 104's intake figure"; "$90.00 an hour (customer's intake terms), 60 minutes free (fleet's intake default)"), shown on the screen's biggest-items table and in the items file.

The form lists the busiest trucks and customers of the imported loads with blank figures, so the carrier types a number beside each name; a row with no figure (a blank one, or a name left with nothing beside it) is dropped, because it says "use the fleet's figure"; a figure with no name is refused, and a name is listed once. It keeps what is typed until saved (`useDraft`). Saving what is stored writes nothing.

## What the ledger says about what it could not price

- **Counted, not priced** (a card on the page, under the biggest items): every counted line with unpriced items, why, and a link to the intake when the missing figure is the intake's.
- **Imported loads that could not be checked for detention**: an imported load whose file carried no wait at any stop (no arrival and departure columns, or none on that row) has no wait to price, so none is invented. They are counted apart from the items, as `n of m imported loads`, with up to ten named and linked, because for these loads it is not known whether a leak exists. (A load with an arrival and no departure has the same standing.)
- A line above the page says how many imported loads are in the period and what the intake holds, or, with an empty intake, that none is priced yet.

## How it is built

- `src/lib/leaks.ts`: pure math (`loadLeaks`, `buildLeakLedger`, `dwellForgone`); the line table `LEAKS` (each line says `intake: true/false`), tests in `tests/leaks.test.ts`.
- `src/lib/leak-intake.ts`: the intake's shape, checks, and the two resolvers; tests in `tests/leak-intake.test.ts`.
- `src/server/tl/leaks.ts`: `getLeakLedger({ period, compare, terminals })`. `terminals` is a list of terminal names, `null` for everything, so a terminal, a region or the whole fleet is one question (R1 will hand it a region's terminals). A load is in scope if it is on a truck or with a driver of those terminals, or not placed anywhere (`terminalSetSql`, the set form of `terminalSql`). The read reuses the KPI's row reader (`getKpiRows` with `finishedOnly`, no stops and no verdicts; it now also carries each load's `channel`, which is how an imported load is known) and its money and mile definitions (`leakLoadOf`), so the ledger's miles and floors are the dashboard's. Detention for an imported load is read with the intake's terms and the truck's profile cleared (`detentionItems`); `coverageOf` counts the imported loads with no wait. Kept with `answerCache` (key: workspace, period, compare, terminals, hour, thresholds, zone, **the intake**).
- `src/components/desk/leaks/ledger.tsx`, `intake-form.tsx` and the two pages under `src/app/(desk)/leaks/`: the screen (hero, by leak, twelve weeks, lanes / customers / trucks, the biggest items, counted-not-priced, sitting right now). Intake columns appear in the weeks and drill tables only when they hold dollars.
- Files: the by-leak file carries a "Priced from" column; the items file carries "Priced from" and the intake figure used; the weeks file has a column per line.

## Tests

`tests/leaks.test.ts` (pure, including the intake lines), `tests/leak-intake.test.ts`, `tests/integration/leaks.integration.test.ts` (every line against stored loads; a scope never returns another terminal's rows; another fleet reads none; the kept answer moves with the data; and **a file of imported loads with stop times, with an empty intake and then a filled one, to the cent**: the truck's profile never prices an imported load, a load with no stop times is counted apart, the frozen and intake lines never share a dollar, a waived imported detention is its own line, the intake's change moves the kept answer, and saving writes one audit event), `tests/leaks-access.test.ts` (the `bill` gate on page, files and headline; no estimates), `tests/perf/leaks.perf.test.ts` (scale database: built under 4 s, kept under 0.3 s; measured under 1 s in total at 1,500 trucks).

## Not in it yet

- A scope menu (regions, several terminals): the page reads the header's one terminal until R1.
- Lumper and layover never billed, driver detention pay, and net lane profit (the audit's "not covered" list).
- A weekly chart: the twelve weeks are a table with a bar; the chart restyle is its own step.
- **The intake's detention terms price the Leak ledger only.** The Detention page, the Invoices recovery card, the unbilled-detention alert and the invoice's detention suggestion still read an imported load's terms from the load's frozen terms or its truck's profile (so, for an imported load, a truck with a profile rate prices it there and a truck without one shows "no rate"). They also cannot waive an imported load's detention unless that profile gives a rate. Bringing them onto the intake is its own step.
- Fuel: an import has no fuel, tolls or other costs, so the imported lens (paid under the floor) takes nothing off the pay. A fuel-card file read against the loads (Data Health's cross-source check) is the way to bring fuel in.
- Appointment-based free time needs the file's appointment columns; without them the wait runs from the arrival, which overstates the wait for a truck that came early. The importer reads the appointment when the file has it.
