# 04 — Remaining Plan, Decisions & Known Gaps

Plan of record: `C:\Users\14698\.claude\plans\create-plan-for-finalization-abstract-feather.md`
(Phases 0a/0b done + Phase 2 copilot done; below is what remains.)

## Confirmed decisions (do not re-litigate)
- API key stored **AES-256-GCM encrypted** in DB; UI shows only a masked key.
- **Anthropic now**, behind a provider interface (`server/llm/registry.ts`); other providers are a drop-in later.
- Parser **falls back to regex** when no key/failure.
- Settings screen is **ADMIN-only** (`SYSTEM_SETTINGS` permission).
- Copilot = **thin layer over existing actions**, runs under user RBAC, **confirms** destructive/financial.
- Hosting: **Vercel + managed Postgres** (resolves ADR-0002).
- Reference data: **full in-app management UI**; management gated to **REGIONAL_MANAGER+/ADMIN**.

## Phase 1 — Reference-data management (next most likely)
- `server/reference.ts`: CRUD for `Broker` (+`BrokerRep`), `Lane` (+`targetRate`), `DropLot` — mirror `board.ts` patterns (region scope, Zod, `createAuditLog`).
- `app/api/reference/{brokers,lanes,drop-lots}/route.ts` — auth + `requireRegionAccess` + **`requireRole(access,"REGIONAL_MANAGER")`** (first real RBAC differentiation).
- Admin UI screens — reuse `db-*` form styles + the `app/review/manual-entry/page.tsx` form pattern. Wire the existing **"Brokers"** nav stub in `board-shell.tsx`; add lanes/lots (admin area or Settings shell).
- **Expose these as copilot tools** in `server/copilot/tools.ts` (e.g. `create_broker`, `set_lane_target`) so "add broker X" works conversationally.

## Phase 0c — Live ingestion (required for drop→auto-populate on Vercel)
- **Queue drain:** `app/api/internal/queue/drain/route.ts` (or a Vercel Cron handler) that reads SQS and calls `processQueueEnvelope` (`server/queue-consumer.ts`); guard with `WORKER_SHARED_SECRET`. (Today nothing consumes SQS in prod.)
- **S3 read:** add `GetObject` to `readUploadedPdf` in `server/upload-storage.ts` (currently local-disk only → worker can't fetch PDFs in prod).

## Phase 3 — Vercel + managed Postgres deploy
- Mark **ADR-0002 Accepted: Vercel + managed Postgres**; add `vercel.json` (replace `netlify.toml`); provision Postgres (Neon/Supabase); `prisma migrate deploy` in build; seed NE region.
- **Vercel Cron** drives the Phase-0c drain route.
- Secrets: Clerk, `ANTHROPIC_API_KEY`/`CONFIG_ENCRYPTION_KEY`, AWS (S3+SQS), `WORKER_SHARED_SECRET`.
- **Prod hardening:** turn OFF `BYPASS_AUTH` / `BYPASS_AUTH_WRITES` / `AUTO_PROVISION_AUTH_USER`; require `WORKER_SHARED_SECRET` on the consume route; review middleware public routes (`/dashboard`, `/review` are currently public in `src/middleware.ts`).

## Known gaps / tech debt (from the system review)
- **RBAC is mostly flat** — only Settings + FSC-override + (planned) reference-data differentiate roles; `requireRole` is otherwise unused. Tighten when expanding.
- **SQS has no prod consumer** and **`readUploadedPdf` is local-only** → Phase 0c.
- **Per-route boilerplate** — region resolution + auth sequence repeats across ~15 routes; a shared helper would reduce risk.
- Some board fields editable via API/copilot but **not yet surfaced in the load-detail drawer UI** (action layer is complete; drawer parity is incremental).
- Review UI has cosmetic "Coming soon" stubs (Lanes/Brokers/Audit nav, Search button) — wire or remove during Phase 1/cleanup.

## Copilot enhancement ideas (optional, user may request)
- More tools (reference data, FSC upsert for RM/ADMIN, create-from-rate-con, bulk edits).
- Streaming responses; richer confirmation previews (before/after diff).
- Two-tier parse model (Haiku→Sonnet escalation on low confidence).
