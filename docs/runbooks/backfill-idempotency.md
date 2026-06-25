# Backfill Idempotency Runbook

## Rule
- Every backfill must be safe to run multiple times with no duplicate semantic effects.

## Required Controls
- Deterministic row selection predicates.
- Upsert or merge semantics (no blind inserts).
- Progress checkpoints and resumable batching.
- Audit entries tagged with backfill run ID.

## Validation
1. Run backfill once on staging snapshot.
2. Run same backfill again.
3. Assert row counts and semantic aggregates are identical.
4. Capture diff output and attach to PR parity evidence.

