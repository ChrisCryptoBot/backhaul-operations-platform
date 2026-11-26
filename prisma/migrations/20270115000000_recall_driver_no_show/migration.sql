-- Dispatch queue P1.5b (2026-11-25): a recall reason of its own for a driver who never showed or quit, apart from one who cannot be reached.
-- Widens the reason check on assignment_events; no row changes. The desk offers the new reason only once this is applied (src/lib/recall-reasons.ts RECALL_OFFERED).
ALTER TABLE "assignment_events" DROP CONSTRAINT IF EXISTS "assignment_events_reason_check";
ALTER TABLE "assignment_events" ADD CONSTRAINT "assignment_events_reason_check" CHECK ("reason_code" IS NULL OR "reason_code" IN ('ASSIGNED_IN_ERROR', 'HOS_TIMEOUT', 'MECHANICAL_BREAKDOWN', 'DRIVER_UNRESPONSIVE', 'DRIVER_NO_SHOW', 'SCHEDULED_RELAY'));
