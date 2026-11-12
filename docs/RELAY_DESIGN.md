# Relays, recall and the digital baton: design

Status (2026-11-06): Phase 0 (this design) and Phase 1 (recall + holder history) are committed. **Phase 2 (legs, the baton, recall-while-rolling) is built on the Desk and uncommitted**; Phases 3 and 4 each wait for a separate go.

## As built in Phase 2 (Desk only, dispatcher records for the driver)
- **Tables** (`20261209000000_relay_legs_handoffs`): `load_legs` (one custody span: who, in what, from where to where, miles with their source, the pay as it stood when the leg closed) and `handoffs` (the baton). A load that never relays has no leg rows.
- **Drop** (`server/tl/relay.ts` `recordDrop`): only a load on the road with a driver. Closes the leg, **takes the assignment off** (nobody holds the load in the yard; the load stays `in_progress`), unhooks the trailer unless it is a driver swap (planned drops waive the dwell stay, so no false leak), writes a holder-trail row, an audit entry and the baton (`dropped`). Requires what the outgoing driver does now.
- **Receive** (`receiveHandoff`): the next driver's tap alone transfers custody. A hook or a rescue is a different truck, a swap keeps the truck; never the driver who dropped it. Another open load for the driver or truck needs a reason. Writes leg N+1, a new in-progress assignment (**no pay estimate**: phase 3), moves the load to the new truck, hooks the trailer to it, and freezes the baton with a SHA-256.
- **Discrepancy** (`flagDiscrepancy` / `acknowledgeDiscrepancy`): freezes the baton as found, blocks custody until dispatch acknowledges, then the driver can take it with the report on record.
- **Rolling empty** (`unassignLoad(..., positioning)`): a driver recalled after accepting, while rolling empty to the pickup, keeps a closed `positioning` leg with the miles and their source, at their own cents a mile (sign-off 1). No baton: there was no freight.
- **Screens:** an "Awaiting handoff" lane on `/dispatch`, a Relay section on the load page (legs, batons, Hand off / Next driver takes the load / Report a problem / Acknowledge), the rolling-empty option in the Recall dialog.
- **Alerts:** `HANDOFF_WAITING` (warn at 1 h, block at 4 h) and `HANDOFF_DISCREPANCY` (block). A load dropped by a hook or rescue no longer counts against its old truck for double-booking (alerts and the assign/receive clash checks); a swap keeps the truck on the load.
- **Not built yet:** per-leg pay and settlement (phase 3: until then the closed leg keeps its pay as it stood and the next driver's assignment has no estimate, so legs are paid by hand), photos and documents on the baton, the planner's per-leg blocks, the bridge/phone (phase 4), hours-of-service checks for the incoming driver beyond the cleared-card and double-booking checks, the Leak Ledger per leg (it still prices on the load's one frozen floor).
Source of truth for the plan: `~/.claude/plans/im-a-bit-worried-jiggly-cherny.md`. This page is the copy that lives with the code.

## Why
The desk assumes one load = one driver = one truck = one trailer.

- `Assignment.loadId` is unique (`prisma/schema.prisma`, model `Assignment`).
- `unassignLoad` (`apps/web/src/server/tl/dispatch.ts`) refuses once a trip has started.
- A taken-off driver survives only as free-text audit.
- `DESK_AUDIT_2026-11.md` rates relay, team, slip-seat and breakdown replacement "Not possible", P1, "design doc first". This is that doc.

Two problems, one answer: **who holds the load right now, and what happens when that is wrong.**

Out of scope everywhere: the self-dispatching owner-operator flow in the phone app. It is complete and must not change.

## The model
| Thing | Meaning | Count per load |
| --- | --- | --- |
| **Load** | The commercial contract: one rate, one invoice. | 1 |
| **Leg** | One custody span: a driver + truck (+ trailer) from A to B. | 1 for a normal load, 2+ for a relay |
| **Baton** (handoff) | The record that closes leg N and opens leg N+1: where, when, seal, paperwork, condition, who recorded it. | legs - 1 |

At every moment exactly one custodian holds the load: a leg's driver, or **"in yard, awaiting handoff"** between a drop and a hook.

### Strangler, not rewrite
`Assignment` stays 1:1 with the load and means "the current holder". Every existing consumer keeps working unchanged: board, planner, alerts, settlement eligibility, bridge, KPI. `LoadLeg` and `Handoff` are added beside it in Phase 2.

Not chosen: dropping `@unique` on `Assignment.loadId`. It turns `load.assignment` into a list and touches all of those consumers at once.

### The exchange point is not a Stop
`Stop.stopType` is pickup or delivery only. If an exchange were a stop:
- `legKinds` / `splitRouteMiles` (`lib/geo.ts`) would read it as loaded or empty miles.
- `lib/detention.ts` has no stop-type filter, so a wait there would bill the customer.

The exchange lives on the `Handoff` row (name, lat/lng, slot), not in `stops`.

## Sign-offs (Chris, 2026-11-06)
1. **Recall before pickup:** the driver is paid standard CPM for the deadhead miles driven. (Phases 2/3.)
2. **KPIs:** a relayed load counts as 1 commercial load; miles and driver pay are split across legs. (Phase 3.)
3. **Recall codes:** `ASSIGNED_IN_ERROR`, `HOS_TIMEOUT`, `MECHANICAL_BREAKDOWN`, `DRIVER_UNRESPONSIVE`, `SCHEDULED_RELAY`. Dispatch role only. Phase 1 offers the first four; `SCHEDULED_RELAY` is reserved for the Phase 2 handoff.
4. **Baton release:** the incoming driver's tap alone transfers custody. Freeze and alert dispatch only when a discrepancy or damage is flagged. (Phases 2 and 4.)

Build 1 relay types: drop-and-hook at a yard, breakdown rescue, driver swap / slip-seat. Deferred: power-only / outside carrier (needs authority, COI and an interchange agreement), cross-dock / transload (piece counts, OS&D: warehouse management).

## Custody states
```
Load status (unchanged strings): draft | accepted | in_progress | completed | tonu | cancelled

Assignment (current holder):  draft -> dispatched -> accepted -> in_progress -> completed
                                 ^          |            |
                                 +-- recall-+------------+      (Phase 1: before the trip starts)

Relay (Phase 2, derived, not a new Load.status):
  leg 1 rolling -> baton DROPPED (awaiting handoff, in yard) -> baton RECEIVED -> leg 2 rolling
                                   \-> baton DISPUTED (discrepancy flagged) -> RESOLVED
```
"Awaiting handoff" is derived from the baton, so no `Load.status` string comparison anywhere has to change.

## Recall table
"Wheels rolled" = the leg's `startedAt` (driver taps Start, dispatcher marks "rolling", or the ELD shows the truck moved after accept). Miles so far always carry a source (ELD / driver / dispatcher); a figure nobody can source stays unknown, never a guess.

| Case | Behaviour | Phase |
| --- | --- | --- |
| Wrong driver, not sent | Plain reassign. | exists |
| Sent, no answer, wrong driver | Recall to the bucket with a reason code. The recall is a stored event; the driver link is told. | 1 |
| Driver confirmed in error | Driver undoes the accept on the phone, or the dispatcher recalls. Both audited. | 1 |
| Not moved yet | Clean undo; load back in "Needs a driver"; recall kept as a structured event. | 1 |
| Rolling, **empty** (before pickup) | No freight to hand over. Leg 1 closes as positioning only; driver paid CPM for the miles driven; the load returns to the bucket. No baton. The new driver still goes to the shipper. | 2/3 |
| Rolling, **loaded** | Becomes a handoff: leg 1 closes where the trailer is; baton required; leg 2 starts there. | 2 |
| Driver offline, recall not delivered | Desk shows the recall as "waiting to reach the driver link, call the driver". Never worded as "driver acknowledged": the phone cannot confirm yet. | 1 (state), 4 (ack) |
| Two dispatchers at once | Existing compare-and-set (`claimLoad`, `claimAssignment`, `LoadMoved`). | exists |
| Leg settled or load invoiced | Recall blocked (same rules as `reopenDelivered`). | 2/3 |

## Edge-case matrix (what must not break)
| # | Edge case | Where it bites today | Answer |
| --- | --- | --- | --- |
| A | Outgoing driver after a drop ("now what?") | nothing models it | A drop prompts: bobtail leg / available at yard / return load. |
| B | HOS clock-out short of the yard | planned location only | Handoff location is dynamic; dispatcher types it until the phone can drop a pin. |
| C | Incoming driver finds a broken seal or damage | no record | Photo + "report discrepancy" before accepting custody; freezes the baton and alerts dispatch. |
| 1 | Leg ownership | `Assignment.loadId` unique, unassign refused once started | Strangler: `Assignment` = current holder, `LoadLeg` = history. |
| 2 | Pay per leg | `SettlementLoad.loadId` unique; cpm uses the load's loaded miles | Key becomes (loadId, legSeq); percent shares across legs sum to at most 100%. |
| 3 | Miles | `routeLegs` reads a relay point as loaded | Exchange not a stop; leg miles from leg boundaries with a source label. |
| 4 | Cost | one frozen floor per load | Ledger keeps the load floor; Data Health says "relay legs not priced per leg". |
| 5 | Detention | all stop waits bill the customer | Exchange waits are internal; per-stop wait attributed to the leg whose driver was there. No driver detention pay exists yet: deferred. |
| 6 | Trailer | drop starts a dwell clock; hooking clears a typed dwell figure | Planned drops are tagged so they do not start a false dwell leak. |
| 7 | HOS | per truck, whole trip | Incoming driver checked against the handoff time and place. |
| 8 | Double-booking | one load window | Per-leg windows. |
| 9 | Customer and KPI | invoice, `paid_short`, TONU are load-level | They stay load-level; only miles and driver pay split by leg. |
| 10 | Clean data | one driver, one truck per check | Each leg has its own driver, truck, pay and arrival checks; handoff time carries a source. |

Alert rules that go blind or misfire on leg 2 today (`lib/alerts.ts`): `DOUBLE_BOOKED`, `TRUCK_DOUBLE_BOOKED` (false overlap over the whole load window), `PICKUP_NO_DRIVER`, `LATE_TO_PICKUP`, `LATE_ON_ROAD`, `SENT_NO_ANSWER`, `NO_TRUCK`, `DRIVER_CLEARANCE`. Signal keys will include the leg so a second offer notifies again (`notifyDue` fires once per level).

## Module change list
1. **Schema:** `AssignmentEvent` (Phase 1); `LoadLeg`, `Handoff` (Phase 2). Prisma is the source of truth; `supabase/` is generated (`npm run db:export-supabase`); applying to prod is Chris's.
2. **Lifecycle** (`lib/load-state.ts`, `server/tl/dispatch.ts`, `execution.ts`, `claim.ts`, `disruptions.ts`): recall (1), recall-to-handoff, drop, receive (2). `startTrip` / `undoStartTrip` per leg; `completeTrip` on the final leg only.
3. **Dispatch bucket** (`/dispatch`, `/loads`, `/planner`, `assign-modal`, `load-view`, `lib/desk-timeline.ts`): recalled chip in "Needs a driver" (1); "Awaiting handoff" lane, relay badges, per-leg planner blocks (2).
4. **Alerts / signals:** per-leg windows; new rules (handoff waiting, discrepancy, leg with no driver, late to exchange). Phase 2.
5. **Money** (`lib/pay.ts`, `lib/settlement.ts`, `server/tl/settlement.ts`): per-leg pay and statement key. Phase 3.
6. **Telematics / evidence:** current leg's truck; `freezeEvidence` and `StopEvidence.vehicleId` per leg window. Phase 2/3.
7. **Hours / shifts:** incoming driver ranked against handoff time and place. Phase 2.
8. **Bridge contract:** additive v3; see `BATON_CONTRACT_V3.md`. Phase 4.
9. **Phone, dispatched side only:** drop and pickup flows, offline queue. Phase 4, behind the dispatched flag.
10. **Clean data:** dispatcher-entered handoff values are marked as such (like "Answer for the driver"); unknown stays unknown.

## Test matrix
| Phase | Unit | Integration (needs Postgres, `RUN_DB_INTEGRATION=true`) |
| --- | --- | --- |
| 1 | recall-reasons | draft unassign needs no code; sent/accepted without a code refused; sent + code writes a `recalled` event, audit and bridge `cancel`; accepted + code returns the load to draft; in-progress refused; concurrent recall gets `LoadMoved`; history order assigned, sent, accepted, recalled, assigned; viewer/accounting cannot recall; terminal scope fences |
| 2 | load-state, alerts, planner, schedule | every recall-table row; each of the three handoff types; discrepancy freezes the baton; per-leg double-booking; planned drop is not a dwell leak |
| 3 | pay, settlement | per-leg statement lines; shares cap at 100%; a leg cannot be paid twice; KPI counts the load once |
| 4 | bridge core, projector | driver-safe projection has no revenue or other driver's pay; phone `completed` closes a leg, never the load; self-dispatch trip render unchanged |

## Open items
- Phone capture that does not exist yet: BOL/loaded photo, odometer, signature, trailer number (Phase 4).
- Driver detention pay (separate from the customer's detention) does not exist; isolating detention per driver is a new feature.
- Bridge write-back is online-only with no queue; an offline queue is a Phase 4 prerequisite.
- Parked gap D-TRIP-CONFIDENTIALITY (trip detail not role-gated, so a hired driver sees revenue) must close before any baton projection ships.
