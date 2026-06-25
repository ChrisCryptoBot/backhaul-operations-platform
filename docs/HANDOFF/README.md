# Drop Bucket — Copilot Finalization Handoff

This folder is the single source of truth for continuing the **conversational copilot
finalization** of Drop Bucket in a fresh conversation. Read these in order:

1. **[01_PROJECT_STATE.md](01_PROJECT_STATE.md)** — what the project is, what's built, commits, what's verified, what's pending.
2. **[02_ARCHITECTURE.md](02_ARCHITECTURE.md)** — system + copilot architecture and the key-files map.
3. **[03_RUNBOOK.md](03_RUNBOOK.md)** — how to run/test locally, env vars, migrations, seeding, and gotchas.
4. **[04_REMAINING_PLAN.md](04_REMAINING_PLAN.md)** — the remaining phases (1, 0c, 3), confirmed decisions, and known gaps.
5. **[05_START_HERE_PROMPT.md](05_START_HERE_PROMPT.md)** — the exact prompt to paste into the new conversation.

**Repo:** `C:\Users\14698\OneDrive\Desktop\backhaul\backhaul-rewrite` (a nested git repo; the app lives in `apps/web`).
**Branch:** `feat/llm-pdf-ingestion-settings`.
**Full plan of record:** `C:\Users\14698\.claude\plans\create-plan-for-finalization-abstract-feather.md`.

**One-line status:** The copilot (edit any load by chat) is **built, tested, and committed**. Remaining: reference-data management UI, live ingestion wiring, and Vercel deploy. The Anthropic account needs **credits** and **two migrations** need applying before the copilot responds live.
