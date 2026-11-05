# Partner backbone

What every partner company (factoring, ELD, fuel card, tracking, vetting, payroll, fuel tax) needs from the desk before a real account is connected. Built 2026-11; no company's live endpoint is wired (each adapter is still one stub file). Everything is per fleet (workspace) and dark until a fleet saves keys and connects.

## What exists

| Piece | Where | What it does |
|---|---|---|
| Sealed keys | `server/partners/credentials-core.ts`, `credentials.ts` | A fleet's keys for a company are sealed (AES-256-GCM, fresh nonce, `v1.<nonce>.<tag>.<cipher>`) with `DESK_CREDENTIAL_KEY` before they are stored in `partner_credentials`. A status read returns names, set or not, where from (fleet or server) and the last four characters; never a value. Not logged, not in an audit line (a save names the fields only), not kept in the browser. |
| Which keys a call uses | `server/partners/call.ts` | The fleet's own key if saved, else the server's environment key. Missing keys: "has no keys yet: set this fleet's keys in Settings, or ask whoever runs the server." |
| Connection health | `server/partners/health.ts`, `connections.ts` | `pending`, `connected`, `error`, `revoked` are all written. Three failures in a row move a connection to `error`; the next try waits 5, 15, 60 minutes, then six hours. `lastError` is shown. "Try again now" clears the failures. |
| Inbound webhook | `server/partners/webhook-core.ts`, `webhook.ts`, route `partners/webhook/[provider]/[token]` | One private URL per fleet and company (unguessable token). Signature (HMAC-SHA256, hex, bare or `sha256=`) is checked on the raw bytes before the body is read as JSON; no secret set means nothing is accepted. Body capped at 256 KB. Each event id is recorded once (a repeat is acknowledged and ignored). Header defaults to `x-signature` until a company is chosen (`signatureHeaderFor`). Funding events update the invoice's factoring state (`factoringStatusOf`). |
| Schedule | `server/partners/sync.ts`, route `partners/cron` | `POST /partners/cron` with header `x-partner-cron: PARTNER_CRON_SECRET` runs the connections that live on a clock: ELD hours every 15 minutes, carrier checks daily. Without the secret the route answers 404. Failures feed connection health. The same heartbeat re-seals keys after a rotation and removes webhook events older than 90 days; the answer is counts only (`ran`, `resealed`, `purged`). |
| How each kind reaches the desk | `server/partners/sync-policy.ts` | One table for all seven contract capabilities: **poll** (ELD, carrier vetting: the schedule asks; silence is a fault, so a connection with no answer for 90 minutes / 3 days is shown **Overdue**), **events** (factoring, payroll, tracking: the company tells the desk by webhook; silence is normal, never overdue), **on demand** (fuel cards, IFTA: asked when a person asks). Settings states each one's rhythm in a sentence. A new capability cannot be added without a row (a test fails). |
| Key rotation | `credentials-core.ts`, `credentials.ts` | `DESK_CREDENTIAL_KEY_PREVIOUS` holds the old key during a rotation; reading tries the current key then that one; the schedule re-seals rows the old key sealed (`resealCredentials`). A row neither key opens is counted and left alone. |
| Settings panel | `components/desk/integrations-panel.tsx` | Per company: state in plain words (Keys needed, Ready to connect, Connected, Needs attention, Disconnected), password boxes (emptied on save), the webhook address once connected, Connect / Try again / Disconnect. Admin only; if the server has no credential key it says so. It also says honestly that the live call is not switched on. |

## Adapters and the sandbox simulator

No company has given us keys or documentation, so the plug-in layer is built and proven against a simulator. **Nothing under `server/partners/adapters/` opens a connection** (a test fails if it ever does).

A company's adapter has three layers (`adapters/types.ts`), so that the day real keys arrive only one of them changes:

1. **Client**: the company's own requests and answers, in the company's own shapes. The *live* client is the only layer that would touch the network; it answers "not implemented" until a company is chosen. The *sandbox* client answers the same calls from the simulator, in the same shapes.
2. **Normalizer**: pure functions from the company's shapes to the desk's (`AdapterShapes` in `call.ts`). Both clients go through it, so the simulator exercises the code the live adapter will run.
3. **Adapter**: asks the client, normalizes, answers a `PartnerResult`.

Shipped: **ELD modeled after Motive** (`adapters/motive.ts`: vehicle positions and each driver's remaining clocks in seconds) and **factoring modeled after TriumphPay** (`adapters/triumphpay.ts`: submit an invoice with its packet, then the factor's webhook events). The field names are what we *assume* such APIs use, modeled on how the products are described, not taken from their documentation; when keys and docs arrive, check the payload types, the live client's methods and `triumphEventToNeutral`, and nothing else. A new company is one file with the same three layers and one line in `adapters/index.ts`.

**Turning the simulator on.** Type a key that starts with `sandbox_` (any text after it) into a company's key box in Settings, Integrations. On the demo desk that saves the key, connects the company at once (the row says *Simulator*) and the schedule starts reading it. On a desk with sign-in on, a `sandbox_` key is refused with a plain message unless the operator set `DESK_PARTNER_SANDBOX=on`.

What the ELD simulator gives: each desk truck a position at one of twelve freight hubs (moving every six hours, drifting every quarter hour, a fix stamped minutes ago, a plausible speed) and each driver clocks inside the rules (drive at most 11 h, shift at most 14 h, cycle at most 70 h, whole minutes, ticking down through the day). The sync stores the position on the truck (`last_lat`, `last_lng`, `last_located_at`), the three clocks on the driver (`hos_drive_minutes`, `hos_shift_minutes`, `hos_cycle_minutes`) and links each truck and driver to the ELD's id by name. A tractor's "hours available" (the Quote's caution) is its driver's drive or shift clock, whichever is less.

What the factoring simulator gives: an invoice sent from the desk is answered with a reference that names it (`TP-SBX-<invoice>`) and the state "with the factor"; `sandboxFactoringEvent` builds the factor's funded, paid, rejected and test events in the factor's shape and signs them the way the receiver checks, so a test or a demo can deliver them to `POST /partners/webhook/<company or "factoring">/<token>`.

## Tables (migration `20261122000000_partner_backbone`)

Migration `20261123000000_eld_telemetry` adds the truck's last position and the driver's ELD id and clocks (all optional, written only by the ELD sync).

`partner_credentials` (workspace, provider, sealed envelope, per-field hints; one row per fleet and company), `partner_events` (provider, event id unique: the once-only record, with kind, outcome applied/ignored/failed), and added columns on `partner_connections` (last synced, failures, next try, webhook token).

## Setting it up

1. Set `DESK_CREDENTIAL_KEY` (32 random bytes, base64) and `PARTNER_CRON_SECRET` on the host. Names and meaning are in `docs/ENVIRONMENT.md`; no value is written anywhere in the repo.
2. A fleet admin opens Settings, Integrations, a company, saves that fleet's keys (and the company's webhook signing secret), then Connects.
3. Paste the shown webhook address into the company's dashboard.
4. Point a scheduler at `POST /partners/cron` with the secret header.

Losing `DESK_CREDENTIAL_KEY` with no previous key loses the stored keys (they are pasted again). To rotate without losing them: set the new key as `DESK_CREDENTIAL_KEY` and the old one as `DESK_CREDENTIAL_KEY_PREVIOUS`, let the schedule run until its `resealed` count is 0, then remove the previous key.

## Not built yet

- A live call to any company. The live client of each shipped adapter answers "not implemented"; no endpoint is guessed. The panel says "not switched on" until one is.
- Real per-company signature header and event shape (the neutral envelope `{id, type, reference}` is read today).
- Plan gating of partner features; a screen to link a tractor to its ELD id; a fuel-card transaction store.
- A poll for factoring, payroll, tracking or fuel cards (a missed webhook is not reconciled by asking the company): it needs each company's real API shape; until one is chosen those kinds are told by webhook or asked for by a person, as the policy table says.
- **Insurance is not a capability** in the vendored contract (`src/truelane/partners/contract.ts`, from the phone repo), so it has no connection row, keys, webhook or rhythm here. Adding it means changing the contract in the phone repo and re-vendoring.
- Verticals with no store or screen: IFTA (state miles, quarter screen, CSV), tracking (opt-in per load, share link), insurance (capability, certificate records, expiry alerts), COI-expiry and ELD-stale alert rules.
- Counsel review before a money-moving or location-sharing capability is switched on for anyone.

## Tests

`tests/partner-backbone.test.ts` (seal and open, tampered envelopes, key checks, signatures, neutral event, backoff, schedule, "a key is never logged / returned / audited / kept in the browser", signature-before-parse) and `tests/integration/partner-backbone.integration.test.ts` (database: save and status, once-only events, health transitions, webhook paths).
