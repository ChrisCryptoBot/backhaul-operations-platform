# Semantic Domain Owners and Reviewer Mapping

| Domain | Primary Owner | Required Reviewer Role |
|---|---|---|
| Data model semantics | Platform backend owner | Prisma/schema reviewer |
| Ingestion lifecycle and duplicate policy | Ingestion owner | Worker/reliability reviewer |
| KPI formulas and parity checks | Analytics owner | KPI math reviewer |
| RBAC and region scoping policy | Security/platform owner | Access control reviewer |

## PR Rule
- Any PR touching one of the domains above must include the matching reviewer role in review requests and parity evidence.

