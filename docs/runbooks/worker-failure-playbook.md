# Worker Failure Playbook

## Signals
- Queue lag
- Retry pressure
- Dead-letter count/rate
- Parse failure class distribution

## Immediate Response
1. Identify failing event type (`PARSE_RATE_CON` vs `RECOMPUTE_WEEK_SNAPSHOT`).
2. Validate contract version in queue payload.
3. Validate lifecycle transition legality for failed entities.
4. Classify failure as transient vs deterministic.

## Remediation
- Transient: retry with exponential backoff.
- Deterministic/schema: move to dead-letter with actionable reason, create audit event.
- Contract mismatch: pause consumer and deploy compatible serializer/deserializer.

## Exit Criteria
- Lag below threshold
- Retry pressure stable
- Dead-letter growth halted

