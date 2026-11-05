# The driver link: desk to the driver's phone (design)

Status: design, 2026-11-04. Build is the **desk half only**, dark behind a per-workspace switch. The phone half already exists and is parked (`TRUELANE/lib/bridgeDispatch.ts`, `lib/domain/dispatchInbox.ts`, flag `bridgeDispatch`). Nothing here calls Supabase until a workspace is switched on and the server holds the secrets.

## 1. What exists, so we build only the missing half
| Piece | Where | State |
|---|---|---|
| Table `bridge.external_dispatch`, trigger `sync_seq`, RLS, `respond_to_dispatch` RPC, `org_members`, storage policies | `TRUELANE/docs/parked/EXTERNAL_DISPATCH_MIGRATION.staged.sql` | **Applied in Supabase 2026-09-16** (do not re-run) |
| Contract v2.1/v2.2 (who owns which column, version counters, reassign vs re-offer) | `docs/parked/EXTERNAL_DISPATCH_CONTRACT.md` | Frozen |
| Phone read (`syncPull`, `useDispatchInbox`) and write-back (`respondToDispatch`) | `TRUELANE/lib/bridgeDispatch.ts`, `lib/domain/dispatchInbox.ts` | Built, parked, flag off |
| Desk projector (`projectLoadToSummary`, `assertDriverSafe`, `driverFacingPay`) | `apps/web/src/server/tl/projector.ts` | Built and tested |
| Desk assignment lifecycle (`assignLoad`, `dispatchLoad`, `unassignLoad`, `recordDriverResponse`), compare-and-set (`claim.ts`) | `server/tl/dispatch.ts` | Built; send and answer are local only |
| Desk writer, transport, outbox, inbound reader | none | **This document** |

## 2. Who owns what (from the contract; the desk never breaks it)
- The desk writes `source_system = 'truelane_desk'` (the table's default is the old working name; the phone does not read the column, and the mobile ingestion path already writes `truelane_mobile`).
- **Desk writes** `status` (`draft | dispatched | reassigned | cancelled`), `load_summary`, `assigned_driver_id`, `replaced_by_dispatch_id`, `assignment_version`. Always with the service role.
- **Phone writes** `driver_response` and `execution_version`, only through `respond_to_dispatch`. States: `accepted | declined | in_progress | completed`, strict order, no skipping, no un-accept.
- The desk **reads** `driver_response`; it derives the board state from `status` + `driver_response.state` and never writes the driver's columns. A re-offer clears `driver_response` to null (the contract's signal).
- Confidentiality: `load_summary` carries no gross, margin, cost or rate confirmation. The desk enforces it twice: `driverSummaryFor` (already) and again at the transport boundary (`assertDriverSafe` on the exact JSON about to leave).

## 3. Identity and tenancy
- **Org:** `Workspace.bridgeOrgId` (Clerk Organization id) maps the workspace to `bridge.external_dispatch.org_id`. Null means no bridge. Decision confirmed by Chris: a small fleet or owner-operator is one workspace; a multi-user carrier is one Clerk Organization mapped to one workspace.
- **Driver:** `Driver.phoneUserId` (the driver's Clerk user id, `auth.jwt()->>'sub'`) maps a desk driver to the phone account. Set by the dispatcher on the driver's page ("Driver's phone account"), unique within a workspace. A driver without one stays in **manual mode** exactly as today (the dispatcher records the answer), so a mixed fleet works.
- **Switch:** a workspace is bridged only when `bridgeOrgId` is set **and** the server has `BRIDGE_SUPABASE_URL` and `BRIDGE_SUPABASE_SERVICE_KEY` (names only; values never printed, logged or sent to a browser) **and** the driver has a `phoneUserId`. Anything less is manual mode. Pure function `bridgeMode(...)` returns `manual | bridged` plus the reason in words, so the screen can say why.

## 4. Write path (desk to phone): transactional outbox
The desk change and the intent to tell the phone commit together or not at all; delivery is retried.

1. **Send** (`dispatchLoad`): in the same transaction that claims the assignment `draft -> dispatched`, if the mode is `bridged`, insert a `BridgeOutbox` row `{kind:'dispatch', assignmentId, assignmentVersion}`. The payload is **not stored**: it is rebuilt from the load at flush time, so a late flush sends the current truth (and the safety check runs on what actually leaves).
2. **Re-offer to the same driver** (assign again, same driver, pay or details changed): row updated in place, `driver_response -> null`, `assignment_version + 1`.
3. **Edit while dispatched or accepted** (stop times, notes, miles): `load_summary` updated, `assignment_version + 1`, response untouched (it reaches the driver on the next pull by design).
4. **Reassign to another driver:** old row `status='reassigned'`, `replaced_by_dispatch_id = new id`; new row `dispatched`. The two drivers never see each other's rows.
5. **Unassign or cancel:** row `status='cancelled'` (terminal; never deleted: it is the phone's eviction signal).
6. **Flusher** (`flushBridgeOutbox`): oldest-first per assignment; builds the summary, runs `assertDriverSafe`, calls the transport with **compare-and-set on `assignment_version`** (`PATCH ... ?id=eq.X&assignment_version=eq.N`); on a version clash it re-reads and retries once, then records `failed` with the reason. Success stores `bridgeDispatchId`, the row's new version and `bridgeSyncedAt` on the assignment. Failures set `attempts`, `nextAttemptAt` (backoff 1, 5, 15, 60 minutes, then daily), `lastError` (a word, never a body or a token). After 5 failures the load shows **"Not delivered to the driver's phone: retry or call them"** and the dispatcher can switch that load to manual.
7. **Triggers:** right after the transaction (best effort, never blocks the send), a cron route `POST /bridge/flush` (secret header `BRIDGE_CRON_SECRET`), and a **Retry** button on the load.
8. **Idempotent:** a row is found by `(org_id, source_load_id, assigned_driver_id)` among `draft|dispatched`; the insert uses that as the natural key, so a repeated flush cannot create two rows for one assignment.

## 5. Read path (phone to desk): pull with a watermark
- `pullBridgeResponses(workspace)`: `GET bridge.external_dispatch?org_id=eq.<org>&sync_seq=gt.<cursor>&order=sync_seq.asc&limit=200`; the cursor is `Workspace.bridgeCursor` (bigint), advanced only after every row of the batch is applied (at-least-once, applied idempotently).
- For each row with a `source_load_id` the desk knows, and `execution_version` greater than the one stored on the assignment: apply `driver_response.state`:
  - `accepted` / `declined`: the existing `recordDriverResponse` path (same checks, audit, load status), with the audit actor "Driver (phone)".
  - `in_progress`: the load starts (status `in_progress`, started-at from `driver_response`), the first stop's arrival when present.
  - `completed`: the load completes: `completed_at`, `actual_total_miles`, per-stop POD refs, `estimated_pay` (display only). The desk still computes the authoritative payout.
  - Anything out of order (an `in_progress` for a load the desk shows cancelled) is **recorded and flagged, not applied** (an alert "The driver's phone says X; the desk says Y").
- **Triggers:** cron `POST /bridge/pull` every minute; later a Supabase database webhook to `/bridge/inbound` to make it instant (same apply function).
- **Documents:** `pod_refs` are storage paths (`pod-photos`); the desk reads them with the service role and lists them under Documents with source "Driver". They never leave the org.

## 6. Messages (second step; separate table)
Messages are not in `external_dispatch`. Add a small `bridge.driver_messages` table (org, driver user id, direction, body, attachment refs, `created_at`, `delivered_at`, `read_at`) with RLS (driver reads own; writes through RPC) and have the desk write with the service role. The existing `Thread`/`Message` rows keep their meaning; `Message.deliveredAt` is finally written by the transport. SQL is applied by hand by Chris; designed after the dispatch link works.

## 7. Failure modes (what the dispatcher sees)
| Situation | Screen says | Desk does |
|---|---|---|
| Workspace not bridged / driver has no phone account | "Manual: you record the driver's answer" (today's controls) | nothing new |
| Sent, outbox pending | "Sending to the driver's phone" | flusher retries |
| Sent, delivered, no answer | "Sent, waiting" with how long | a late-answer alert (Wave 3) |
| Delivery failed 5 times | "Not delivered: retry or call them" + the reason word | stays dispatched; Retry, or switch the load to manual |
| Driver accepted after the desk reassigned | nothing on the desk | RPC refuses (`dispatch_conflict`); phone evicts and shows its banner |
| Phone says completed, desk says cancelled | alert "Out of step" | record, do not apply |
| Transport down (Supabase unreachable) | banner on the load and in Settings | outbox keeps; reads resume from the cursor |

## 8. Security
Service-role key only in server env, read inside the call, never stored in the database, a response, a log or an audit row. The cron routes require a secret header and refuse otherwise (401, no detail). Every outgoing JSON passes `assertDriverSafe`; the test suite fails if any projected summary has a forbidden key or a load secret as a value. The desk never trusts `driver_response` shape: it is parsed against a strict schema (state enum, bounded numbers, path prefix check `<org>/...` on every storage ref). A driver id in a row must equal the assignment's `phoneUserId` or the row is ignored and flagged.

## 9. What is built now (dark) and what is not
**Built:** schema and local migration (`workspaces.bridge_org_id`, `bridge_cursor`; `drivers.phone_user_id`; `assignments.bridge_dispatch_id`, `bridge_execution_version`, `bridge_synced_at`, `bridge_error`; `bridge_outbox`), the pure core (mode, row mapping, outbox decisions, response interpretation, backoff), the transport interface with a fetch-based PostgREST implementation (unit-tested against a mocked `fetch`: URL, headers, body, no secret in any thrown message) and an in-memory implementation for tests, outbox enqueue inside send, unassign and reassign, the flusher and puller with integration tests on the demo DB, the two cron routes, the delivery chip and Retry on the load, and the driver's phone-account field.
**Not built (needs Chris or the phone):** switching any workspace on (needs the secrets), the Clerk org and driver mapping data, the messages table, instant inbound via database webhook, un-parking the phone flag `bridgeDispatch`, an end-to-end test against the real Supabase.

## 10. Verification
Unit: mode decision table; summary leaks (forbidden keys, secret numbers); outbox decisions per event; response interpretation including out-of-order; backoff. Integration (demo DB, in-memory transport): send enqueues in the same transaction (rolled back with it); flush delivers once and is idempotent; version clash retried once; accept/decline/start/complete applied in order; out-of-order flagged; unassign cancels the row; reassign supersedes. Transport: mocked fetch pins method, URL, `Authorization` and `apikey` headers, `Content-Profile: bridge`, and that no error message contains the key. Existing suites stay green; with the switch off the desk behaves exactly as before.
