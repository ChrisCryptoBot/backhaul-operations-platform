# ADR-0009: Deliverable-First Gates and Stable Adapters

**Status:** Accepted  
**Date:** 2026-05-04

## Context
Execution must remain deliverable-first while unresolved decisions (multi-region policy specifics, worker topology) should not block coding progress. The system also needs durable contract and semantics governance.

## Decision
- Treat each work unit as complete only with code + tests + traceability update.
- Introduce stable adapter boundaries:
  - policy adapter for region/role decisions,
  - worker orchestrator adapter for queue topology decisions.
- Freeze and version cross-boundary contracts early.

## Consequences
- We can keep implementation moving with stable interfaces while backing decisions evolve.
- Contract changes become intentional and auditable through version bumps.
- Test and traceability burden increases per PR by design.

