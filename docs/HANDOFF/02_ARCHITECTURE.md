# 02 — Architecture & Key Files

## Layering (reuse, don't reinvent)
```
app/api/* (routes)  →  server/* (services/actions)  →  domain/* (pure logic)  →  prisma
       │                       │                              │
  policyAdapter         contracts/* (zod, v1)         adapters: policy, worker-orchestrator
```
- **Mutations are centralized** in `server/*` functions, each: region-scoped (`runInRegionScope` / `withNonDeletedRegionScope`), Zod-validated at the route, and **audit-logged** via `createAuditLog`. These are the copilot's tools.
- **Auth/RBAC:** `policyAdapter.requireRegionAccess` + `assertPermission` (matrix in `domain/policy/permissions.ts`); roles in `lib/rbac.ts` (`requireRole`). Source of truth = `UserRegionRole`.

## The copilot (the centerpiece — DONE)
```
Chat panel (components/copilot/copilot-panel.tsx, on the board)
  → POST /api/copilot (app/api/copilot/route.ts) — resolves {userId, regionId, role}
    → server/copilot/agent.ts  (Claude tool-use loop; model via getActiveCopilotConfig)
      → server/copilot/tools.ts (COPILOT_TOOLS + dispatchTool)
        → existing server actions (board.ts / board-detail.ts), under the user's RBAC
```
**Design invariants (keep these):**
- Copilot introduces **no new mutation path** — tools call existing actions only.
- Runs **as the user** (`assertBoardWrite` enforces `BOARD:WRITE`); cannot exceed manual permissions.
- **Risky actions are staged, not executed:** `RISKY_TOOLS` (`soft_delete_load`, `set_tonu`), any `update_load_fields` touching `FINANCIAL_FIELDS`, and `set_load_status` to non-BOOKED return `needsConfirmation`; the UI shows a Confirm card → POST `/api/copilot {confirm:{tool,input}}` executes it.
- `update_load_fields` **whitelists** field keys (`ALLOWED_LOAD_FIELDS`) so the model can't write arbitrary columns.
- Every change is audit-logged by the underlying action (actor = the user).

**Current tools:** `find_loads`, `get_load_detail`, `update_load_fields`, `set_load_status`, `set_tonu`, `soft_delete_load`. (Reference-data tools will be added in Phase 1.)

## Ingestion pipeline (context)
Upload PDF → `finalizeUpload` (dedup, idempotency) → SQS `PARSE_RATE_CON` → `processQueueEnvelope`
(`server/queue-consumer.ts`) → `parseRateConfirmation(buffer)` (`server/parser-engine.ts`:
LLM via `server/llm/providers/anthropic.ts`, **regex fallback** if no key/failure) → `EXTRACTED`
→ review approve → `Load` created → SQS `RECOMPUTE_WEEK_SNAPSHOT`.
**Gap (Phase 0c):** nothing consumes SQS in prod, and `readUploadedPdf` reads local disk only (no S3 GetObject).

## LLM config resolution
- `server/llm/config.ts`: `getActiveLlmConfig()` (parser) and `getActiveCopilotConfig()` (copilot, uses `copilotModel`, default `claude-sonnet-4-6`). Reads the `LlmProviderConfig` DB row (key decrypted via `lib/crypto-config.ts`), else env bootstrap (`ANTHROPIC_API_KEY` / `LLM_PROVIDER` / `LLM_MODEL` / `COPILOT_MODEL`).
- Settings service: `server/llm/settings.ts`; screen: `app/settings/` (ADMIN-only; permission `SYSTEM_SETTINGS`).

## Key files map
| Area | Path |
|---|---|
| Copilot tools + dispatch | `apps/web/src/server/copilot/tools.ts` |
| Copilot agent loop | `apps/web/src/server/copilot/agent.ts` |
| Copilot API | `apps/web/src/app/api/copilot/route.ts` |
| Copilot UI | `apps/web/src/components/copilot/copilot-panel.tsx` (mounted in `components/board/board-shell.tsx`) |
| Load action layer | `apps/web/src/server/board.ts` (`updateBoardLoadFields`, `setBoardLoadStatus`, `setLoadTonuLifecycle`, `softDeleteBoardLoad`, leg upsert/delete) |
| Load detail (read) | `apps/web/src/server/board-detail.ts` (`getLoadDetail`) |
| Review/manual actions | `apps/web/src/server/review.ts` |
| FSC | `apps/web/src/server/fsc.ts` (`upsertFscIndex`, `getEffectiveFscRate`) |
| KPI math | `apps/web/src/server/kpi.ts` (`computeLoadMetrics`), `domain/kpi/pure.ts` |
| LLM provider/config/settings | `apps/web/src/server/llm/{providers/anthropic,config,settings,registry}.ts` |
| Crypto for secrets | `apps/web/src/lib/crypto-config.ts` |
| Policy/RBAC | `apps/web/src/domain/policy/{permissions,policy-adapter}.ts`, `lib/rbac.ts`, `lib/access.ts`, `lib/scope.ts` |
| Board API | `apps/web/src/app/api/board/route.ts` |
| Prisma schema | `prisma/schema.prisma` |
| Queue | `apps/web/src/server/{queue,queue-consumer}.ts`, `app/api/internal/queue/consume/route.ts` |
| Upload storage | `apps/web/src/server/upload-storage.ts` |
