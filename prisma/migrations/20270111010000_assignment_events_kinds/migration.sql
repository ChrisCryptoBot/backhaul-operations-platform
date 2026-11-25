ALTER TABLE "assignment_events" DROP CONSTRAINT "assignment_events_kind_check";
ALTER TABLE "assignment_events" ADD CONSTRAINT "assignment_events_kind_check"
  CHECK ("kind" IN ('assigned', 'reassigned', 'sent', 'accepted', 'declined', 'recalled', 'removed', 'dropped', 'received', 'cancelled', 'tonu', 'reoffered', 'reopened', 'deleted', 'restored'));
