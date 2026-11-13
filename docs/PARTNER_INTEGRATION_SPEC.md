# TrueLane Dispatch: partner integration specification

For the engineering teams of ELD and telematics, factoring, shipment-visibility, payroll and carrier-data companies that want to connect to a carrier's TrueLane Dispatch desk. This document describes what the desk does today, as built, and says plainly where a company's own side is still to be written. It is accurate to the code at the commit that carries it; `tests/partner-spec.test.ts` fails if the routes, headers, event kinds, polling and retry numbers, scopes, plan line or either worked signature below drift from the code. Sections 9 to 12 describe the read API, outbound webhooks, plan gating with the money-moving switch, and Partner issues.

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
| Accounting (`accounting`) | QuickBooks Online (`quickbooks`) | Simulator: an in-memory QuickBooks company per fleet (customers, vendors, items, accounts, invoices, credit memos, payments, bills, journal entries, the change feed). Connects by OAuth 2, not a static key. Live call: not written. |

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

**Event kinds (closed set).** `factoring.submitted`, `factoring.funded`, `factoring.paid`, `factoring.rejected`, `payroll.paid`, `payroll.rejected`, `tracking.arrived`, `tracking.departed`, `ping`. Any other `type` is recorded as ignored, never rejected.

- `factoring.*` moves an invoice's factoring status one allowed step from where it is (a replay or an out-of-order event cannot move it backwards); `reference` is the invoice number or the factor's reference.
- `payroll.paid` marks the sent statements on a run as paid.
- `payroll.rejected` releases a refused payment: `reference` is the run, `reference_id` the statement (all of the run's statements when it is absent), `reason` the company's words. The statement is no longer sent and shows the reason until it is sent again. The desk also asks payroll about runs it has not heard of three days after sending (twice a day), and applies what it finds exactly as these events, so an event that arrives after the poll moves nothing.
- `tracking.arrived` and `tracking.departed` record a shipment milestone against the load named by `reference` (the stop by `stop`).
- `ping` is a connectivity test and is recorded and audited.
- **There is no telematics push event** (ignition, idle, position) in this set. ELD data reaches the desk by polling (section 3). A push event would be an addition to this set and its mapper; it is not built.

**Answers.** `200 {"ok":true,"result":"applied"}` when the event changed something, `"ignored"` when it was valid but changed nothing, `"duplicate"` when that event id was already seen (safe to retry). `500 {"ok":false,"result":"failed"}` when the desk could not apply a verified event (an error on the desk's side): send it again. `401` invalid signature, `404` unknown token or a company name that does not fit it, `400` body is not JSON, `413` too large.

**Idempotency and retention.** One record per `(company, event id)`, written with its verified body **before** the event is applied. A repeat answers `duplicate` and changes nothing, with three exceptions that run the event again: the first try **failed**; the first try has sat unfinished for more than 10 minutes; or the event was ignored for a reason a person can fix on the desk (`No invoice with that reference.`, `No invoice reference.`). The body is kept only while the event is being applied and after it failed; once the event has any other outcome the body is let go and the record holds an id, a kind and an outcome. Records are removed 90 days after they arrive, except open issues (failed, stuck, or ignored for a fixable reason), which stay until a person settles them on Partner issues (section 12) and then 90 more days.

## 3. Polling (the desk asks a company)

| Capability | Mode | Rhythm |
|---|---|---|
| ELD and telematics | poll | every 15 minutes; a connection with no answer for 90 minutes is shown as overdue |
| Carrier vetting | poll | every 24 hours; overdue after 3 days |
| Factoring, payroll, tracking | events | the company tells the desk; silence is normal, nothing is overdue |
| Fuel cards, IFTA | on demand | when a person asks, never on a clock |

**Health and backoff.** A call that reaches the company and is answered clears its failures and stamps "last synced". A failure (`upstream_error`) adds one; after **3** in a row the connection shows **error** with a Retry. The schedule asks again after **5, 15, 60 minutes, then 6 hours**. A call that never reached the company (not configured, not connected, not implemented) says nothing about the company's health.

**The schedule's heartbeat.** `POST /partners/cron` with the header `x-partner-cron: <secret>` (the server's `PARTNER_CRON_SECRET`). It does not exist (404) until the server holds the secret; a wrong secret is a plain 401. It asks every connection whose time has come, delivers the outbound webhooks that are due (section 10), re-seals keys and webhook signing secrets under a rotated server key, and removes expired events, deliveries and position fixes. The answer is counts only. **The repository does not ship a scheduler:** whoever hosts the desk calls this route every few minutes.

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

## 8. Planned partner expansion (after the current build plan, not yet in the contract)

None of the capabilities or companies below are in `src/truelane/partners/contract.ts` or built yet; each requires a contract change, secret definitions, and an adapter after the current money waves conclude:

| Area | Candidate companies / protocols | Intended desk role (planned, not built) |
|---|---|---|
| Broker visibility (`tracking`) | **Descartes MacroPoint** | Broker-requested tracking responses (pushing load milestones / GPS status back to brokers) alongside carrier-initiated tracking links and geofences. |
| Carrier-side factoring (`factoring`) | **RTS Financial**, **OTR Solutions**, **eCapital**, **Apex Capital** | Direct invoice submission, advance/fee/reserve-release sync, and chargeback reconciliation (expanding beyond `triumphpay` and Wave 2 batch files). |
| Tolls and scales (`tolls`, new) | **Bestpass**, **PrePass**, **CAT Scale** | Automated toll and scale receipt ingestion mapped to trucks and loads, feeding settlement deductions, load margin, and Leak ledger checks. |
| EDI & broker tenders (`edi`, new) | **Orderful**, **Stedi** (EDI 204 / 214 / 210), direct broker APIs (e.g., **C.H. Robinson Navisphere**) | Ingesting 204 load tenders into loads and returning 214 milestone status + 210 freight invoices (paired with Wave 7 outbound webhooks and read API). |
| Fuel cards & pricing (`fuel_card` / pricing) | **Comdata**, **TCS Fuel**, **EFS**, **Mudflap**, plus **OPIS** network benchmarks | Wider small-fleet fuel-card import coverage plus expected network discount terms so missed fuel discounts can be priced in dollars. |
| Broker credit & market rates (`market`, new) | **DAT**, **Truckstop**, **Ansonia** | Broker credit / days-to-pay checks before dispatch and lane market benchmarks alongside the fleet's own cost floor. |
| Bank cash reconciliation (`banking`, new) | **Plaid** / treasury feeds | Matching actual ACH/wire deposits against `InvoicePayment` rows, factor advances, and reserve releases for Cash KPI and Data health integrity checks. |
| Fleet insurance & driver qualification (`compliance` / `insurance`, new) | **Tenstreet**, **Foley**, **SambaSafety**, commercial COI / telematics insurers | MVR, PSP, and Drug & Alcohol Clearinghouse tracking, automated COI intake, and opt-in safety-score sharing for insurance renewals. |
| Horizontal breadth (existing capabilities) | **Geotab** (`eld`), **Xero** / **Sage Intacct** (`accounting`), **Check** / **ADP RUN** / **Rippling** (`payroll`), **Fleetio** / **Fullbay** (`maintenance`) | Broader provider coverage within existing or adjacent fleet workflows as customer demand requires. |

## 9. The read API (a fleet's own systems read from the desk)

Sections 2 to 7 are companies the desk calls or that call the desk. This section and the next are the other direction: a carrier's own software (its accounting, its BI, a partner it chooses) reading the carrier's money records, and being told when they change. Both are per fleet, made by the fleet's admin in Settings, Integrations, and come with the plan named in section 11.

**Routes.** `GET` only, open to a signed-out caller (the key is the credential; no cookie or session is read on this path):

| Route | Scope the key needs | Lists |
|---|---|---|
| `GET /api/v1/invoices` | `invoices` | invoices and credit memos (`object` is `invoice` or `credit_memo`) |
| `GET /api/v1/payments` | `payments` | payments recorded against invoices |
| `GET /api/v1/settlements` | `settlements` | driver statements, finalized or voided (drafts are not statements yet and are not listed) |
| `GET /api/v1/loads` | `loads` | loads (a load deleted from the desk is not listed) |

**Keys.** Sent as `Authorization: Bearer <key>`. A key looks like `tlk_live_ab12cd34_<43 characters>`: `tlk_`, then `live` (or `test` on the demo desk; they behave the same), then 8 lowercase letters or digits, then 32 random bytes in base64url. The first part (`tlk_live_ab12cd34`) is the key's public prefix, shown on screen beside its last four characters. The whole key is shown **once**, when it is made; the desk keeps only its SHA-256, the prefix and the last four, and compares in constant time. A key carries one or more of exactly four scopes, `invoices`, `payments`, `settlements`, `loads`, chosen when it is made; it cannot be widened later (make another). A fleet keeps at most 20 keys in use. Revoking is immediate and final.

**Order of checks.** Bearer header, key shape, key by prefix, hash, not revoked, scope, plan, rate window, then the page parameters, then the read (inside the key's own fleet only: the read runs in a mode where no code can fall back to a person's or the demo's fleet).

**Rate limit.** At most **60 requests a minute per key** (a fixed one-minute window counted on the key's row, so every server instance shares one count). Every authenticated answer carries `x-ratelimit-limit` and `x-ratelimit-remaining`; over the limit is a `429` with `retry-after` (whole seconds).

**Paging.** Oldest first by creation time, ties by id. `limit` is 50 when not given and is held to 1..100; a value that is not a whole number is a `400`. `after` is the `next_cursor` of the previous page, an opaque string; one this API did not give out is a `400`. Because the cursor is where the last page ended, rows added while paging are never skipped or repeated.

**Answers.** Every answer is JSON with `cache-control: no-store` and an **`x-request-id`** header (`req_` and 24 hex characters) that is also in the body as `request_id`. A list:

```json
{ "object": "list", "data": [ ... ], "has_more": true, "next_cursor": "eyJ0Ijoi...", "timezone": "America/Chicago", "request_id": "req_..." }
```

A refusal is `{ "error": { "code": "...", "message": "..." }, "request_id": "req_..." }`:

| Status | `code` | When |
|---|---|---|
| 401 | `unauthenticated` | no Bearer header, not a key, or a key the desk does not know (all answer the same); with `www-authenticate: Bearer realm="truelane"` |
| 401 | `revoked` | the key was revoked |
| 403 | `forbidden_scope` | the key may not read this route |
| 403 | `plan` | the fleet's plan does not include the read API |
| 429 | `rate_limited` | over 60 requests in the minute; with `retry-after` |
| 400 | `bad_request` | `limit` or `after` not acceptable |
| 500 | `server_error` | an error on the desk's side; no detail beyond the request id |

**Values.** Times are ISO 8601 in UTC (`2026-11-13T15:04:05.000Z`); the fleet's own time zone is named once per list in `timezone`. Money is a decimal string with two places (`"1040.00"`), never a number; miles have one place. A statement's period is two dates, `YYYY-MM-DD`. Ids are the desk's own.

**No driver details.** A load or a statement names its driver by `driver_id` only: no name, phone, email, tax id or pay setup. An invoice names its customer as a business (`bill_to`: name and MC). A payroll claim the desk holds while it is sending is not shown as a payroll run.

## 10. Outbound webhooks (the desk tells a fleet's systems)

An admin gives the desk an address (an endpoint) and ticks the events it should receive. When one of those money records changes, the desk queues the event **in the same database transaction as the change** (a change that is rolled back queues nothing) and the partner schedule (`POST /partners/cron`, section 3) delivers it. Nothing is sent from inside the change itself.

**Event types.** `invoice.created`, `invoice.voided`, `credit_memo.created`, `credit_memo.voided`, `payment.applied`, `payment.reversed`, `statement.finalized`, `statement.voided`. **Send a test** in Settings sends `webhook.test` (`data` is a short message; it changes nothing and never counts against the endpoint).

**Body.** `{ "id": "evt_<32 hex>", "object": "event", "type": "<type>", "created_at": "<ISO UTC>", "data": { ... } }`. `data` is the record as it stands at the end of the change, in exactly the shape the read API returns for it (section 9), so the same no-driver-details rule holds. A `payment.reversed` carries the payment as it was just before it was removed.

**Headers.** `content-type: application/json`, `user-agent: TrueLane-Webhooks/1`, and:

- **`x-truelane-event-id`**: the event's `id`, the same on every retry and on every endpoint it goes to. Keep it and do each event once.
- **`x-truelane-timestamp`**: seconds since 1970 when this attempt was signed.
- **`x-truelane-signature`**: `t=<unix>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">` under the endpoint's signing secret.

**Checking a delivery.** Recompute `v1` over the **raw bytes** received (before parsing), compare in constant time, and refuse a `t` more than **5 minutes** from your own clock. A retry is signed again with a new timestamp; its body and event id are the same.

Worked example (the same example is checked by a test): secret `whsec_example_secret`, timestamp `1767225600`, body

```json
{"id":"evt_0123456789abcdef0123456789abcdef","object":"event","type":"invoice.created"}
```

gives `x-truelane-signature: t=1767225600,v1=979ece3d56377e4952033230ca0cb9f1ee3646a924fab941125be3bc9dfaf5ea`.

```js
// Node
const crypto = require("crypto");
const parts = Object.fromEntries(header.split(",").map((p) => p.split("=", 2)));
const expected = crypto.createHmac("sha256", secret).update(`${parts.t}.${rawBody}`, "utf8").digest("hex");
const ok = Math.abs(Date.now() / 1000 - Number(parts.t)) <= 300 && crypto.timingSafeEqual(Buffer.from(parts.v1, "hex"), Buffer.from(expected, "hex"));
```

**The signing secret.** `whsec_` and 32 random bytes in base64url, made by the desk, sealed at rest like a partner key, shown **once** when the endpoint is made and once on **New secret** (the old one stops working at that moment). A screen shows its last four characters only.

**Delivery and retries.** A `2xx` answer is delivered. Anything else is a failure, including a redirect (`3xx`; redirects are never followed) and no answer within 10 seconds. A failed delivery is retried after **5, 15, 60 minutes, then every 6 hours**; the **8th** failed attempt makes it `dead`. **3** dead deliveries in a row switch the endpoint off (said in the audit trail, by TrueLane) until an admin switches it on again. A schedule run takes due deliveries with a short lease, so two runs at once never send the same row; events are not promised in order, and the same event may arrive more than once (keep the event id). Delivered events are kept 90 days after they were sent; failed and dead ones stay on Partner issues (section 12) until settled, then 90 days.

**Where it may be sent.** `https://` (plain `http://` is accepted only on a desk not running in production). Refused: a user name or password in the address; `localhost`, `*.localhost`, `*.local`, `*.internal`; and any address that is loopback, private, link-local (including the cloud metadata address `169.254.169.254`), carrier-grade NAT, multicast, reserved, documentation or benchmarking space, in IPv4 or IPv6, including IPv4 written inside IPv6 (`::ffff:`, NAT64 `64:ff9b::/96`, 6to4 `2002::/16`) and IPv6 unique-local `fc00::/7`. The name is resolved and **every** answer is checked, when the endpoint is made and again at every send; the connection is then made to the checked address only (so a name cannot be re-pointed between the check and the send). No setting opens private addresses.

## 11. Plan gating and the money-moving switch

**Plan gating.** Each partner feature has a lowest plan (`FEATURE_PLAN`, `src/lib/partner-gates.ts`): every company capability in section 1 is on every plan; **the read API and outbound webhooks come with the Pro plan and up**. A fleet below it is refused in words ("Sending webhooks comes with the Pro plan and up; this fleet is on Starter. ...") when it makes a key, calls the read API (`403 plan`), makes, switches on, renews or tests an endpoint; a change on such a fleet queues no event, and a delivery already waiting is put back without counting an attempt.

**The money-moving switch.** A call that would move money through a company for real (selling an invoice to a factor; sending a pay run to payroll, but not payroll's status check) needs **both**:

1. the server's operator has set **`MONEY_MOVING_COUNSEL_APPROVED`**`=yes`, saying counsel signed off this deployment (no fleet can set this); and
2. the fleet's admin has switched money moving on for that fleet in Settings, Integrations, with a written reason (at least 8 characters), which is audited. Switching it on needs the server's sign-off; switching it off never does.

Without both, the call is refused before anything is claimed or sent, with the reason in words; a factoring batch's live delivery is held the same way. A simulator key (`sandbox_`) moves nothing and always passes. Reading from a company never needs the switch. Since no company's live call is written (see the top of this page), the switch guards a path that is not yet open.

## 12. Partner issues and the showcase

**Partner issues** (`/partners/issues`, read by admin and billing, acted on by admin) lists in one place what went wrong between the desk and a company: inbound events that failed, are stuck, or were ignored for a fixable reason; outbound deliveries that failed or are dead (test sends are left out); connections in error or overdue; sync cursors with an error; and QuickBooks sign-ins that have expired or end within 14 days. Actions: **Run again** (an inbound event, from its kept body, under its own event id, so it applies once), **Send again** (an outbound delivery: same event id and body, new signature, retry schedule restarts), **Try again now** (a connection), and **Settle** (resolved or dismissed, with a reason). Each is audited.

**The showcase** (`/partners/showcase`, admin, only where simulators are allowed) runs one load through every simulator in a separate fleet of its own (ELD, carrier check, tracking, fuel card, IFTA, factoring, payroll, QuickBooks, a signed webhook to a receiver built into the desk, and a read API call), so a partner can watch the whole contract work without a network. It never touches a real fleet's records, and the schedule never delivers its webhooks.

Contact for partnership and integration: the address on the desk's sign-in page.
