# Data health (B4), built 2026-11-05

How complete the desk's own records are, and where two sources that should agree do not. The point of the package is one environment with accurate data, so the desk scores its own data before anyone reads a number built on it. Screen: `/data-health`. One-sheet report: `/data-health/report` (print or save as a PDF). Files: `data-health` (every check) and `data-health-checks` (the cross-source checks). For the billing office (the `bill` capability: an admin, accounting, or a dispatcher an admin has allowed to bill), like the Leak ledger, because it reads money. It reads the terminals in view, so the page says which.

Nothing in it is estimated. A field is filled in when the desk holds a real value; a check is counted over the items it applies to; a figure the desk cannot tell is never counted as a pass.

## Completeness (`lib/data-health.ts`, pure)

| Module (weight) | Checks |
|---|---|
| Loads (40%), finished loads of the window | customer named; pickup and delivery places; finish time; loaded miles over zero; revenue; truck on it; driver on it; driver pay figure (only when a driver is on it); market rate; floor frozen at accept; proof of delivery (a file, a typed note, or closed without one on purpose); fuel recorded; rate confirmation on file. A TONU is not asked for miles, a truck or a market rate. |
| Stops (15%) | arrival time on every stop of a finished load (on-time and wait figures read them) |
| Trucks (15%) | cost profile; home base; miles per gallon |
| Drivers (15%) | CDL expiry; medical card expiry; phone |
| Trailers (15%) | registration expiry; inspection expiry |

A module's score is the share of its checked fields that are filled in (null when nothing was checked: nothing to check is not 100%). The headline weights the modules that have anything to check. The word beside it: 90% and over "Ready for a read", 70% "Mostly there", below that "Needs work first". Each gap names its examples (linked to the load, truck, driver or trailer) and the count behind them.

## Cross-source checks

| Check | Compared on | Honest limits |
|---|---|---|
| Fuel card and the load's own fuel | the card purchases tied to a finished load against `expense_fuel_actual`; apart when the gap is over the larger of $25 and a tenth; also a purchase with no fuel on the load, and fuel on the load with no purchase (only when the desk has card data) | the purchase is tied to a load by the truck and the load's stop times, a day either side (`server/partners/fuel-store.ts`), so a purchase near a load's edge can be tied to the wrong one |
| Rate confirmation and the invoice | the invoice's Line haul, TONU and Fuel surcharge lines (or the whole amount when it kept no lines) against the rate plus the fuel surcharge the rate confirmation promised, to the dollar; billed under, over, or matched | only loads with a rate confirmation file or path can be checked; detention, lumper and layover lines are extras and left out |
| Truck positions and billed miles | a straight line between position pings, first arrival to last, against the billed loaded miles; apart when under 70% or over 130%; fewer than six pings is not enough to say | **no odometer or ELD mileage is stored, and pings are kept 7 days**, so only loads finished in the last 7 days are checked (newest 60); older loads are not checked and the page says so |

## Where it lives

`lib/data-health.ts` (rules and tests: `tests/data-health.test.ts`), `server/tl/data-health.ts` (the read: one lean SQL over the finished loads of the window, the units of the scope, the pings; kept per slice with `answerCache`; at most 20,000 loads, said on the page when it stops there; tests: `tests/integration/data-health.integration.test.ts`), `components/desk/data-health/parts.tsx`, the two pages, the CSV in `server/tl/exports.ts`, the access rules in `tests/data-health-access.test.ts`.

## Not in it yet

An ELD mileage comparison beyond the last week (needs an odometer or ELD miles field); a dollar figure per gap (what a missing proof of delivery or a missing rate confirmation cost) once the Leak ledger and these share a basis; a history of the score week by week (the score is computed now, not stored).
