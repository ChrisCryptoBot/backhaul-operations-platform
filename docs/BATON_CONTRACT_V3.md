# The baton: contract v3 (draft, no code)

Status: Phase 0 draft, 2026-11-06. Nothing here is built. It is the shape Phase 2 (Desk) and Phase 4 (bridge and phone) will both use, so the phone is "a simple UI that sends the same payload the desk dispatcher can already enter".

The frozen v2.1 contract (`docs/parked/EXTERNAL_DISPATCH_CONTRACT.md` in the phone repo) is **not edited**. v3 is additive: new row kinds and new optional fields. A v2.1 reader that ignores them keeps working.

## Principles
- One custodian at a time. Between a drop and a hook the custodian is "yard".
- **Every value names its source** (`driver`, `dispatcher`, `eld`) and who entered it. A value nobody can source is `null`, never an estimate.
- The dispatcher can enter any baton field on a driver's behalf (like "Answer for the driver"); the record says so.
- A baton carries no money: no revenue, no rate, no other driver's pay. It passes the same driver-safe check as the dispatch summary (`assertDriverSafe`).
- The proof (seal photo, documents, condition photos) is frozen with a SHA-256 over the baton at the moment custody transfers or a discrepancy is flagged, as detention evidence is.

## Baton shape
```jsonc
{
  "kind": "baton",
  "batonId": "string",              // desk id
  "loadId": "string",               // source_load_id, as v2.1
  "type": "drop_hook | rescue | slip_seat",
  "reason": "planned | hos | breakdown | recall_convert",
  "state": "planned | dropped | received | disputed | resolved",
  "outgoingLeg": 1,                 // legSeq closing
  "incomingLeg": 2,                 // legSeq opening (null until a driver is named)
  "location": {
    "name": "Pilot Flagstaff #204",
    "lat": 35.19, "lng": -111.65,
    "slot": "12",
    "setBy": "planned_yard | emergency_pin | dispatcher_typed"
  },
  "equipment": {
    "tractorOut": "string|null", "tractorIn": "string|null",
    "trailer": "string|null"     // the trailer number; null when it is not recorded
  },
  "custody": {
    "droppedAt": "ISO|null", "droppedSource": "driver|dispatcher|eld|null",
    "receivedAt": "ISO|null", "receivedSource": "driver|dispatcher|null"
  },
  "seal": {
    "number": "string|null", "photoRef": "string|null",
    "matchesOnPickup": "true|false|null"
  },
  "documents": ["documentId"],      // LoadDocument rows (BOL, scale ticket, POD of leg 1)
  "reefer": { "setTemp": "number|null", "actualTemp": "number|null", "fuelPct": "number|null" },
  "condition": { "ok": "true|false|null", "photoRefs": ["string"], "notes": "string|null" },
  "discrepancy": {
    "flagged": false,
    "raisedBy": "incoming_driver|dispatcher|null",
    "photoRefs": ["string"], "notes": "string|null",
    "acknowledgedBy": "string|null", "acknowledgedAt": "ISO|null"
  },
  "outgoingNext": "bobtail | hook_empty | return_load | available_at_yard | null",
  "enteredBy": { "name": "string", "via": "phone | dispatcher" },
  "frozen": { "at": "ISO|null", "sha256": "string|null" }
}
```

## Rules
1. **Drop** (outgoing driver, or dispatcher for them): sets `state: dropped`, writes `droppedAt` and the location, and requires `outgoingNext` (edge case A). The load shows "Awaiting handoff".
2. **Receive** (incoming driver's tap alone, sign-off 4): sets `state: received`, `receivedAt`, and transfers custody. No dispatcher release is needed.
3. **Discrepancy** (edge case C): the incoming driver may raise one **before** accepting custody, with at least one photo. State becomes `disputed`, the baton is frozen, dispatch is alerted at block level. Custody does not transfer until dispatch acknowledges or the driver accepts with the discrepancy on record. The outgoing driver is not blamed by default: the record shows condition as found.
4. **Emergency stop** (edge case B): `location.setBy` is `emergency_pin` (phone) or `dispatcher_typed`; the incoming driver's route is rebuilt from it.
5. **Recall-convert** (rolling and loaded): the dispatcher creates a baton with `reason: recall_convert`, location = where the trailer is, and leg 1 closes with miles that carry a source.

## Additive bridge changes (Phase 4)
- Row per leg: the key `(org_id, source_load_id, assigned_driver_id)` already allows several driver rows per desk load; a `leg_seq` optional field is added.
- New outbox kinds beside `dispatch | update | reassign_old | cancel`: `recall` (carries a reason code, so the phone can say why), `handoff_drop`, `handoff_receive`.
- Driver-safe projection: only the leg's own stops and the baton documents; never revenue, never another driver's pay.
- `respond_to_dispatch` gains `handoff_drop` and `handoff_receive` responses; `completed` closes a **leg**, never the load (the phone's `completed` is final in `lib/loadStatusMerge.ts`, so the leg row must be a separate row from the load).
- Offline: the phone write path needs a queue first; today a failed write returns `'error'` and nothing retries.
