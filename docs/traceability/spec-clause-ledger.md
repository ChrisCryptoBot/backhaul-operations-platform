# Drop Bucket Spec-to-Code Traceability Ledger

## Usage
- Every PR must update this ledger for each affected clause.
- Status values:
  - `implemented`
  - `partial`
  - `deferred`
- Evidence must include:
  - code paths,
  - test paths,
  - residual mismatch notes (if any).

## Clause Mapping

| Clause ID | Requirement | Status | Code Evidence | Test Evidence | Residual Mismatch |
|---|---|---|---|---|---|
| 0.6 | Backend/API/UI semantic alignment and drilldown | implemented | `apps/web/src/server/*`, `apps/web/src/components/*`, `apps/web/src/lib/ui/behavioral-contracts.ts` | `apps/web/tests/*`, `apps/web/tests/components/*.test.tsx` | none |
| 7.3 | Canonical field semantics | implemented | `apps/web/src/domain/semantics/index.ts`, `prisma/schema.prisma` | `apps/web/tests/domain/semantics/semantics.test.ts`, `apps/web/tests/scope.test.ts` | none |
| 8.2 | Upload/finalize flow | implemented | `apps/web/src/app/api/rate-confirmations/route.ts`, `apps/web/src/server/upload-storage.ts`, `apps/web/src/contracts/upload-finalize.ts` | `apps/web/tests/api-rate-confirmations.test.ts`, `apps/web/tests/ingestion-finalize-upload.test.ts` | none |
| 8.5 | Duplicate handling exact + soft | implemented | `apps/web/src/domain/ingestion/duplicate-policy.ts`, `apps/web/src/server/ingestion.ts`, `apps/web/src/server/rate-confirmation-activity.ts`, `apps/web/src/components/board/board-shell.tsx` | `apps/web/tests/domain/ingestion/duplicate-policy.test.ts`, `apps/web/tests/rate-confirmation-activity.test.ts`, `apps/web/tests/api-rate-confirmations.test.ts` | none |
| 8.6 | Parse lifecycle and failures | implemented | `apps/web/src/domain/ingestion/lifecycle.ts`, `apps/web/src/server/queue-consumer.ts`, `apps/web/src/server/parser-engine.ts`, `apps/web/src/server/ingestion.ts`, `apps/web/src/contracts/queue.ts` | `apps/web/tests/domain/ingestion/lifecycle.test.ts`, `apps/web/tests/queue-consumer.test.ts`, `apps/web/tests/ingestion-parse-failure.test.ts`, `apps/web/tests/api-internal-queue-consume.test.ts` | none |
| 9.1 | Deterministic KPI formulas | implemented | `apps/web/src/domain/kpi/pure.ts`, `apps/web/src/server/kpi.ts`, `apps/web/src/server/snapshots.ts` | `apps/web/tests/domain/kpi/pure.test.ts`, `apps/web/tests/kpi.test.ts`, `apps/web/tests/snapshots.regression.test.ts` | none |
| 9.2.1 | Inclusion/exclusion matrix | implemented | `apps/web/src/domain/semantics/index.ts`, `apps/web/src/server/snapshots.ts`, `apps/web/src/server/kpi-dashboard.ts` | `apps/web/tests/domain/semantics/semantics.test.ts`, `apps/web/tests/snapshots.regression.test.ts`, `apps/web/tests/kpi-dashboard.test.ts` | none |
| 9.1 MileMax | Totals-level only invariant | implemented | `apps/web/src/domain/semantics/index.ts`, `apps/web/src/domain/kpi/pure.ts`, `apps/web/src/server/snapshots.ts`, `apps/web/src/server/kpi-dashboard.ts`, `prisma/migrations/20260504_weeksnapshot_milemax_and_tonu/migration.sql`, `prisma/migrations/20260504_weeksnapshot_inbound_parity_fields/migration.sql` | `apps/web/tests/domain/semantics/semantics.test.ts`, `apps/web/tests/kpi-dashboard.test.ts`, `apps/web/tests/snapshots.regression.test.ts` | none |
| 13/14 | Region scoping + RBAC | implemented | `apps/web/src/domain/policy/policy-adapter.ts`, `apps/web/src/domain/policy/permissions.ts`, `apps/web/src/lib/scoped-query.ts`, `apps/web/src/app/api/*` | `apps/web/tests/policy-matrix.contract.test.ts`, `apps/web/tests/scope.test.ts`, `apps/web/tests/api-*.test.ts` | none |
| 16 | Delivery evidence + CI gates | implemented | `.github/workflows/phase1-ci.yml`, `docs/runbooks/*`, `docs/traceability/*`, `apps/web/src/server/worker-reliability-gates.ts` | `npm run test:semantic`, `npm run test:critical-path`, `npm run test:worker-gates`, full `npm test` | none |

