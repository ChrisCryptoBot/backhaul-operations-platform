# Migration Rollback Runbook

## Preconditions
- Confirm migration ID and affected tables/columns.
- Confirm backup snapshot point.
- Pause write-heavy jobs if needed.

## Rollback Steps
1. Disable traffic to mutation endpoints (maintenance or feature-flag gate).
2. Revert application deployment to previous compatible version.
3. Apply explicit rollback SQL script for the migration.
4. Run smoke checks:
   - auth + scoped reads,
   - upload endpoint,
   - board and dashboard loads.
5. Re-enable traffic.

## Post-Rollback Evidence
- SQL script executed
- Validation command output
- Incident note with clause impact

