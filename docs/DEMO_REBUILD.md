# Demo rebuild: TrueLane-shaped dispatch interface

Branch `demo/truelane-dispatch`. Goal: reuse this app as a demo of dispatch software for the TrueLane Build page,
rebuilt around TrueLane's current schema (`TRUELANE/db/schema.ts`), with made-up data only. Plan of record:
`C:\Users\14698\.claude\plans\i-put-the-web-cheeky-clock.md` (decisions: demo-first and standalone, no prod Supabase,
no Clerk orgs, no real keys; copilot removed; rate-con reader kept and rewired; KPI dashboard kept).

## Baseline before any change (2026-10-28)
`tsc --noEmit` clean; vitest 89 files / 590 tests pass.

## Stage 1 (done): copilot removed
Deleted `server/copilot/*`, `components/copilot/*`, `app/api/copilot`, `lib/ui/alert-fix.ts`, `CopilotIcon`, the `.db-cop*`
and `.db-fab` CSS, the copilot model setting, its tests, and the stale `docs/HANDOFF/*`. `tests/no-copilot.test.ts` keeps it gone.
After: `tsc` clean; vitest 84 files / 492 tests pass. `create_relayed_load` (relay-load creation) existed only in the
deleted `tools.ts`; recover it from commit `3b422f3` if it is ever wanted.

## Moved to Stage 2 on purpose
These are coupled to the schema and ingestion rewrite, so doing them first would mean touching everything twice:
- Region dimension and employer vocabulary (Region, RegionConfig, UserRegionRole, `runInRegionScope`, MG/TMW, MileMax,
  Carlisle, Leesport, Sealed Air, "Drop Bucket", relay/drop-lot terms). `WeekSnapshot`, `snapshots.ts` and `lane-week-*`
  stay (the KPI dashboard needs them), re-keyed to one demo workspace.
- AWS S3/SQS and the cron queue (replaced by local upload and synchronous parse), together with the old `server/llm/*`
  layer, `LlmProviderConfig` and `@anthropic-ai/sdk` (replaced by the TrueLane-schema rate-con reader).
- Live DAT client and `DatProviderConfig` (mock variance stays), FSC table, route and tool.
- Clerk replaced by a `DEMO_MODE` session behind an `auth()` seam.

## Next
Stage 2: schema and math (vendored TrueLane domain modules, golden tests, seed). Then UI (3), verify (4), and the script
and Build page slot (5, in the TrueLane repo).
