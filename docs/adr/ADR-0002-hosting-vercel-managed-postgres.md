# ADR-0002: Hosting on Vercel + Managed Postgres

**Status:** Accepted  
**Date:** 2026-06-18

## Context
The app was scaffolded with a Netlify build config (`netlify.toml`) but the hosting target
was never finalized. Drop Bucket is a Next.js 14 (App Router/RSC) app with a Prisma/Postgres
data layer, Clerk auth, AWS S3 + SQS for ingestion, and an Anthropic-backed copilot. It needs:
first-class Next.js App Router support (RSC, route handlers, middleware), a managed Postgres
the app can reach over `DATABASE_URL`, scheduled execution to drain SQS (Phase 0c added the
drain route but nothing invokes it on a schedule), and straightforward secret management.

## Decision
- Host the web app on **Vercel** (native Next.js App Router support; replaces Netlify).
- Use a **managed Postgres** provider (Neon or Supabase) reached via `DATABASE_URL`.
- Run **`prisma migrate deploy`** as part of the Vercel build so schema changes ship with code.
- Drive the **Phase 0c queue-drain** route (`/api/internal/queue/drain`) with **Vercel Cron**.
- Keep AWS **S3 + SQS** for PDF storage and job queues (unchanged); Vercel holds the AWS creds.
- Remove `netlify.toml`; deployment config now lives in `vercel.json`.

## Consequences
- Deployment is reproducible: migrations apply on every production build; the drain runs on a
  fixed schedule rather than needing a standalone worker.
- Secrets (Clerk, `DATABASE_URL`, `ANTHROPIC_API_KEY`/`CONFIG_ENCRYPTION_KEY`, AWS, and
  `WORKER_SHARED_SECRET`) are managed in Vercel project settings — see `docs/DEPLOY_VERCEL.md`.
- Production hardening is enforced in code as defense-in-depth: auth bypass is ignored in
  production, and the internal worker routes require `WORKER_SHARED_SECRET` in production.
- This supersedes the implicit Netlify assumption and resolves the open ADR-0002 hosting
  question referenced in the project handoff.
