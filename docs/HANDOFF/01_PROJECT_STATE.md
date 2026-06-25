# 01 — Project State

## What this is
**Drop Bucket** — a freight **backhaul operations platform** for an Northbridge Furniture
backhaul coordinator (Northeast / CDC Carlisle, PA). It replaces Excel trackers: ingest
broker **rate-confirmation PDFs**, extract load data, review, and roll up weekly KPIs.

**Stack:** Next.js 14 (App Router, RSC) · Prisma + PostgreSQL · Clerk auth (RBAC via
`UserRegionRole`) · AWS SQS (parse + recompute jobs) + S3 (PDF storage) · Anthropic
(`@anthropic-ai/sdk`) · Zod contracts · Decimal money math · Vitest (200+ tests).

**Repo:** `C:\Users\14698\OneDrive\Desktop\backhaul\backhaul-rewrite` — **nested git repo**;
app code under `apps/web`. (The outer `Desktop\backhaul` folder is a different git repo full
of unrelated AppData noise — ignore it.)

**Branch:** `feat/llm-pdf-ingestion-settings`. **Build spec:** `BLUEPRINT FILES/DROP_BUCKET_BUILD_SPEC_v1.md`.

## The finalization goal (what the user asked for)
Turn the system into one the coordinator runs **by talking to it**: a copilot that can
**update/change every data point of a load**, backed by **full in-app reference-data
management** (brokers/lanes/drop-lots), deployed on **Vercel + managed Postgres**.

## DONE & committed (this work, on the branch above)
| Commit | What |
|---|---|
| `ad4bd5f` | LLM PDF parsing (Anthropic native-PDF + forced-tool extraction) replacing the regex parser, with regex fallback; ADMIN **Settings** screen (`/settings`) to manage provider/model/API key, **AES-256-GCM encrypted** in new `LlmProviderConfig` table |
| `c3f07ef` | `.gitignore` hardened to exclude all `.env*` (keep `.env.example`) |
| `eef250a` | Delivery-date capture (LLM + manual) + **"Deliveries due today"** board section |
| `628ab8f` | **Full action layer**: every load field writable via `updateBoardLoadFields` + `/api/board` `update-fields` (incl. financial fields with metric recompute); green build (typecheck 0) |
| `bcc24c4` | **The copilot**: tools→existing-actions, Claude tool-use agent loop, `/api/copilot`, chat panel on the board, per-config `copilotModel` (default Sonnet 4.6) |

## Verified at last checkpoint
- `npm run typecheck` → **0 errors**
- `npm run lint` → clean
- `npm run test` → **211 passed, 3 skipped, 0 failures** (52 files)

## Pending (not yet built) — see 04_REMAINING_PLAN.md
- **Phase 1** — reference-data management (broker/lane/drop-lot CRUD + UI + RBAC gate; expose as copilot tools).
- **Phase 0c** — live ingestion: SQS queue-drain (Vercel Cron) + S3 `GetObject` read.
- **Phase 3** — Vercel + managed-Postgres deploy + prod hardening.

## Blockers to running the copilot live (not code — environment)
1. **Anthropic account has $0 balance** — add credits (Console → Plans & Billing). Auth works; inference is blocked until funded.
2. **Two migrations authored but not applied:** `prisma/migrations/20260618_llm_provider_config` and `20260618_llm_copilot_model`. Apply with `prisma migrate deploy`.
3. **`DEMO_DATA=true`** in `apps/web/.env.local` makes the board use demo data and skip the DB; the copilot reads/writes the real DB. Set `DEMO_DATA=false` and seed to test against real loads. (See 03_RUNBOOK.md.)

## Security note
- A **dev Anthropic key was pasted in chat** and stored in `apps/web/.env.local` (git-ignored) — **rotate it** when done testing.
- `replace-secrets.txt` at the repo root contains **real credentials** — never commit it (gitignore now covers it).
