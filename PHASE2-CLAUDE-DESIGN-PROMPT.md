# Backhaul Operations Platform — Context Brief + Phase 2 Prompt

> Paste **PART A (Context Brief)** into Claude design first so it builds on the real
> data model, then paste **PART B (Phase 2 prompt)**. Ask for an apply-ready package
> (zip: `PLAN.md` + files/snippets). This is a scratch doc — not committed to the app.

---

## PART A — CONTEXT BRIEF (reusable)

**What this app is.** A backhaul coordinator's operations platform. A backhaul
coordinator's job is two coupled workflows: (1) a **Daily Booking Plan** (driver-first)
where a planner manually records which drivers will be empty tomorrow — expected empty
time + empty location — and the coordinator sources freight to bring each driver back
**loaded** to the home DC in Leesport, PA ("all roads lead home to Leesport"); and
(2) a **Tracker** (load-first) where a booked backhaul becomes a tracked `Load`
(PU/DEL status & ETA, relay drivers, appt windows, refs) monitored to delivery.
Flow: Booking Plan → book → Tracker.

**Stack & layout.** Next.js 14 app-router + Prisma/Postgres + Clerk. App code lives in
`apps/web/src`. Prisma schema is at **repo root** `prisma/schema.prisma` (migrations in
`prisma/migrations`). Path alias `@/…` → `apps/web/src`.

**Reference-entity pattern (clone this exactly).** Every reference entity is a 4-layer chain:
1. **Contract** — `apps/web/src/contracts/reference.ts`: Zod create/update field schemas +
   a `z.discriminatedUnion("action", […])` mutation schema with `create_*` / `update_*` /
   `delete_*` variants. Each variant carries an optional `regionId`. Export the inferred type.
2. **Server actions** — `apps/web/src/server/reference.ts`: `list* / create* / update* /
   softDelete*`. Every function wraps `runInRegionScope(regionId, async (tx) => …)`, filters
   with `withNonDeletedRegionScope(regionId, {…})`, catches Prisma `P2002` → throws a
   `"…already exists"` Error, and writes `tx.auditLog.create({ data: createAuditLog({ entityType,
   entityId, action, actorId, timestamp: new Date(), afterValue|reason }) })`. Validation lives
   at the route, not here. RBAC is enforced by the caller.
3. **API route** — `apps/web/src/app/api/reference/<x>/route.ts`: `GET` + `POST`. Uses
   `auth()` from `@clerk/nextjs/server`, `isAuthBypassed()` for dev bypass, the local
   `resolveReferenceRegion({ requestedRegionId, bypassAuth })` helper (returns `resolvePhase1RegionId()`
   or `"dev-region"` fallback), and `policyAdapter.requireRegionAccess` + `assertPermission`
   with resource `REFERENCE_DATA` (action READ on GET, WRITE on POST) **skipped when bypassAuth**.
   POST parses the mutation schema, branches on `body.action`, then returns the refreshed list.
   Error mapping: `ZodError`→400, `PolicyViolationError`→403, message includes `"in use"` or
   `"already exists"`→409, `"not found"`→404, else 500.
4. **Page + manager** — `apps/web/src/app/reference/<x>/page.tsx` (server component: auth →
   `requireRegionAccess` → `assertPermission`/`isPermissionAllowed` for `canWrite`, renders
   `<AppShell title viewerIsAdmin viewerCanManageReference regionCode>` wrapping the manager)
   and `apps/web/src/app/reference/<x>/<x>-manager.tsx` (`"use client"`; uses `ReferenceTabs`,
   `Modal`, `ConfirmDialog`, `EmptyState`, `Toggle`, `UndoToast`/`useToast`, icons from
   `@/components/icons`; POSTs mutations to the API route and swaps in the returned list).
   Register the page in nav: `apps/web/src/components/shell/app-sidebar.tsx` (Reference group)
   **and** `apps/web/src/components/reference/reference-tabs.tsx` (`TABS` array).

**Phase 1 entities already shipped (do not redo).**
- `Driver` — `code` (VarChar16, unique per region), `fullName`, `phone?`, `homeDropLotId?`
  (→ `DropLot`, SetNull), `active`, `attributes DriverAttribute[]`, weekly schedule flat on the
  row: `scheduleDays DayOfWeek[]` + `scheduleStart "HH:MM"` + `scheduleTimeZone?` + `scheduleNote?`.
- `DirectCustomer` — `name`, nullable cadence pair (`cadenceCount` + `cadencePeriod DAY|WEEK`), `notes`.
- Enums: `DriverAttribute` (LTL_CERT, SLEEPER, TURNS_ONLY, DEDICATED, REGIONAL, FLEX, SHUTTLE, PTP),
  `DayOfWeek` (MON…SUN), `CadencePeriod` (DAY, WEEK).
- Optional driver FKs already on `Load` (`pickupDriverId` / `deliveryDriverId`) and
  `LoadLeg` (`driverId`), all SetNull + indexed, no backfill.
- Pages `/reference/drivers` and `/reference/direct-customers` live; both are in sidebar + tabs.

**Domain models to reuse (don't recreate).** Home DC = `DistributionCenter` (Leesport, PA:
`name/city/state`, region-scoped). Yards = `DropLot` (has `code`, `city/state`, `slipSeat`,
`dropHookRequired`). Relay = `LoadLeg`. Rostered driver = `Driver`.

**The `Load` model is large and mostly non-null.** A `Load` requires (not exhaustive):
`weekIso`, `pickupDate`, `status LoadStatus` (default BOOKED), `createdById`, `lineHaulRate`,
`loadedMiles`, `puDeadheadMiles`, `delDeadheadMiles`, `fscApplies`, plus dozens of optional
tracker fields. Today the **only** Load-creation path is `createLoadFromReview(...)` in
`apps/web/src/server/review.ts` (rate-confirmation ingestion). There is no lightweight
"create a blank Load" path yet — Phase 2's "book → Load" step must define a deliberate
**minimal Load create** (sensible defaults for the required financial/mileage fields, status
BOOKED, headed to the Leesport DC). Flag any assumption here in `PLAN.md`.

**Hard constraints (every round).**
- **Strictly additive.** Do NOT remove or reduce ANY existing tracker/`Load` data point or column.
- Keep `npm run typecheck` and `npm run test` green (run from `apps/web`).
- Any schema change ships a Prisma migration under `prisma/migrations` (no backfill unless asked).
- Preserve: region-scoping (`runInRegionScope` / `withNonDeletedRegionScope`), policy
  (`policyAdapter`; resources `REFERENCE_DATA` / `BOARD`), soft-delete (`deletedAt`),
  audit logging (`createAuditLog`), and the dev auth-bypass path (`isAuthBypassed`).
- **Environment:** no live Postgres in the dev box — `prisma generate` (client types, no DB) is
  all typecheck/tests need; `prisma migrate dev` (real tables) is run separately against a real DB.
  Windows/OneDrive gotcha: `prisma generate` throws EPERM if a `npm run dev` node process holds the
  query-engine DLL — stop node first.

**Source of truth.** Two spreadsheet tabs exported as CSVs one dir above the repo:
`BACKHAUL PLANNER(DAILY BOOKING PLAN ).csv` (driver roster by home yard + the daily working plan;
its working header is `Pick Up DRIVER, EMPTY CITY, EMPTY CITY2, BACKHAUL, PU CITY & DH, PU TIMES,
DEL CITY & DH, DEL TIMES, STATUS`) and `BACKHAUL PLANNER(MASTER PLANNER).csv` (the ~32-column
tracker). The Daily Booking Plan's working header IS the shape of the Phase 2 entity.

---

## PART B — PHASE 2 PROMPT (Daily Booking Plan page)

**Goal.** Build the driver-first **Daily Booking Plan**: a page where the planner records which
rostered drivers will be empty on a given `planDate` (expected empty time + empty location), the
status of sourcing a backhaul for each, and — when booked — a link to the sourced `Load` headed to
the Leesport DC. This is the left half of the coordinator's job; it feeds the Tracker.

Follow the **reference-entity pattern** in the Context Brief exactly. Produce an apply-ready
package: `PLAN.md` (assumptions, migration summary, file list, test list, open questions) plus each
new/changed file as a full file or a clearly-anchored snippet ("append to `contracts/reference.ts`
after the DirectCustomer section", etc.).

### Data model — new `BookingPlanEntry`
Add to `prisma/schema.prisma` (repo root) + a migration. Region-scoped, soft-deletable, audited.
Fields (map to the CSV working header):
- `id`, `regionId`, `deletedAt?`, `createdAt`, `updatedAt` (standard).
- `planDate DateTime` — the day the driver is empty (date-only semantics; store midnight UTC or a
  `@db.Date`, your call — state which in PLAN.md).
- `driverId String` → `Driver` (onDelete: **Restrict** or SetNull? Recommend Restrict so a plan
  line always names a driver; justify in PLAN.md). Indexed.
- `expectedEmptyAt String?` — local "HH:MM" wall-clock, same convention as `Driver.scheduleStart`
  (regex `^([01]\d|2[0-3]):[0-5]\d$`). (The empty *time*.)
- `emptyCity String?`, `emptyState String?` — where the driver goes empty (CSV "EMPTY CITY").
- `emptyCityAlt String?` — the CSV's "EMPTY CITY2" (a secondary/optional empty location).
- `backhaulNote String?` — free text describing the freight being sourced (CSV "BACKHAUL").
- `status BookingPlanStatus` — new enum `NEEDS_BACKHAUL | SOURCING | BOOKED` (default NEEDS_BACKHAUL).
- `sourcedLoadId String?` → `Load` (onDelete: SetNull), unique or not? (A plan line books at most
  one Load → recommend `@unique`; justify). Indexed.
- Optional staging fields mirroring the CSV so the plan line is self-contained without a Load yet:
  `puCityDh String?`, `puTimes String?`, `delCityDh String?`, `delTimes String?`. (These are the
  planner's shorthand before a real Load exists — keep as strings, matching the sheet.)
Add the back-relation on `Load` (`bookingPlanEntry BookingPlanEntry?`) additively — do NOT touch
any existing `Load` column.

### Contract — `apps/web/src/contracts/reference.ts`
Append a `bookingPlanStatusSchema` enum and `bookingPlanEntryCreate/UpdateFields` schemas + a
`bookingPlanMutationSchema` discriminated union: `create_booking_plan_entry`,
`update_booking_plan_entry`, `delete_booking_plan_entry` (with `reason`), and a dedicated
`book_booking_plan_entry` action (the "source a Load" transition — see below). Reuse the existing
`citySchema` / `stateSchema` / phone-style trims already in the file.

### Server — `apps/web/src/server/reference.ts`
Append `BookingPlanEntrySummary` interface + `listBookingPlanEntries({ regionId, planDate? })`,
`createBookingPlanEntry`, `updateBookingPlanEntry`, `softDeleteBookingPlanEntry`, and
`bookBookingPlanEntry` (the transition: validates the entry is region-scoped and not already
BOOKED, creates a **minimal Load** headed to the Leesport `DistributionCenter` with status BOOKED
via a new small helper — reuse or factor out the required-field defaults from `createLoadFromReview`
in `server/review.ts` — sets `Load.pickupDriverId = entry.driverId`, links `sourcedLoadId`, flips
status to BOOKED, audits both the entry transition and the Load creation). List must resolve the
driver (`code` + `fullName`) and, if present, minimal sourced-Load info. Guard `softDelete` the same
way `softDeleteDriver` guards in-use ("… cannot be removed" → 409). Audit actions:
`REFERENCE_BOOKING_PLAN_CREATE|UPDATE|DELETE|BOOK`.

### API route — `apps/web/src/app/api/reference/booking-plan/route.ts`
Clone `api/reference/drivers/route.ts` verbatim in shape (auth/bypass, `resolveReferenceRegion`,
`REFERENCE_DATA` READ/WRITE, error→status mapping incl. 409/404). GET supports an optional
`planDate` query param. POST branches over the four actions.

### Page + manager
`apps/web/src/app/reference/booking-plan/page.tsx` (server component like `drivers/page.tsx`; fetch
entries + the driver list for the picker) and `booking-plan-manager.tsx` (`"use client"`). UI: a
date selector for `planDate`; a table/board of empty drivers with inline status pills
(NEEDS_BACKHAUL → SOURCING → BOOKED); a create/edit `Modal` (driver picker, empty time HH:MM,
empty city/state + alt, backhaul note, the PU/DEL shorthand cells); a **"Book"** action per row that
calls `book_booking_plan_entry` and, on success, surfaces a link to the created Load on the board.
Also surface the **Direct Customers** staging list (guaranteed recurring freight) as a side panel so
the planner can pull from it when sourcing. Use `ReferenceTabs`, `ConfirmDialog`, `EmptyState`,
`UndoToast`. Register the page in `app-sidebar.tsx` (Reference group) **and** `reference-tabs.tsx`.

### Tests (Vitest)
Mirror the Phase 1 test trio: `server/__tests__/reference-booking-plan.test.ts` (create/update/
soft-delete/book happy paths + in-use/duplicate/not-found + the book→Load transition sets
pickupDriverId & links sourcedLoadId & flips status), `api-reference-booking-plan.test.ts` (200s,
409 on double-book, 404, 403 when policy denied, 400 on bad body), and a
`contracts/reference-booking-plan.contract.test.ts` (schema accept/reject incl. bad HH:MM and the
book action shape). Keep the full suite green.

### PLAN.md must call out
- The `planDate` storage choice (Date vs DateTime midnight).
- The `driverId` / `sourcedLoadId` onDelete + uniqueness choices.
- The **minimal-Load defaults** chosen for the required non-null financial/mileage fields
  (`lineHaulRate`, `loadedMiles`, deadheads, `fscApplies`, `weekIso`, `createdById`) and how the
  Leesport DC is resolved (`DistributionCenter` lookup by region).
- Confirmation that no existing `Load`/tracker column is removed or narrowed (strictly additive).
