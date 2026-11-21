-- Phase 2 step 1: a claim flagged because the phone account already belongs to another driver is recorded once per claim, not on every pull.
ALTER TABLE "driver_link_invites" ADD COLUMN "flagged_for" TEXT;
