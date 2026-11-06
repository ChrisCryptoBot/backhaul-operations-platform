# Detention evidence pack

`/detention/[loadId]` (a printable sheet), a card on **Invoices**, and a line in the load's Dock Waiting & Detention panel. What a truck's own track says about each stop of a delivered load, kept so a detention claim weeks later still has its proof, and confirmed by a person before it changes anything.

Rules: `apps/web/src/lib/detention-evidence.ts` (pure). Freeze, read and decide: `apps/web/src/server/tl/detention-evidence.ts`. Table: `stop_evidence` (migration `20261206000000_stop_evidence`).

## The problem it answers

Detention is only ever as good as a typed `stops.wait_minutes`. A truck that sat at a dock and nobody wrote it down is invisible to the Invoices recovery list and to the Leak Ledger, and a wait that *was* typed has no proof behind it when the broker disputes the invoice's Detention line. The ELD's position fixes (`vehicle_pings`) can answer both, but they are deleted after seven days (`PING_KEEP_DAYS`) and a claim is made weeks later. So the evidence is frozen at delivery.

## What the track supports (conservative by construction)

A stop counts as **at the facility within 0.25 mile** (a dock or yard, not the next exit). The Where-it-is tab keeps its own one-mile line; the two are different on purpose.

- **Arrival** is the **first fix inside**, **departure** the **last fix inside**: the truck may have come earlier and left later, so a proposal is never larger than what the track can prove. The gap to the neighbouring fix outside is kept and shown (`before_gap_min`, `after_gap_min`).
- A **visit** is one run of fixes inside. The truck seen outside for 30 minutes or less between two stretches inside, or never seen outside between them, is one visit (pulled forward, or round the block). A longer absence starts a second visit; only the **first** is proposed and the count is shown.
- **The clock starts at the later of the arrival and the appointment window's start.** Wait = departure minus that, in whole minutes (rounded down), never below zero. Arrive early and the wait still counts from when the window opens.
- A truck **still inside at the last fix** has an arrival and no departure: no wait is proposed, and a person must type one (with why).
- **Quality**: `good` (the first fix inside is within 20 minutes of the last one outside before it, the same at the departure, and at least three fixes inside); `thin` (a longer gap at either end, fewer than three inside, or a track that starts with the truck already there); `none` (the truck had fixes but never came within 0.25 mile: the row says so, and it stops the catch-up retrying). A truck with no fixes at all in the days around the delivery gets no row.
- What a wait is **worth** is the invoice's own rule (`computeBillableDetention`): minutes past the free time at the truck's rate (the load's frozen terms, else the truck's cost profile, else the company's free time). No rate, no amount.

## What is stored, and when

One row per placed stop (`stops.lat/lng` set): the fixes within two miles of the stop (at most 200, thinned evenly while always keeping the ones that decide the visit), the proposal, the quality, and a **SHA-256 of the canonical evidence**, so the sheet can say whether it has been touched since (`matches what was frozen` / `DOES NOT MATCH`). The row is kept with the load and removed only with it; it is **not** purged with the fixes.

Frozen **when the load is delivered** (`completeTrip`, best effort: it never fails a delivery), and by a **catch-up** that covers loads delivered in the last six days with a placed stop and no evidence yet (a delivery entered late, or fixes that arrived after). The catch-up runs at the start of `POST /partners/cron`, **before it deletes old fixes**, and from `POST /signals/cron`. A stop that already has evidence keeps it: it is replaced only while still undecided and only if the track now shows *more* of the visit, never less, because once the fixes are deleted a second look would find nothing and must not erase the proof.

## A proposal changes nothing

It does not touch the stop, the load, the alerts, the Invoices recovery or the Leak Ledger. The Invoices card, "Detention the truck's track shows, not yet confirmed", lists delivered stops with a proposed wait past the free time that is longer than what was typed (including stops where nobody typed anything), newest first, with the amount: detention the desk has not recorded. It is not counted in any total.

## Deciding (the `figures` capability, the office that may correct a trip)

- **Confirm** accepts the proposal as it is, or a different wait in whole minutes (up to a week) with **a few words on why** (required whenever it differs from the track, and whenever the track has no wait). The arrival is the track's; to change that, correct the trip on the load. Confirming writes the stop's arrival and wait **through the same `correctTrip` every other correction uses**, so the dock wait is recomputed, the audit trail records before and after, and the Invoices recovery and the invoice's Detention line pick it up with no new money code. The arrival is stored to the minute (seconds of the fix are dropped, as for anything typed on a stop).
- A load that has **already been invoiced** refuses a rewrite (the invoice carries the waits it was billed on); the refusal says so. The evidence can then be **kept as proof only**: it is marked confirmed, the stop and the load are not changed, and the sheet says so.
- **Dismiss** needs a reason (at least three characters) and writes nothing to the stop.
- A decided row is final. Both decisions are audited (`detention_evidence_confirmed`, `detention_evidence_dismissed`).

## Who sees it

Reading needs `dispatch`, `bill` or `figures`; the terminals the person is limited to fence every read and every decision (another terminal's sheet is not found, and a decision by id is refused in the same words as for evidence that does not exist). Another desk's rows are never read. Nothing about positions leaves the desk.

## Honest limits

- **Today the only fixes are the sandbox simulator's.** No live ELD call exists (the Motive adapter is sandbox-only), so real evidence appears only once a live adapter writes `vehicle_pings`. The freeze, the pack and the confirm are built and tested; the quality of the data is the ELD's. The demo's two sample loads (`DM-EV-01`, a good track; `DM-EV-02`, a thin one) come from `scripts/seed-evidence-demo.ts`, which writes loads and made-up fixes only. It is opt-in and not part of `seed-demo.ts`, so the demo's baseline totals stay as the tests pin them: run it, then `POST /signals/cron` once, and the evidence is frozen by the same catch-up. `--remove` takes the sample away again.
- Fixes are only as frequent as the ELD sends them: a sparse track is graded `thin` and the sheet says the times are approximate.
- The phone's own arrival tap (`startTrip`) is not read here.
