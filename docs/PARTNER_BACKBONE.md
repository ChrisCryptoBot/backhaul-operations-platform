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

## Tables (migration `20261122000000_partner_backbone`)

`partner_credentials` (workspace, provider, sealed envelope, per-field hints; one row per fleet and company), `partner_events` (provider, event id unique: the once-only record, with kind, outcome applied/ignored/failed), and added columns on `partner_connections` (last synced, failures, next try, webhook token).

## Setting it up

1. Set `DESK_CREDENTIAL_KEY` (32 random bytes, base64) and `PARTNER_CRON_SECRET` on the host. Names and meaning are in `docs/ENVIRONMENT.md`; no value is written anywhere in the repo.
2. A fleet admin opens Settings, Integrations, a company, saves that fleet's keys (and the company's webhook signing secret), then Connects.
3. Paste the shown webhook address into the company's dashboard.
4. Point a scheduler at `POST /partners/cron` with the secret header.

Losing `DESK_CREDENTIAL_KEY` with no previous key loses the stored keys (they are pasted again). To rotate without losing them: set the new key as `DESK_CREDENTIAL_KEY` and the old one as `DESK_CREDENTIAL_KEY_PREVIOUS`, let the schedule run until its `resealed` count is 0, then remove the previous key.

## Not built yet

- A live call to any company. Each adapter stays one file; no endpoint is guessed. The panel says "not switched on" until one is.
- Real per-company signature header and event shape (the neutral envelope `{id, type, reference}` is read today).
- Plan gating of partner features; a screen to link a tractor to its ELD id; a fuel-card transaction store.
- A poll for factoring, payroll, tracking or fuel cards (a missed webhook is not reconciled by asking the company): it needs each company's real API shape; until one is chosen those kinds are told by webhook or asked for by a person, as the policy table says.
- **Insurance is not a capability** in the vendored contract (`src/truelane/partners/contract.ts`, from the phone repo), so it has no connection row, keys, webhook or rhythm here. Adding it means changing the contract in the phone repo and re-vendoring.
- Verticals with no store or screen: IFTA (state miles, quarter screen, CSV), tracking (opt-in per load, share link), insurance (capability, certificate records, expiry alerts), COI-expiry and ELD-stale alert rules.
- Counsel review before a money-moving or location-sharing capability is switched on for anyone.

## Tests

`tests/partner-backbone.test.ts` (seal and open, tampered envelopes, key checks, signatures, neutral event, backoff, schedule, "a key is never logged / returned / audited / kept in the browser", signature-before-parse) and `tests/integration/partner-backbone.integration.test.ts` (database: save and status, once-only events, health transitions, webhook paths).
