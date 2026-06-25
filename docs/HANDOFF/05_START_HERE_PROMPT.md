# 05 — Start-Here Prompt (paste into the new conversation)

Copy everything in the block below into the first message of the fresh conversation.

---

I'm continuing the "copilot finalization" of my Drop Bucket / backhaul project. Everything you
need to pick up exactly where we left off is in a handoff folder. **Before doing anything else,
read these files in order and confirm you understand the state:**

- `C:\Users\14698\OneDrive\Desktop\backhaul\backhaul-rewrite\docs\HANDOFF\README.md`
- `docs\HANDOFF\01_PROJECT_STATE.md`
- `docs\HANDOFF\02_ARCHITECTURE.md`
- `docs\HANDOFF\03_RUNBOOK.md`
- `docs\HANDOFF\04_REMAINING_PLAN.md`

Context in one line: it's a Next.js 14 + Prisma + Clerk + AWS + Anthropic freight ops app
(app code in `apps/web`, nested git repo, branch `feat/llm-pdf-ingestion-settings`). The
**conversational copilot that edits any load by chat is already built, tested, and committed**
(`server/copilot/*`, `/api/copilot`, `components/copilot/copilot-panel.tsx`). Remaining work:
**Phase 1** (reference-data management UI), **Phase 0c** (live ingestion: SQS drain + S3 read),
and **Phase 3** (Vercel + managed Postgres deploy). Confirmed decisions and known gaps are in
`04_REMAINING_PLAN.md`.

Working rules: reuse the existing audited, region-scoped action layer (the copilot adds no new
mutation paths and runs under the user's RBAC); keep the build green (`npx tsc --noEmit`, `eslint`,
`vitest run` from `apps/web`); commit only when I ask; never stage `replace-secrets.txt`,
`apps/web/.tmp/`, or `apps/web/test-results/`. Note the dev Anthropic key in `apps/web/.env.local`
should be rotated, and the account currently needs credits before the copilot responds live.

After you've read the handoff files, give me a short summary of the current state in your own words
and tell me the options for what to do next — then wait for me to choose. **Do not start coding or
make changes until I confirm the direction.**

---
