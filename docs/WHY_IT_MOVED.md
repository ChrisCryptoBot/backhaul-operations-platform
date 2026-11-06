# Why it moved

`/kpi/moved` (Money group, for the billing office like the Leak Ledger). What the desk made this week against the week before, which lane or customer moved it, and why. The math is one pure file, `apps/web/src/lib/moves.ts`; the read is `apps/web/src/server/tl/moves.ts`.

## The weeks

The dashboard's own: seven days ending now, and the seven before. "Earlier week" and "Later week" slide both back or forward (up to ten weeks). A load belongs to the week it finished in, on the same finished-load rows and the same money and mile definitions as every KPI fact.

## The figure that moves

The **result** of a week: gross (line haul, fuel surcharge, TONU and layover pay) plus the **detention that was billed** (from the invoice's own Detention line, or what an older invoice carries above the rate and the surcharge), less the **fuel, tolls and other costs recorded on the loads**. It is not profit: the truck's fixed costs are not in it, and a load with no cost recorded counts as costing nothing (the screen counts those loads and says so).

## The seven effects

With A the earlier week and B the later one, L the loaded miles, D every mile driven, E = D - L the empty miles, H the line haul, h = H / L the line haul per loaded mile, X the recorded costs and x = X / D the cost per mile driven:

| Effect | Worked out as | Says |
| --- | --- | --- |
| Rate per loaded mile | (h_B - h_A) x L_B | Paid more or less per loaded mile, on this week's miles |
| Loaded miles | (L_B - L_A) x (h_A - x_A) | More or fewer loaded miles, at last week's rate and cost per mile |
| Empty miles | -(E_B - E_A) x x_A | More or fewer empty miles, each at last week's cost per mile |
| Fuel and other costs per mile | -(x_B - x_A) x D_B | What a mile cost (fuel price, tolls, other), on this week's miles |
| Fuel surcharge | F_B - F_A | The surcharge paid |
| TONU and layover pay | O_B - O_A | TONU fees and layover pay |
| Detention billed | T_B - T_A | Detention on invoices. Waiting that was never billed is in the Leak Ledger |

The first four are the change in line haul less the change in costs, regrouped, so the seven add to the change in result **exactly**. The effects are worked out in cents; the few cents rounding leaves go on the largest effect, so a row's effects always add to the change shown on it (a 2,000-case sweep in `tests/moves.test.ts` holds this, including loads whose driven miles are not a clean loaded plus empty).

A lane or customer that ran in only one of the two weeks cannot have its rate and its miles told apart. It gets one line, **Lane started or stopped** (all of its line haul and cost change), and the surcharge, TONU and detention lines as usual. The row says "Ran only this week" or "Ran only the week before".

Effects are per row. The whole-desk bridge is its own calculation, not the sum of the rows' effects (the split is not additive across lanes), but the rows' **changes** add to the desk's change, and the screen's "more lanes" line carries the changes of the rows past the first twenty-five.

## Who sees it

The `bill` capability (an admin, accounting, or a dispatcher an admin has allowed to bill). The terminals in view narrow the loads before anything is added up, so a person limited to a terminal never reads another's figures.

## Not in it

Fixed costs and driver pay, market rates, per-load detail beyond the lane or customer, and a forecast. The Leak Ledger is where unbilled detention and the priced cost of empty miles are.
