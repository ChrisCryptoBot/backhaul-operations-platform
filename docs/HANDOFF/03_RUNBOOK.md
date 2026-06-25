# 03 — Runbook (run, test, verify)

All commands run from the app repo root: `C:\Users\14698\OneDrive\Desktop\backhaul\backhaul-rewrite`.
(Windows; Git Bash + PowerShell both available. The dev shell is bypass-auth, so you're ADMIN locally.)

## Verify gates (run after any change)
```
cd apps/web
npx tsc --noEmit        # must be 0 errors
npx eslint .            # must be clean
npx vitest run          # 211 passed / 3 skipped at last checkpoint
```
Note: the project's custom ESLint rule forbids `Number(...)` on numeric inputs — use Decimal or type guards.

## Run the app locally
```
# from backhaul-rewrite/
npx prisma generate --schema=./prisma/schema.prisma     # if schema changed
npm run dev                                             # → http://localhost:3000
```

## Make the copilot respond live (currently blocked — environment only)
1. **Add Anthropic credits** (Console → Plans & Billing). The dev key is already in `apps/web/.env.local`. Copilot defaults to **Sonnet 4.6** — ensure access + credit.
2. **Apply migrations** (needs Postgres running at `DATABASE_URL`):
   ```
   npx prisma migrate deploy --schema=./prisma/schema.prisma
   ```
   Applies `LlmProviderConfig` + `copilotModel` (and any others).
3. **Seed demo data** (region NE, drop lots, sample loads, lanes, rules):
   ```
   node scripts/seed-showcase.mjs
   ```
4. **⚠ Set `DEMO_DATA=false`** in `apps/web/.env.local`. With `DEMO_DATA=true` the board shows demo data and skips the DB; the copilot reads/writes the **real DB**, so they won't match. Keep `BYPASS_AUTH=true` (makes you ADMIN so the panel + Settings work).
5. `npm run dev` → open the board → click **"Ask copilot"** (bottom-right).

## Try the copilot
- *"What loads do we have this week?"* → `find_loads` (read-only)
- *"Set the delivery date for load &lt;ref&gt; to 2026-06-22 and mark POD received"* → applies directly; board refreshes
- *"Set the line-haul rate on load &lt;ref&gt; to 1850"* → **Confirm card** (financial) → Confirm → revenue recomputes
- *"Delete load &lt;ref&gt; — duplicate"* → **Confirm card** (destructive)

## Troubleshooting
- *"No LLM API key configured"* (503) → key not loaded; restart `next dev` after editing `.env.local`, or set the key in `/settings`.
- Copilot can't find a load → it queries the DB; the load must be seeded and `DEMO_DATA` must be off.
- A COORDINATOR being refused FSC override / cross-region edit is **expected** (RBAC working).

## Key env vars (`apps/web/.env.local` for dev; `.env.example` documents all)
- Auth/DB: `CLERK_SECRET_KEY`, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `DATABASE_URL`
- Dev toggles: `BYPASS_AUTH=true`, `AUTO_PROVISION_AUTH_USER=true`, `DEMO_DATA` (set false to test copilot)
- LLM: `ANTHROPIC_API_KEY` (bootstrap fallback), `LLM_PROVIDER`, `LLM_MODEL`, `COPILOT_MODEL`, `CONFIG_ENCRYPTION_KEY` (required to store a key via Settings; 32-byte base64)
- AWS (for real ingestion/deploy): `AWS_REGION`, `S3_BUCKET_NAME`, `SQS_PARSE_QUEUE_URL`, `SQS_RECOMPUTE_QUEUE_URL`, `WORKER_SHARED_SECRET` (queue consume route)

## Git
- Branch: `feat/llm-pdf-ingestion-settings`. Commit only when the user asks. End commit messages with the Co-Authored-By line.
- Never stage `replace-secrets.txt`, `apps/web/.tmp/`, `apps/web/test-results/`.
