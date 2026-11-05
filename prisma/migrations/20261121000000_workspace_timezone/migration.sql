-- The carrier's own clock: where billing days, aging, weekly limits, statement weeks and "this month" are counted (src/lib/tz.ts). Existing fleets keep Central, which is what the desk always used.
ALTER TABLE "workspaces" ADD COLUMN "timezone" TEXT NOT NULL DEFAULT 'America/Chicago';
