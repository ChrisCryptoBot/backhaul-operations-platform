# Load-history importer (B6), built 2026-11-05

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
| Invoice date / amount, Paid date / amount | no | paid when there is a paid date, invoiced when there is an invoice date or amount; the amounts fill from rate plus surcharge when blank; a load with none is listed as ready to invoice |

## What an imported load is (and is not)

A **finished load** with `channel = "import:<batch>"`. It has **no driver** (history never lands on a driver pay statement or the planner), **no stops**, **no geocoding** (an import must not spend the daily map allowance), and **no frozen floor**: the cost profile today is not what the truck cost that day, so the Leak ledger counts its empty miles and says they are not priced, and Data health lists it under "floor frozen at accept". Its created date is its pickup (or delivery) date, so the weeks and lead times are the real ones.

## Safety

- Both the preview and the import read the file on the server, against the desk as it is then. The import writes 500 at a time in one transaction with the workspace locked and the duplicate check made again under the lock, so two clicks at once write once and a fully raced second click writes (and records) nothing.
- A load already on the desk (same number, same customer; a blank customer on either side is the same one) or twice in the file is left out and counted apart from rows with a problem. Problem rows are numbered as in the file (the header is line 1) and can be downloaded with the reason in front.
- Limits: 20,000 rows to a file and the action body of 10 MB; at most 20,000 rows to a preview.
- One audit event per import (`loads_import_completed`, the batch id on it). **Remove this import** (`removeLoadImportAction`) deletes every load of the batch still on the desk, the way any deleted load is deleted (each can be restored from the Deleted loads list), and records `loads_import_removed`.

## Where it lives

`lib/load-import.ts` (pure: fields, match, row checks, what a row becomes; `tests/load-import.test.ts`), `server/tl/load-import.ts` (preview, commit, list, remove; `tests/integration/load-import.integration.test.ts`), `components/desk/load-import-panel.tsx`, `app/(desk)/loads/import/page.tsx`, three actions in `app/(desk)/actions.ts` (in `tests/loads-roles.test.ts`).

## A weekly tracker: imported history (built 2026-11-05)

A spreadsheet of lane-per-week totals is not a list of loads, so it is **not** turned into loads. Page: `/loads/import/weekly` (linked from the loads import). Same four steps and the same safety (server-side check, one transaction with the duplicate check again under the lock, one audit event per batch, "Remove this import"), with its own fields (`lib/tracker-import.ts`): week (any day of the week; counted Monday to Sunday), lane (one "Dallas, TX to Atlanta, GA" column, or a pickup and a delivery column), loads, line haul, loaded miles, and optionally the fuel surcharge and empty miles (a total, or before pickup plus after delivery). A lane-week already imported, or twice in the file, is left out.

The rows go to their own table, `imported_history` (migration `20261203000000_imported_history`, applied to the local databases; **Chris applies it by hand on the desk's own Supabase, then re-runs `supabase/lockdown_rls.sql`, which is now `20261203000001_enable_rls.sql`**). They are shown on the KPI page under the heading "Imported history" (weeks, newest first, and the biggest lanes) and are **never added to a figure built from loads**: the KPI, Lanes, Customers, the Leak ledger and Data health do not read them. Per mile is over loaded miles (a tracker has no revenue-mile basis); empty share is empty miles over every mile driven. The history belongs to no terminal, so it is shown to people who can see every terminal. Removing an import deletes its rows (they are copies of the spreadsheet).

Tests: `tests/tracker-import.test.ts`, `tests/integration/tracker-import.integration.test.ts` (the KPI of the desk is unchanged by an import); the model is in the `no-legacy` list.

## Not in it yet

A saved column match per carrier (today the match is guessed again on each file); a chart of the imported weeks (today a table); imported history in the Lanes page's week grid.
