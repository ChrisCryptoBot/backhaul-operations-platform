# Leak ledger (Phase B1), built 2026-11-05

One dollar figure per leak, by week and for a period, with the loads behind each line. Page `/leaks`, files `/export/leaks`, `/export/leaks-weeks`, `/export/leaks-items`, and a one-line headline on `/kpi`. For the billing office only: the `bill` capability (an admin, accounting, or a dispatcher an admin has allowed to bill). The KPI page itself has no role gate, so the ledger asks for `bill` on its own.

## The lines, and what each is worked out on

| Leak | Group | Basis | Unpriced when |
|---|---|---|---|
| Detention not billed | owed and not billed | wait past the free time at the truck's detention rate (frozen on the load at booking, else the truck's), less what the invoice's Detention line carried; as of now | the truck has no detention rate (counted, not priced) |
| TONU fees not invoiced | owed and not billed | a TONU load's fee with no invoice yet, by the week the TONU was recorded | never |
| Detention waived | given up on purpose | detention a person marked as not billed (audit `detention_waived`, reason kept), by the week the load finished | never |
| Trailer dwell waived or lowered | given up on purpose | the drop from "Owed" before to after on audit `dwell_waived` / `dwell_adjusted`; history starts when those events began being written | never |
| Empty-mile cost | burned running empty | empty miles (before pickup and after delivery, the KPI's own `deadheadMilesOf`) times the load's frozen `snapshotBaseFloorRpm`, before fuel | the load has no frozen floor (miles counted and shown, dollars left out) |
| Paid under the floor | lens, **not added** | `floor x driven miles - (gross - fuel, tolls, other costs)` when positive; its empty miles are already inside it | no floor or no miles driven (not judged) |

The headline total adds the five counted lines. The lens is shown beside them and never summed, because it contains the empty miles. Dwell **owed right now** on dropped trailers past their free time is shown apart ("Sitting right now"): it has no date until it is billed or given up, so it is not in the weeks.

Wording rules held: every line prints its basis; unpriced items are counted and listed apart from the dollars; nothing is estimated from a market rate; money adds in whole cents.

## How it is built

- `src/lib/leaks.ts`: pure math (`loadLeaks`, `buildLeakLedger`, `dwellForgone`), tests in `tests/leaks.test.ts`.
- `src/server/tl/leaks.ts`: `getLeakLedger({ period, compare, terminals })`. `terminals` is a list of terminal names, `null` for everything, so a terminal, a region or the whole fleet is one question (R1 will hand it a region's terminals). A load is in scope if it is on a truck or with a driver of those terminals, or not placed anywhere (`terminalSetSql`, the set form of `terminalSql`). The read reuses the KPI's row reader (`getKpiRows` with `finishedOnly`, no stops and no verdicts) and its money and mile definitions (`leakLoadOf`), so the ledger's miles and floors are the dashboard's. Kept with `answerCache` (key: workspace, period, compare, terminals, hour, thresholds, zone).
- `src/components/desk/leaks/ledger.tsx` and `src/app/(desk)/leaks/page.tsx`: the screen (hero, by leak, twelve weeks, lanes / customers / trucks, the biggest items, sitting right now).

## Tests

`tests/leaks.test.ts` (pure), `tests/integration/leaks.integration.test.ts` (every line against stored loads, a scope never returns another terminal's rows, another fleet reads none, the kept answer moves with the data), `tests/leaks-access.test.ts` (the `bill` gate on page, files and headline; no estimates), `tests/perf/leaks.perf.test.ts` (scale database: built under 4 s, kept under 0.3 s; measured under 1 s in total at 1,500 trucks).

## Not in it yet

- A scope menu (regions, several terminals): the page reads the header's one terminal until R1.
- Lumper and layover never billed, driver detention pay, and net lane profit (the audit's "not covered" list).
- A weekly chart: the twelve weeks are a table with a bar; the chart restyle is its own step.
