# Backhaul Web (Phase 1)

This app contains the NE-only Phase 1 bootstrap for:

- Clerk auth + role mapping
- Prisma schema and core entities
- SQS parse/recompute queue contracts
- Tuesday FSC workflow with load-confirmation blocking when missing
- KPI decimal formula utilities

## S3 Lifecycle Policy (Required)

- Keep rate-confirmation PDFs in hot storage for 90 days
- Archive after 90 days
- Delete after 7 years
