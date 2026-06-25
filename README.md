# Backhaul Operations Platform

A web application that replaces a spreadsheet-based freight **backhaul** coordination
workflow with a real system: rate-confirmation intake, an AI-assisted parsing pipeline,
a relay-aware daily load board, and a live KPI engine — multi-region, role-scoped, and audited.

> **Portfolio project.** All names, lanes, brokers, and data in this repository are
> synthetic and illustrative; it does not contain any real company's operational data.

## The problem

Regional freight coordinators track backhaul loads in Excel — hand-transcribing ~12 fields
per rate confirmation, then rolling daily tabs up into a weekly KPI workbook. That workflow
drifts: broken formulas, totals that silently miss lanes, week labels that don't roll
forward, no version history, no cross-region visibility, and no way to drill from a regional
KPI down to the load and its source document. The central analytical gap is **planned vs.
actual empty miles** — reconciling the relay plan against what actually ran.

## What it does

- **Intake** — drop a rate-confirmation PDF → an async pipeline (LLM extraction with a
  deterministic regex fallback) proposes structured fields → the coordinator confirms.
- **Load board** — a daily, lot-sectioned board with a relay-aware workflow: per-leg
  drivers, trailer custody / handoff continuity, a status lifecycle, an obligation
  checklist, and exception alerts.
- **KPI engine** — live empty-mile %, loaded / negotiation-floor RPM, vs-target, fuel
  surcharge, week-over-week trend, and a lane scorecard, computed from the load store and
  rolled up by region.
- **Copilot** — an in-app assistant for board changes, plus a deterministic, no-LLM
  relay-load intake interview that works without any API credits.

## Stack

Next.js 14 (App Router) · TypeScript · Prisma + PostgreSQL · Anthropic API (PDF
extraction) · AWS S3 · Vercel. Region-scoped multi-tenancy, RBAC, and an append-only
audit log.

## Analysis & architecture (the BSA work, not just the code)

This repository is organized to show the requirements and modeling behind the build:

- **[`prisma/schema.prisma`](prisma/schema.prisma)** — the relational data model (loads,
  legs, rate confirmations, lanes, brokers, KPI snapshots) and migrations.
- **[`docs/adr/`](docs/adr)** — Architectural Decision Records: the rationale behind key
  choices.
- **[`docs/traceability/`](docs/traceability)** — requirement → implementation traceability
  (spec-clause ledger, semantic domain owners, PR parity evidence).
- **[`docs/HANDOFF/`](docs/HANDOFF)** — project state, architecture overview, and runbooks.
- **[`apps/web/`](apps/web)** — the Next.js application (board, KPI dashboard, intake,
  copilot, and API routes).

## Running locally

See [`docs/HANDOFF/03_RUNBOOK.md`](docs/HANDOFF/03_RUNBOOK.md) and copy
[`.env.example`](.env.example) to `apps/web/.env.local`. The app runs against a local
Postgres via Prisma; an auth-bypass dev mode lets you run the board without configuring
Clerk or AWS.

```
npm install
npm run dev        # Next.js dev server (apps/web)
npm run test       # vitest
npm run typecheck  # tsc --noEmit
```

---

Built by **Christopher McDaniel** as a working demonstration of translating an operational
domain into requirements, a data model, and a shipped full-stack system.
