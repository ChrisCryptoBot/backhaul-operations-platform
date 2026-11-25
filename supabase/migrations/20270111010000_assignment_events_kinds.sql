-- Generated from prisma/migrations/20270111010000_assignment_events_kinds/migration.sql by apps/web/scripts/export-supabase.mjs. Do not edit here: change the Prisma migration and run npm run db:export-supabase.

ALTER TABLE "assignment_events" DROP CONSTRAINT "assignment_events_kind_check";
ALTER TABLE "assignment_events" ADD CONSTRAINT "assignment_events_kind_check"
  CHECK ("kind" IN ('assigned', 'reassigned', 'sent', 'accepted', 'declined', 'recalled', 'removed', 'dropped', 'received', 'cancelled', 'tonu', 'reoffered', 'reopened', 'deleted', 'restored'));
