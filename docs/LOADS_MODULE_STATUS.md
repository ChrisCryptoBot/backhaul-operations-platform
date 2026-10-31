# Loads module: where it stands (2026-10-31)

A graded audit of the desk's Loads module found a C+ (state races, four different "pay" numbers, gaps against the phone). Five phases were built locally and are **not committed**. This page is the one place that says what changed, what Chris has to do, and what is open.

## Decisions taken
- **The invoice bills the agreed rate** (agreed linehaul + fuel surcharge + extras). The linehaul actually paid is a separate figure; a short pay shows as short against the invoice.
- **One earnings figure on every screen** (`src/lib/load-gross.ts`): paid linehaul if entered, else the agreed rate, plus fuel surcharge and layover pay. A TONU is its fee. Detention, lumper and other billed extras sit beside it, not inside it.

## What was built
| Phase | Result |
|---|---|
| 1. Integrity | Compare-and-set on every load move (`server/tl/claim.ts`), editing a delivered load no longer rewrites what was paid, the driver-safe check no longer trips on times and miles, Enter in Demo controls answers nothing, double-submit guards, bounded TONU fee and pay rates. |
| 2. One money contract | `grossOf` everywhere, month totals over the whole month, one overdue rule (`lib/overdue.ts`), write-off and layover stored, History money cell (part paid, closed short, TONU), frozen floor on delivered loads. |
| 3. Phone parity | Net pay, profit a mile and $ an hour columns and sorts; search by every word; itemised costs, rider, revenue note, actual miles (quote kept, variance flag over 8%); correct waits and seals with this load's detention terms; proof of delivery per stop and a 21-day file alert; cancel note, TONU miles, reopen a cancelled load or TONU; phone `scheduled`/`dispatched` read as accepted/sent. |
| 4. Flow and scope | Deleted view with guarded Restore, terminal scope on History and the files, bounded and labelled CSVs, manual factoring steps, drawer loading and error states, read-only loads for viewers. |
| 5. Tests | Role matrix, cross-workspace refusal for 18 load actions, racing double-fires, History search, file vs screen, scale budgets. The race test found and fixed a real bug: several documents added at the same moment could pass the 20-document limit. |

## For Chris
1. **Production migrations** (applied to the local demo and scale databases only): `20261115000000_quote_extras`, `20261116000000_quote_decision_details`, `20261117000000_load_write_off`, `20261118000000_loads_phone_parity`. The last was edited after it was applied locally, so a local `migrate dev` would complain about its checksum; `migrate deploy` is fine.
2. **Open question: percent driver pay.** A driver paid "a percent of the rate" is paid a percent of the *agreed* rate today. If the customer short-pays, should the driver's percent follow what was *paid* instead? Nothing was changed.
3. **Owner-only destructive money actions** (void invoice, undo payment, write-off, delete) are a dispatcher's today. Proposed: owner only. Needs a decision.
4. **Factoring** status moves by hand ("Mark funded" and so on) until the factor's webhook is connected (the Connect gate).

## Not done
- Tax-exclude switch (needs a column and the tax screens).
- History verdict chip still reads the truck's live cost profile (the floor is frozen; the chip is not).
- Hourly driver-pay estimate from the load's hours.
- "N loads hidden by the terminal" note; vocabulary sweep.
- A 25,000-row loads file is about twenty-five pages of a second each; if that is too slow, lower `MAX_EXPORT_ROWS` in `server/tl/exports.ts`.
