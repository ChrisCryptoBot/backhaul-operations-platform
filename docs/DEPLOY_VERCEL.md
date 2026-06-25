# Deploying Drop Bucket to Vercel + Managed Postgres

Decision of record: [ADR-0002](adr/ADR-0002-hosting-vercel-managed-postgres.md). Build/cron
config lives in [`vercel.json`](../vercel.json) at the repo root. This doc is the operator
checklist — the code/config is in place; the steps below are the manual provisioning that
must happen in the Vercel / Postgres / AWS dashboards.

## 1. Provision managed Postgres
- Create a Postgres database (Neon or Supabase).
- Copy the pooled connection string into `DATABASE_URL` (Prisma needs the **pooled** URL for
  serverless; if the provider also gives a direct URL, keep it for `prisma migrate deploy`).

## 2. Create the Vercel project
- **Root Directory:** the repo root (`backhaul-rewrite`) — the app is a workspace under
  `apps/web` but Prisma + `vercel.json` live at the root.
- Framework preset: **Next.js**. `vercel.json` already sets:
  - `buildCommand`: `prisma migrate deploy --schema=./prisma/schema.prisma && npm run build`
    — migrations apply on every production build, then the workspace builds.
  - `outputDirectory`: `apps/web/.next`.
  - `crons`: hits `/api/internal/queue/drain` every 5 minutes.

## 3. Environment variables (Vercel → Settings → Environment Variables)
Auth / DB:
- `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`
- `DATABASE_URL`

LLM (parser + copilot):
- `ANTHROPIC_API_KEY` (bootstrap fallback; the active key normally lives encrypted in
  `LlmProviderConfig` via the Settings screen) — **rotate the dev key before go-live**
- `CONFIG_ENCRYPTION_KEY` (32-byte base64; required to store a key via Settings)
- Optional: `LLM_PROVIDER`, `LLM_MODEL`, `COPILOT_MODEL`

AWS (ingestion):
- `AWS_REGION`, `S3_BUCKET_NAME`, `SQS_PARSE_QUEUE_URL`, `SQS_RECOMPUTE_QUEUE_URL`
- AWS credentials for the runtime (e.g. `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`) with
  IAM allowing `s3:GetObject` on the bucket and `sqs:ReceiveMessage` + `sqs:DeleteMessage` on
  both queues (plus `sqs:SendMessage` for enqueue).

Worker / cron:
- `WORKER_SHARED_SECRET` — required in production; guards the `/consume` and `/drain` routes.
- `CRON_SECRET` — set this to the **same value** as `WORKER_SHARED_SECRET`. Vercel Cron sends
  `Authorization: Bearer <CRON_SECRET>`, which the drain route accepts.

Region:
- `PHASE1_REGION_CODE` (defaults to `NE`).

**Do NOT set** `BYPASS_AUTH`, `BYPASS_AUTH_WRITES`, or `AUTO_PROVISION_AUTH_USER` in
production. As defense-in-depth the code already ignores all three when `NODE_ENV=production`
(see `lib/auth-mode.ts` and `lib/access.ts`), but leave them unset regardless.

## 4. Migrate + seed
- Migrations run automatically via the build command. The pending set includes
  `LlmProviderConfig`, `copilotModel`, and `drop_lot_soft_delete`.
- Seed the NE region + reference data once after the first deploy (run against the prod DB):
  ```
  node scripts/seed-showcase.mjs
  ```

## 5. Verify after deploy
- Sign in via Clerk; confirm `/`, `/dashboard`, `/review`, `/settings`, and `/reference/*`
  load and that unauthenticated access to the protected routes is redirected.
- Trigger the drain manually to confirm wiring:
  ```
  curl -X POST https://<app>/api/internal/queue/drain -H "x-worker-secret: $WORKER_SHARED_SECRET"
  ```
  Then confirm the Vercel Cron entry appears under Project → Cron Jobs and runs on schedule.
- Upload a rate-con PDF → confirm the worker drains the parse job and the load reaches review
  (this exercises the Phase 0c S3 `GetObject` read path).

## Production hardening (enforced in code)
- `isAuthBypassed()` returns `false` in production regardless of `BYPASS_AUTH`.
- `AUTO_PROVISION_AUTH_USER` is ignored in production.
- `/api/internal/queue/consume` and `/api/internal/queue/drain` reject unauthenticated calls
  in production even if `WORKER_SHARED_SECRET` is unset (so a misconfig fails closed).
- `/dashboard` and `/review` are protected at the edge (middleware) in addition to their RSC
  checks; only `/`, `/sign-in`, and `/visual-regression` are public.
