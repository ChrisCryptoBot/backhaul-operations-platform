# Leak audit, November 2026

What this is: an audit of how well the desk finds and patches the freight leaks on the consulting page, and how it compares with a weekly KPI tracker a prior company ran in a spreadsheet. Written from the code (file references are under `apps/web/src`), then updated after the quick wins in this round were built. Nothing here names the prior company or its places.

How to read the status: **Built** means the desk computes it automatically and shows it; **Partial** means a piece is there but a person must type something, or a part is missing; **Missing** means not found. "Needs typing" says who has to enter a figure for the number to exist.

## 1. The leaks on the consulting page

| # | Leak | Before this round | Now | Where | What is still missing |
|---|---|---|---|---|---|
| 1 | Rate vs market | Built | Built | `truelane/lib/domain/marketVariance.ts`, `server/tl/kpi.ts`, KPI histogram, Lanes "Against market", Quote verdict (`lib/verdict.ts`) | The market rate is typed per load (or taken from the lane's own record); there is no market feed |
| 2 | Lane profit | Partial (gross, per mile, empty %) | Partial | `/lanes` | No net per lane (needs cost allocation per load) |
| 3 | Customer profit | Partial | Partial | `/customers` | No net per customer |
| 4 | Unbilled accessorials | Partial (detention only) | Partial | `DETENTION_UNBILLED` alert, Invoices "Detention not yet billed", waive with audit | Lumper and layover never billed are not detected |
| 5 | TONU recovery | Partial | Partial | `server/tl/disruptions.ts`, KPI, invoice line | No TONU dollars trend or billed-vs-owed view |
| 6 | On-time pickup and drop | Partial (one figure) | **Built** | KPI Service card, report | Pickups and deliveries now split; the KPI rule has no grace, the driver scorecard uses 60 min early and 30 late (left as it is) |
| 7 | SLA by customer | Missing | **Built** | `/customers` On time column | The share of stops reached by the window close, per customer |
| 8 | Why loads fail | Built, with gaps | Built, with gaps | KPI "Why loads fell through" | Driver declines and passed quotes are not in the same card (passed quotes are on `/kpi/quotes`) |
| 9 | Rolled loads | Partial (audit only) | **Built** | KPI Service card, `/customers` Rolled column, report | Counted from reschedule events, with the reason picked |
| 10 | Lead time | Missing | **Built** | KPI Service card, `/customers` Books ahead, report | Days from booking to pickup |
| 11 | Deadhead by lane | Built | Built | `/lanes`, KPI deadhead bars | Now also total empty miles before and after, loaded and trip miles per lane |
| 12 | Cost per mile | Partial | Partial | per-truck floor on `/fleet`, "cleared the floor" share | No actual cost per mile by lane or period |
| 13 | Load mix | Missing | **Built** | KPI Load mix card | Share of loads and revenue by trailer, load type and customer |
| 14 | Driver utilization | Partial | Partial | Planner supply and demand, driver table | No days or hours on loads vs available, and no history |
| 15 | Dwell time | Partial | Partial | dock waits in KPI, trailer dwell with typed override | Waits not by lane or trend; trailer dwell has no history |
| 16 | Trucks running empty | Partial | **Built** | KPI "Empty miles by truck", `kpi-trucks` CSV, `/lanes` | Worst ten trucks; a lane-by-week grid is on `/lanes` |
| 17 | Reports built by hand | Partial | Partial | `/kpi/report` (print or PDF), CSV exports | The report is still built by a person clicking; nothing sends itself |
| 18 | Lanes and customers quietly losing money | Partial | Partial | lane scorecard (BELOW/OK against a target), "Below market" chips | No alert and no automatic "why"; the week-over-week change is shown per lane but not explained |

"What seals it" on the page:

| # | Promise | Status | Where | Gap |
|---|---|---|---|---|
| 19 | Automated pipelines (a weekly report that builds and sends itself) | **Missing** | the partner and driver-link cron routes exist (`app/(public)/partners/cron`, `bridge/cron`); `vercel.json` has no `crons` | No scheduler, no report builder that runs by itself |
| 20 | Real-time alerts by text, email or Slack | **Missing** | alerts are in-app only (`lib/alerts.ts`, `/alerts`), derived on request and stored nowhere | No outbound channel, no mail or SMS or Slack dependency |
| 21 | Predictive models | **Missing** | none | Needs history first |

## 2. The weekly KPI tracker, metric by metric

| Tracker metric | Before | Now | Where |
|---|---|---|---|
| Loads, line-haul revenue, revenue per load (per lane) | Partial | **Built** | `/lanes` Per load, report |
| Loaded miles, pickup and delivery empty miles, total empty and trip miles (per lane) | Partial (averages only) | **Built** | `/lanes` Loaded, Empty (total), Trip columns; `kpi-lanes` CSV; report lines |
| Empty-mile % | Built | Built | `/lanes` |
| All-in rate per mile | Built | Built | `/lanes` Per mile |
| Negotiated floor rate vs all-in (two separate figures) | Missing | Missing | The desk has one gross-per-mile; a negotiated-only line is the line haul without the surcharge (now summed on the KPI) |
| Fuel surcharge dollars | Stored only | **Built** | KPI Fuel surcharge card, report, CSV |
| Target rate per lane and "vs target" | Missing | **Built** | `/lanes` Target per load (typed by dispatch or billing), Vs target, `lane_targets` table |
| Lane scorecard with BELOW / OK | Partial (market only) | **Built** | `/lanes` Scorecard chip |
| Weekly totals row | Partial | Partial | KPI headline and report; there is no per-lane weekly totals row |
| Week-over-week trend with variance and charts | Partial (company-wide) | **Built** | KPI 12-week trends, `/lanes` "Lanes, week by week" for the ten busiest lanes |
| Weekly KPI report | Partial | **Built** | `/kpi/report`: loaded and deadhead miles, fuel surcharge, on-time split, books ahead, rolled, offers and acceptance |
| "Operational challenges / notes for the call" | Missing | **Built** | Notes box on the report, one per week, kept and audited, printed with the report |
| Fuel surcharge summary: weekly diesel index, rate per loaded mile, percent, prior-week comparison | Missing | **Built** (history builds from now) | KPI Fuel surcharge card; the diesel price is kept (`diesel_prices`) each time EIA is read, with a button to read it; no scheduler, so the comparison needs a read each week |
| Tender offers received vs accepted, acceptance % | Partial | **Built** | KPI Offers and acceptance card: quotes received (saved or decided, and still open) against booked |

## 3. What the desk has that the tracker never did

Per-load verdict against the truck's own floor, the Quote desk, detention recovery and its waive, trailer dwell with a person's override, the radar map with clusters and a radius search by ZIP or city, shifts and driver codes, the audit trail, role-based access, and one environment for loads, dispatch, drivers, fuel, ELD and invoices (the point of the package).

## 4. Not covered (needs an outside service or a decision)

- Email, text or Slack alerts and a report that sends itself: a mail or SMS provider and keys, a Slack webhook, and a scheduler. Phase B of the plan designs these as an adapter seam like the partner adapters.
- Forecasting and predictive models: after the data has history.
- A market-rate feed.
- Net profit per lane and customer (cost allocation per load).
- TONU dollars trend; detecting a lumper or layover that was never billed; per-day driver utilization history.

## 5. Next (Phase B, not built)

1. **Leak ledger:** one weekly dollar figure per leak (empty-mile cost at the truck's cost per mile, unbilled detention, trailer dwell, below-floor shortfall, TONU not invoiced), with a trend and a drill to the loads. The consulting page's own samples are all dollar leaks.
2. **Signals that persist and notify:** stored signals with a first-seen date and a status, thresholds per company, and delivery by Slack, email and text on a schedule.
3. **Data health:** a completeness score and cross-source checks only one package can make (fuel card against trip fuel, ELD miles against billed miles, rate confirmation against invoice): the Data Readiness read, produced in the app.
4. **Why it moved:** split a lane's week-over-week change into rate, miles, deadhead, fuel and detention.
5. **Load-history importer** with column mapping, so a client's TMS export or weekly tracker can be loaded.
6. **Detention evidence pack** from geofence arrival and departure, proposed and confirmed by a person.

## 6. The consulting page against the product

The page's thesis is right: signals are only trustworthy when the data is in one place. Suggested copy changes until Phase B is built:

- Say which parts are live today: the dollars-and-miles read, lane and customer scorecards, detention and dwell, a weekly report with notes. Say which are coming: alerts by text, email or Slack, a report that sends itself, predictive models.
- Add what a carrier asks before handing over data: who can see what (roles exist), export and deletion, and retention, beside the NDA line.
- Offer the package framing the founder described: dispatch, the app and the TMS in one environment, with the read as the way in.
- The $750 read can be produced from the desk's own data once Data health exists.

## How this was checked

By reading the code and the schema, then building and testing each quick win (`tests/kpi-quickwins.test.ts`, `tests/kpi-extras.test.ts`, `tests/integration/kpi-quickwins.integration.test.ts`). Dollar figures on screen are computed from stored loads; none is invented. The diesel history starts when the price is first read.
