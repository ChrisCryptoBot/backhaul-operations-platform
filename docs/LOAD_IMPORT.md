# Load-history importer (B6), built 2026-11-05; stop times added 2026-11-06

Bring a carrier's finished loads in from a spreadsheet or a TMS export, so a read of their numbers (KPI, lanes, customers, the Leak ledger, Data health) can start from history instead of from the day they began using the desk. Page: `/loads/import` (a button on Loads > History). Four steps: choose a CSV, confirm which column is which, check every row, import. For dispatchers and admins (the `dispatch` capability).

## What a file means

One row per finished load. The desk guesses the match from the headers (`lib/load-import.ts` `autoMap`: a tracker's own words such as "Broker", "DH Pickup", "FSC", "Unit" are known) and shows it; any field can be pointed at any column, a column feeds one field. The template download has the desk's own names.

| Field | Needed | Notes |
|---|---|---|
| Load number | yes | the key for "already on the desk" |
| Customer | no | the other half of the key |
| Pickup city, Delivery city | yes | "Dallas, TX", "dallas tx", "DALLAS, TX 75207" and a full street address all become "Dallas, TX", so lanes match the ones Quote and the KPI use; anything else is kept as typed |
| Delivery date | yes | the day it finished (2026-09-16 or 9/16/2026); not in the future. Stored as that calendar day |
| Pickup date | no | also sets how old the load is (lead time) |
| Loaded miles | yes | over 0 and no more than 6,000 |
| Empty miles before pickup / after delivery | no | counted in empty-mile share and the ledger |
| Line haul | yes | the agreed rate without the surcharge; over $0 |
| Fuel surcharge | no | dollars |
| Truck | no | matched to a truck on the desk by name; a name the desk does not have is imported with no truck and counted on the screen |
| Invoice date / amount, Paid date / amount | no | paid when there is a paid date, invoiced when there is an invoice date or amount; the amounts fill from rate plus surcharge when blank; a load with none is listed as ready to invoice. An invoice amount above the rate plus the fuel surcharge is read as detention already billed (the Leak ledger takes it off the detention it prices) |
| Pickup arrival / departure, Delivery arrival / departure | no | a date **and time** each (2026-09-14 08:05, 9/14/2026 8:05 AM, or with an offset). Read on the carrier's clock (the workspace's zone) unless the cell carries its own offset. These are what detention is priced from |
| Pickup appointment, Delivery appointment | no | a date and time. Free time starts at the later of the arrival and the appointment, so a truck that came early is not owed for the hours before it |

Column names a TMS uses are known: "Shipper In / Out", "Consignee In / Out", "PU Check In / Out", "DEL Check In / Out", "Pickup Arrival", "Delivery Departure", "PU Appt" and the like. The template download has the desk's own names for all six time columns.

### Stop times (a stop's arrival, departure and appointment)

- A side (pickup or delivery) with an **arrival and a departure** becomes a stop with its arrival and a **wait in whole minutes**: from the later of the arrival and the appointment to the departure, never below zero (floored, so a minute not waited is not claimed). The wait is real elapsed time, so a clock change inside it is not billed as an hour that did not happen.
- An **arrival with no departure** becomes a stop with the arrival and **no wait**: a wait nobody recorded is not estimated. A **departure with no arrival** has nothing to measure from and makes no stop. A row with no times has no stops.
- A mistake in the row, named with its line: a time that is not a date and time (a day alone, "yesterday"), a departure before the arrival, or a wait of more than 7 days (a typo in a date, not a wait).
- Preview step 3 says how many loads carry a wait, how many have an arrival and no departure, and how many have no times; with no time column matched it says that detention cannot be checked on any of them.

## What an imported load is (and is not)

A **finished load** with `channel = "import:<batch>"`. It has **no driver** (history never lands on a driver pay statement or the planner), **no geocoding** (an import must not spend the daily map allowance), and **no frozen floor or detention terms**: the cost profile today is not what the truck cost that day. The Leak ledger therefore prices its empty miles and its detention from the figures the carrier gave at the **Leak Read intake** (`docs/LEAK_LEDGER.md`), as separate lines marked "intake, not frozen at booking", and counts what the intake cannot price; Data health still lists it under "floor frozen at accept", because the intake's figure is not a floor frozen at booking. Its created date is its pickup (or delivery) date, so the weeks and lead times are the real ones.

**Stops, only when the file carries stop times.** Up to two (sequence 1 pickup, sequence 2 delivery; type and role `pickup` / `delivery`), each with the address as the lane spells it, the arrival, and the wait. They have **no coordinates and no time window**: nothing is looked up on the map, and a stop with no window is never on time or late. A file with no stop times leaves the load with **no stops**, and the Leak ledger counts it among the imported loads that could not be checked for detention. Because a load that has a delivery stop would otherwise be asked for a proof of delivery (an alert, and a caution when invoicing), `podStopsMissing` skips imported loads: history is not the desk's to ask a proof of delivery for.

## Safety

- Both the preview and the import read the file on the server, against the desk as it is then. The import writes 500 at a time in one transaction with the workspace locked and the duplicate check made again under the lock, so two clicks at once write once and a fully raced second click writes (and records) nothing.
- A load already on the desk (same number, same customer; a blank customer on either side is the same one) or twice in the file is left out and counted apart from rows with a problem. Problem rows are numbered as in the file (the header is line 1) and can be downloaded with the reason in front.
- Limits: 20,000 rows to a file and the action body of 10 MB; at most 20,000 rows to a preview. A stop's wait is at most 7 days.
- One audit event per import (`loads_import_completed`, the batch id on it, with how many loads carry a wait at a stop). **Remove this import** (`removeLoadImportAction`) deletes every load of the batch still on the desk, the way any deleted load is deleted (each can be restored from the Deleted loads list), and records `loads_import_removed`.

## Where it lives

`lib/load-import.ts` (pure: fields, match, `readDateTime`, row checks, what a row becomes; `tests/load-import.test.ts`), `server/tl/load-import.ts` (preview, commit with the stops in the same transaction, list, remove; the times are read on `workspaceTimezone`; `tests/integration/load-import.integration.test.ts`), `components/desk/load-import-panel.tsx`, `app/(desk)/loads/import/page.tsx`, three actions in `app/(desk)/actions.ts` (in `tests/loads-roles.test.ts`).

## A weekly tracker: imported history (built 2026-11-05)

A spreadsheet of lane-per-week totals is not a list of loads, so it is **not** turned into loads. Page: `/loads/import/weekly` (linked from the loads import). Same four steps and the same safety (server-side check, one transaction with the duplicate check again under the lock, one audit event per batch, "Remove this import"), with its own fields (`lib/tracker-import.ts`): week (any day of the week; counted Monday to Sunday), lane (one "Dallas, TX to Atlanta, GA" column, or a pickup and a delivery column), loads, line haul, loaded miles, and optionally the fuel surcharge and empty miles (a total, or before pickup plus after delivery). A lane-week already imported, or twice in the file, is left out.

The rows go to their own table, `imported_history` (migration `20261203000000_imported_history`, applied to the local databases; **Chris applies it by hand on the desk's own Supabase, then re-runs `supabase/lockdown_rls.sql`, which is now `20261203000001_enable_rls.sql`**). They are shown on the KPI page under the heading "Imported history" (weeks, newest first, and the biggest lanes) and are **never added to a figure built from loads**: the KPI, Lanes, Customers, the Leak ledger and Data health do not read them. Per mile is over loaded miles (a tracker has no revenue-mile basis); empty share is empty miles over every mile driven. The history belongs to no terminal, so it is shown to people who can see every terminal. Removing an import deletes its rows (they are copies of the spreadsheet).

Tests: `tests/tracker-import.test.ts`, `tests/integration/tracker-import.integration.test.ts` (the KPI of the desk is unchanged by an import); the model is in the `no-legacy` list.

## Not in it yet

A saved column match per carrier (today the match is guessed again on each file); a chart of the imported weeks (today a table); imported history in the Lanes page's week grid; a total-detention or "wait minutes" column for an export that has only a total and no stop times (today such a load is counted, not priced); a fuel-cost column (an import has no fuel, so the Leak ledger's imported "paid under the floor" takes nothing off the pay).
