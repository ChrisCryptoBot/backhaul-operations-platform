# TrueLane Dispatch: partner integration specification

For the engineering teams of ELD and telematics, factoring, shipment-visibility, payroll and carrier-data companies that want to connect to a carrier's TrueLane Dispatch desk. This document describes what the desk does today, as built, and says plainly where a company's own side is still to be written. It is accurate to the code at the commit that carries it; `tests/partner-spec.test.ts` fails if the routes, headers, event kinds, polling numbers or the worked signature below drift from the code.

**Read this first: what is and is not live.** Every company below is reached through an adapter with a built-in simulator. No company's real endpoint, payload or signing scheme is in the desk, and none is guessed. A carrier can enter a test key (one that starts with `sandbox_`) and exercise the whole pipeline end to end against the simulator, which opens no network. The live call to a company is not switched on until a company is chosen and its adapter is written against its own documentation. Nothing here claims otherwise.

## 1. The model: a carrier's own account, BYO credentials

TrueLane does not resell a partner's service and does not hold one master key. Each carrier ("fleet") connects its **own** account with the partner by entering that account's API credentials in Settings, Integrations. The desk seals them on the server (never returned to a browser, never logged) and calls the partner on that carrier's behalf. A carrier can disconnect and remove its keys at any time.

Capabilities and the companies the desk is built to reach (the list is the vendored contract, `src/truelane/partners/contract.ts`; a company that is not listed needs a contract change first):

| Capability | Companies in the contract | State today |
|---|---|---|
| ELD and telematics (`eld`) | Motive, Samsara | Motive: full simulator (positions, speed, heading, engine state, idle time, hours of service, fleet and roster). Samsara: answers `not_implemented`. Live call for both: not written. |
| Shipment tracking (`tracking`) | project44, FourKites | project44: simulator with stop geofence events. FourKites: `not_implemented`. |
| Factoring (`factoring`) | TriumphPay | Simulator with the full status flow. Live call: not written. |
| Payroll (`payroll`) | Gusto | Simulator. Live call: not written. |
| Carrier vetting (`vetting`) | Highway | Simulator. Live call: not written. |
| Fuel cards (`fuel_card`) | AtoB, WEX | WEX: simulator. AtoB: `not_implemented`. Live call for both: not written. |
| IFTA (`ifta`) | ProMiles | Simulator. Live call: not written. |

**Spireon is not a company the contract knows.** Adding one is a contract change (a name in the capability's list, the names of its secrets, and an adapter file), made in the TrueLane phone repository and vendored into the desk. The adapter interface in section 6 is what a company implements against.

## 2. Webhooks (a company tells the desk)

**Endpoint.** `POST /partners/webhook/{provider}/{token}`. `{provider}` is the company's name (for example `motive`, `triumphpay`) or its capability (`factoring`); `{token}` is a private, per-connection token of 20 to 80 characters (letters, digits, `_`, `-`) that the carrier copies from Settings into the company's webhook settings. The route is open to a signed-out caller on purpose: the signature is the credential.

**Signature.** HMAC-SHA256, lowercase hex, computed over the **raw request body bytes** under the connection's webhook secret, sent in the **`x-signature`** header as `<hex>` or `sha256=<hex>`. Compared in constant time. A missing, malformed or wrong signature is a 401 and the body is not read. The signing secret is the carrier's own (set beside its API key in Settings) or, failing that, the server's; the name of each company's secret is in the contract (`MOTIVE_WEBHOOK_SECRET`, `TRIUMPHPAY_WEBHOOK_SECRET`, and so on). The header name is one line to change per company when its real one is known.

Worked example (the same example is checked by a test): secret `whsec_example_0123456789`, body

```json
{"id":"evt_1001","type":"factoring.funded","reference":"INV-1001","reference_id":"TP-77"}
```

gives `x-signature: 03c9cf20540c4c7206535027579c93cc8039e0effb2bdd75a23139cef6eec838`.

```js
// Node
const sig = require("crypto").createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
```

```python
# Python
import hmac, hashlib
sig = hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
```

**Body limit.** 256 KB. Larger is a 413.

**Neutral envelope.** `{ "id": string?, "type": <kind>, "reference": string?, "reference_id": string? }`, plus `stop` (the stop's number in the load) for tracking events. `id` is the company's own id for the event and is what makes a repeat recognisable; a body with no id gets a stable one from its bytes. A company with its own event shape is mapped into this envelope by its adapter (TriumphPay, Gusto and project44 have modeled mappers; none is confirmed against a real payload).

**Event kinds (closed set).** `factoring.submitted`, `factoring.funded`, `factoring.paid`, `factoring.rejected`, `payroll.paid`, `tracking.arrived`, `tracking.departed`, `ping`. Any other `type` is recorded as ignored, never rejected.

- `factoring.*` moves an invoice's factoring status one allowed step from where it is (a replay or an out-of-order event cannot move it backwards); `reference` is the invoice number or the factor's reference.
- `payroll.paid` marks the sent statements on a run as paid.
- `tracking.arrived` and `tracking.departed` record a shipment milestone against the load named by `reference` (the stop by `stop`).
- `ping` is a connectivity test and is recorded and audited.
- **There is no telematics push event** (ignition, idle, position) in this set. ELD data reaches the desk by polling (section 3). A push event would be an addition to this set and its mapper; it is not built.

**Answers.** `200 {"ok":true,"result":"applied"}` when the event changed something, `"ignored"` when it was valid but changed nothing, `"duplicate"` when that event id was already seen (safe to retry). `401` invalid signature, `404` unknown token or a company name that does not fit it, `400` body is not JSON, `413` too large.

**Idempotency and retention.** One record per `(company, event id)`; a repeat answers `duplicate` and changes nothing. Event records hold an id, a kind and an outcome only (never a body) and are removed after 90 days.

## 3. Polling (the desk asks a company)

| Capability | Mode | Rhythm |
|---|---|---|
| ELD and telematics | poll | every 15 minutes; a connection with no answer for 90 minutes is shown as overdue |
| Carrier vetting | poll | every 24 hours; overdue after 3 days |
| Factoring, payroll, tracking | events | the company tells the desk; silence is normal, nothing is overdue |
| Fuel cards, IFTA | on demand | when a person asks, never on a clock |

**Health and backoff.** A call that reaches the company and is answered clears its failures and stamps "last synced". A failure (`upstream_error`) adds one; after **3** in a row the connection shows **error** with a Retry. The schedule asks again after **5, 15, 60 minutes, then 6 hours**. A call that never reached the company (not configured, not connected, not implemented) says nothing about the company's health.

**The schedule's heartbeat.** `POST /partners/cron` with the header `x-partner-cron: <secret>` (the server's `PARTNER_CRON_SECRET`). It does not exist (404) until the server holds the secret; a wrong secret is a plain 401. It asks every connection whose time has come, re-seals keys under a rotated server key, and removes expired events and position fixes. The answer is counts only. **The repository does not ship a scheduler:** whoever hosts the desk calls this route every few minutes.

## 4. What the desk reads from an ELD

One `eld` call returns, for the carrier's tractors and drivers, in the desk's own shape (`AdapterShapes["eld"]`, `src/server/partners/call.ts`): per tractor its position and the time of the fix, **speed, heading, engine state (`moving`, `idle`, `off`), hours idled today, minutes standing with the engine on, VIN**, and the hours its driver has left to drive and work; per driver the minutes left on the drive, shift and cycle clocks. With `discover`, the company's whole fleet and roster (unit numbers, VINs, make, model, year; names, licence numbers and the vehicle each driver is assigned to) so a carrier's trucks and drivers can be added in one step. The shapes the Motive adapter assumes (`MotiveLocations`, `MotiveHos`, `MotiveRoster`) are modeled on how a Motive-style API is described, not taken from its documentation: the only things to verify against a real API are those payload types and the live client's three methods (`vehicleLocations`, `hosAvailability`, `fleetRoster`).

What the desk does with it: the radar map, idle fuel waste (about a gallon an hour at the fleet's fuel price), trailer dwell, a load's "Where it is" tab (speed, road, miles to go, ETA, 1-mile geofence) and a caution on a Quote. Position fixes are kept 7 days. None of it changes a verdict or writes an arrival on a stop.

## 5. Credentials and the carrier's consent

Keys are entered by a carrier admin, sealed at rest under a server key, shown back only as a hint (the last characters), and used only on that carrier's own calls. A carrier admin can remove them. The desk sends nothing to a company until that carrier has connected it, and tracking links are shared per load with the carrier's explicit opt-in.

## 6. How a company plugs in (the adapter interface)

A company is one adapter, `{ live, sandbox }`, a function from the desk's input shape to a result `{ ok: true, data } | { ok: false, code, message? }` with one of the codes `not_configured`, `not_implemented`, `not_connected`, `unauthenticated`, `bad_json`, `bad_request`, `method_not_allowed`, `invalid_signature`, `upstream_error`. The desk never sees a company's error text beyond our own code. The simulator is selected by a key that starts with `sandbox_` and is allowed on the demo desk (or where `DESK_PARTNER_SANDBOX=on`), and is deterministic per tractor and quarter hour, so a partner can run it to see exactly what the desk will show.

## 7. What a company must still do to be live

1. Be added to the contract if it is not already listed (Spireon today), with the names of its secrets.
2. Provide credentials and documentation so its adapter's live client can be written (and the assumed payload types checked).
3. Confirm its webhook signing scheme and header, and its event shapes, so its mapper can replace the neutral envelope.
4. Agree the data terms: what the carrier consents to share, and retention.

Contact for partnership and integration: the address on the desk's sign-in page.
