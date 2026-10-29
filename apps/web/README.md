# Dispatch desk (web app)

The Next.js app for the dispatcher desk. Start from the repository [README](../../README.md); this folder holds the code:

- `src/app/(desk)/` — the pages (loads, load detail, dispatch queue, drivers, trucks, invoices, rate confirmations, KPI dashboard) and their server actions.
- `src/server/tl/` — the TrueLane-shaped read model, load evaluation, dispatch actions, KPI aggregation and the driver-safe projector.
- `src/server/ratecon/` — the rate-confirmation reader (two canned sample readings, a live path that needs `ANTHROPIC_API_KEY`), the draft mapper and the review gate.
- `src/truelane/` — TrueLane's own math, copied by `scripts/vendor-truelane.mjs`. Do not edit it by hand.
- `scripts/seed-demo.ts` — the invented fleet (3 trucks, 4 drivers, 42 loads). Run it against a throwaway database only.
- `tests/` — unit tests, plus `tests/integration` (the dispatcher flow, run with `RUN_DB_INTEGRATION=true`).
